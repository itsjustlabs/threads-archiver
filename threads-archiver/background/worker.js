/**
 * Background service worker for Threads Archiver (MV3).
 *
 * Responsibilities:
 *  - Alarm-based sync (hourly by default)
 *  - Fetch saved posts list → detect new posts
 *  - Fetch thread detail + archive media for each new post
 *  - Delta-reply polling: cheaply detect new replies via reply_count
 *  - Store everything in IndexedDB via shared/db.js
 *  - Notify popup of sync status via chrome.storage.session
 */

import {
  setBridgeTab, setMetaParams, fetchAllSaved, fetchThreadDetail, fetchCounts, getLastRequest,
  downloadMedia, normalizePost, AuthError, QUERY_DEFS, codeToPk,
  extractImages, extractVideos,
} from '../shared/api.js';

import {
  getThread, putThread, getAllThreads,
  putMedia, getMedia, getMediaForPost, getStorageStats, getAllMediaIds,
} from '../shared/db.js';

// ── constants ──────────────────────────────────────────────────────────────────

const ALARM_NAME        = 'threads-sync';
const ALARM_PERIOD_MIN  = 60;   // each sync loads the Threads page once
const DELTA_BATCH_SIZE  = 50;   // max post IDs per reply-count request

// ── install / startup ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(details => {
  scheduleAlarm();
  setSyncStatus('idle');
  // New code may handle whatever broke, so give it a chance.
  if (details?.reason === 'update') clearCompatPause('extension updated');
});

chrome.runtime.onStartup.addListener(async () => {
  scheduleAlarm();
  if (await isPaused()) return; // stay paused across restarts until user resumes
  maybeResumeFullRefresh(); // finish an interrupted full refresh
});

function scheduleAlarm() {
  chrome.alarms.get(ALARM_NAME, existing => {
    // Also replace an alarm left by a version with a different period.
    if (existing?.periodInMinutes !== ALARM_PERIOD_MIN) {
      chrome.alarms.create(ALARM_NAME, {
        delayInMinutes:  1,
        periodInMinutes: ALARM_PERIOD_MIN,
      });
    }
  });
}

// ── alarm handler ──────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return;
  if (await isPaused()) return; // respect an explicit pause — don't auto-resume
  const { [COMPAT_PAUSE_KEY]: compatPaused } = await chrome.storage.local.get(COMPAT_PAUSE_KEY);
  if (compatPaused) {
    console.log('[archiver] Scheduled sync skipped: paused after repeated compatibility failures');
    return;
  }
  const { [BACKOFF_UNTIL_KEY]: until = 0 } = await chrome.storage.local.get(BACKOFF_UNTIL_KEY);
  if (Date.now() < until) {
    console.log(`[archiver] Scheduled sync skipped: backing off until ${new Date(until).toISOString().slice(11, 16)} UTC`);
    return;
  }
  // An interrupted full refresh takes priority over the regular sync
  if (await maybeResumeFullRefresh()) return;
  runSync();
});

// ── message handler (from popup) ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SYNC_NOW') {
    setPaused(false); _pauseRequested = false; // manual sync clears any pause
    runSync().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // keep channel open
  }
  if (msg.type === 'FULL_REFRESH') {
    setPaused(false); _pauseRequested = false;
    runFullRefresh().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // keep channel open
  }
  if (msg.type === 'PAUSE_SYNC') {
    // If a job is running, ask it to stop at the next checkpoint; otherwise
    // just set the persisted flag so scheduled runs don't start.
    _pauseRequested = true;
    (async () => {
      if (!_syncing) { await setPaused(true); await setSyncStatus('paused', { message: 'Sync paused' }); }
      sendResponse({ ok: true, running: _syncing });
    })();
    return true;
  }
  if (msg.type === 'RESUME_SYNC') {
    _pauseRequested = false;
    (async () => {
      await setPaused(false);
      await clearCompatPause('resumed from the popup');
      // Resume whatever was in progress: a full-refresh queue takes priority.
      if (!(await maybeResumeFullRefresh())) runSync();
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === 'IMPORT_ARCHIVE') {
    // The zip bytes are handed off via the Cache API (runtime messages are
    // JSON-serialized and can't carry an ArrayBuffer).
    runImport()
      .then(res => sendResponse(res))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // keep channel open
  }
  if (msg.type === 'ARCHIVE_REPLY') {
    archiveReply(msg)
      .then(res => sendResponse(res))
      .catch(e => sendResponse({ ok: false, error: e.message, authError: e instanceof AuthError }));
    return true;
  }
  if (msg.type === 'REFRESH_THREAD') {
    refreshThread(msg.code)
      .then(res => sendResponse(res))
      .catch(e => sendResponse({ ok: false, error: e.message, authError: e instanceof AuthError }));
    return true;
  }
  if (msg.type === 'GET_STATUS') {
    getSyncStatus().then(s => sendResponse(s));
    return true;
  }
  if (msg.type === 'GET_STATS') {
    getStorageStats().then(s => sendResponse(s));
    return true;
  }
});

// ── sync status (chrome.storage.session = ephemeral, clears on browser close) ──

async function setSyncStatus(state, extra = {}) {
  await chrome.storage.session.set({ syncStatus: { state, ...extra, updatedAt: Date.now() } });
}

async function getSyncStatus() {
  const { syncStatus } = await chrome.storage.session.get('syncStatus');
  // The paused flag is persisted (storage.local); the session status is not,
  // so after a browser restart reflect the pause the popup would otherwise miss.
  if (await isPaused() && syncStatus?.state !== 'syncing') {
    return { ...(syncStatus ?? {}), state: 'paused', message: syncStatus?.message ?? 'Sync paused' };
  }
  return syncStatus ?? { state: 'idle' };
}

// ── pause / resume ───────────────────────────────────────────────────────────
// Cooperative: a pause request lets the in-flight item finish, then the next
// checkpoint (top of each per-item loop) stops the run cleanly. The paused
// flag is persisted so the alarm won't silently auto-resume; the work itself
// is idempotent (archiving skips existing, delta/repair re-scan), so resuming
// is just running the job again.

const PAUSE_KEY = 'syncPaused';
let _pauseRequested = false;

class SyncPaused extends Error {
  constructor() { super('Paused'); this.name = 'SyncPaused'; }
}

/** Called at safe checkpoints inside sync loops. */
function throwIfPaused() {
  if (_pauseRequested) throw new SyncPaused();
}

async function isPaused() {
  const { [PAUSE_KEY]: v } = await chrome.storage.local.get(PAUSE_KEY);
  return v === true;
}
const setPaused = v => chrome.storage.local.set({ [PAUSE_KEY]: v });

// ── main sync ──────────────────────────────────────────────────────────────────

// ── incremental scan + back-off state (chrome.storage.local) ─────────────────
const LAST_FULL_SCAN_KEY = 'lastFullScanAt';
const BACKOFF_UNTIL_KEY  = 'syncBackoffUntil';
const BACKOFF_MS_KEY     = 'syncBackoffMs';
const FULL_SCAN_EVERY_MS = 24 * 60 * 60_000;
const BACKOFF_FIRST_MS   = 60 * 60_000;
const BACKOFF_MAX_MS     = 8 * 60 * 60_000;

async function fullScanDue() {
  const { [LAST_FULL_SCAN_KEY]: last } = await chrome.storage.local.get(LAST_FULL_SCAN_KEY);
  if (!last) {
    // First run with this code: start the daily clock now rather than firing a
    // ~96-request full scan straight away while Threads is already limiting us.
    await chrome.storage.local.set({ [LAST_FULL_SCAN_KEY]: Date.now() });
    return false;
  }
  return Date.now() - last > FULL_SCAN_EVERY_MS;
}

// 1h, then doubling up to 8h, until a sync succeeds again.
async function startBackoff() {
  const { [BACKOFF_MS_KEY]: prev } = await chrome.storage.local.get(BACKOFF_MS_KEY);
  const ms = prev ? Math.min(prev * 2, BACKOFF_MAX_MS) : BACKOFF_FIRST_MS;
  const until = Date.now() + ms;
  await chrome.storage.local.set({ [BACKOFF_UNTIL_KEY]: until, [BACKOFF_MS_KEY]: ms });
  return until;
}

// ── compatibility auto-pause ─────────────────────────────────────────────────
// When Threads changes in a way this version can't handle, every sync fails
// the same way. After COMPAT_PAUSE_AFTER consecutive failures of that kind,
// stop scheduled syncs instead of retrying every 30 minutes. Cleared by a
// successful sync, by Resume / Sync now in the popup, or by an extension update.
const COMPAT_FAILS_KEY   = 'compatFailures';
const COMPAT_PAUSE_KEY   = 'compatPausedAt';
const COMPAT_PAUSE_AFTER = 3;

// Errors that mean "Threads no longer matches what this code expects", as
// opposed to network trouble (retry), a web page (back off) or a logout.
function isCompatError(e) {
  return /GraphQL execution error|GraphQL returned no|is not valid JSON|Unexpected token|Unknown query key|HTTP 4\d\d from GraphQL/.test(e?.message ?? '');
}

async function recordCompatFailure() {
  const { [COMPAT_FAILS_KEY]: n = 0 } = await chrome.storage.local.get(COMPAT_FAILS_KEY);
  await chrome.storage.local.set({ [COMPAT_FAILS_KEY]: n + 1 });
  return n + 1;
}

async function clearCompatPause(why) {
  const { [COMPAT_PAUSE_KEY]: paused } = await chrome.storage.local.get(COMPAT_PAUSE_KEY);
  await chrome.storage.local.remove([COMPAT_FAILS_KEY, COMPAT_PAUSE_KEY]);
  if (paused) console.log(`[archiver] Compatibility pause cleared (${why})`);
}

// The popup has one line for status. Keep it short; full details go to the log.
function shortError(e) {
  const m = e?.message ?? String(e);
  if (/THREADS_WEB_PAGE/.test(m))            return 'Threads returned a page instead of data';
  if (isCompatError(e))                      return 'Threads changed; this version can’t read it';
  if (/timed out|no answer from the Threads tab|Bridge unreachable|Failed to fetch/.test(m))
                                             return 'Network problem; will retry';
  const first = m.split(/(?<=\.)\s/)[0];
  return first.length > 90 ? first.slice(0, 87) + '…' : first;
}

// ── unload the Threads tab between syncs ─────────────────────────────────────
// The /saved tab is only needed while a sync runs: live query IDs and tokens
// come from it. Left loaded, some loads of Threads got stuck running flat out
// for a day; the container has no GPU, so a tab in front renders on the CPU.
// After each sync, discard it: it stays in the tab strip using no CPU or
// memory, and the next sync loads it again. Chrome won't discard the tab in
// front, so another tab is brought forward first.
async function releaseThreadsTabs() {
  try {
    const tabs = (await chrome.tabs.query({ url: 'https://*.threads.com/*' }))
      .filter(t => isSavedPage(t.url) && !t.discarded && t.status !== 'unloaded');
    for (const tab of tabs) {
      if (tab.active) {
        const others = (await chrome.tabs.query({ windowId: tab.windowId }))
          .filter(t => !isSavedPage(t.url))   // bringing one forward would reload it
          .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
        if (others.length) await chrome.tabs.update(others[0].id, { active: true });
        else await chrome.tabs.create({ windowId: tab.windowId, active: true });
      }
      await chrome.tabs.discard(tab.id);
      console.log(`[archiver] Unloaded the Threads tab ${tab.id} until the next sync`);
    }
  } catch (e) {
    console.warn('[archiver] Could not unload the Threads tab: ' + e.message);
  }
}

let _syncing = false;
let _syncStartedAt = 0;
let _syncRun = 0;          // so a hung run finishing late can't clear a newer run's flag
const STALE_SYNC_MS = 45 * 60_000;
const POST_TIMEOUT_MS = 5 * 60_000;

// Settles with the promise, or rejects after ms. The original promise may keep
// running in the background, but the sync no longer waits on it.
function withTimeout(promise, ms, what) {
  return Promise.race([promise, new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms))]);
}

async function runSync() {
  if (_syncing) {
    const mins = Math.round((Date.now() - _syncStartedAt) / 60_000);
    if (Date.now() - _syncStartedAt < STALE_SYNC_MS) {
      console.log(`[archiver] Sync skipped: the previous sync is still running (${mins} min)`);
      return;
    }
    // A sync this old is hung, not busy; don't let it block every future sync.
    console.warn(`[archiver] Previous sync has run ${mins} min; treating it as hung and starting a new one`);
  }
  _syncing = true;
  _syncStartedAt = Date.now();
  const run = ++_syncRun;
  // Chrome stops an extension's service worker after ~30s without extension
  // events or API calls, and waiting on a long media download doesn't count.
  // That killed syncs mid-archive with nothing logged: every timer and flag
  // died with the worker. Any extension API call resets the idle timer.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000);
  await setSyncStatus('syncing', { message: 'Starting sync…' });
  console.log('[archiver] Sync started');

  try {
    // ── 0. Find / open a Threads tab and wire up the content-script bridge ──
    await setSyncStatus('syncing', { message: 'Connecting to Threads…' });
    await ensureBridgeReady();

    // ── 1. Fetch saved list ─────────────────────────────────────────────────
    await setSyncStatus('syncing', { message: 'Fetching saved posts…' });

    // Incremental by default: the saved list is newest-first, so stop at the
    // first page with nothing new. Re-reading all ~380 saved posts every
    // 30 minutes (~96 requests) is what got the session rate-limited. A full
    // scan still runs at most once a day, to catch anything saved out of order.
    const fullScan = await fullScanDue();
    const allEdges = [];
    let pages = 0;
    await fetchAllSaved(async edges => {
      pages++;
      allEdges.push(...edges);
      if (fullScan) return true;
      for (const edge of edges) {
        const node = edge.node ?? edge;
        const code = (node?.thread_items?.[0]?.post ?? node)?.code;
        if (code && !(await getThread(code))) return true;   // something new here: keep going
      }
      return false;
    });
    if (fullScan) await chrome.storage.local.set({ [LAST_FULL_SCAN_KEY]: Date.now() });

    console.log(`[archiver] ${allEdges.length} saved edges fetched ` +
      `(${fullScan ? 'full scan' : 'incremental'}, ${pages} page(s))`);

    // ── 2. Detect new posts ─────────────────────────────────────────────────
    const newNodes = [];
    for (const edge of allEdges) {
      const node = edge.node ?? edge;
      const post = node?.thread_items?.[0]?.post ?? node;
      if (!post?.code) continue;

      const existing = await getThread(post.code);
      if (!existing) {
        newNodes.push(node);
      }
    }

    console.log(`[archiver] ${newNodes.length} new posts to archive`);

    // ── 3. Archive new posts ────────────────────────────────────────────────
    // newNodes is a snapshot from step 2. Re-check existence just before
    // archiving each one so anything added since (a concurrent import, or a
    // resume after an import) is deduped rather than re-fetched/overwritten.
    for (let i = 0; i < newNodes.length; i++) {
      throwIfPaused(); // finish the previous post, then stop here if paused
      const node = newNodes[i];
      const code = (node?.thread_items?.[0]?.post ?? node)?.code;
      if (code && await getThread(code)) continue; // imported/archived meanwhile
      await setSyncStatus('syncing', {
        message: `Archiving post ${i + 1} of ${newNodes.length}…`,
      });
      console.log(`[archiver] Archiving post ${i + 1}/${newNodes.length} (${code ?? '?'})`);
      try {
        await withTimeout(archivePost(node), POST_TIMEOUT_MS, `Archiving post ${code ?? '?'}`);
      } catch (e) {
        if (e instanceof AuthError) throw e; // propagate auth errors
        console.warn('[archiver] Failed to archive post: ' + e.message);
      }
    }

    // ── 4. Delta-reply check for existing posts ─────────────────────────────
    await setSyncStatus('syncing', { message: 'Checking for new replies…' });
    await checkDeltas();

    // ── 5. Repair missing/expired media with fresh CDN URLs ─────────────────
    await setSyncStatus('syncing', { message: 'Repairing missing media…' });
    await repairMissingMedia();

    const stats = await getStorageStats();
    await setSyncStatus('idle', {
      message:     `Sync complete — ${stats.threadCount} archived`,
      lastSync:    Date.now(),
      threadCount: stats.threadCount,
      mediaBytes:  stats.mediaBytes,
    });

    await chrome.storage.local.remove([BACKOFF_UNTIL_KEY, BACKOFF_MS_KEY]);
    await clearCompatPause('sync succeeded');
    console.log('[archiver] Sync complete');

  } catch (e) {
    if (e instanceof SyncPaused) {
      await setPaused(true);
      const stats = await getStorageStats().catch(() => ({}));
      await setSyncStatus('paused', {
        message: 'Sync paused', threadCount: stats.threadCount, mediaBytes: stats.mediaBytes,
      });
      console.log('[archiver] Sync paused');
    } else if (e instanceof AuthError) {
      console.error('[archiver] Sync error:', e);
      await setSyncStatus('auth_error', { message: e.message });
    } else if (/THREADS_WEB_PAGE/.test(e.message)) {
      const until = await startBackoff();
      console.warn(`[archiver] ${e.message}. Backing off: no scheduled sync until ` +
        `${new Date(until).toISOString().slice(11, 16)} UTC`);
      await setSyncStatus('error', {
        message: `${shortError(e)}; retrying after ` +
          new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      });
    } else if (isCompatError(e)) {
      const n = await recordCompatFailure();
      console.error(`[archiver] Sync error (compatibility, ${n}/${COMPAT_PAUSE_AFTER}): ` + e.message);
      if (/BarcelonaSavedPageRefetchableQuery/.test(e.message)) {
        await diagnosePagination().catch(err =>
          console.warn('[archiver] Pagination diagnostic failed: ' + err.message));
      }
      if (/no saved posts for SAVED_VIEWER/.test(e.message)) {
        await describeSavedQuery().catch(err =>
          console.warn('[archiver] Saved-query diagnostic failed: ' + err.message));
      }
      if (n >= COMPAT_PAUSE_AFTER) {
        await chrome.storage.local.set({ [COMPAT_PAUSE_KEY]: Date.now() });
        console.warn(`[archiver] Scheduled syncs paused after ${n} compatibility failures in a row. ` +
          'They resume after an extension update, a successful "Sync now", or Resume.');
        await setSyncStatus('paused', { message: 'Threads changed; syncing paused until an update' });
      } else {
        await setSyncStatus('error', { message: shortError(e) });
      }
    } else {
      console.error('[archiver] Sync error: ' + e.message);
      await setSyncStatus('error', { message: shortError(e) });
    }
  } finally {
    clearInterval(keepAlive);
    if (run === _syncRun) {
      _pauseRequested = false;
      _syncing = false;
      await releaseThreadsTabs();
    }
  }
}

// ── bridge preparation (shared by full sync and single-thread refresh) ────────

/**
 * Find/open a Threads tab, inject the bridge, extract page tokens and dynamic
 * query params, and configure the API client. Throws AuthError if tokens
 * can't be read (not logged in / page not loaded).
 */
async function ensureBridgeReady() {
  const tabId = await findOrCreateThreadsTab();
  await waitForBridge(tabId);
  setBridgeTab(tabId);
  console.log(`[archiver] Bridge ready on tab ${tabId}`);

  const pageParams = await extractPageParams(tabId);
  console.log('[archiver] Page params: ' + JSON.stringify({
    lsd: pageParams.lsd ? pageParams.lsd.slice(0, 10) + '…' : '(empty)',
    fb_dtsg: pageParams.fb_dtsg ? 'found' : '(not found)',
    __rev: pageParams.__rev,
    dsUserId: pageParams.dsUserId,
  }));
  if (!pageParams.lsd) {
    throw new AuthError('Could not read auth tokens from Threads. Make sure the Threads tab is fully loaded and you are logged in.');
  }
  const dynQueries = pageParams.queries ?? {};
  console.log('[archiver] Dynamic query params: ' + JSON.stringify(
    Object.fromEntries(Object.entries(dynQueries).map(([k, v]) =>
      [k, v ? `${v.docId} (${Object.keys(v.providers ?? {}).length} providers, ${(v.args ?? []).length} declared args)` : '(fallback to snapshot)']))));

  setMetaParams({
    lsd:      pageParams.lsd,
    fb_dtsg:  pageParams.fb_dtsg,
    __hs:     pageParams.__hs,
    __rev:    pageParams.__rev,
    __s:      pageParams.__s,
    __hsi:    pageParams.__hsi,
    __dyn:    pageParams.__dyn,
    __csr:    pageParams.__csr,
    _dsUserId: pageParams.dsUserId,
    queries:   dynQueries,
  });
  return tabId;
}

// ── single-thread refresh (from reader UI) ─────────────────────────────────────

/**
 * Re-fetch one archived thread on demand: fresh detail (text, replies,
 * counts), then download any media the archive is missing using the fresh
 * CDN URLs. Preserves already-archived media (no re-download).
 */
async function refreshThread(code) {
  if (_syncing) throw new Error('A sync is already running — try again in a moment.');
  _syncing = true;
  console.log(`[archiver] Refreshing thread ${code}`);

  try {
    const thread = await getThread(code);
    if (!thread) throw new Error(`Thread "${code}" is not in the archive.`);

    await ensureBridgeReady();
    const updated = await refreshThreadCore(thread);

    console.log(`[archiver] Refreshed ${code} — ${updated.replies?.length ?? 0} replies, ${updated.mediaMissing ?? 0} media missing`);
    return { ok: true, mediaMissing: updated.mediaMissing ?? 0, replyCount: updated.replies?.length ?? 0 };
  } finally {
    _syncing = false;
    await releaseThreadsTabs();
  }
}

/**
 * Core of a single-thread refresh. Assumes the bridge is ready and the
 * _syncing lock is held by the caller.
 */
async function refreshThreadCore(thread) {
  const detail = await fetchThreadDetail(thread.pk || codeToPk(thread.code));
  if (!detail) throw new Error('Thread could not be fetched — it may have been deleted.');

  const now     = Date.now();
  const updated = { ...thread, lastCheckedAt: now };

  // Root post: refresh text + counts
  const rootPost = detail.containing_thread?.thread_items?.[0]?.post;
  if (rootPost) {
    updated.text       = rootPost.caption?.text ?? updated.text;
    updated.likeCount  = rootPost.like_count ?? updated.likeCount;
    updated.replyCount = rootPost.text_post_app_info?.direct_reply_count ?? updated.replyCount;
  }

  // Rebuild thread items + replies from detail (archived media refs are
  // preserved by enrichFromDetail's merge)
  enrichFromDetail(updated, detail);

  // Refresh avatar if it never archived / went missing
  if (!updated.profilePicId && rootPost?.user?.profile_pic_url) {
    const avatarId = `${updated.code}/avatar/0`;
    const buf = await downloadMedia(rootPost.user.profile_pic_url);
    if (buf) {
      await putMedia({
        id: avatarId, postCode: updated.code, role: 'avatar', index: 0,
        mimeType: guessMime(rootPost.user.profile_pic_url, 'image/jpeg'),
        data: buf, width: null, height: null, durationMs: null,
        originalUrl: rootPost.user.profile_pic_url, archivedAt: now,
      });
      updated.profilePicId = avatarId;
    }
  }

  // Download whatever's missing (skips refs that already have bytes)
  await archiveMediaList(updated, now);

  updated.lastActivityAt      = computeLastActivityAt(updated);
  updated.mediaRepairAttempts = updated.mediaMissing ? (thread.mediaRepairAttempts ?? 0) : 0;
  await putThread(updated);
  return updated;
}

// ── full refresh (all archived threads) ────────────────────────────────────────

/**
 * Re-fetch detail for EVERY archived thread: user icons (root, per-item,
 * per-reply), missing media, video posters, reply counts. Heavier than a
 * normal sync — one detail request per thread, throttled.
 */
const FULL_REFRESH_KEY = 'fullRefreshQueue';

/**
 * Resumable: the queue of remaining thread codes is persisted in
 * chrome.storage.local after every item. If the service worker dies mid-run
 * (browser quit, extension reload), maybeResumeFullRefresh() picks the queue
 * back up on worker startup or at the next sync alarm.
 */
async function runFullRefresh(resumeCodes = null) {
  if (_syncing) return;
  _syncing = true;
  console.log(`[archiver] Full refresh ${resumeCodes ? `resumed (${resumeCodes.length} remaining)` : 'started'}`);

  try {
    await setSyncStatus('syncing', { message: 'Full refresh: connecting…' });
    await ensureBridgeReady();

    let codes = resumeCodes;
    if (!codes) {
      codes = (await getAllThreads()).map(t => t.code);
      await chrome.storage.local.set({ [FULL_REFRESH_KEY]: codes });
    }

    const total = codes.length;
    let refreshed = 0, failed = 0;

    while (codes.length) {
      throwIfPaused(); // finish the current thread, then stop; queue is persisted
      const code = codes[0];
      await setSyncStatus('syncing', {
        message: `Full refresh: ${total - codes.length + 1} of ${total}…`,
      });
      try {
        const thread = await getThread(code);
        if (thread) await refreshThreadCore(thread);
        refreshed++;
      } catch (e) {
        if (e instanceof AuthError) throw e; // keep queue — resume after re-login
        failed++;
        console.warn(`[archiver] Full refresh failed for ${code}:`, e.message);
      }
      codes = codes.slice(1);
      await chrome.storage.local.set({ [FULL_REFRESH_KEY]: codes });
      // Throttle: don't hammer the GraphQL endpoint
      await new Promise(r => setTimeout(r, 400));
    }

    await chrome.storage.local.remove(FULL_REFRESH_KEY);

    const stats = await getStorageStats();
    await setSyncStatus('idle', {
      message:     `Full refresh complete — ${refreshed} refreshed${failed ? `, ${failed} failed` : ''}`,
      lastSync:    Date.now(),
      threadCount: stats.threadCount,
      mediaBytes:  stats.mediaBytes,
    });
    console.log(`[archiver] Full refresh complete — ${refreshed} ok, ${failed} failed`);

  } catch (e) {
    // Queue stays in storage.local so the run resumes at the next
    // startup/alarm rather than starting over.
    if (e instanceof SyncPaused) {
      await setPaused(true);
      const stats = await getStorageStats().catch(() => ({}));
      await setSyncStatus('paused', {
        message: 'Full refresh paused', threadCount: stats.threadCount, mediaBytes: stats.mediaBytes,
      });
      console.log('[archiver] Full refresh paused (queue kept)');
    } else {
      console.error('[archiver] Full refresh error (queue kept for resume):', e);
      await setSyncStatus(e instanceof AuthError ? 'auth_error' : 'error', { message: e.message });
    }
  } finally {
    clearInterval(keepAlive);
    if (run === _syncRun) {
      _pauseRequested = false;
      _syncing = false;
      await releaseThreadsTabs();
    }
  }
}

// ── import (runs in the worker so it survives popup close) ──────────────────────

/**
 * Import an exported archive (ZIP or legacy JSON) given its raw bytes.
 * Non-destructive merge: add new threads, update an existing one only if the
 * imported copy is newer, never regress local data; media is add-only by id.
 * Progress is reported via the shared status ('importing' + progress 0..1) so
 * the popup shows it and can reconnect after being closed. Returns a summary.
 */
const IMPORT_CACHE = 'ta-import';
// Cache API keys must be http(s) URLs (chrome-extension:// is rejected). This
// is just an identifier — nothing is ever fetched from it.
const IMPORT_KEY   = 'https://threads-archiver.local/import-payload';

async function runImport() {
  if (_syncing) throw new Error('A sync or refresh is running — pause or wait, then import.');
  _syncing = true;
  const before = await getSyncStatus();
  try {
    await setSyncStatus('importing', { message: 'Reading file…', progress: 0 });

    // Bytes were stashed in the Cache API by the popup.
    const cache = await caches.open(IMPORT_CACHE);
    const resp  = await cache.match(IMPORT_KEY);
    if (!resp) throw new Error('Import payload not found — please pick the file again.');
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // 'PK'

    let data, mediaBytesFor;
    if (isZip) {
      const entries  = await parseZip(bytes);
      const manifest = [...entries.keys()].find(k => k.endsWith('archive.json') && !k.startsWith('__MACOSX/'));
      if (!manifest) throw new Error('archive.json not found in zip.');
      const prefix = manifest.slice(0, -'archive.json'.length);
      data = JSON.parse(new TextDecoder().decode(entries.get(manifest)));
      mediaBytesFor = m => { const e = entries.get(prefix + m.file); return e ? e.slice().buffer : null; };
    } else {
      data = JSON.parse(new TextDecoder().decode(bytes));
      mediaBytesFor = m => (typeof m.data === 'string' ? b64ToBuf(m.data) : null);
    }

    if (data.format !== 'threads-archiver-export' || !Array.isArray(data.threads) || !Array.isArray(data.media)) {
      throw new Error('Not a Threads Archiver export.');
    }

    const activity = x => x?.lastActivityAt ?? x?.takenAt ?? 0;
    const totalThreads = data.threads.length, totalMedia = data.media.length;
    const totalWork = totalThreads + totalMedia || 1;
    let added = 0, updated = 0, unchanged = 0;

    for (let i = 0; i < data.threads.length; i++) {
      const thread = data.threads[i];
      if (!thread?.code) continue;
      const existing = await getThread(thread.code).catch(() => null);
      if (!existing) { await putThread(thread); added++; }
      else if (activity(thread) > activity(existing)) { await putThread(thread); updated++; }
      else unchanged++;
      if (i % 10 === 0) await setSyncStatus('importing', { message: `Importing threads… ${i + 1}/${totalThreads}`, progress: (i + 1) / totalWork });
    }

    const haveMedia = new Set(await getAllMediaIds().catch(() => []));
    let m = 0;
    for (let i = 0; i < data.media.length; i++) {
      const media = data.media[i];
      if (!media?.id || haveMedia.has(media.id)) continue;
      const b = mediaBytesFor(media);
      if (!b) continue;
      await putMedia({ ...media, file: undefined, data: b });
      m++;
      if (i % 15 === 0) await setSyncStatus('importing', { message: `Importing media… ${m}`, progress: (totalThreads + i + 1) / totalWork });
    }

    const parts = [];
    if (added)     parts.push(`${added} new`);
    if (updated)   parts.push(`${updated} updated`);
    if (unchanged) parts.push(`${unchanged} already present`);
    const summary = `Imported: ${parts.join(', ') || 'nothing new'} · ${m} media file${m === 1 ? '' : 's'} added`;

    const stats = await getStorageStats().catch(() => ({}));
    await setSyncStatus('idle', { lastSync: before.lastSync, threadCount: stats.threadCount, mediaBytes: stats.mediaBytes });
    console.log(`[archiver] ${summary}`);
    return { ok: true, summary, added, updated, unchanged, media: m };
  } catch (e) {
    await setSyncStatus('error', { message: `Import failed: ${e.message}` });
    throw e;
  } finally {
    _syncing = false;
    caches.open(IMPORT_CACHE).then(c => c.delete(IMPORT_KEY)).catch(() => {}); // free the payload
  }
}

// ── ZIP reader (STORE + DEFLATE), used by import ───────────────────────────────

function b64ToBuf(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Parse a ZIP → Map<name, Uint8Array>. STORE + DEFLATE; skips dirs + __MACOSX. */
async function parseZip(bytes) {
  const u16 = i => bytes[i] | (bytes[i + 1] << 8);
  const u32 = i => (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;

  let e = bytes.length - 22;
  while (e >= 0 && u32(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Not a valid zip file.');

  const count = u16(e + 10);
  let p = u32(e + 16);
  const dec = new TextDecoder();
  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (u32(p) !== 0x02014b50) throw new Error('Corrupt zip (bad central directory).');
    const method     = u16(p + 10);
    const csize      = u32(p + 20);
    const nameLen    = u16(p + 28);
    const extraLen   = u16(p + 30);
    const commentLen = u16(p + 32);
    const lho        = u32(p + 42);
    const name       = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/') || name.startsWith('__MACOSX/')) continue;
    const dataStart = lho + 30 + u16(lho + 26) + u16(lho + 28);
    const raw = bytes.subarray(dataStart, dataStart + csize);
    if (method === 0)      entries.set(name, raw);
    else if (method === 8) entries.set(name, await inflateRaw(raw));
    else throw new Error(`Zip entry "${name}" uses unsupported compression method ${method}.`);
  }
  return entries;
}

/** Resume an interrupted full refresh, if one is pending. Returns true if resumed. */
async function maybeResumeFullRefresh() {
  const { [FULL_REFRESH_KEY]: queue } = await chrome.storage.local.get(FULL_REFRESH_KEY);
  if (!queue?.length) return false;
  console.log(`[archiver] Resuming interrupted full refresh — ${queue.length} threads remaining`);
  runFullRefresh(queue);
  return true;
}

// ── archive a single post ──────────────────────────────────────────────────────

async function archivePost(rawNode) {
  // Normalize from saved-list data first (fast, no extra request)
  const partial = normalizePost(rawNode);
  if (!partial.code) return;

  const now = Date.now();
  partial.archivedAt    = now;
  partial.lastCheckedAt = now;

  // Try to fetch full thread detail (richer thread_items, replies, media URLs)
  // The detail query takes the numeric pk, not the shortcode.
  let fullData = null;
  try {
    fullData = await fetchThreadDetail(partial.pk || codeToPk(partial.code));
    if (fullData) {
      enrichFromDetail(partial, fullData);
      partial.detailFetched = true;
    }
  } catch (e) {
    // Detail fetch failing is non-fatal — we have saved-list data
    console.warn(`[archiver] Detail fetch failed for ${partial.code}:`, e.message);
  }

  // Archive avatar
  await archiveAvatar(partial, now);

  // Archive images + videos from all thread_items
  await archiveMediaList(partial, now);

  // Store thread (without transient URL fields to save space)
  partial.profilePicUrl  = undefined;
  partial.lastActivityAt = computeLastActivityAt(partial);
  await putThread(partial);
  console.log(`[archiver] Archived ${partial.code} (@${partial.username})`);
}

async function archiveAvatar(partial, now) {
  if (!partial.profilePicUrl) return;
  const avatarId = `${partial.code}/avatar/0`;
  const existing = await getMediaFromId(avatarId);
  if (existing) {
    partial.profilePicId = avatarId;
    return;
  }
  const buf = await downloadMedia(partial.profilePicUrl);
  if (buf) {
    await putMedia({
      id: avatarId, postCode: partial.code, role: 'avatar', index: 0,
      mimeType: guessMime(partial.profilePicUrl, 'image/jpeg'),
      data: buf, width: null, height: null, durationMs: null,
      originalUrl: partial.profilePicUrl, archivedAt: now,
    });
    partial.profilePicId = avatarId;
  }
}

/**
 * Archive a post from an already-fetched thread detail (used when archiving
 * a reply as its own thread — the detail's containing_thread IS the reply).
 */
async function archivePostFromDetail(detail, extra = {}) {
  const partial = normalizePost(detail.containing_thread);
  if (!partial.code) throw new Error('Post has no code — cannot archive.');

  const now = Date.now();
  partial.archivedAt    = now;
  partial.lastCheckedAt = now;
  Object.assign(partial, extra);

  enrichFromDetail(partial, detail);
  partial.detailFetched = true;

  await archiveAvatar(partial, now);
  await archiveMediaList(partial, now);

  partial.profilePicUrl  = undefined;
  partial.lastActivityAt = computeLastActivityAt(partial);
  await putThread(partial);
  console.log(`[archiver] Archived ${partial.code} (@${partial.username})${extra.sourceParent ? ` — from reply in ${extra.sourceParent}` : ''}`);
  return partial;
}

/**
 * Archive a reply (from the reader UI) as a first-class thread: fetch its own
 * thread detail — which includes ITS replies — and store it like any saved post.
 */
async function archiveReply({ pk, code: replyCode, parent }) {
  const existing = await getThread(replyCode);
  if (existing) return { ok: true, already: true, code: replyCode };

  if (_syncing) throw new Error('A sync is already running — try again in a moment.');
  _syncing = true;
  console.log(`[archiver] Archiving reply ${replyCode} (pk ${pk})`);

  try {
    await ensureBridgeReady();
    const detail = await fetchThreadDetail(pk || codeToPk(replyCode));
    if (!detail?.containing_thread) {
      throw new Error('Could not fetch this reply — it may have been deleted.');
    }
    const t = await archivePostFromDetail(detail, { sourceParent: parent ?? null });
    return { ok: true, code: t.code, replyCount: t.replies?.length ?? 0, mediaMissing: t.mediaMissing ?? 0 };
  } finally {
    _syncing = false;
    await releaseThreadsTabs();
  }
}

async function getMediaFromId(id) {
  try { return await getMedia(id); } catch { return null; }
}

/**
 * Merge richer detail-query data into the normalized partial object.
 *
 * Rebuilding threadItems/replies from detail produces fresh media refs with
 * transient CDN URLs and NO archivedId. When `partial` is an existing archived
 * thread (delta update / manual refresh), we must carry the archivedIds over,
 * otherwise already-stored media would be orphaned and re-downloaded.
 */
function enrichFromDetail(partial, detail) {
  const containing = detail?.containing_thread;
  if (!containing) return;

  const prevItems   = partial.threadItems ?? [];
  const prevReplies = new Map((partial.replies ?? []).map(r => [r.code, r]));

  const items = containing.thread_items ?? [];
  if (items.length) {
    partial.threadItems = items.map((item, i) => {
      const p    = item.post ?? {};
      const u    = p.user ?? {};
      const prev = prevItems[i];
      return {
        text:        p.caption?.text ?? '',
        code:        p.code ?? '',
        username:    u.username ?? '',
        displayName: u.full_name ?? u.username ?? '',
        avatarId:    prev?.avatarId ?? null,
        avatarUrl:   prev?.avatarId ? null : (u.profile_pic_url ?? null),
        images:      mergeArchivedRefs(extractImages(p), prev?.images),
        videos:      mergeArchivedRefs(extractVideos(p), prev?.videos),
      };
    });
  }

  // Reply threads
  const replyThreads = detail?.reply_threads ?? [];
  partial.replies = replyThreads.flatMap(rt =>
    (rt.thread_items ?? []).map(item => {
      const p = item.post ?? {};
      const u = p.user ?? {};
      const prev = prevReplies.get(p.code);
      return {
        pk:         p.pk ?? '',
        code:       p.code ?? '',
        username:   u.username ?? '',
        text:       p.caption?.text ?? '',
        takenAt:    p.taken_at ?? 0,
        likeCount:  p.like_count ?? 0,
        replyCount: p.text_post_app_info?.direct_reply_count ?? 0,
        avatarId:   prev?.avatarId ?? null,
        avatarUrl:  prev?.avatarId ? null : (u.profile_pic_url ?? null),
        images:     mergeArchivedRefs(extractImages(p), prev?.images),
        videos:     mergeArchivedRefs(extractVideos(p), prev?.videos),
      };
    })
  );

  // Update max reply pk cursor
  const allPks = partial.replies.map(r => BigInt(r.pk || '0'));
  if (allPks.length) {
    partial.maxReplyPk = allPks.reduce((a, b) => a > b ? a : b).toString();
  }
}

/**
 * Carry archivedId over from previously stored refs (matched by position)
 * onto freshly extracted refs. Refs with stored bytes drop their transient
 * URL; unarchived refs keep the fresh URL so a later pass can download it.
 */
function mergeArchivedRefs(freshRefs = [], oldRefs = []) {
  for (let i = 0; i < freshRefs.length; i++) {
    const old = oldRefs?.[i];
    if (old?.archivedId) {
      freshRefs[i].archivedId = old.archivedId;
      freshRefs[i].url = null;
      delete freshRefs[i].failed;
    }
    if (old?.posterId) {
      freshRefs[i].posterId  = old.posterId;
      freshRefs[i].posterUrl = null;
    }
  }
  return freshRefs;
}

/**
 * Download one media ref and store it. Mutates the ref:
 *  - success → { archivedId: id, failed: undefined }
 *  - failure → { failed: true } (archivedId cleared) so the repair pass can
 *    retry with a fresh CDN URL on a later sync.
 * The transient CDN URL is always zeroed out (they expire in 24–48h).
 */
async function archiveOneMedia(ref, { id, postCode, role, index, now, fallbackMime, durationMs = null }) {
  const buf = ref.url ? await downloadMedia(ref.url) : null;
  if (buf) {
    await putMedia({
      id, postCode, role, index,
      mimeType: guessMime(ref.url, fallbackMime),
      data: buf, width: ref.width ?? null, height: ref.height ?? null,
      durationMs, originalUrl: ref.url, archivedAt: now,
    });
    ref.archivedId = id;
    delete ref.failed;
  } else {
    ref.archivedId = null;
    ref.failed = true;
  }
  ref.url = null;
  return !!buf;
}

async function archiveMediaList(thread, now) {
  let imgIdx = 0, vidIdx = 0, itemIdx = 0;

  // Refs that already have archivedId (merged from a previous archive) are
  // skipped — their bytes are already stored.
  for (const item of thread.threadItems ?? []) {
    // Item author's avatar — only when it's a different author than the
    // thread's root user (saved reply → parent post context). Same-author
    // items fall back to the thread avatar in the reader.
    if (item.username && item.username !== thread.username) {
      await archiveItemAvatar(item, thread.code, itemIdx, now);
    } else {
      item.avatarUrl = null;
    }
    itemIdx++;
    for (const img of item.images ?? []) {
      if (!img.archivedId) {
        await archiveOneMedia(img, {
          id: `${thread.code}/image/${imgIdx}`, postCode: thread.code,
          role: 'image', index: imgIdx, now, fallbackMime: 'image/jpeg',
        });
      }
      imgIdx++;
    }

    for (const vid of item.videos ?? []) {
      if (!vid.archivedId) {
        await archiveOneMedia(vid, {
          id: `${thread.code}/video/${vidIdx}`, postCode: thread.code,
          role: 'video', index: vidIdx, now, fallbackMime: 'video/mp4',
          durationMs: vid.durationMs ?? null,
        });
      }
      await archivePoster(vid, thread.code, vidIdx, now);
      vidIdx++;
    }
  }

  // Also archive reply media + reply author avatars
  for (const reply of thread.replies ?? []) {
    await archiveReplyAvatar(reply, thread.code, now);
    let ri = 0;
    for (const img of reply.images ?? []) {
      if (!img.archivedId) {
        await archiveOneMedia(img, {
          id: `${thread.code}/reply-${reply.code}/image/${ri}`, postCode: thread.code,
          role: 'image', index: ri, now, fallbackMime: 'image/jpeg',
        });
      }
      ri++;
    }
  }

  thread.mediaMissing = countMissingMedia(thread);
}

/**
 * Archive a thread item's author avatar (role 'avatar', keyed per item).
 * Used when a saved reply's ancestor chain contains posts by other authors.
 * Cosmetic — not counted in mediaMissing.
 */
async function archiveItemAvatar(item, postCode, itemIdx, now) {
  if (item.avatarId) { item.avatarUrl = null; return; }
  if (!item.avatarUrl) return;
  const id  = `${postCode}/item-${itemIdx}/avatar/0`;
  const buf = await downloadMedia(item.avatarUrl);
  if (buf) {
    await putMedia({
      id, postCode, role: 'avatar', index: itemIdx,
      mimeType: guessMime(item.avatarUrl, 'image/jpeg'),
      data: buf, width: null, height: null, durationMs: null,
      originalUrl: item.avatarUrl, archivedAt: now,
    });
    item.avatarId = id;
  }
  item.avatarUrl = null;
}

/**
 * Archive a reply author's profile picture (role 'avatar', keyed per reply).
 * Cosmetic — not counted in mediaMissing.
 */
async function archiveReplyAvatar(reply, postCode, now) {
  if (reply.avatarId) { reply.avatarUrl = null; return; }
  if (!reply.avatarUrl || !reply.code) return;
  const id  = `${postCode}/reply-${reply.code}/avatar/0`;
  const buf = await downloadMedia(reply.avatarUrl);
  if (buf) {
    await putMedia({
      id, postCode, role: 'avatar', index: 0,
      mimeType: guessMime(reply.avatarUrl, 'image/jpeg'),
      data: buf, width: null, height: null, durationMs: null,
      originalUrl: reply.avatarUrl, archivedAt: now,
    });
    reply.avatarId = id;
  }
  reply.avatarUrl = null;
}

/**
 * Archive a video's poster frame (role 'thumbnail'). Cosmetic — not counted
 * in mediaMissing and never blocks the video itself.
 */
async function archivePoster(vid, postCode, vidIdx, now) {
  if (vid.posterId) { vid.posterUrl = null; return; }
  if (!vid.posterUrl) return;
  const id  = `${postCode}/thumb/${vidIdx}`;
  const buf = await downloadMedia(vid.posterUrl);
  if (buf) {
    await putMedia({
      id, postCode, role: 'thumbnail', index: vidIdx,
      mimeType: guessMime(vid.posterUrl, 'image/jpeg'),
      data: buf, width: vid.width ?? null, height: vid.height ?? null,
      durationMs: null, originalUrl: vid.posterUrl, archivedAt: now,
    });
    vid.posterId = id;
  }
  vid.posterUrl = null;
}

/** Count media refs that have no stored bytes (failed or never archived). */
function countMissingMedia(thread, existingIds = null) {
  let missing = 0;
  const refMissing = ref => {
    if (!ref.archivedId) return true;
    if (existingIds && !existingIds.has(ref.archivedId)) return true;
    return false;
  };
  for (const item of thread.threadItems ?? []) {
    for (const ref of [...(item.images ?? []), ...(item.videos ?? [])]) {
      if (refMissing(ref)) missing++;
    }
  }
  for (const reply of thread.replies ?? []) {
    for (const ref of reply.images ?? []) {
      if (refMissing(ref)) missing++;
    }
  }
  return missing;
}

// ── delta reply check ──────────────────────────────────────────────────────────

async function checkDeltas() {
  const threads = await getAllThreads();
  if (!threads.length) return;

  // Batch into groups to avoid huge requests
  for (let i = 0; i < threads.length; i += DELTA_BATCH_SIZE) {
    throwIfPaused();
    const batch = threads.slice(i, i + DELTA_BATCH_SIZE);
    const pks   = batch.map(t => t.pk).filter(Boolean);
    if (!pks.length) continue;

    let counts;
    try {
      counts = await fetchCounts(pks);
    } catch (e) {
      console.warn('[archiver] fetchCounts failed:', e.message);
      continue;
    }

    for (const thread of batch) {
      const c = counts[thread.pk];
      if (!c) continue;

      const hasNewReplies = c.replyCount > (thread.replyCount ?? 0);
      if (!hasNewReplies) {
        // Update like count only
        await putThread({ ...thread, likeCount: c.likeCount, lastCheckedAt: Date.now() });
        continue;
      }

      // New replies detected — re-fetch detail
      console.log(`[archiver] New replies on ${thread.code}: ${thread.replyCount} → ${c.replyCount}`);
      try {
        const detail = await fetchThreadDetail(thread.pk || codeToPk(thread.code));
        const updated = { ...thread, replyCount: c.replyCount, likeCount: c.likeCount, lastCheckedAt: Date.now() };
        if (detail) {
          enrichFromDetail(updated, detail);
          // Archive any new reply media
          await archiveNewReplyMedia(updated, thread, Date.now());
        }
        updated.lastActivityAt = computeLastActivityAt(updated);
        await putThread(updated);
      } catch (e) {
        console.warn(`[archiver] Delta detail fetch failed for ${thread.code}:`, e.message);
        // At minimum, update counts
        await putThread({ ...thread, replyCount: c.replyCount, likeCount: c.likeCount, lastCheckedAt: Date.now() });
      }
    }
  }
}

/**
 * Archive media only for replies that are new (pk > maxReplyPk checkpoint).
 */
async function archiveNewReplyMedia(updated, previous, now) {
  const prevMaxPk = BigInt(previous.maxReplyPk || '0');
  for (const reply of updated.replies ?? []) {
    await archiveReplyAvatar(reply, updated.code, now); // no-op if already stored
    if (!reply.pk || BigInt(reply.pk) <= prevMaxPk) continue;
    let ri = 0;
    for (const img of reply.images ?? []) {
      await archiveOneMedia(img, {
        id: `${updated.code}/reply-${reply.code}/image/${ri}`, postCode: updated.code,
        role: 'image', index: ri, now, fallbackMime: 'image/jpeg',
      });
      ri++;
    }
  }
  updated.mediaMissing = countMissingMedia(updated);
}

// ── media repair ───────────────────────────────────────────────────────────────

const MEDIA_REPAIR_MAX_ATTEMPTS = 5;

/**
 * Find threads with media refs that have no stored bytes (download failed at
 * archive time, or legacy records written before failure tracking). CDN URLs
 * expire in 24–48h, so the original URL is useless — re-fetch thread detail
 * to get fresh URLs and retry the downloads. Gives up per-thread after
 * MEDIA_REPAIR_MAX_ATTEMPTS consecutive unsuccessful passes (post deleted,
 * media removed, etc.) — the reader shows those as permanently unavailable.
 */
async function repairMissingMedia() {
  const threads = await getAllThreads();

  for (const thread of threads) {
    throwIfPaused();
    let media;
    try { media = await getMediaForPost(thread.code); } catch { continue; }
    const have = new Set(media.map(m => m.id));

    const avatarMissing = !!thread.profilePicId && !have.has(thread.profilePicId);
    const missing       = countMissingMedia(thread, have);

    if (!missing && !avatarMissing) {
      // Heal a stale counter if a previous pass fixed everything
      if (thread.mediaMissing) await putThread({ ...thread, mediaMissing: 0, mediaRepairAttempts: 0 });
      continue;
    }
    if ((thread.mediaRepairAttempts ?? 0) >= MEDIA_REPAIR_MAX_ATTEMPTS) continue;

    console.log(`[archiver] Repairing ${missing} missing media on ${thread.code} ` +
                `(attempt ${(thread.mediaRepairAttempts ?? 0) + 1}/${MEDIA_REPAIR_MAX_ATTEMPTS})`);

    let detail = null;
    try {
      detail = await fetchThreadDetail(thread.pk || codeToPk(thread.code));
    } catch (e) {
      if (e instanceof AuthError) throw e;
      console.warn(`[archiver] Repair detail fetch failed for ${thread.code}:`, e.message);
    }

    const updated = { ...thread };
    const now     = Date.now();

    if (detail) {
      // Fresh CDN URLs, matched to stored refs by position.
      const freshItems = (detail.containing_thread?.thread_items ?? []).map(it => {
        const p = it.post ?? {};
        return { images: extractImages(p), videos: extractVideos(p) };
      });
      const freshReplies = new Map();
      for (const rt of detail.reply_threads ?? []) {
        for (const it of rt.thread_items ?? []) {
          const p = it.post ?? {};
          if (p.code) freshReplies.set(p.code, { images: extractImages(p) });
        }
      }

      // Avatar — repair a dangling profilePicId, or one that never archived,
      // while we have fresh detail in hand anyway.
      const freshUser = detail.containing_thread?.thread_items?.[0]?.post?.user;
      if ((avatarMissing || !updated.profilePicId) && freshUser?.profile_pic_url) {
        const avatarId = `${updated.code}/avatar/0`;
        const buf = await downloadMedia(freshUser.profile_pic_url);
        if (buf) {
          await putMedia({
            id: avatarId, postCode: updated.code, role: 'avatar', index: 0,
            mimeType: guessMime(freshUser.profile_pic_url, 'image/jpeg'),
            data: buf, width: null, height: null, durationMs: null,
            originalUrl: freshUser.profile_pic_url, archivedAt: now,
          });
          updated.profilePicId = avatarId;
        }
      }

      // Thread-item media (same id-assignment traversal as archiveMediaList)
      let imgIdx = 0, vidIdx = 0;
      for (let i = 0; i < (updated.threadItems ?? []).length; i++) {
        const item  = updated.threadItems[i];
        const fresh = freshItems[i];

        for (let j = 0; j < (item.images ?? []).length; j++) {
          const ref = item.images[j];
          const id  = `${updated.code}/image/${imgIdx}`;
          if (!ref.archivedId || !have.has(id)) {
            const freshUrl = fresh?.images?.[j]?.url;
            if (freshUrl) {
              ref.url = freshUrl;
              await archiveOneMedia(ref, {
                id, postCode: updated.code, role: 'image', index: imgIdx,
                now, fallbackMime: 'image/jpeg',
              });
            } else {
              ref.archivedId = null;
              ref.failed = true;
            }
          }
          imgIdx++;
        }

        for (let j = 0; j < (item.videos ?? []).length; j++) {
          const ref      = item.videos[j];
          const id       = `${updated.code}/video/${vidIdx}`;
          const freshVid = fresh?.videos?.[j];
          if (!ref.archivedId || !have.has(id)) {
            if (freshVid?.url) {
              ref.url = freshVid.url;
              await archiveOneMedia(ref, {
                id, postCode: updated.code, role: 'video', index: vidIdx,
                now, fallbackMime: 'video/mp4',
                durationMs: freshVid.durationMs ?? ref.durationMs ?? null,
              });
            } else {
              ref.archivedId = null;
              ref.failed = true;
            }
          }
          // Poster frame (cosmetic): repair if missing and a fresh URL exists
          if (!ref.posterId && freshVid?.posterUrl) {
            ref.posterUrl = freshVid.posterUrl;
            await archivePoster(ref, updated.code, vidIdx, now);
          }
          vidIdx++;
        }
      }

      // Reply media (matched by reply code)
      for (const reply of updated.replies ?? []) {
        const fresh = freshReplies.get(reply.code);
        let ri = 0;
        for (const ref of reply.images ?? []) {
          const id = `${updated.code}/reply-${reply.code}/image/${ri}`;
          if (!ref.archivedId || !have.has(id)) {
            const freshUrl = fresh?.images?.[ri]?.url;
            if (freshUrl) {
              ref.url = freshUrl;
              await archiveOneMedia(ref, {
                id, postCode: updated.code, role: 'image', index: ri,
                now, fallbackMime: 'image/jpeg',
              });
            }
          }
          ri++;
        }
      }
    }

    // Recount against actual DB state and persist
    const mediaAfter = await getMediaForPost(updated.code).catch(() => []);
    const haveAfter  = new Set(mediaAfter.map(m => m.id));
    updated.mediaMissing        = countMissingMedia(updated, haveAfter);
    updated.mediaRepairAttempts = updated.mediaMissing ? (thread.mediaRepairAttempts ?? 0) + 1 : 0;
    await putThread(updated);

    if (updated.mediaMissing) {
      console.warn(`[archiver] ${updated.code}: ${updated.mediaMissing} media still missing after repair`);
    } else {
      console.log(`[archiver] ${updated.code}: media fully repaired`);
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * Latest activity on a thread (unix seconds): the newer of the root post's
 * timestamp and its newest archived reply. Drives "recently updated" sorting.
 */
function computeLastActivityAt(thread) {
  let latest = thread.takenAt ?? 0;
  for (const r of thread.replies ?? []) {
    if ((r.takenAt ?? 0) > latest) latest = r.takenAt;
  }
  return latest;
}

function guessMime(url, fallback) {
  if (!url) return fallback;
  const ext = url.split('?')[0].split('.').pop().toLowerCase();
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
           webp: 'image/webp', gif: 'image/gif',
           mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' }[ext] ?? fallback;
}

// extractImages / extractVideos are imported from shared/api.js — a video's
// image_versions2 is its poster frame, attached as videos[].posterUrl.

// ── pagination diagnostic (temporary) ─────────────────────────────────────────
// Our next-page query fails with a bare "execution error" even though its
// doc_id and variable names match the live page. To find the difference, let
// the /saved page paginate by itself, capture that request, and compare it with
// ours. Logs a single line; values that could be sensitive are summarised.

async function diagnosePagination() {
  const ours  = getLastRequest();
  const tabId = await findOrCreateThreadsTab();

  // Hidden tabs skip rendering, so the page's infinite-scroll observer never
  // fires there. Bring the tab to the front for the experiment, then put back
  // whatever was in front before.
  const tab = await chrome.tabs.get(tabId);
  const [prev] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  await chrome.tabs.update(tabId, { active: true });
  await new Promise(r => setTimeout(r, 1500));

  let captured;
  try {
    [{ result: captured } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      world:  'MAIN',
      args:   [ours?.name ?? 'BarcelonaSavedPageRefetchableQuery'],
      func:   async (wantName) => {
        // Capture every GraphQL request the page makes: field and header names
        // always, variables only for the query we care about.
        const captured = [];
        const headerNames = new WeakMap();
        const headerPairs = new WeakMap();   // values stay in the page; never returned
        const urlOf = new WeakMap();
        const parseBody = (body) => {
          try {
            const p = new URLSearchParams(
              (body instanceof FormData || body instanceof URLSearchParams || typeof body === 'string') ? body : '');
            const name = p.get('fb_api_req_friendly_name');
            if (!name) return null;
            let variables;
            if (name === wantName) { try { variables = JSON.parse(p.get('variables') || '{}'); } catch {} }
            return { name, docId: p.get('doc_id'), formKeys: [...p.keys()].sort(), variables };
          } catch { return null; }
        };
        const parseResponse = (text) => {
          try {
            const j = JSON.parse(String(text).replace(/^for \(;;\);/, ''));
            return { errors: (j.errors ?? []).slice(0, 2).map(e => e?.message ?? e),
                     errorCount: (j.errors ?? []).length,
                     dataKeys: Object.keys(j.data ?? {}) };
          } catch (e) { return { unparsable: String(e).slice(0, 80) }; }
        };
        const origSend = XMLHttpRequest.prototype.send;
        const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        const origFetch = window.fetch;
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url) {
          urlOf.set(this, { method, url: String(url) });
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
          const list = headerNames.get(this) ?? [];
          list.push(String(k).toLowerCase()); headerNames.set(this, list);
          const pairs = headerPairs.get(this) ?? [];
          pairs.push([String(k), String(v)]); headerPairs.set(this, pairs);
          return origSetHeader.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (body) {
          const req = parseBody(body);
          if (req) {
            const entry = { via: 'xhr', req, headers: (headerNames.get(this) ?? []).sort() };
            if (req.name === wantName) {
              const rawBody = (body instanceof FormData || body instanceof URLSearchParams)
                ? new URLSearchParams(body).toString() : String(body);
              entry._raw = { ...(urlOf.get(this) ?? { method: 'POST', url: '/graphql/query' }), body: rawBody,
                             headers: headerPairs.get(this) ?? [] };
            }
            captured.push(entry);
            this.addEventListener('load', () => { entry.status = this.status; entry.res = parseResponse(this.responseText); });
          }
          return origSend.apply(this, arguments);
        };
        window.fetch = async function (input, init) {
          const req = parseBody(init?.body);
          const res = await origFetch.apply(this, arguments);
          if (req) {
            const h = init?.headers instanceof Headers ? [...init.headers.keys()] : Object.keys(init?.headers ?? {});
            const entry = { via: 'fetch', req, headers: h.map(k => k.toLowerCase()).sort(), status: res.status };
            captured.push(entry);
            try { entry.res = parseResponse(await res.clone().text()); } catch {}
          }
          return res;
        };
        const scrollAll = () => {
          window.scrollTo(0, document.documentElement.scrollHeight);
          for (const el of document.querySelectorAll('*')) {
            if (el.scrollHeight > el.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
              el.scrollTop = el.scrollHeight;
            }
          }
        };
        try {
          for (let i = 0; i < 8 && !captured.some(c => c.req.name === wantName && c.res); i++) {
            scrollAll();
            await new Promise(r => setTimeout(r, 2500));
          }
        } finally {
          XMLHttpRequest.prototype.open = origOpen;
          XMLHttpRequest.prototype.send = origSend;
          XMLHttpRequest.prototype.setRequestHeader = origSetHeader;
          window.fetch = origFetch;
        }

        // Replay the page's own successful pagination request, changing one
        // thing at a time, to find which difference makes Threads refuse ours.
        const replays = [];
        const ok = captured.find(c => c.req.name === wantName && c._raw && c.status === 200 && !c.res?.errorCount);
        if (ok) {
          const OUR_HEADERS = ['accept', 'content-type', 'x-csrftoken', 'x-fb-friendly-name', 'x-fb-lsd', 'x-ig-app-id'];
          const send = (body, headers) => new Promise(resolve => {
            const x = new XMLHttpRequest();
            x.open(ok._raw.method, ok._raw.url);
            for (const [k, v] of headers) x.setRequestHeader(k, v);
            x.onload = () => resolve({ status: x.status, ...parseResponse(x.responseText) });
            x.onerror = () => resolve({ status: 'network error' });
            x.send(body);
          });
          const variants = {
            'A exact replay (control)':     p => p,
            'B page size 20':               p => { const v = JSON.parse(p.get('variables')); v.first = 20; p.set('variables', JSON.stringify(v)); return p; },
            'C without fb_dtsg + jazoest':  p => { p.delete('fb_dtsg'); p.delete('jazoest'); return p; },
            'D only our headers':           p => p,
          };
          for (const [label, mutate] of Object.entries(variants)) {
            const params = mutate(new URLSearchParams(ok._raw.body));
            const headers = label.startsWith('D')
              ? ok._raw.headers.filter(([k]) => OUR_HEADERS.includes(k.toLowerCase()))
              : ok._raw.headers;
            const r = await send(params.toString(), headers);
            replays.push({ variant: label, status: r.status, errorCount: r.errorCount ?? null,
                           error: r.errors?.[0] ?? r.unparsable ?? null });
            await new Promise(res => setTimeout(res, 800));   // don't hammer Threads
          }
        }
        for (const c of captured) delete c._raw;   // nothing with token values leaves the page
        return { visibility: document.visibilityState, captured: captured.slice(0, 12), replays };
      },
    });
  } finally {
    if (prev?.id && prev.id !== tabId) await chrome.tabs.update(prev.id, { active: true }).catch(() => {});
  }

  const list = captured?.captured ?? [];
  // Headers the bridge sends (content/bridge.js handleGQL), lower-cased.
  const OUR_HEADERS = ['accept', 'content-type', 'x-csrftoken', 'x-fb-friendly-name', 'x-fb-lsd', 'x-ig-app-id'];
  const ourForm = ours?.formKeys ?? [];
  const union = key => [...new Set(list.flatMap(c => key(c)))].sort();
  const summary = {
    tabVisibility: captured?.visibility,
    pageRequests: list.map(c => `${c.req.name} -> ${c.status ?? 'pending'}${c.res?.errorCount ? ` (${c.res.errorCount} errors)` : ''}`),
    formFieldsPageOnly: union(c => c.req.formKeys).filter(k => !ourForm.includes(k)),
    formFieldsOursOnly: ourForm.filter(k => !union(c => c.req.formKeys).includes(k)),
    headersPageOnly: union(c => c.headers ?? []).filter(h => !OUR_HEADERS.includes(h)),
  };
  // Cursors and long strings are summarised as length + short prefix.
  const show = v => (typeof v === 'string' && v.length > 24) ? `<${v.length} chars, ${v.slice(0, 6)}…>` : v;
  const theirs = list.find(c => c.req.name === ours?.name && c.req.variables);
  if (theirs) {
    const tv = theirs.req.variables, ov = ours?.variables ?? {};
    const differing = {};
    for (const k of new Set([...Object.keys(tv), ...Object.keys(ov)])) {
      if (JSON.stringify(tv[k]) !== JSON.stringify(ov[k])) differing[k] = { page: show(tv[k]), ours: show(ov[k]) };
    }
    summary.pagination = {
      pageRequestSucceeded: theirs.status === 200 && !theirs.res?.errorCount,
      response: theirs.res,
      sameDocId: theirs.req.docId === ours?.docId,
      variablesThatDiffer: differing,
    };
  } else {
    summary.pagination = 'page did not paginate during the experiment';
  }
  summary.replays = captured?.replays?.length ? captured.replays
    : 'no successful page pagination request to replay';
  console.log('[archiver] Page\'s own requests vs ours: ' + JSON.stringify(summary));
}

// ── saved-query diagnostic (temporary) ─────────────────────────────────────────
// The viewer query has answered "ok" with empty data since Oct 21, with no
// errors, while the /saved page still shows the list. A root field that is
// simply absent usually means it sits behind an @include/@skip condition, so
// log the live query's top levels and the values of any condition variables.

async function describeSavedQuery() {
  const tabId = await findOrCreateThreadsTab();
  const modules = [QUERY_DEFS.SAVED_VIEWER.module, QUERY_DEFS.SAVED_REFETCH.module];
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    world:  'MAIN',
    args:   [modules],
    func:   (modules) => {
      const out = {};
      for (const name of modules) {
        try {
          const mod = require(name);
          const req = mod?.default ?? mod;
          const conditions = new Set();
          const walk = (sels, depth) => (sels ?? []).map(sel => {
            const o = { kind: sel.kind };
            if (sel.name) o.name = sel.name;
            if (sel.condition) { o.if = sel.condition; o.passingValue = sel.passingValue; conditions.add(sel.condition); }
            if (sel.args?.length) o.args = sel.args.map(a => a.name);
            if (sel.selections) o.sel = depth < 2 ? walk(sel.selections, depth + 1) : `${sel.selections.length} more`;
            return o;
          });
          const root = walk(req.operation?.selections, 0);
          const provided = req.params?.providedVariables ?? {};
          const values = {};
          for (const c of conditions) {
            try { values[c] = typeof provided[c]?.get === 'function' ? provided[c].get() : (c in provided ? provided[c] : 'not provided'); }
            catch (e) { values[c] = 'get() threw: ' + String(e).slice(0, 60); }
          }
          out[req.params?.name ?? name] = { docId: req.params?.id, root, conditionValues: values };
        } catch (e) {
          out[name] = 'unavailable: ' + String(e).slice(0, 80);
        }
      }
      return out;
    },
  });
  console.log('[archiver] Saved-query shape: ' + JSON.stringify(result).slice(0, 3000));
}

// ── page param extraction (MAIN world) ────────────────────────────────────────

/**
 * Run in the page's MAIN world where Meta's require() is available.
 * Returns LSD token, haste session, client revision, and related params.
 *
 * Meta registers modules with __d("NAME", deps, factory) and exposes them
 * via the global require("NAME"). The LSD (Leak Session Data) token is what
 * acts as Meta's request-signing mechanism for internal GraphQL calls.
 */
async function extractPageParams(tabId) {
  // Map of query key → Relay module name, passed into the MAIN world so we
  // can pull fresh doc_ids + provider values straight from the page's own
  // Relay artifacts. Self-heals when Meta rotates doc_ids/providers.
  const queryModules = Object.fromEntries(
    Object.entries(QUERY_DEFS).map(([key, def]) => [key, def.module])
  );

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world:  'MAIN',
    args:   [queryModules],
    func:   (queryModules) => {
      function safeReq(name) {
        try { return (typeof require === 'function') ? require(name) : null; }
        catch { return null; }
      }
      function safeGet(fn, fb = '') {
        try { const v = fn(); return (v != null && v !== '') ? String(v) : fb; }
        catch { return fb; }
      }

      // Try Meta's module system first (most reliable).
      // Note: haste_session / hsi / client_revision all live in SiteData —
      // HasteSupportData only exposes { handle }.
      const lsdMod    = safeReq('LSD');
      const siteMod   = safeReq('SiteData');

      const lsd   = safeGet(() => lsdMod?.token);
      // The anti-forgery token the page sends with its own GraphQL requests.
      const fbDtsg = safeGet(() => safeReq('DTSGInitialData')?.token);
      const __hs  = safeGet(() => siteMod?.haste_session);
      const __hsi = safeGet(() => siteMod?.hsi);
      const __rev = safeGet(() => siteMod?.client_revision ?? siteMod?.clientRevision);
      const __s   = safeGet(() => siteMod?.pr ?? siteMod?.spin ?? siteMod?.s);

      // Fallback: parse from page HTML (script tag content)
      const html  = document.documentElement.innerHTML;
      const ex    = (re, fb = '') => { const m = html.match(re); return m?.[1] ?? fb; };

      const dsUserId = (document.cookie.match(/ds_user_id=([^;]+)/) ?? [])[1]
        || ex(/"ds_user_id":"(\d+)"/)
        || '';

      const csrfToken = (document.cookie.match(/csrftoken=([^;]+)/) ?? [])[1] ?? '';

      // Extract live doc_ids + provider variable values from Relay modules.
      // Only modules loaded on the current page resolve; missing ones fall
      // back to the snapshot in shared/api.js.
      const queries = {};
      for (const [key, modName] of Object.entries(queryModules)) {
        try {
          const mod = safeReq(modName);
          const req = mod?.default ?? mod;
          if (req?.params?.id) {
            const providers = {};
            for (const [pk, prov] of Object.entries(req.params.providedVariables ?? {})) {
              try {
                const v = (typeof prov?.get === 'function') ? prov.get() : prov;
                if (typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number') {
                  providers[pk] = v;
                }
              } catch {}
            }
            // The arguments the live query declares, so a mismatch with what we
            // send can be reported (Threads itself only says "execution error").
            // Provided variables (__relay_internal__pv__*) are listed here too.
            const defs = req.operation?.argumentDefinitions ?? req.fragment?.argumentDefinitions ?? [];
            const args = defs.map(a => ({ name: a.name, required: a.defaultValue == null }));
            queries[key] = { docId: String(req.params.id), name: req.params.name, providers, args };
          } else {
            queries[key] = null;
          }
        } catch { queries[key] = null; }
      }

      return {
        lsd:      lsd   || ex(/"LSD",\[\],\{"token":"([^"]+)"/),
        fb_dtsg:  fbDtsg || ex(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/),
        __hs:     __hs  || ex(/"haste_session":"([^"]+)"/),
        __rev:    __rev || ex(/"client_revision":(\d+)/),
        __s:      __s   || ex(/"session_id":"([^"]+)"/),
        __hsi:    __hsi || ex(/"hsi":"([^"]+)"/),
        __dyn:    ex(/"dynamic_js_bundle":"([^"]+)"/),
        __csr:    ex(/"client_sr_version":"([^"]+)"/),
        dsUserId,
        csrfToken,
        queries,
      };
    },
  });

  return results?.[0]?.result ?? {};
}

// ── bridge tab management ──────────────────────────────────────────────────────

/**
 * Find an existing logged-in Threads tab, or open one in the background.
 * Returns the tab ID once the page is fully loaded.
 */
async function findOrCreateThreadsTab() {
  // Only reuse a tab that is on /saved. That page is what loads the Relay
  // modules for the saved-posts queries; on any other Threads page (e.g. the
  // home feed) extractPageParams can't read live doc_ids and silently falls
  // back to the snapshot in shared/api.js, which breaks once Meta rotates them.
  const existing = await chrome.tabs.query({ url: 'https://*.threads.com/*' });
  const saved    = existing.filter(t => isSavedPage(t.url));
  const complete = saved.find(t => t.status === 'complete');
  if (complete) {
    console.log(`[archiver] Reusing existing /saved tab ${complete.id}`);
    return complete.id;
  }
  // Unloaded after the last sync (see releaseThreadsTabs): load it again.
  const unloaded = saved.find(t => t.discarded || t.status === 'unloaded');
  if (unloaded) {
    console.log(`[archiver] Loading the /saved tab ${unloaded.id}`);
    await chrome.tabs.reload(unloaded.id);
    return withTimeout(waitForTabLoad(unloaded.id), 60_000, 'Loading the Threads tab');
  }
  // A /saved tab is loading — wait for it
  if (saved.length) {
    const loading = saved[0];
    console.log(`[archiver] Waiting for loading /saved tab ${loading.id}`);
    return waitForTabLoad(loading.id);
  }
  // No /saved tab open — create one silently in the background.
  console.log(`[archiver] No /saved tab found (${existing.length} other Threads tab(s) open) — opening one`);
  const tab = await new Promise(resolve => {
    chrome.tabs.create({ url: 'https://www.threads.com/saved', active: false }, t => {
      // On failure Chrome sets lastError and passes null (e.g. an alarm fired
      // while no normal browser window is open — nowhere to host the tab).
      void chrome.runtime.lastError;
      resolve(t ?? null);
    });
  });
  if (!tab?.id) {
    throw new Error(
      'Could not open a Threads tab (no browser window available). ' +
      'Open threads.com in a tab, make sure you are logged in, then sync again.'
    );
  }
  return waitForTabLoad(tab.id);
}

function isSavedPage(url) {
  try { return new URL(url).pathname.replace(/\/+$/, '') === '/saved'; }
  catch { return false; }
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    const check = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(check);
        resolve(tabId);
      }
    };
    chrome.tabs.onUpdated.addListener(check);
    // Also resolve immediately if it's somehow already complete
    chrome.tabs.get(tabId, t => { if (t?.status === 'complete') { chrome.tabs.onUpdated.removeListener(check); resolve(tabId); } });
  });
}

/**
 * Ensure the bridge content script is running in the given tab.
 *
 * Content scripts declared in the manifest are only auto-injected into tabs
 * that open AFTER the extension is loaded. For already-open tabs we must
 * inject programmatically. The bridge script is idempotent (double-injection
 * is harmless because of the window.__threadsArchiverBridge guard).
 */
async function waitForBridge(tabId) {
  // First: try a ping — fast path for tabs where the script is already running.
  const alreadyReady = await ping(tabId);
  if (alreadyReady) return;

  // Inject the bridge script programmatically into the existing tab.
  console.log(`[archiver] Injecting bridge into tab ${tabId}`);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files:  ['content/bridge.js'],
    });
  } catch (e) {
    throw new Error(`Could not inject bridge into tab ${tabId}: ${e.message}`);
  }

  // Give the script a moment to register its listener, then confirm.
  await new Promise(r => setTimeout(r, 200));
  const ready = await ping(tabId);
  if (!ready) throw new Error('Bridge injected but did not respond. Is the tab logged into Threads?');
}

async function ping(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'BRIDGE_PING' });
    return res?.ok === true;
  } catch {
    return false;
  }
}
