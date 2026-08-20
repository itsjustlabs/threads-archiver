/**
 * Regenerates the README screenshots with fictional demo data.
 *
 * Loads the extension into headless Chromium via Playwright, seeds the
 * extension's IndexedDB with demo threads (canvas-generated images/avatars —
 * no real archive content), and captures the timeline, reader, and popup.
 *
 * Usage:
 *   npm i playwright && npx playwright install chromium
 *   node docs/screenshots/generate.mjs
 *
 * Env overrides: EXT_PATH (extension dir), OUT_DIR (output dir).
 * Note: uses a throwaway Chromium profile — never touches your real archive.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT  = process.env.EXT_PATH ?? path.resolve(HERE, '../../threads-archiver');
const OUT  = process.env.OUT_DIR  ?? HERE;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-shots-'));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1180, height: 860 },
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

// Find the extension id from its MV3 service worker
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
console.log('extension id:', extId);

const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/archive/archive.html`);

// ── seed demo data (threads + canvas-generated media) ──────────────────────────
await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('threads-archiver', 1);
    r.onupgradeneeded = ({ target: { result: d } }) => {
      const ts = d.createObjectStore('threads', { keyPath: 'code' });
      ts.createIndex('by_archived', 'archivedAt');
      ts.createIndex('by_taken', 'takenAt');
      d.createObjectStore('media', { keyPath: 'id' }).createIndex('by_post', 'postCode');
    };
    r.onsuccess = e => res(e.target.result);
    r.onerror = e => rej(e.target.error);
  });
  const put = (store, val) => new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).put(val);
    t.oncomplete = res; t.onerror = e => rej(e.target.error);
  });

  async function makeImage(w, h, c1, c2, kind) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, w, h);
    gr.addColorStop(0, c1); gr.addColorStop(1, c2);
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    if (kind === 'chart') {
      g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 6; g.beginPath();
      const pts = [[.06,.75],[.22,.55],[.38,.62],[.54,.35],[.7,.42],[.86,.18]];
      pts.forEach(([x,y],i)=> i ? g.lineTo(x*w,y*h) : g.moveTo(x*w,y*h)); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.9)';
      pts.forEach(([x,y])=>{ g.beginPath(); g.arc(x*w,y*h,9,0,7); g.fill(); });
    } else if (kind === 'grid') {
      g.fillStyle = 'rgba(255,255,255,.16)';
      for (let i=0;i<5;i++) for (let j=0;j<3;j++) {
        g.beginPath(); g.roundRect(w*.08+i*w*.18, h*.14+j*h*.29, w*.14, h*.22, 14); g.fill();
      }
    } else if (kind === 'rings') {
      for (let i=5;i>0;i--){ g.beginPath(); g.arc(w/2,h/2,i*Math.min(w,h)*.09,0,7);
        g.strokeStyle=`rgba(255,255,255,${.12+i*.08})`; g.lineWidth=10; g.stroke(); }
    }
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    return blob.arrayBuffer();
  }
  async function makeAvatar(letter, bg) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = bg; g.beginPath(); g.arc(64,64,64,0,7); g.fill();
    g.fillStyle = '#fff'; g.font = '700 64px -apple-system, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(letter, 64, 70);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    return blob.arrayBuffer();
  }
  const media = async (id, postCode, role, buf) =>
    put('media', { id, postCode, role, index: 0, mimeType: 'image/png', data: buf,
                   width: null, height: null, durationMs: null, originalUrl: null, archivedAt: Date.now() });

  const NOW = 1787100000; // ≈ 2026-08-14, unix seconds

  // Thread 1 — multi-part with images + replies
  await media('DEMOAA/avatar/0', 'DEMOAA', 'avatar', await makeAvatar('A', '#7c5cff'));
  await media('DEMOAA/image/0',  'DEMOAA', 'image',  await makeImage(1000, 700, '#1b2a4a', '#7c5cff', 'chart'));
  await media('DEMOAA/image/1',  'DEMOAA', 'image',  await makeImage(1000, 700, '#0f3d3e', '#37c978', 'grid'));
  await media('DEMOAA/reply-DEMOR1/avatar/0', 'DEMOAA', 'avatar', await makeAvatar('M', '#e06d3d'));
  await media('DEMOAA/reply-DEMOR2/avatar/0', 'DEMOAA', 'avatar', await makeAvatar('S', '#2a9d8f'));
  await put('threads', {
    code: 'DEMOAA', pk: '1', username: 'ada_builds', displayName: 'Ada 🛠',
    text: 'Shipped a local-first archiver this weekend — everything lives in IndexedDB, media included. No servers, no accounts.\n\nThread on what I learned 👇 #localfirst #buildinpublic',
    takenAt: NOW - 86400 * 2, archivedAt: (NOW - 86400 * 2 + 1800) * 1000,
    lastActivityAt: NOW - 3600 * 5, likeCount: 412, replyCount: 38,
    profilePicId: 'DEMOAA/avatar/0', mediaMissing: 0, detailFetched: true, maxReplyPk: '99',
    threadItems: [
      { text: 'Shipped a local-first archiver this weekend — everything lives in IndexedDB, media included. No servers, no accounts.\n\nThread on what I learned 👇 #localfirst #buildinpublic',
        code: 'DEMOAA', username: 'ada_builds', displayName: 'Ada 🛠', avatarId: null,
        images: [{ archivedId: 'DEMOAA/image/0', width: 1000, height: 700 }], videos: [] },
      { text: 'Biggest surprise: CDN URLs expire in ~48h, so you archive the bytes or you lose them. Retry-with-fresh-URLs turned out to be essential.',
        code: 'DEMOAB', username: 'ada_builds', displayName: 'Ada 🛠', avatarId: null,
        images: [{ archivedId: 'DEMOAA/image/1', width: 1000, height: 700 }], videos: [] },
    ],
    replies: [
      { pk: '11', code: 'DEMOR1', username: 'marco.dev', text: 'This is great — does delta sync re-fetch the whole thread or just new replies?', takenAt: NOW - 86400, likeCount: 21, replyCount: 4, avatarId: 'DEMOAA/reply-DEMOR1/avatar/0', images: [], videos: [] },
      { pk: '12', code: 'DEMOR2', username: 'sam_codes', text: 'IndexedDB for media bytes is underrated. unlimitedStorage + ArrayBuffers just works.', takenAt: NOW - 3600 * 5, likeCount: 9, replyCount: 1, avatarId: 'DEMOAA/reply-DEMOR2/avatar/0', images: [], videos: [] },
    ],
  });

  // Thread 2 — image post, same month
  await media('DEMOBB/avatar/0', 'DEMOBB', 'avatar', await makeAvatar('N', '#2a9d8f'));
  await media('DEMOBB/image/0',  'DEMOBB', 'image',  await makeImage(1000, 700, '#3a2450', '#d94f70', 'rings'));
  await put('threads', {
    code: 'DEMOBB', pk: '2', username: 'norm.designs', displayName: 'Norm',
    text: 'Dark-mode timeline views should group by month. Hills I will die on, #37.',
    takenAt: NOW - 86400 * 6, archivedAt: (NOW - 86400 * 6 + 900) * 1000,
    lastActivityAt: NOW - 86400 * 6, likeCount: 128, replyCount: 12,
    profilePicId: 'DEMOBB/avatar/0', mediaMissing: 0, detailFetched: true,
    threadItems: [{ text: 'Dark-mode timeline views should group by month. Hills I will die on, #37.',
      code: 'DEMOBB', username: 'norm.designs', displayName: 'Norm', avatarId: null,
      images: [{ archivedId: 'DEMOBB/image/0', width: 1000, height: 700 }], videos: [] }],
    replies: [],
  });

  // Thread 3 — text-only, previous month
  await media('DEMOCC/avatar/0', 'DEMOCC', 'avatar', await makeAvatar('K', '#d94f70'));
  await put('threads', {
    code: 'DEMOCC', pk: '3', username: 'kaiya.codes', displayName: 'Kaiya',
    text: 'PSA: @ada_builds wrote up the bridge pattern for calling same-origin APIs from an extension service worker. Saved me a week. #chromeextensions',
    takenAt: NOW - 86400 * 33, archivedAt: (NOW - 86400 * 33 + 600) * 1000,
    lastActivityAt: NOW - 86400 * 30, likeCount: 86, replyCount: 7,
    profilePicId: 'DEMOCC/avatar/0', mediaMissing: 0, detailFetched: true,
    threadItems: [{ text: 'PSA: @ada_builds wrote up the bridge pattern for calling same-origin APIs from an extension service worker. Saved me a week. #chromeextensions',
      code: 'DEMOCC', username: 'kaiya.codes', displayName: 'Kaiya', avatarId: null, images: [], videos: [] }],
    replies: [{ pk: '31', code: 'DEMOR3', username: 'ada_builds', text: 'glad it helped!', takenAt: NOW - 86400 * 30, likeCount: 12, replyCount: 0, avatarId: null, images: [], videos: [] }],
  });

  // Thread 4 — archived from a reply, previous month
  await media('DEMODD/avatar/0', 'DEMODD', 'avatar', await makeAvatar('P', '#e0a13d'));
  await put('threads', {
    code: 'DEMODD', pk: '4', username: 'petra_ml', displayName: 'Petra',
    text: 'The trick is treating every reply as a potential root: fetch its own thread detail and it becomes a first-class archive entry.',
    takenAt: NOW - 86400 * 40, archivedAt: (NOW - 86400 * 39) * 1000,
    lastActivityAt: NOW - 86400 * 39, likeCount: 54, replyCount: 3,
    profilePicId: 'DEMODD/avatar/0', mediaMissing: 0, detailFetched: true, sourceParent: 'DEMOAA',
    threadItems: [{ text: 'The trick is treating every reply as a potential root: fetch its own thread detail and it becomes a first-class archive entry.',
      code: 'DEMODD', username: 'petra_ml', displayName: 'Petra', avatarId: null, images: [], videos: [] }],
    replies: [],
  });

  return 'seeded';
});
console.log('demo data seeded');

// ── 1. archive timeline ─────────────────────────────────────────────────────────
await page.reload();
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, 'timeline.png') });
console.log('timeline.png');

// ── 2. reader ───────────────────────────────────────────────────────────────────
await page.goto(`chrome-extension://${extId}/reader/reader.html?code=DEMOAA`);
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, 'reader.png') });
console.log('reader.png');

// ── 3. popup ────────────────────────────────────────────────────────────────────
const popup = await ctx.newPage();
await popup.setViewportSize({ width: 380, height: 700 });
await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
await popup.waitForTimeout(700);
await popup.screenshot({ path: path.join(OUT, 'popup.png') });
console.log('popup.png');

await ctx.close();
fs.rmSync(PROFILE, { recursive: true, force: true });
console.log('done');
