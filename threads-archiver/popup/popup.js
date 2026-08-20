/**
 * Popup controller for Threads Archiver.
 * Connects to background/worker.js via chrome.runtime.sendMessage.
 */

import { getAllThreads, getMedia, getAllMediaIds, forEachMedia, putThread, putMedia } from '../shared/db.js';

const syncBtn     = document.getElementById('syncBtn');
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

const fullRefreshBtn = document.getElementById('fullRefreshBtn');

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

function applyStatus(s) {
  statusDot.className = `status-dot ${s.state ?? 'idle'}`;
  switch (s.state) {
    case 'syncing':    statusText.textContent = s.message ?? 'Syncing…'; break;
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
  if ((thread.replies?.length ?? 0) > 0) parts.push(`${thread.replies.length} reply${thread.replies.length > 1 ? 's' : ''} archived`);
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
  const prevStatus = statusText.textContent;
  try {
    statusText.textContent = 'Exporting…';

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

    statusText.textContent = `Exported ${threads.length} threads, ${n} media files`;
  } catch (e) {
    statusText.textContent = `Export failed: ${e.message}`;
  } finally {
    exportBtn.disabled = false;
    setTimeout(() => { statusText.textContent = prevStatus; }, 6000);
  }
});

importBtn.addEventListener('click', () => importFile.click());

importFile.addEventListener('change', async () => {
  const file = importFile.files?.[0];
  importFile.value = ''; // allow re-selecting the same file
  if (!file) return;

  importBtn.disabled = true;
  try {
    statusText.textContent = 'Reading file…';
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // 'PK'

    let data, mediaBytesFor;
    if (isZip) {
      const entries  = parseZip(bytes);
      const manifest = [...entries.keys()].find(k => k.endsWith('archive.json'));
      if (!manifest) throw new Error('archive.json not found in zip.');
      const prefix = manifest.slice(0, -'archive.json'.length);
      data = JSON.parse(new TextDecoder().decode(entries.get(manifest)));
      mediaBytesFor = m => {
        const e = entries.get(prefix + m.file);
        return e ? e.slice().buffer : null; // slice → standalone ArrayBuffer
      };
    } else {
      data = JSON.parse(new TextDecoder().decode(bytes));
      mediaBytesFor = m => (typeof m.data === 'string' ? b64ToBuf(m.data) : null);
    }

    if (data.format !== EXPORT_FORMAT || !Array.isArray(data.threads) || !Array.isArray(data.media)) {
      throw new Error('Not a Threads Archiver export.');
    }

    let t = 0;
    for (const thread of data.threads) {
      if (!thread?.code) continue;
      await putThread(thread);
      t++;
      if (t % 20 === 0) statusText.textContent = `Importing threads… ${t}/${data.threads.length}`;
    }

    let m = 0;
    for (const media of data.media) {
      if (!media?.id) continue;
      const buf = mediaBytesFor(media);
      if (!buf) continue;
      await putMedia({ ...media, file: undefined, data: buf });
      m++;
      if (m % 25 === 0) statusText.textContent = `Importing media… ${m}/${data.media.length}`;
    }

    statusText.textContent = `Imported ${t} threads, ${m} media files`;
    await renderThreads();
    await refreshStatus();
  } catch (e) {
    statusText.textContent = `Import failed: ${e.message}`;
  } finally {
    importBtn.disabled = false;
  }
});

function b64ToBuf(b64) {
  const bin   = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// ── minimal ZIP writer / reader (STORE method only, no dependencies) ───────────

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

/** Parse a ZIP made by makeZip (or any STORE-only zip) → Map<name, Uint8Array>. */
function parseZip(bytes) {
  const u16 = i => bytes[i] | (bytes[i + 1] << 8);
  const u32 = i => (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;

  // Find end-of-central-directory record (scan back past any zip comment)
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
    if (method !== 0) {
      throw new Error('Zip uses compression — only Threads Archiver exports (uncompressed) are supported.');
    }
    const dataStart = lho + 30 + u16(lho + 26) + u16(lho + 28);
    entries.set(name, bytes.subarray(dataStart, dataStart + csize));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

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
