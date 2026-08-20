# Threads Archiver API

Read-only local REST API over an exported archive, so external tools can fetch
and crawl the cached threads. Zero dependencies — needs only Node 18+.

The extension's data lives in Chrome's IndexedDB, which nothing outside the
browser can reach. The flow is: export from the extension, serve the export.

## Usage

1. Extension popup → **⤓ Export .zip** → saves `threads-archive-YYYY-MM-DD.zip`
2. Extract the zip (this server is inside it, at `api/server.js`)
3. Run the server from the extracted folder:

```sh
cd threads-archive-2026-07-20
node api/server.js .            # serves archive.json + media/ files
# legacy v1 .json exports (base64 media) also work:
node api/server.js old-export.json --port 8787
```

4. Open http://localhost:8787/docs for Swagger UI — or just open `index.html`
   in a browser for the bundled viewer UI (no server needed).

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /threads` | Paginated summaries. Params: `q` (full-text), `username`, `sort` (`newest\|oldest\|updated\|archived`), `missing` (bool), `limit` (≤500), `offset` |
| `GET /threads/{code}` | Full thread: items (per-item authors), replies, media refs with `mediaUrl` |
| `GET /threads/{code}/replies` | Just the archived replies |
| `GET /media/{id}` | Raw archived bytes with original MIME type (`id` URL-encoded, e.g. `abc%2Fimage%2F0`) |
| `GET /stats` | Counts + sizes |
| `GET /openapi.json` | OpenAPI 3.0 spec |
| `GET /docs` | Swagger UI |
| `POST /reload` | Re-read the export file (picks the newest again if given a directory) |

## Crawling pattern

```sh
curl 'http://localhost:8787/threads?limit=100&offset=0'   # page through summaries
curl 'http://localhost:8787/threads/DamEts4ieSp'          # full content per code
# follow every "mediaUrl" field for images/videos/avatars/posters
```

## Security notes

- Binds to **127.0.0.1 only** — never exposed to the network.
- **CORS is off by default.** Your archive is personal data: with an open
  `Access-Control-Allow-Origin`, any website in your browser could read it off
  localhost while the server runs. Pass `--cors` only when a browser-based
  tool on another origin genuinely needs access; CLI tools (curl, scripts)
  don't need it.
