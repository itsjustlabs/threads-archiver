/**
 * Popup controller for Threads Archiver.
 * Connects to background/worker.js via chrome.runtime.sendMessage.
 */

import { getAllThreads, getMedia, getAllMediaIds } from '../shared/db.js';
import { BUILD } from '../shared/version.js';

const syncBtn     = document.getElementById('syncBtn');
const fullRefreshBtn = document.getElementById('fullRefreshBtn');
const pauseBtn    = document.getElementById('pauseBtn'); // used by applyStatus during init
const statusDot   = document.getElementById('statusDot');
const statusText  = document.getElementById('statusText');
const statsText   = document.getElementById('statsText');
const threadList  = document.getElementById('threadList');
const searchInput      = document.getElementById('searchInput');
const sortSelect       = document.getElementById('sortSelect');
const missingFilterBtn = document.getElementById('missingFilter');

// ── list state ─────────────────────────────────────────────────────────────────

let _query       = '';
let _sort        = 'newest';
let _onlyMissing = false;
let _holdStatusUntil = 0; // suppress the status poller while a transient msg shows

// ── init ───────────────────────────────────────────────────────────────────────

await refreshStatus();
await renderThreads();

setInterval(refreshStatus, 4000);

// ── search + sort controls ─────────────────────────────────────────────────────

let _searchDebounce = null;
searchInput.addEventListener('input', () => {
  clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(() => {
    _query = searchInput.value.trim().toLowerCase();
    renderThreads();
  }, 150);
});

sortSelect.addEventListener('change', () => {
  _sort = sortSelect.value;
  renderThreads();
});

missingFilterBtn.addEventListener('click', () => {
  _onlyMissing = !_onlyMissing;
  missingFilterBtn.classList.toggle('active', _onlyMissing);
  renderThreads();
});

// ── sync / full-refresh buttons ────────────────────────────────────────────────

function runWorkerJob(type) {
  syncBtn.disabled = fullRefreshBtn.disabled = true;

  chrome.runtime.sendMessage({ type }, async () => {
    await refreshStatus();
    await renderThreads();
    syncBtn.disabled = fullRefreshBtn.disabled = false;
  });

  // Poll status while the job runs (full refresh can take a while)
  const poll = setInterval(async () => {
    const s = await getStatus();
    applyStatus(s);
    if (s.state !== 'syncing') {
      clearInterval(poll);
      await renderThreads();
      syncBtn.disabled = fullRefreshBtn.disabled = false;
    }
  }, 1500);
}

syncBtn.addEventListener('click', () => runWorkerJob('SYNC_NOW'));
fullRefreshBtn.addEventListener('click', () => runWorkerJob('FULL_REFRESH'));

// Pause finishes the in-flight item then stops; resume continues the job.
pauseBtn.addEventListener('click', async () => {
  const s = await getStatus();
  if (s.state === 'paused') {
    holdStatus('Resuming…', 4000);
    runWorkerJob('RESUME_SYNC');
  } else if (s.state === 'syncing') {
    pauseBtn.disabled = true;
    pauseBtn.textContent = 'Pausing…';
    chrome.runtime.sendMessage({ type: 'PAUSE_SYNC' }, () => { pauseBtn.disabled = false; });
  }
});

document.getElementById('openArchiveBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('archive/archive.html') });
});

// ── status ─────────────────────────────────────────────────────────────────────

async function getStatus() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, s => resolve(s ?? { state: 'idle' }));
  });
}

async function refreshStatus() {
  const s = await getStatus();
  applyStatus(s);
}

// Export/import results are transient messages the periodic status poller
// would otherwise immediately overwrite. holdStatus() shows one and suppresses
// status updates to the text line until it expires.
function holdStatus(msg, ms = 10000) {
  statusText.textContent = msg;
  statusText.title = msg;
  _holdStatusUntil = Date.now() + ms;
}

function applyStatus(s) {
  statusDot.className = `status-dot ${s.state ?? 'idle'}`;

  // Pause button: "Pause" while syncing, "Resume" while paused, hidden otherwise
  if (s.state === 'syncing') {
    pauseBtn.style.display = ''; pauseBtn.textContent = 'Pause'; pauseBtn.disabled = false;
  } else if (s.state === 'paused') {
    pauseBtn.style.display = ''; pauseBtn.textContent = 'Resume'; pauseBtn.disabled = false;
  } else {
    pauseBtn.style.display = 'none';
  }

  // Import progress bar (shown only during a background import)
  const bar = document.getElementById('progressBar');
  if (bar) {
    if (s.state === 'importing') {
      bar.style.display = 'block';
      bar.querySelector('.progress-fill').style.width = `${Math.round((s.progress ?? 0) * 100)}%`;
    } else {
      bar.style.display = 'none';
    }
  }

  if (Date.now() < _holdStatusUntil) return; // keep a transient message visible
  switch (s.state) {
    case 'syncing':    statusText.textContent = s.message ?? 'Syncing…'; break;
    case 'importing':  statusText.textContent = s.message ?? 'Importing…'; break;
    case 'paused':     statusText.textContent = '⏸ ' + (s.message ?? 'Paused'); break;
    case 'auth_error': statusText.textContent = '⚠ Not logged in to Threads'; break;
    case 'error':      statusText.textContent = `Error: ${s.message ?? 'unknown'}`; break;
    default:
      if (s.lastSync) {
        statusText.textContent = `Last sync: ${relativeTime(s.lastSync)}`;
      } else {
        statusText.textContent = 'Not synced yet';
      }
  }
  statusText.title = statusText.textContent;   // full text on hover
  if (s.threadCount != null) {
    statsText.textContent = `${s.threadCount} archived · ${formatBytes(s.mediaBytes ?? 0)}`;
  }
}

// ── thread list ────────────────────────────────────────────────────────────────

async function renderThreads() {
  const all = await getAllThreads();

  // Compute missing-media counts against actual stored media (keys only —
  // catches legacy records whose refs claim archivedId but have no bytes,
  // without waiting for a sync to update the stored counter).
  const mediaIds = new Set(await getAllMediaIds().catch(() => []));
  for (const t of all) t._missing = countMissingMedia(t, mediaIds);

  let threads = filterThreads(all, _query);
  if (_onlyMissing) threads = threads.filter(t => t._missing > 0);
  threads = sortThreads(threads, _sort);

  // Update the filter button with a live count
  const totalMissing = all.filter(t => t._missing > 0).length;
  missingFilterBtn.textContent = totalMissing ? `⚠ ${totalMissing}` : '⚠';
  missingFilterBtn.style.display = (totalMissing || _onlyMissing) ? '' : 'none';

  threadList.innerHTML = '';

  if (!threads.length && all.length) {
    const note = document.createElement('div');
    note.className = 'list-empty-note';
    note.textContent = _onlyMissing && !_query
      ? 'No threads with missing media.'
      : `No threads match “${searchInput.value.trim()}”.`;
    threadList.appendChild(note);
    return;
  }

  for (const t of threads) {
    const el = await buildThreadItem(t);
    threadList.appendChild(el);
  }
}

/** Media refs with no stored bytes, verified against the media store's keys. */
function countMissingMedia(t, mediaIds) {
  let n = 0;
  const missing = r => !r.archivedId || !mediaIds.has(r.archivedId);
  for (const item of t.threadItems ?? []) {
    for (const r of [...(item.images ?? []), ...(item.videos ?? [])]) {
      if (missing(r)) n++;
    }
  }
  for (const reply of t.replies ?? []) {
    for (const r of reply.images ?? []) {
      if (missing(r)) n++;
    }
  }
  return n;
}

function filterThreads(threads, query) {
  if (!query) return threads;
  return threads.filter(t => {
    const haystack = [
      t.text, t.username, t.displayName,
      ...(t.threadItems ?? []).map(i => i.text),
      ...(t.replies ?? []).flatMap(r => [r.text, r.username]),
    ].filter(Boolean).join('\n').toLowerCase();
    return haystack.includes(query);
  });
}

/**
 * lastActivityAt is written by the sync worker; for threads archived before
 * that field existed, fall back to computing it from archived replies.
 */
function lastActivity(t) {
  if (t.lastActivityAt) return t.lastActivityAt;
  let latest = t.takenAt ?? 0;
  for (const r of t.replies ?? []) {
    if ((r.takenAt ?? 0) > latest) latest = r.takenAt;
  }
  return latest;
}

function sortThreads(threads, sort) {
  const s = [...threads];
  switch (sort) {
    case 'oldest':   return s.sort((a, b) => (a.takenAt ?? 0) - (b.takenAt ?? 0));
    case 'updated':  return s.sort((a, b) => lastActivity(b) - lastActivity(a));
    case 'archived': return s.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
    case 'newest':
    default:         return s.sort((a, b) => (b.takenAt ?? 0) - (a.takenAt ?? 0));
  }
}

async function buildThreadItem(thread) {
  const a = document.createElement('a');
  a.className = 'thread-item';
  a.href = '#';
  a.dataset.code = thread.code;

  // Avatar
  let avatarEl;
  if (thread.profilePicId) {
    const m = await getMedia(thread.profilePicId).catch(() => null);
    if (m?.data) {
      const blob = new Blob([m.data], { type: m.mimeType ?? 'image/jpeg' });
      const url  = URL.createObjectURL(blob);
      avatarEl = document.createElement('img');
      avatarEl.className = 'avatar';
      avatarEl.src = url;
      avatarEl.alt = thread.username;
      // Revoke after render to free memory
      avatarEl.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    }
  }
  if (!avatarEl) {
    avatarEl = document.createElement('div');
    avatarEl.className = 'avatar-placeholder';
    avatarEl.textContent = (thread.displayName || thread.username || '?')[0].toUpperCase();
  }

  const body = document.createElement('div');
  body.className = 'thread-body';

  const meta = document.createElement('div');
  meta.className = 'thread-meta';

  const name = document.createElement('span');
  name.className = 'thread-name';
  name.textContent = thread.displayName || thread.username;

  const handle = document.createElement('span');
  handle.className = 'thread-handle';
  handle.textContent = `@${thread.username}`;

  const date = document.createElement('span');
  date.className = 'thread-date';
  // When sorting by activity, show when the thread last had activity instead
  date.textContent = _sort === 'updated'
    ? relativeTime(lastActivity(thread) * 1000)
    : relativeTime(thread.takenAt * 1000);

  meta.append(name, handle, date);

  const text = document.createElement('div');
  text.className = 'thread-text';
  text.textContent = thread.text || '(no text)';

  const stats = document.createElement('div');
  stats.className = 'thread-stats';

  const parts = [`♥ ${thread.likeCount ?? 0}`];
  if ((thread.replyCount ?? 0) > 0) parts.push(`💬 ${thread.replyCount}`);
  if ((thread.replies?.length ?? 0) > 0) parts.push(`${thread.replies.length} ${thread.replies.length === 1 ? 'reply' : 'replies'} archived`);
  if (thread.sourceParent) parts.push('↳ from a reply');
  stats.textContent = parts.join('  ');

  const missing = thread._missing ?? thread.mediaMissing ?? 0;
  if (missing > 0) {
    a.classList.add('has-missing');
    const warn = document.createElement('span');
    warn.className = 'media-warning';
    warn.textContent = `⚠ ${missing} media missing`;
    warn.title = (thread.mediaRepairAttempts ?? 0) >= 5
      ? 'Media could not be recovered — source appears to be gone'
      : 'Media expired before archiving — will retry on next sync';
    stats.appendChild(warn);
  }

  body.append(meta, text, stats);
  a.append(avatarEl, body);

  a.addEventListener('click', e => {
    e.preventDefault();
    openReader(thread.code);
  });

  return a;
}

function openReader(code) {
  const url = chrome.runtime.getURL(`reader/reader.html?code=${encodeURIComponent(code)}`);
  chrome.tabs.create({ url });
}

// ── backup & settings ──────────────────────────────────────────────────────────
// Export/import (which needs a file picker) live on the full-tab archive page:
// the popup closes when the OS file dialog opens, which would cancel an import.

document.getElementById('openSettingsBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('archive/archive.html#settings') });
});

// Build/version line
try {
  const versionEl = document.getElementById('versionLine');
  if (versionEl) versionEl.textContent = `v${BUILD.version} · ${BUILD.commit}`;
} catch { /* no-op */ }

// ── utilities ──────────────────────────────────────────────────────────────────

function relativeTime(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60)           return 'just now';
  if (s < 3600)         return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)        return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7)   return `${Math.floor(s / 86400)}d ago`;
  if (s < 86400 * 30)  return `${Math.floor(s / (86400 * 7))}w ago`;
  return new Date(ms).toLocaleDateString();
}

function formatBytes(b) {
  if (b < 1024)        return `${b} B`;
  if (b < 1048576)     return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824)  return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}
