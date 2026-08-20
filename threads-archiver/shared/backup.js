/**
 * Archive backup: build a self-contained export ZIP, and hand an import file
 * to the background worker. Shared by the archive page's settings menu.
 *
 * Import runs in the service worker (survives the page/popup closing); the
 * file is handed off via the Cache API because runtime messages are
 * JSON-serialized and can't carry an ArrayBuffer. The file input that drives
 * import must live in a full tab (the popup closes when the OS file dialog
 * opens), which is why this is used from the archive page.
 */

import { getAllThreads, forEachMedia } from './db.js';

export const EXPORT_FORMAT = 'threads-archiver-export';

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

/**
 * Build the export ZIP. onProgress(msg) is called with status strings.
 * Returns { blob, filename, threadCount, mediaCount }.
 */
export async function buildExportZip(onProgress = () => {}) {
  const threads   = await getAllThreads();
  const enc       = new TextEncoder();
  const mediaMeta = [];
  const files     = [];

  let n = 0;
  await forEachMedia(m => {
    const file = `media/${m.id}.${extFor(m.mimeType)}`;
    mediaMeta.push({ ...m, data: undefined, file });
    files.push({ name: file, data: new Uint8Array(m.data ?? new ArrayBuffer(0)) });
    if (++n % 25 === 0) onProgress(`Exporting… ${n} media files`);
  });

  const manifest = JSON.stringify({
    format: EXPORT_FORMAT, version: 2, exportedAt: Date.now(), threads, media: mediaMeta,
  });

  onProgress('Building zip…');
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

  return {
    blob: makeZip(files),
    filename: `threads-archive-${new Date().toISOString().slice(0, 10)}.zip`,
    threadCount: threads.length,
    mediaCount: n,
  };
}

/**
 * Stash the chosen file for the worker and kick off IMPORT_ARCHIVE.
 * Resolves with the worker's result ({ ok, summary, ... }). Progress is
 * reported by the worker via the shared status ('importing') — poll GET_STATUS.
 */
export async function startImport(file) {
  const cache = await caches.open('ta-import');
  await cache.put('https://threads-archiver.local/import-payload', new Response(file));
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'IMPORT_ARCHIVE' }, r =>
      resolve(r ?? { ok: false, error: chrome.runtime.lastError?.message ?? 'No response from background worker.' }));
  });
}

// ── minimal ZIP writer (STORE method only, no dependencies) ────────────────────

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
export function makeZip(files) {
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
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);   // UTF-8 names
    lh.setUint16(8, 0, true);        // STORE
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, f.data.length, true);
    lh.setUint32(22, f.data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, f.data);
    central.push({ name, crc, size: f.data.length, offset });
    offset += 30 + name.length + f.data.length;
  }

  let cdSize = 0;
  for (const e of central) {
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, e.crc, true);
    cd.setUint32(20, e.size, true);
    cd.setUint32(24, e.size, true);
    cd.setUint16(28, e.name.length, true);
    cd.setUint32(42, e.offset, true);
    parts.push(cd.buffer, e.name);
    cdSize += 46 + e.name.length;
  }

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  parts.push(eocd.buffer);

  return new Blob(parts, { type: 'application/zip' });
}
