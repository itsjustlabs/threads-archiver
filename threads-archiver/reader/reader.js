/**
 * Thread reader view — renders a single archived thread with full media.
 * Opened in a new tab by popup.js via chrome.tabs.create().
 *
 * URL: reader.html?code=<shortcode>
 */

import { getThread, getMediaForPost } from '../shared/db.js';

const code = new URLSearchParams(location.search).get('code');

const loadingEl    = document.getElementById('loading');
const errorEl      = document.getElementById('error');
const contentEl    = document.getElementById('content');
const refreshBtn   = document.getElementById('refreshBtn');
const refreshIcon  = document.getElementById('refreshIcon');
const refreshLabel = document.getElementById('refreshLabel');
const refreshNote  = document.getElementById('refreshNote');

if (!code) {
  showError('No thread code in URL.');
} else {
  render().catch(e => showError(e.message));
}

// ── refresh now ────────────────────────────────────────────────────────────────

refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  refreshIcon.classList.add('spin');
  refreshLabel.textContent = 'Refreshing…';
  setRefreshNote('');

  const res = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'REFRESH_THREAD', code }, r =>
      resolve(r ?? { ok: false, error: chrome.runtime.lastError?.message ?? 'No response from background worker.' }));
  });

  refreshBtn.disabled = false;
  refreshIcon.classList.remove('spin');
  refreshLabel.textContent = 'Refresh now';

  if (res.ok) {
    const bits = [`Refreshed just now — ${res.replyCount} repl${res.replyCount === 1 ? 'y' : 'ies'} archived`];
    if (res.mediaMissing > 0) bits.push(`${res.mediaMissing} media item(s) still unavailable`);
    setRefreshNote(bits.join(' · '));
    await render(); // re-render with fresh data
  } else {
    setRefreshNote(res.authError
      ? 'Not logged in to Threads — open threads.com, log in, then try again.'
      : `Refresh failed: ${res.error}`, true);
  }
});

function setRefreshNote(msg, isError = false) {
  refreshNote.style.display = msg ? 'block' : 'none';
  refreshNote.textContent   = msg;
  refreshNote.className     = `refresh-note${isError ? ' error' : ''}`;
}

// ── main render ────────────────────────────────────────────────────────────────

async function render() {
  const thread = await getThread(code);
  if (!thread) {
    showError(`Thread "${code}" not found in archive.`);
    return;
  }

  contentEl.innerHTML = ''; // re-renderable (used after Refresh now)

  document.title = `@${thread.username} — Threads Archiver`;

  // Load all media for this thread into a map by id
  const mediaList = await getMediaForPost(code);
  const mediaMap  = Object.fromEntries(mediaList.map(m => [m.id, m]));

  const frag = document.createDocumentFragment();

  // ── header card ──────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'thread-header';

  const authorRow = document.createElement('div');
  authorRow.className = 'author-row';

  // Avatar
  const avatarEl = await buildAvatarEl(thread, mediaMap, 48, 'avatar');
  authorRow.appendChild(avatarEl);

  const authorInfo = document.createElement('div');
  authorInfo.className = 'author-info';
  const profileUrl = `https://www.threads.com/@${encodeURIComponent(thread.username)}`;
  authorInfo.innerHTML = `
    <div class="name"><a class="plain-link" href="${esc(profileUrl)}" target="_blank" rel="noopener">${esc(thread.displayName || thread.username)}</a></div>
    <div class="handle"><a class="plain-link" href="${esc(profileUrl)}" target="_blank" rel="noopener">@${esc(thread.username)}</a></div>
  `;
  authorRow.appendChild(authorInfo);
  header.appendChild(authorRow);

  const dateEl = document.createElement('div');
  dateEl.className = 'post-date';
  const postUrl = `https://www.threads.com/@${encodeURIComponent(thread.username)}/post/${encodeURIComponent(thread.code)}`;
  dateEl.innerHTML = `<a class="plain-link" href="${esc(postUrl)}" target="_blank" rel="noopener" title="View original on Threads">${esc(formatDate(thread.takenAt * 1000))} ↗</a>`;
  header.appendChild(dateEl);

  // Thread items (native multi-part — same author composed together)
  const items = thread.threadItems?.length ? thread.threadItems : [{
    text: thread.text,
    images: [],
    videos: [],
  }];

  for (let i = 0; i < items.length; i++) {
    const item  = items[i];
    const isLast = i === items.length - 1;

    if (items.length > 1) {
      // Show connector line for multi-part threads
      const part = document.createElement('div');
      part.className = 'thread-part';

      const partAvatar = document.createElement('div');
      partAvatar.className = 'thread-part-avatar';
      const smallAvatar = await buildItemAvatarEl(thread, item, mediaMap);
      if (smallAvatar.tagName === 'IMG') {
        partAvatar.appendChild(smallAvatar);
      } else {
        partAvatar.textContent = smallAvatar.textContent;
      }
      part.appendChild(partAvatar);

      // When the saved post is a reply, ancestor items may be by a different
      // author — show who wrote this part
      if (item.username && item.username !== thread.username) {
        const author = document.createElement('div');
        author.className = 'part-author';
        const itemProfile = `https://www.threads.com/@${encodeURIComponent(item.username)}`;
        const itemPost = item.code
          ? `https://www.threads.com/@${encodeURIComponent(item.username)}/post/${encodeURIComponent(item.code)}`
          : itemProfile;
        author.innerHTML = `
          <a class="plain-link part-author-name" href="${esc(itemProfile)}" target="_blank" rel="noopener">${esc(item.displayName || item.username)}</a>
          <a class="plain-link part-author-handle" href="${esc(itemPost)}" target="_blank" rel="noopener" title="View on Threads">@${esc(item.username)} ↗</a>
        `;
        part.appendChild(author);
      }

      if (item.text) {
        const t = document.createElement('div');
        t.className = 'post-text';
        t.innerHTML = linkify(item.text);
        part.appendChild(t);
      }

      const media = await buildMediaEl(item, i, code, mediaMap, thread);
      if (media) part.appendChild(media);

      header.appendChild(part);
    } else {
      // Single post — no connector line needed
      if (item.text) {
        const t = document.createElement('div');
        t.className = 'post-text';
        t.innerHTML = linkify(item.text);
        header.appendChild(t);
      }

      const media = await buildMediaEl(item, 0, code, mediaMap, thread);
      if (media) header.appendChild(media);
    }
  }

  // Stats
  const stats = document.createElement('div');
  stats.className = 'post-stats';
  // Number() coercion: counts normally are numbers, but a crafted import
  // file could put strings here — never interpolate them raw into HTML.
  const likeN  = Number(thread.likeCount) || 0;
  const replyN = Number(thread.replyCount) || 0;
  stats.innerHTML = `
    <span>♥ ${likeN}</span>
    <span>💬 ${replyN} ${replyN === 1 ? 'reply' : 'replies'}</span>
    <span style="margin-left:auto; font-size:11px">Archived ${esc(relativeTime(thread.archivedAt))}</span>
  `;
  header.appendChild(stats);

  // Missing-media banner
  if (thread.mediaMissing > 0) {
    const banner = document.createElement('div');
    banner.className = 'media-repair-banner';
    banner.textContent = (thread.mediaRepairAttempts ?? 0) >= 5
      ? `⚠ ${thread.mediaMissing} media item(s) could not be recovered — the source appears to be gone.`
      : `⚠ ${thread.mediaMissing} media item(s) missing — the archiver will retry with fresh URLs on the next sync.`;
    header.appendChild(banner);
  }
  frag.appendChild(header);

  // ── replies ───────────────────────────────────────────────────────────────────
  if (thread.replies?.length) {
    const label = document.createElement('div');
    label.className = 'section-label';

    const labelText = document.createElement('span');
    labelText.textContent = `Replies (${thread.replies.length})`;
    label.appendChild(labelText);

    const collapseAll = document.createElement('button');
    collapseAll.className = 'collapse-all';
    collapseAll.textContent = 'Collapse all';
    collapseAll.addEventListener('click', () => {
      const cards = contentEl.querySelectorAll('.reply-card');
      const anyExpanded = [...cards].some(c => !c.classList.contains('collapsed'));
      cards.forEach(c => setReplyCollapsed(c, anyExpanded));
      collapseAll.textContent = anyExpanded ? 'Expand all' : 'Collapse all';
    });
    label.appendChild(collapseAll);
    frag.appendChild(label);

    for (const reply of thread.replies) {
      const card = await buildReplyCard(reply, code, mediaMap);
      frag.appendChild(card);
    }
  } else {
    const note = document.createElement('div');
    note.className = 'no-replies';
    note.textContent = thread.replyCount > 0
      ? `${thread.replyCount} replies exist — sync again to fetch them.`
      : 'No replies.';
    frag.appendChild(note);
  }

  contentEl.appendChild(frag);
  loadingEl.style.display  = 'none';
  contentEl.style.display  = 'block';
}

// ── reply card ─────────────────────────────────────────────────────────────────

async function buildReplyCard(reply, parentCode, mediaMap) {
  const card = document.createElement('div');
  card.className = 'reply-card';

  const authorRow = document.createElement('div');
  authorRow.className = 'reply-author';

  // Reply avatar — archived image if we have it, else letter placeholder
  const av = document.createElement('div');
  av.className = 'reply-avatar';
  const avMedia = reply.avatarId ? mediaMap[reply.avatarId] : null;
  if (avMedia?.data) {
    const url = URL.createObjectURL(new Blob([avMedia.data], { type: avMedia.mimeType ?? 'image/jpeg' }));
    const img = document.createElement('img');
    img.src = url; img.alt = reply.username;
    img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    av.appendChild(img);
  } else {
    av.textContent = (reply.username || '?')[0].toUpperCase();
  }
  authorRow.appendChild(av);

  const profileUrl = `https://www.threads.com/@${encodeURIComponent(reply.username)}`;
  const replyUrl   = reply.code
    ? `https://www.threads.com/@${encodeURIComponent(reply.username)}/post/${encodeURIComponent(reply.code)}`
    : profileUrl;

  const info = document.createElement('div');
  info.innerHTML = `
    <div class="reply-name"><a class="plain-link" href="${esc(profileUrl)}" target="_blank" rel="noopener">${esc(reply.username)}</a></div>
    <div class="reply-handle"><a class="plain-link" href="${esc(profileUrl)}" target="_blank" rel="noopener">@${esc(reply.username)}</a></div>
  `;
  authorRow.appendChild(info);

  const date = document.createElement('span');
  date.className = 'reply-date';
  if (reply.takenAt) {
    date.innerHTML = `<a class="plain-link" href="${esc(replyUrl)}" target="_blank" rel="noopener" title="View on Threads">${esc(relativeTime(reply.takenAt * 1000))} ↗</a>`;
  }
  authorRow.appendChild(date);

  // Archive action — a reply with its own conversation can be archived as
  // a first-class thread (with ITS replies + media)
  if (reply.code) {
    authorRow.appendChild(await buildReplyArchiveAction(reply, parentCode));
  }

  // Collapse toggle
  const toggle = document.createElement('button');
  toggle.className = 'reply-toggle';
  toggle.textContent = '▾';
  toggle.title = 'Collapse reply';
  toggle.addEventListener('click', () => setReplyCollapsed(card, !card.classList.contains('collapsed')));
  authorRow.appendChild(toggle);

  card.appendChild(authorRow);

  if (reply.text) {
    const t = document.createElement('div');
    t.className = 'reply-text';
    t.innerHTML = linkify(reply.text);
    card.appendChild(t);
  }

  // Stats footer: likes + how many replies THIS reply has
  const footer = document.createElement('div');
  footer.className = 'reply-stats';
  const bits = [`♥ ${reply.likeCount ?? 0}`];
  if ((reply.replyCount ?? 0) > 0) {
    bits.push(`💬 ${reply.replyCount} ${reply.replyCount === 1 ? 'reply' : 'replies'}`);
  }
  footer.textContent = bits.join('   ');

  // Reply images
  const replyImages = (reply.images ?? []).filter(img => img.archivedId);
  if (replyImages.length) {
    const grid = buildMediaGrid(replyImages.length);
    for (let i = 0; i < replyImages.length; i++) {
      const img  = replyImages[i];
      const m    = mediaMap[img.archivedId];
      const item = document.createElement('div');
      item.className = 'media-item';
      if (m?.data) {
        const blob = new Blob([m.data], { type: m.mimeType ?? 'image/jpeg' });
        const url  = URL.createObjectURL(blob);
        const el   = document.createElement('img');
        el.src = url; el.alt = '';
        el.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
        item.appendChild(el);
      }
      grid.appendChild(item);
    }
    card.appendChild(grid);
  }

  card.appendChild(footer);
  return card;
}

/** Collapse/expand a reply card and keep its chevron in sync. */
function setReplyCollapsed(card, collapsed) {
  card.classList.toggle('collapsed', collapsed);
  const t = card.querySelector('.reply-toggle');
  if (t) {
    t.textContent = collapsed ? '▸' : '▾';
    t.title = collapsed ? 'Expand reply' : 'Collapse reply';
  }
}

/**
 * Build the per-reply archive control: a button that archives the reply (and
 * its own replies + media) as a standalone thread, or a link to the archived
 * copy if it already exists.
 */
async function buildReplyArchiveAction(reply, parentCode) {
  const wrap = document.createElement('span');
  wrap.className = 'reply-actions';

  const archivedLink = () => {
    const a = document.createElement('a');
    a.className = 'reply-archive-link';
    a.href = chrome.runtime.getURL(`reader/reader.html?code=${encodeURIComponent(reply.code)}`);
    a.target = '_blank';
    a.textContent = 'Archived ✓';
    a.title = 'Open the archived copy of this reply';
    return a;
  };

  // Already archived as its own thread?
  const existing = await getThread(reply.code).catch(() => null);
  if (existing) {
    wrap.appendChild(archivedLink());
    return wrap;
  }

  const btn = document.createElement('button');
  btn.className = 'reply-archive-btn';
  btn.textContent = 'Archive';
  btn.title = (reply.replyCount ?? 0) > 0
    ? `Archive this reply and its ${reply.replyCount} repl${reply.replyCount === 1 ? 'y' : 'ies'}`
    : 'Archive this reply as its own thread';

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Archiving…';

    const res = await new Promise(resolve => {
      chrome.runtime.sendMessage(
        { type: 'ARCHIVE_REPLY', pk: reply.pk, code: reply.code, parent: parentCode },
        r => resolve(r ?? { ok: false, error: chrome.runtime.lastError?.message ?? 'No response from background worker.' }));
    });

    if (res.ok) {
      wrap.replaceChildren(archivedLink());
    } else {
      btn.textContent = 'Failed — retry';
      btn.title = res.authError
        ? 'Not logged in to Threads — open threads.com and log in first.'
        : res.error;
      btn.disabled = false;
    }
  });

  wrap.appendChild(btn);
  return wrap;
}

// ── media helpers ──────────────────────────────────────────────────────────────

async function buildMediaEl(item, partIdx, postCode, mediaMap, thread) {
  const refs = [...(item.images ?? []), ...(item.videos ?? [])];
  if (!refs.length) return null;

  // A ref is "stored" only if its media record actually has bytes.
  const stored  = refs.filter(r => r.archivedId && mediaMap[r.archivedId]?.data);
  const missing = refs.length - stored.length;

  if (!stored.length) {
    // Nothing archived for this part — show a single status note
    const el = document.createElement('div');
    el.className = 'media-not-archived';
    el.textContent = missingMediaMessage(missing, thread);
    return el;
  }

  const grid = buildMediaGrid(refs.length);

  for (const ref of refs) {
    const m    = ref.archivedId ? mediaMap[ref.archivedId] : null;
    const cell = document.createElement('div');
    cell.className = 'media-item';

    if (m?.data) {
      const blob = new Blob([m.data], { type: m.mimeType ?? 'image/jpeg' });
      const url  = URL.createObjectURL(blob);

      if (m.role === 'video') {
        const vid = document.createElement('video');
        vid.src = url; vid.controls = true; vid.preload = 'metadata';
        vid.style.width = '100%'; vid.style.height = '100%';
        // Archived poster frame, if we have one (kept alive for the page's
        // lifetime — poster must remain valid while displayed)
        const poster = ref.posterId ? mediaMap[ref.posterId] : null;
        if (poster?.data) {
          vid.poster = URL.createObjectURL(new Blob([poster.data], { type: poster.mimeType ?? 'image/jpeg' }));
        }
        vid.addEventListener('loadedmetadata', () => URL.revokeObjectURL(url), { once: true });
        cell.appendChild(vid);
      } else {
        const img = document.createElement('img');
        img.src = url; img.alt = '';
        img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
        cell.appendChild(img);
      }
    } else {
      // Expired / not yet repaired. If it's a video whose poster frame we
      // did archive, show that behind the notice instead of a blank tile.
      cell.classList.add('media-expired');
      const poster = ref.posterId ? mediaMap[ref.posterId] : null;
      if (poster?.data) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(new Blob([poster.data], { type: poster.mimeType ?? 'image/jpeg' }));
        img.alt = '';
        img.className = 'poster-fallback';
        cell.appendChild(img);
      }
      const note = document.createElement('div');
      note.className = 'media-expired-inner';
      note.innerHTML = `⚠<br>${esc(missingMediaMessage(1, thread, true))}`;
      cell.appendChild(note);
    }

    grid.appendChild(cell);
  }

  return grid;
}

/** Human message for missing media, aware of whether repair is still pending. */
function missingMediaMessage(count, thread, short = false) {
  const gaveUp = (thread?.mediaRepairAttempts ?? 0) >= 5;
  if (short) {
    return gaveUp ? 'Expired' : 'Expired — retrying on next sync';
  }
  return gaveUp
    ? `${count} media item(s) expired before archiving — source no longer available.`
    : `${count} media item(s) expired before archiving — will retry with fresh URLs on next sync.`;
}

function buildMediaGrid(count) {
  const grid = document.createElement('div');
  grid.className = `media-grid count-${Math.min(count, 4)}`;
  return grid;
}

// ── avatar builder ─────────────────────────────────────────────────────────────

/**
 * Avatar for a thread part: the item's own author avatar when archived
 * (parent-post context on saved replies), else the thread author's avatar.
 */
async function buildItemAvatarEl(thread, item, mediaMap) {
  const m = item.avatarId ? mediaMap[item.avatarId] : null;
  if (m?.data) {
    const url = URL.createObjectURL(new Blob([m.data], { type: m.mimeType ?? 'image/jpeg' }));
    const img = document.createElement('img');
    img.src = url; img.alt = item.username || '';
    img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    return img;
  }
  if (item.username && item.username !== thread.username) {
    const ph = document.createElement('div');
    ph.textContent = item.username[0].toUpperCase();
    return ph;
  }
  return buildAvatarEl(thread, mediaMap, 46, 'avatar');
}

async function buildAvatarEl(thread, mediaMap, size, role) {
  if (thread.profilePicId && mediaMap[thread.profilePicId]) {
    const m = mediaMap[thread.profilePicId];
    const blob = new Blob([m.data], { type: m.mimeType ?? 'image/jpeg' });
    const url  = URL.createObjectURL(blob);
    const img  = document.createElement('img');
    img.className = 'avatar';
    img.style.width = img.style.height = `${size}px`;
    img.src = url; img.alt = thread.username;
    img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    return img;
  }
  const placeholder = document.createElement('div');
  placeholder.className = 'avatar-placeholder';
  placeholder.style.width = placeholder.style.height = `${size}px`;
  placeholder.textContent = (thread.displayName || thread.username || '?')[0].toUpperCase();
  return placeholder;
}

// ── utilities ──────────────────────────────────────────────────────────────────

function showError(msg) {
  loadingEl.style.display = 'none';
  errorEl.style.display   = 'block';
  errorEl.textContent     = `Error: ${msg}`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/**
 * Render raw post text as safe HTML with linked URLs, @mentions, and #tags.
 *
 * Takes UNESCAPED text and does its own escaping — do not pre-escape.
 * Single-pass tokenizer: the old sequential-replace version re-matched the
 * URLs inside its own generated <a href> attributes and produced nested,
 * broken markup.
 */
function linkify(raw) {
  const text = String(raw ?? '');
  // URLs | @mentions (letters/digits/._, as in Threads handles) | #tags
  // (unicode letters/digits/_). Lookbehind stops mid-word matches (emails etc.)
  const re = /https?:\/\/[^\s<>"']+|(?<![\p{L}\p{N}_@#])@[\p{L}\p{N}][\p{L}\p{N}._]*|(?<![\p{L}\p{N}_@#])#[\p{L}\p{N}][\p{L}\p{N}_]*/gu;

  let out = '', last = 0;
  for (const m of text.matchAll(re)) {
    out += esc(text.slice(last, m.index));
    const tok = m[0];

    if (tok.startsWith('http')) {
      // Trim trailing punctuation that's almost certainly sentence-level
      const url   = tok.replace(/[)\].,!?;:]+$/, '');
      const trail = tok.slice(url.length);
      out += `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>${esc(trail)}`;
    } else if (tok.startsWith('@')) {
      const user  = tok.slice(1).replace(/\.+$/, ''); // trailing dot = punctuation
      const trail = tok.slice(1 + user.length);
      out += `<a class="mention" href="https://www.threads.com/@${encodeURIComponent(user)}" target="_blank" rel="noopener">@${esc(user)}</a>${esc(trail)}`;
    } else {
      const tag = tok.slice(1);
      out += `<a class="tag" href="https://www.threads.com/search?q=${encodeURIComponent('#' + tag)}&serp_type=tags" target="_blank" rel="noopener">#${esc(tag)}</a>`;
    }
    last = m.index + tok.length;
  }
  out += esc(text.slice(last));
  return out;
}

function formatDate(ms) {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long',
    day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function relativeTime(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60)          return 'just now';
  if (s < 3600)        return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)       return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7)  return `${Math.floor(s / 86400)}d ago`;
  if (s < 86400 * 30) return `${Math.floor(s / (86400 * 7))}w ago`;
  return new Date(ms).toLocaleDateString();
}
