# Threads Archiver

A Chrome extension (Manifest V3) that automatically archives your **Threads saved posts** locally — full text, replies, images, and videos — and keeps them readable even after the originals are deleted.

Everything stays on your machine: posts and media live in the extension's IndexedDB. No external services, no telemetry, no accounts.

## Features

- **Auto-sync** — checks your saved posts every 30 minutes and archives new ones (text, media bytes, reply chains, author icons)
- **Delta reply tracking** — cheaply detects new replies on archived threads and fetches them
- **Media repair** — Threads CDN URLs expire within ~48h; missed downloads are retried with fresh URLs on later syncs
- **Reader view** — full-tab thread reader with inline media, collapsible replies, per-reply "Archive this" (captures a reply and *its* conversation as a first-class thread)
- **Archive timeline** — browse all saves with search, sorting (date / recently updated / recently archived), and month grouping
- **Self-contained export** — one ZIP with all media as real files, a standalone offline viewer (`index.html`), and a bundled REST API; import it on any other machine
- **Local REST API** — serve an export with `node api/server.js` and crawl it over HTTP, Swagger UI included

## Install

1. Clone this repo
2. Open `chrome://extensions`, enable **Developer mode**
3. **Load unpacked** → select the `threads-archiver/` directory
4. Log in to [threads.com](https://www.threads.com), then click the extension → **Sync now**

After changing code, hit ↺ on the extension card in `chrome://extensions`.

## How it works

Threads' internal GraphQL API requires session cookies plus request-signing tokens (`lsd` etc.) that only exist inside a Threads page. The extension:

1. Injects a content-script **bridge** into a Threads tab, where `fetch()` is same-origin (cookies flow automatically, no CORS)
2. Extracts tokens and current query doc_ids from the page's own JS module registry (`MAIN` world) — so it **self-heals when Meta rotates identifiers**
3. The service worker orchestrates sync through the bridge and writes to IndexedDB

Details, data model, and API response shapes are documented in [CLAUDE.md](CLAUDE.md).

## Export / share / crawl

Popup → **⤓ Export .zip** produces a folder anyone can use without the extension:

- open `index.html` — offline timeline + thread viewer
- `node api/server.js .` — REST API with Swagger docs at `/docs` (see [api/README.md](threads-archiver/api/README.md))
- `archive.json` — machine-readable manifest; media as real files under `media/`

**⤒ Import** restores a ZIP (or legacy `.json` export) into another browser profile.

## Privacy & security notes

- The extension only reads **your own saved posts**, using **your own session**, and stores them **locally**. Nothing is sent anywhere except the requests to threads.com your browser would make anyway.
- Exports contain your saved posts and media — treat the ZIP as personal data before sharing it.
- The API server binds to `127.0.0.1` and ships with CORS **disabled by default** (`--cors` to opt in), so websites in your browser can't read your archive off localhost.
- Session tokens are held in memory during a sync only — never persisted or exported.

## Disclaimer

Unofficial personal-archival tool, not affiliated with or endorsed by Meta. It automates access to Threads' private web API on your behalf; that API can change at any time and heavy use is at your own risk under Meta's Terms of Service. Archive responsibly — the content you save belongs to its authors.

## Development

- `CLAUDE.md` — architecture notes, GraphQL query snapshots, data model, debugging playbook (also serves as agent context for AI-assisted development)
- Hooks via [pre-commit](https://pre-commit.com): `pip install pre-commit && pre-commit install` — JS syntax, JSON validation, secret/private-key/session-token detection, large-file and export-file guards (see `.pre-commit-config.yaml`)
- No build step, no dependencies — vanilla JS everywhere, including the ZIP writer and the API server

## License

[MIT](LICENSE)
