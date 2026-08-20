/**
 * Popup controller for Threads Archiver.
 * Connects to background/worker.js via chrome.runtime.sendMessage.
 */

import { getAllThreads, getMedia, getAllMediaIds, forEachMedia } from '../shared/db.js';

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

// ── export / import ────────────────────────────────────────────────────────────
// Export: a self-contained ZIP (STORE, no compression — media is already
// compressed) that anyone can extract and view locally:
//   archive.json    manifest v2 — threads + media metadata, media as file paths
//   data.js         same manifest as window.ARCHIVE_DATA (file:// viewers can't fetch)
//   index.html      standalone viewer (timeline + thread pages)
//   media/…         raw media files with real extensions
//   api/server.js   local REST API + Swagger (see api/README.md)
// Import: accepts these ZIPs, or legacy v1 .json exports (base64 media).

const EXPORT_FORMAT = 'threads-archiver-export';

const exportBtn  = document.getElementById('exportBtn');
const importBtn  = document.getElementById('importBtn');
const importFile = document.getElementById('importFile');

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
};
const extFor = mime => MIME_EXT[mime] ?? 'bin';

async function fetchPackaged(pathInExt) {
  const res = await fetch(chrome.runtime.getURL(pathInExt));
  if (!res.ok) throw new Error(`Missing packaged file: ${pathInExt}`);
  return res.text();
}

exportBtn.addEventListener('click', async () => {
  exportBtn.disabled = true;
  try {
    holdStatus('Exporting…', 60000);

    const threads   = await getAllThreads();
    const enc       = new TextEncoder();
    const mediaMeta = [];
    const files     = [];

    let n = 0;
    await forEachMedia(m => {
      const file = `media/${m.id}.${extFor(m.mimeType)}`;
      mediaMeta.push({ ...m, data: undefined, file });
      files.push({ name: file, data: new Uint8Array(m.data ?? new ArrayBuffer(0)) });
      if (++n % 25 === 0) statusText.textContent = `Exporting… ${n} media files`;
    });

    const manifest = JSON.stringify({
      format: EXPORT_FORMAT, version: 2, exportedAt: Date.now(),
      threads, media: mediaMeta,
    });

    statusText.textContent = 'Building zip…';
    const [viewerHtml, apiJs, apiReadme] = await Promise.all([
      fetchPackaged('export/viewer.html'),
      fetchPackaged('api/server.js'),
      fetchPackaged('api/README.md'),
    ]);
    const readme = [
      '# Threads Archive (exported)', '',
      `Exported ${new Date().toISOString()} — ${threads.length} threads, ${n} media files.`, '',
      '- **View**: open `index.html` in a browser.',
      '- **Crawl via API**: `node api/server.js .` then open http://localhost:8787/docs',
      '- `archive.json` is the machine-readable manifest; media paths are relative.', '',
    ].join('\n');

    files.unshift(
      { name: 'index.html',    data: enc.encode(viewerHtml) },
      { name: 'data.js',       data: enc.encode(`window.ARCHIVE_DATA = ${manifest};`) },
      { name: 'archive.json',  data: enc.encode(manifest) },
      { name: 'README.md',     data: enc.encode(readme) },
      { name: 'api/server.js', data: enc.encode(apiJs) },
      { name: 'api/README.md', data: enc.encode(apiReadme) },
    );

    const blob = makeZip(files);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `threads-archive-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    holdStatus(`Exported ${threads.length} threads, ${n} media files`);
  } catch (e) {
    holdStatus(`Export failed: ${e.message}`);
  } finally {
    exportBtn.disabled = false;
  }
});

importBtn.addEventListener('click', () => importFile.click());

importFile.addEventListener('change', async () => {
  const file = importFile.files?.[0];
  importFile.value = ''; // allow re-selecting the same file
  if (!file) return;

  importBtn.disabled = true;
  // Poll the worker's status for the live progress bar. The import runs in the
  // service worker, so it keeps going even if this popup is closed — reopening
  // reconnects to the same progress.
  const poll = setInterval(async () => applyStatus(await getStatus()), 500);
  try {
    statusText.textContent = 'Reading file…';
    // Hand the file to the worker via the Cache API — runtime messages are
    // JSON-serialized and can't carry the raw bytes.
    const cache = await caches.open('ta-import');
    await cache.put('https://threads-archiver.local/import-payload', new Response(file));
    const res = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'IMPORT_ARCHIVE' }, r =>
        resolve(r ?? { ok: false, error: chrome.runtime.lastError?.message ?? 'No response from background worker.' }));
    });
    clearInterval(poll);
    if (res.ok) { holdStatus(res.summary); await renderThreads(); }
    else holdStatus(`Import failed: ${res.error}`);
  } catch (e) {
    clearInterval(poll);
    holdStatus(`Import failed: ${e.message}`);
  } finally {
    importBtn.disabled = false;
  }
});

// ── minimal ZIP writer (STORE method only, no dependencies) — used by export ───

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: [{ name: string, data: Uint8Array }] → Blob (application/zip) */
function makeZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  const parts = [], central = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const crc  = crc32(f.data);
    const lh   = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);            // local file header sig
    lh.setUint16(4, 20, true);                    // version needed
    lh.setUint16(6, 0x0800, true);                // flags: UTF-8 names
    lh.setUint16(8, 0, true);                     // method: STORE
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, f.data.length, true);        // compressed size
    lh.setUint32(22, f.data.length, true);        // uncompressed size
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);                    // extra len
    parts.push(lh.buffer, name, f.data);
    central.push({ name, crc, size: f.data.length, offset });
    offset += 30 + name.length + f.data.length;
  }

  let cdSize = 0;
  for (const e of central) {
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);            // central dir sig
    cd.setUint16(4, 20, true);                    // version made by
    cd.setUint16(6, 20, true);                    // version needed
    cd.setUint16(8, 0x0800, true);                // flags
    cd.setUint16(10, 0, true);                    // method
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, e.crc, true);
    cd.setUint32(20, e.size, true);
    cd.setUint32(24, e.size, true);
    cd.setUint16(28, e.name.length, true);
    cd.setUint32(42, e.offset, true);             // local header offset
    parts.push(cd.buffer, e.name);
    cdSize += 46 + e.name.length;
  }

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);            // end of central dir sig
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  parts.push(eocd.buffer);

  return new Blob(parts, { type: 'application/zip' });
}
// (ZIP reading lives in the worker — import runs there so it survives popup close.)

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
