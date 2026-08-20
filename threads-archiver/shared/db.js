/**
 * IndexedDB layer for Threads Archiver.
 *
 * Stores:
 *   threads  – thread metadata + post text + reply list
 *   media    – image / video / avatar bytes as ArrayBuffer
 */

const DB_NAME    = 'threads-archiver';
const DB_VERSION = 1;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = ({ target: { result: db } }) => {
      if (!db.objectStoreNames.contains('threads')) {
        const ts = db.createObjectStore('threads', { keyPath: 'code' });
        ts.createIndex('by_archived', 'archivedAt');
        ts.createIndex('by_taken',    'takenAt');
      }
      if (!db.objectStoreNames.contains('media')) {
        const ms = db.createObjectStore('media', { keyPath: 'id' });
        ms.createIndex('by_post', 'postCode');
      }
    };

    req.onsuccess  = ({ target: { result: db } }) => { _db = db; resolve(db); };
    req.onerror    = ({ target: { error } })       => reject(error);
  });
}

// ── generic helpers ────────────────────────────────────────────────────────────

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t   = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror    = ({ target: { error } }) => reject(error);
    if (req) req.onsuccess = ({ target: { result } }) => resolve(result);
  }));
}

// ── threads ────────────────────────────────────────────────────────────────────

/**
 * Thread shape:
 * {
 *   code:          string        — Threads post shortcode (URL key)
 *   pk:            string        — numeric post ID
 *   username:      string
 *   displayName:   string
 *   profilePicId:  string|null   — media id for archived avatar
 *   text:          string        — root post text
 *   takenAt:       number        — unix timestamp
 *   likeCount:     number
 *   replyCount:    number        — used for delta detection
 *   maxReplyPk:    string|null   — highest reply PK seen (delta cursor)
 *   threadItems:   PostItem[]    — native multi-part items (same author, composed together)
 *   replies:       Reply[]       — reply chain
 *   archivedAt:    number        — when we first archived it
 *   lastCheckedAt: number        — when we last polled for new replies
 *   detailFetched: boolean       — whether we have full thread_items + media
 * }
 */
export const putThread  = thread  => tx('threads', 'readwrite', s => s.put(thread));
export const getThread  = code    => tx('threads', 'readonly',  s => s.get(code));
export const delThread  = code    => tx('threads', 'readwrite', s => s.delete(code));

export function getAllThreads() {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t   = db.transaction('threads', 'readonly');
    const req = t.objectStore('threads').index('by_archived').openCursor(null, 'prev');
    const out = [];
    req.onsuccess = ({ target: { result: cursor } }) => {
      if (!cursor) { resolve(out); return; }
      out.push(cursor.value);
      cursor.continue();
    };
    req.onerror = ({ target: { error } }) => reject(error);
  }));
}

// ── media ─────────────────────────────────────────────────────────────────────

/**
 * Media shape:
 * {
 *   id:         string   — `${postCode}/${role}/${index}`
 *   postCode:   string
 *   role:       'avatar' | 'image' | 'video' | 'thumbnail'
 *   index:      number   — position within the post's media list
 *   mimeType:   string
 *   data:       ArrayBuffer
 *   width:      number | null
 *   height:     number | null
 *   durationMs: number | null   — video only
 *   originalUrl: string         — for reference / re-fetch
 *   archivedAt: number
 * }
 */
export const putMedia      = media     => tx('media', 'readwrite', s => s.put(media));
/** All media ids (keys only — no ArrayBuffers loaded). Cheap existence check. */
export const getAllMediaIds = ()       => tx('media', 'readonly',  s => s.getAllKeys());
export const getMedia      = id        => tx('media', 'readonly',  s => s.get(id));
export const delMedia      = id        => tx('media', 'readwrite', s => s.delete(id));

/**
 * Iterate all media records one at a time via cursor (avoids loading every
 * ArrayBuffer into memory at once). `cb` may be async; awaited per record.
 */
export function forEachMedia(cb) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t   = db.transaction('media', 'readonly');
    const req = t.objectStore('media').openCursor();
    const pending = [];
    req.onsuccess = ({ target: { result: cursor } }) => {
      if (!cursor) { Promise.all(pending).then(resolve, reject); return; }
      pending.push(Promise.resolve(cb(cursor.value)));
      cursor.continue();
    };
    req.onerror = ({ target: { error } }) => reject(error);
  }));
}

export function getMediaForPost(postCode) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t   = db.transaction('media', 'readonly');
    const req = t.objectStore('media').index('by_post').getAll(postCode);
    req.onsuccess = ({ target: { result } }) => resolve(result);
    req.onerror   = ({ target: { error } })  => reject(error);
  }));
}

export async function deleteThread(code) {
  const media = await getMediaForPost(code);
  await Promise.all(media.map(m => delMedia(m.id)));
  await delThread(code);
}

// ── stats ─────────────────────────────────────────────────────────────────────

export async function getStorageStats() {
  const threads = await getAllThreads();
  let mediaBytes = 0;
  await openDB().then(db => new Promise((resolve, reject) => {
    const t   = db.transaction('media', 'readonly');
    const req = t.objectStore('media').openCursor();
    req.onsuccess = ({ target: { result: cursor } }) => {
      if (!cursor) { resolve(); return; }
      mediaBytes += cursor.value.data?.byteLength ?? 0;
      cursor.continue();
    };
    req.onerror = ({ target: { error } }) => reject(error);
  }));
  return { threadCount: threads.length, mediaBytes };
}
