/**
 * Background service worker for Threads Archiver (MV3).
 *
 * Responsibilities:
 *  - Alarm-based sync (every 30 min by default)
 *  - Fetch saved posts list → detect new posts
 *  - Fetch thread detail + archive media for each new post
 *  - Delta-reply polling: cheaply detect new replies via reply_count
 *  - Store everything in IndexedDB via shared/db.js
 *  - Notify popup of sync status via chrome.storage.session
 */

import {
  setBridgeTab, setMetaParams, fetchAllSaved, fetchThreadDetail, fetchCounts,
  downloadMedia, normalizePost, AuthError, QUERY_DEFS, codeToPk,
  extractImages, extractVideos,
} from '../shared/api.js';

import {
  getThread, putThread, getAllThreads,
  putMedia, getMedia, getMediaForPost, getStorageStats, getAllMediaIds,
} from '../shared/db.js';

// ── constants ──────────────────────────────────────────────────────────────────

const ALARM_NAME        = 'threads-sync';
const ALARM_PERIOD_MIN  = 30;
const DELTA_BATCH_SIZE  = 50;   // max post IDs per reply-count request

// ── install / startup ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  scheduleAlarm();
  setSyncStatus('idle');
});

chrome.runtime.onStartup.addListener(async () => {
  scheduleAlarm();
  if (await isPaused()) return; // stay paused across restarts until user resumes
  maybeResumeFullRefresh(); // finish an interrupted full refresh
});

function scheduleAlarm() {
  chrome.alarms.get(ALARM_NAME, existing => {
    if (!existing) {
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

let _syncing = false;

async function runSync() {
  if (_syncing) return;
  _syncing = true;
  await setSyncStatus('syncing', { message: 'Starting sync…' });
  console.log('[archiver] Sync started');

  try {
    // ── 0. Find / open a Threads tab and wire up the content-script bridge ──
    await setSyncStatus('syncing', { message: 'Connecting to Threads…' });
    await ensureBridgeReady();

    // ── 1. Fetch saved list ─────────────────────────────────────────────────
    await setSyncStatus('syncing', { message: 'Fetching saved posts…' });

    const allEdges = [];
    await fetchAllSaved(async edges => { allEdges.push(...edges); });

    console.log(`[archiver] ${allEdges.length} saved edges fetched`);

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
      try {
        await archivePost(node);
      } catch (e) {
        if (e instanceof AuthError) throw e; // propagate auth errors
        console.warn('[archiver] Failed to archive post:', e.message);
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
    } else {
      console.error('[archiver] Sync error:', e);
      await setSyncStatus('error', { message: e.message });
    }
  } finally {
    _pauseRequested = false;
    _syncing = false;
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
  console.log('[archiver] Page params:', {
    lsd: pageParams.lsd ? pageParams.lsd.slice(0, 10) + '…' : '(empty)',
    __rev: pageParams.__rev,
    dsUserId: pageParams.dsUserId,
  });
  if (!pageParams.lsd) {
    throw new AuthError('Could not read auth tokens from Threads. Make sure the Threads tab is fully loaded and you are logged in.');
  }
  const dynQueries = pageParams.queries ?? {};
  console.log('[archiver] Dynamic query params:',
    Object.fromEntries(Object.entries(dynQueries).map(([k, v]) =>
      [k, v ? `${v.docId} (${Object.keys(v.providers ?? {}).length} providers)` : '(fallback to snapshot)'])));

  setMetaParams({
    lsd:      pageParams.lsd,
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
    _pauseRequested = false;
    _syncing = false;
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
            queries[key] = { docId: String(req.params.id), name: req.params.name, providers };
          } else {
            queries[key] = null;
          }
        } catch { queries[key] = null; }
      }

      return {
        lsd:      lsd   || ex(/"LSD",\[\],\{"token":"([^"]+)"/),
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
  // Prefer an already-complete Threads tab
  const existing = await chrome.tabs.query({ url: 'https://*.threads.com/*' });
  const complete  = existing.find(t => t.status === 'complete');
  if (complete) {
    console.log(`[archiver] Reusing existing tab ${complete.id}`);
    return complete.id;
  }
  // A tab is loading — wait for it
  if (existing.length) {
    const loading = existing[0];
    console.log(`[archiver] Waiting for loading tab ${loading.id}`);
    return waitForTabLoad(loading.id);
  }
  // No Threads tab open — create one silently in the background.
  // Open /saved specifically — that page loads the Relay modules for the
  // saved-posts queries, letting extractPageParams resolve them dynamically.
  console.log('[archiver] No Threads tab found — opening one');
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
