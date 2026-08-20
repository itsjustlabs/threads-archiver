# Threads Archiver — Chrome Extension

A Chrome MV3 extension that auto-archives your Threads saved posts locally (text + media) and renders them in a thread-reader view, even after the originals are deleted.

## Project structure

```
manifest.json          MV3 manifest — permissions, content_scripts, service worker
background/worker.js   Service worker — sync orchestration, IndexedDB writes
content/bridge.js      Content script — same-origin GQL fetch proxy
shared/api.js          GraphQL client (routes through bridge)
shared/db.js           IndexedDB wrapper (threads + media stores)
popup/popup.html+js    Extension popup — thread list, sync button, status
reader/reader.html+js  Full-tab thread reader with inline media
archive/archive.html+js Full-tab timeline of all saves — search/sort/filter,
                       month grouping, lazy media thumbs; reader "← All saves"
                       links here, popup ⧉ button opens it
icons/                 PNG icons (16, 48, 128px)
api/server.js          Zero-dep local REST API over an export file (Swagger at
                       /docs) — external tools crawl the archive via HTTP;
                       see api/README.md

```

## Architecture

### The bridge pattern
Threads' GraphQL endpoint (`https://www.threads.com/graphql/query`) requires session cookies and Meta-specific request tokens (`lsd`, `__hs`, `__rev`, etc.). A service worker can't make credentialed same-origin requests to it reliably.

**Solution**: `content/bridge.js` is injected into a Threads tab. It runs in the page's isolated content-script world, where `fetch()` to `threads.com` is same-origin — cookies are included automatically, no CORS. The service worker sends messages to it via `chrome.tabs.sendMessage`.

### Token extraction
Meta's `lsd` token (request-signing) and related params are extracted by running `chrome.scripting.executeScript({ world: 'MAIN' })` in the page's JavaScript context, where `require('LSD').token` and `require('HasteSupportData')` are available. This runs in `extractPageParams()` in `worker.js` before each sync.

### Sync flow (background/worker.js `runSync`)
1. Find or open a Threads tab, inject bridge, ping to confirm ready
2. Extract page params from MAIN world (`extractPageParams`)
3. Call `setMetaParams()` + `setBridgeTab()` in `api.js`
4. Fetch all saved post edges (paginated via `SAVED_VIEWER` → `SAVED_REFETCH` doc_ids)
5. For each new post: fetch thread detail, download media bytes to IndexedDB
6. Delta-check existing posts: batch `fetchCounts` → if `reply_count` grew, re-fetch detail

### Data model (IndexedDB)
**`threads` store** — keyed by post `code` (shortcode):
- `code`, `pk`, `username`, `displayName`, `text`, `takenAt`
- `threadItems[]` — native multi-part posts (same author composing a thread)
- `replies[]` — reply chain from others
- `replyCount`, `maxReplyPk` — delta detection cursors
- `profilePicId` — reference into `media` store
- `lastActivityAt` — unix seconds of newest activity (root post or newest reply); drives "recently updated" sort in popup
- `mediaMissing` — count of media refs with no stored bytes (CDN URL expired before download)
- `mediaRepairAttempts` — consecutive repair passes that failed; repair gives up at 5
- media refs (`threadItems[].images[]` etc.) carry `archivedId` (set only when bytes stored) or `failed: true`
- video refs also carry `posterId` (role `thumbnail` in media store) — a video post's `image_versions2` is its poster frame, NOT a separate image; extractImages skips it and extractVideos attaches it as `posterUrl`. Carousel items may each be image or video.
- `replies[]` entries carry `likeCount` + `replyCount` (that reply's own direct_reply_count) and `avatarId` (author's profile pic, media id `${code}/reply-${replyCode}/avatar/0`; cosmetic, not counted in mediaMissing)
- `sourceParent` — set when a thread was archived via the reader's per-reply "Archive" action (`ARCHIVE_REPLY` message); the reply becomes a first-class thread keyed by its own code

### Full refresh (background/worker.js `runFullRefresh`)
Popup "⟳ Full refresh" re-fetches detail for every archived thread (icons,
media, posters, counts). Resumable: the remaining-codes queue persists in
`chrome.storage.local` (`fullRefreshQueue`) after each item; an interrupted
run resumes on worker startup or at the next sync alarm (which it preempts).

### Export / import (popup footer)
Export is a self-contained ZIP (STORE method, no compression — vanilla-JS zip
writer + CRC32 in popup.js): `archive.json` (manifest v2 — media entries have
`file` paths instead of bytes), `data.js` (same manifest as
`window.ARCHIVE_DATA`, because file:// pages can't fetch), `index.html`
(standalone viewer bundled from export/viewer.html — timeline + thread pages,
hash routing, works offline), `media/<id>.<ext>` (raw bytes, extension from
mimeType), and `api/` (server + README). Import accepts these ZIPs (STORE + DEFLATE
parser in popup.js — DEFLATE via DecompressionStream, so Finder/OS-recompressed
zips also work; skips dirs + __MACOSX) or legacy v1 .json exports (base64 media).
Import is a **non-destructive merge**: a thread is added if new, updated only if
the imported copy has a later lastActivityAt (never regresses local data), else
left as "already present"; media is add-only by id (never overwrites stored
bytes, never deletes). Result is shown via holdStatus() so the periodic status
poller doesn't clobber it. api/server.js serves either format — point it at the
extracted folder (archive.json) or a v1 file.

### Media repair (background/worker.js `repairMissingMedia`)
Runs as sync step 5. For threads with missing media bytes (failed download or
legacy record), re-fetches thread detail to get fresh CDN URLs (originals expire
in 24–48h), retries the downloads, and updates `mediaMissing`/`mediaRepairAttempts`.
Reader shows a banner + placeholder tiles: "retrying on next sync" until attempts
hit 5, then "source no longer available".

**`media` store** — keyed by `${code}/${role}/${index}`:
- `role`: `avatar | image | video`
- `data`: `ArrayBuffer` (actual bytes — CDN URLs expire in 24–48h)
- `mimeType`, `width`, `height`, `durationMs`

## Key constants (shared/api.js QUERY_DEFS — verified live 2026-07-10)

```js
SAVED_VIEWER   = '28630728353184508'  // BarcelonaSavedPageViewerQuery — NO plain vars, 27 providers
SAVED_REFETCH  = '27876850938599212'  // BarcelonaSavedPageRefetchableQuery — { first, after } + 27 providers
THREAD_DETAIL  = '36740430502268116'  // BarcelonaPostPageDirectQuery — { postID: <numeric pk>, sort_order: 'TOP' } + 31 providers
REPLY_COUNTS   = '27196539320018072'  // useBarcelonaBatchedDynamicPostCountsSubscriptionQuery — { post_ids: [pk] }, no providers
```

**Self-healing**: doc_ids and provider values are resolved dynamically at sync time from
the page's Relay module registry (`require('<Name>.graphql').params.id` +
`.params.providedVariables` with `.get()` per provider) in `extractPageParams`. The
values in `QUERY_DEFS` are only fallbacks for modules not loaded on the current page.
If a query starts failing with `{"errors":[{"message":"execution error"}], "data":null}`,
the snapshot has drifted AND dynamic resolution failed — refresh the snapshot by running
`require('<module>').params` in a Threads tab console on a page that uses that query.

### Response shapes (current)
- Saved list: `data.xdt_text_app_viewer.saved_media.{edges, page_info}` (both viewer + refetch)
- Thread detail: `data.data.edges[]` — `edges[0].node` = containing thread, `edges[1..]` = reply threads; each node has `thread_items[].post`; api.js synthesizes `{ containing_thread, reply_threads }` from this for worker.js
- Reply counts: `data.data.posts[]` with `pk`, `like_count`, `text_post_app_info.direct_reply_count`
- `postID` for thread detail is the **numeric pk**, not the shortcode (`codeToPk()` in api.js converts)

### Token locations (MAIN world)
- `require('LSD').token` — works
- `haste_session`, `hsi`, `client_revision` — all in `require('SiteData')` (NOT HasteSupportData, which only has `handle`)
- `ds_user_id`, `csrftoken` — cookies

## Known issues / active debugging

### Resolved 2026-07-10 (was: AuthError on fetchAllSaved)
All three GQL calls verified working live from a logged-in Threads tab. Root causes, all fixed:
1. Hardcoded provider-variable list was stale — the saved query needs 27 providers (code had 15; `HasMessaging` had flipped to `false`). Meta returns HTTP 200 + `execution error` when providers don't match the persisted query.
2. Viewer query takes no `count` variable; refetch takes `{ first, after }` not `{ count, cursor }`.
3. `BarcelonaPostPageQuery` no longer exists — replaced by `BarcelonaPostPageDirectQuery` with new doc_id, pk-based `postID`, and edge-array response shape.
4. `REPLY_COUNTS` doc_id had rotated; response shape moved to `data.data.posts`.
5. `manifest.json` lacked `host_permissions` for `*.cdninstagram.com` / `*.fbcdn.net`, which service-worker media downloads require.

### Debugging steps
- **Service worker console**: `chrome://extensions` → Threads Archiver → "Service Worker" link → Console tab. Shows `[archiver]` prefixed logs.
- **Threads tab console**: F12 on the Threads tab → Console. Shows `[archiver bridge]` prefixed logs from the content script.
- **Network tab on Threads tab**: filter by `graphql/query`, look at Form Data of POST requests to see real `doc_id` and `variables`.

To manually test a GQL call from the Threads tab console:
```js
// Check LSD token (run in Threads tab console, not service worker)
require('LSD')  // should return { token: "..." }

// Check bridge is active
window.__threadsArchiverBridge  // should be true
```

## Loading the extension
1. `chrome://extensions` → enable Developer Mode
2. "Load unpacked" → select this directory
3. After any code change: click ↺ refresh on the extension card
4. For already-open Threads tabs: bridge is re-injected automatically on next Sync

## Permissions used
- `cookies` — read `ds_user_id` and `csrftoken`
- `scripting` — inject `content/bridge.js` into existing tabs + MAIN-world token extraction
- `alarms` — 30-minute sync schedule
- `unlimitedStorage` — media bytes can be large
- `host_permissions: https://*.threads.com/*` — cookie access + content script scope
