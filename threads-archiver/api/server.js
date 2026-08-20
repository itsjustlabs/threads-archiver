#!/usr/bin/env node
/**
 * Threads Archiver — local read-only REST API over an exported archive file.
 *
 * The archive lives in the extension's IndexedDB, which nothing outside
 * Chrome can reach. This server serves the JSON file produced by the popup's
 * "⤓ Export archive" button, so any other tool can fetch/crawl the cached
 * threads over HTTP.
 *
 * Zero dependencies — plain node:http. Swagger UI is loaded from a CDN by
 * the /docs page; the spec itself is served locally at /openapi.json.
 *
 * Usage:
 *   node server.js <archive.json | export.json | directory> [--port 8787]
 *
 * Works with both export formats:
 *   v2 (zip export, extracted): directory containing archive.json + media/ files
 *   v1 (legacy .json export):   single file with base64-inlined media
 * Given a directory, archive.json is preferred, else the newest
 * threads-archive-*.json. POST /reload re-reads without restarting.
 */

import http from 'node:http';
import fs   from 'node:fs';
import path from 'node:path';

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx !== -1 ? Number(args[portIdx + 1]) : 8787;
// CORS is OPT-IN: with an open Access-Control-Allow-Origin, any website in
// your browser could read the whole archive off localhost while the server
// runs. Pass --cors only when a browser-based tool on another origin needs it.
const CORS = args.includes('--cors');
const target = args.find((a, i) => !a.startsWith('--') && (portIdx === -1 || i !== portIdx + 1));

if (!target) {
  console.error('Usage: node server.js <archive.json | export.json | directory> [--port 8787] [--cors]');
  process.exit(1);
}

function corsHeaders() {
  return CORS ? { 'Access-Control-Allow-Origin': '*' } : {};
}

// ── archive loading ─────────────────────────────────────────────────────────

let archive = null;   // { exportedAt, threads: Map<code, thread>, media: Map<id, rec>, sourceFile }

function resolveExportFile(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return p;
  // Extracted zip export? (v2: archive.json + media/ files)
  const manifest = path.join(p, 'archive.json');
  if (fs.existsSync(manifest)) return manifest;
  // Otherwise the newest legacy JSON export in the directory
  const candidates = fs.readdirSync(p)
    .filter(f => /^threads-archive-.*\.json$/.test(f))
    .map(f => path.join(p, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!candidates.length) throw new Error(`No archive.json or threads-archive-*.json in ${p}`);
  return candidates[0];
}

function loadArchive() {
  const file = resolveExportFile(target);
  console.log(`Loading ${file} …`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.format !== 'threads-archiver-export') {
    throw new Error('Not a threads-archiver export file (bad "format" field).');
  }
  archive = {
    sourceFile: file,
    baseDir:    path.dirname(path.resolve(file)), // v2: media paths are relative to this
    exportedAt: data.exportedAt ?? null,
    version:    data.version ?? 1,
    threads:    new Map((data.threads ?? []).map(t => [t.code, t])),
    media:      new Map((data.media ?? []).map(m => [m.id, m])),
  };
  const fileBased = [...archive.media.values()].filter(m => m.file).length;
  console.log(`Loaded ${archive.threads.size} threads, ${archive.media.size} media records` +
              (fileBased ? ` (${fileBased} file-based)` : '') + '.');
}

// ── helpers ─────────────────────────────────────────────────────────────────

const MEDIA_BASE = '/media/';

function mediaUrl(id) {
  return id ? MEDIA_BASE + encodeURIComponent(id) : null;
}

/** Attach mediaUrl to every archived ref so crawlers can fetch bytes. */
function withMediaUrls(thread) {
  const t = structuredClone(thread);
  const decorate = ref => {
    ref.mediaUrl  = ref.archivedId ? mediaUrl(ref.archivedId) : null;
    ref.posterUrl = ref.posterId   ? mediaUrl(ref.posterId)   : undefined;
  };
  for (const item of t.threadItems ?? []) {
    (item.images ?? []).forEach(decorate);
    (item.videos ?? []).forEach(decorate);
    if (item.avatarId) item.avatarUrl = mediaUrl(item.avatarId);
  }
  for (const reply of t.replies ?? []) {
    (reply.images ?? []).forEach(decorate);
    (reply.videos ?? []).forEach(decorate);
    if (reply.avatarId) reply.avatarUrl = mediaUrl(reply.avatarId);
  }
  if (t.profilePicId) t.profilePicUrl = mediaUrl(t.profilePicId);
  return t;
}

function lastActivity(t) {
  if (t.lastActivityAt) return t.lastActivityAt;
  let latest = t.takenAt ?? 0;
  for (const r of t.replies ?? []) if ((r.takenAt ?? 0) > latest) latest = r.takenAt;
  return latest;
}

function summarize(t) {
  return {
    code:           t.code,
    pk:             t.pk ?? null,
    username:       t.username ?? '',
    displayName:    t.displayName ?? '',
    text:           t.text ?? '',
    takenAt:        t.takenAt ?? 0,
    lastActivityAt: lastActivity(t),
    archivedAt:     t.archivedAt ?? 0,
    likeCount:      t.likeCount ?? 0,
    replyCount:     t.replyCount ?? 0,
    archivedReplies: t.replies?.length ?? 0,
    mediaMissing:   t.mediaMissing ?? 0,
    sourceParent:   t.sourceParent ?? null,
    url:            `/threads/${encodeURIComponent(t.code)}`,
    originalUrl:    `https://www.threads.com/@${t.username}/post/${t.code}`,
  };
}

function matchesQuery(t, q) {
  const hay = [
    t.text, t.username, t.displayName,
    ...(t.threadItems ?? []).map(i => i.text),
    ...(t.replies ?? []).flatMap(r => [r.text, r.username]),
  ].filter(Boolean).join('\n').toLowerCase();
  return hay.includes(q);
}

const SORTS = {
  newest:   (a, b) => (b.takenAt ?? 0) - (a.takenAt ?? 0),
  oldest:   (a, b) => (a.takenAt ?? 0) - (b.takenAt ?? 0),
  updated:  (a, b) => lastActivity(b) - lastActivity(a),
  archived: (a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0),
};

function json(res, status, body) {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(),
  });
  res.end(s);
}

// ── routes ──────────────────────────────────────────────────────────────────

function handleThreadsList(res, params) {
  const q       = (params.get('q') ?? '').trim().toLowerCase();
  const sort    = SORTS[params.get('sort') ?? 'newest'] ? (params.get('sort') ?? 'newest') : 'newest';
  const limit   = Math.min(Math.max(Number(params.get('limit') ?? 50), 1), 500);
  const offset  = Math.max(Number(params.get('offset') ?? 0), 0);
  const missing = params.get('missing') === 'true';
  const user    = (params.get('username') ?? '').trim().toLowerCase();

  let items = [...archive.threads.values()];
  if (q)       items = items.filter(t => matchesQuery(t, q));
  if (user)    items = items.filter(t => (t.username ?? '').toLowerCase() === user);
  if (missing) items = items.filter(t => (t.mediaMissing ?? 0) > 0);
  items.sort(SORTS[sort]);

  const page = items.slice(offset, offset + limit);
  json(res, 200, {
    total: items.length,
    offset,
    limit,
    sort,
    items: page.map(summarize),
  });
}

function handleThreadDetail(res, code) {
  const t = archive.threads.get(code);
  if (!t) return json(res, 404, { error: `Thread "${code}" not found` });
  json(res, 200, withMediaUrls(t));
}

function handleThreadReplies(res, code) {
  const t = archive.threads.get(code);
  if (!t) return json(res, 404, { error: `Thread "${code}" not found` });
  const full = withMediaUrls(t);
  json(res, 200, { code, count: full.replies?.length ?? 0, replies: full.replies ?? [] });
}

function handleMedia(res, id) {
  const m = archive.media.get(id);
  if (!m) return json(res, 404, { error: `Media "${id}" not found` });

  let buf;
  if (m.file) {
    // v2 (zip export): bytes live on disk relative to archive.json
    const p = path.resolve(archive.baseDir, m.file);
    if (!p.startsWith(archive.baseDir + path.sep)) {
      return json(res, 400, { error: 'Invalid media path' });
    }
    if (!fs.existsSync(p)) return json(res, 404, { error: `Media file missing on disk: ${m.file}` });
    buf = fs.readFileSync(p);
  } else {
    // v1 (legacy JSON export): base64 inline
    buf = Buffer.from(m.data ?? '', 'base64');
  }

  res.writeHead(200, {
    'Content-Type': m.mimeType ?? 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': 'max-age=31536000, immutable',
    ...corsHeaders(),
  });
  res.end(buf);
}

function handleStats(res) {
  let mediaBytes = 0;
  for (const m of archive.media.values()) {
    if (m.file) {
      try { mediaBytes += fs.statSync(path.resolve(archive.baseDir, m.file)).size; } catch {}
    } else {
      // base64 length → approximate raw size without decoding
      mediaBytes += Math.floor((m.data?.length ?? 0) * 3 / 4);
    }
  }
  const threads = [...archive.threads.values()];
  json(res, 200, {
    sourceFile:    archive.sourceFile,
    exportedAt:    archive.exportedAt,
    threadCount:   threads.length,
    replyCount:    threads.reduce((n, t) => n + (t.replies?.length ?? 0), 0),
    mediaCount:    archive.media.size,
    mediaBytes,
    threadsWithMissingMedia: threads.filter(t => (t.mediaMissing ?? 0) > 0).length,
  });
}

// ── OpenAPI spec ────────────────────────────────────────────────────────────

const MEDIA_REF = {
  type: 'object',
  properties: {
    archivedId: { type: 'string', nullable: true, description: 'Media store key; null if bytes were never captured' },
    mediaUrl:   { type: 'string', nullable: true, description: 'Fetchable URL for the archived bytes (/media/{id})' },
    posterUrl:  { type: 'string', nullable: true, description: 'Poster frame URL (videos only)' },
    width:      { type: 'integer', nullable: true },
    height:     { type: 'integer', nullable: true },
    durationMs: { type: 'integer', nullable: true, description: 'Videos only' },
    failed:     { type: 'boolean', description: 'True when the CDN URL expired before the bytes were captured' },
  },
};

const OPENAPI = {
  openapi: '3.0.3',
  info: {
    title: 'Threads Archiver API',
    version: '1.0.0',
    description:
      'Read-only API over a Threads Archiver export file. Serves archived/cached ' +
      'Threads posts (text, replies, stats) and their media bytes, so external ' +
      'tools can fetch and crawl the archive.\n\n' +
      'Crawling pattern: `GET /threads` (paginate with `limit`/`offset`) → ' +
      '`GET /threads/{code}` for full content → follow `mediaUrl` fields for bytes.',
  },
  servers: [{ url: `http://localhost:${PORT}` }],
  paths: {
    '/threads': {
      get: {
        summary: 'List archived threads',
        parameters: [
          { name: 'q',        in: 'query', schema: { type: 'string' },  description: 'Full-text search across post text, usernames, and reply text' },
          { name: 'username', in: 'query', schema: { type: 'string' },  description: 'Exact author username filter' },
          { name: 'sort',     in: 'query', schema: { type: 'string', enum: ['newest', 'oldest', 'updated', 'archived'], default: 'newest' } },
          { name: 'missing',  in: 'query', schema: { type: 'boolean' }, description: 'Only threads with missing media' },
          { name: 'limit',    in: 'query', schema: { type: 'integer', default: 50, maximum: 500 } },
          { name: 'offset',   in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: {
          200: {
            description: 'Paginated thread summaries',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                total:  { type: 'integer' },
                offset: { type: 'integer' },
                limit:  { type: 'integer' },
                sort:   { type: 'string' },
                items:  { type: 'array', items: { $ref: '#/components/schemas/ThreadSummary' } },
              },
            } } },
          },
        },
      },
    },
    '/threads/{code}': {
      get: {
        summary: 'Full thread detail',
        description: 'Complete archived record: thread items (with per-item authors), replies, media refs with fetchable mediaUrl fields.',
        parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' }, description: 'Threads post shortcode' }],
        responses: {
          200: { description: 'The thread', content: { 'application/json': { schema: { $ref: '#/components/schemas/Thread' } } } },
          404: { description: 'Not archived' },
        },
      },
    },
    '/threads/{code}/replies': {
      get: {
        summary: 'Archived replies for a thread',
        parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Replies', content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              code:    { type: 'string' },
              count:   { type: 'integer' },
              replies: { type: 'array', items: { $ref: '#/components/schemas/Reply' } },
            },
          } } } },
          404: { description: 'Not archived' },
        },
      },
    },
    '/media/{id}': {
      get: {
        summary: 'Raw archived media bytes',
        description: 'Serves the stored bytes with the original MIME type. `id` is the URL-encoded media key, e.g. `abc123%2Fimage%2F0`.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Media bytes (image/*, video/*)' },
          404: { description: 'Unknown media id' },
        },
      },
    },
    '/stats': {
      get: {
        summary: 'Archive statistics',
        responses: { 200: { description: 'Counts and sizes' } },
      },
    },
    '/reload': {
      post: {
        summary: 'Re-read the export file from disk',
        description: 'Use after replacing the export with a newer one. If the server was started with a directory, the newest threads-archive-*.json is picked again.',
        responses: { 200: { description: 'Reloaded' }, 500: { description: 'Reload failed' } },
      },
    },
  },
  components: {
    schemas: {
      ThreadSummary: {
        type: 'object',
        properties: {
          code:            { type: 'string', description: 'Threads post shortcode (primary key)' },
          pk:              { type: 'string', nullable: true, description: 'Numeric post id' },
          username:        { type: 'string' },
          displayName:     { type: 'string' },
          text:            { type: 'string' },
          takenAt:         { type: 'integer', description: 'Unix seconds the post was made' },
          lastActivityAt:  { type: 'integer', description: 'Unix seconds of newest activity (post or newest reply)' },
          archivedAt:      { type: 'integer', description: 'Unix ms the post was archived' },
          likeCount:       { type: 'integer' },
          replyCount:      { type: 'integer', description: 'Reply count on Threads' },
          archivedReplies: { type: 'integer', description: 'Replies captured in the archive' },
          mediaMissing:    { type: 'integer', description: 'Media refs with no stored bytes' },
          sourceParent:    { type: 'string', nullable: true, description: 'Parent thread code when archived from a reply' },
          url:             { type: 'string', description: 'Detail endpoint for this thread' },
          originalUrl:     { type: 'string', description: 'Original post on threads.com' },
        },
      },
      Thread: {
        type: 'object',
        description: 'Full archived thread record. Media refs include mediaUrl fields pointing at /media/{id}.',
        properties: {
          code:          { type: 'string' },
          pk:            { type: 'string' },
          username:      { type: 'string' },
          displayName:   { type: 'string' },
          text:          { type: 'string' },
          takenAt:       { type: 'integer' },
          likeCount:     { type: 'integer' },
          replyCount:    { type: 'integer' },
          profilePicUrl: { type: 'string', nullable: true, description: 'Author avatar (/media/ URL)' },
          threadItems: {
            type: 'array',
            description: 'Multi-part items; each may have its own author (parent context on saved replies)',
            items: {
              type: 'object',
              properties: {
                text:        { type: 'string' },
                code:        { type: 'string' },
                username:    { type: 'string' },
                displayName: { type: 'string' },
                avatarUrl:   { type: 'string', nullable: true },
                images:      { type: 'array', items: MEDIA_REF },
                videos:      { type: 'array', items: MEDIA_REF },
              },
            },
          },
          replies:      { type: 'array', items: { $ref: '#/components/schemas/Reply' } },
          mediaMissing: { type: 'integer' },
          sourceParent: { type: 'string', nullable: true },
        },
      },
      Reply: {
        type: 'object',
        properties: {
          pk:         { type: 'string' },
          code:       { type: 'string' },
          username:   { type: 'string' },
          text:       { type: 'string' },
          takenAt:    { type: 'integer' },
          likeCount:  { type: 'integer' },
          replyCount: { type: 'integer', description: "This reply's own direct reply count on Threads" },
          avatarUrl:  { type: 'string', nullable: true },
          images:     { type: 'array', items: MEDIA_REF },
          videos:     { type: 'array', items: MEDIA_REF },
        },
      },
    },
  },
};

const DOCS_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Threads Archiver API — Swagger UI</title>
  <meta charset="utf-8">
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({ url: '/openapi.json', dom_id: '#ui', deepLinking: true });
  </script>
</body>
</html>`;

// ── server ──────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p   = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS ? {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    } : {});
    return res.end();
  }

  try {
    if (req.method === 'GET' && (p === '/' || p === '/docs')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(DOCS_HTML);
    }
    if (req.method === 'GET' && p === '/openapi.json') return json(res, 200, OPENAPI);
    if (req.method === 'GET' && p === '/stats')        return handleStats(res);
    if (req.method === 'GET' && p === '/threads')      return handleThreadsList(res, url.searchParams);

    let m;
    if (req.method === 'GET' && (m = p.match(/^\/threads\/([^/]+)\/replies$/))) {
      return handleThreadReplies(res, decodeURIComponent(m[1]));
    }
    if (req.method === 'GET' && (m = p.match(/^\/threads\/([^/]+)$/))) {
      return handleThreadDetail(res, decodeURIComponent(m[1]));
    }
    if (req.method === 'GET' && p.startsWith(MEDIA_BASE)) {
      return handleMedia(res, decodeURIComponent(p.slice(MEDIA_BASE.length)));
    }
    if (req.method === 'POST' && p === '/reload') {
      loadArchive();
      return json(res, 200, { ok: true, threads: archive.threads.size, media: archive.media.size });
    }

    json(res, 404, { error: 'Not found. See /docs for the API.' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

loadArchive();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nThreads Archiver API running:`);
  console.log(`  Swagger UI   http://localhost:${PORT}/docs`);
  console.log(`  OpenAPI      http://localhost:${PORT}/openapi.json`);
  console.log(`  Threads      http://localhost:${PORT}/threads`);
  console.log(`  Stats        http://localhost:${PORT}/stats\n`);
});
