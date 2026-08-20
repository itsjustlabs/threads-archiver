/**
 * Archive timeline — full-tab browsing view for all saved threads.
 * An expanded version of the popup list: search, sort, missing-media filter,
 * month-grouped cards with lazily loaded media thumbnails.
 *
 * Cards link to reader/reader.html; the reader's "← All saves" links back here.
 */

import { getAllThreads, getMediaForPost, getAllMediaIds } from '../shared/db.js';

const timelineEl  = document.getElementById('timeline');
const countLabel  = document.getElementById('countLabel');
const searchInput = document.getElementById('searchInput');
const sortSelect  = document.getElementById('sortSelect');
const missingBtn  = document.getElementById('missingFilter');

let _query       = '';
let _sort        = 'newest';
let _onlyMissing = false;

// Lazy media loading: fill a card's avatar + thumbs when it scrolls into view
const _observer = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (e.isIntersecting) {
      _observer.unobserve(e.target);
      loadCardMedia(e.target).catch(() => {});
    }
  }
}, { rootMargin: '400px' });

await render();

// ── controls ───────────────────────────────────────────────────────────────────

let _debounce = null;
searchInput.addEventListener('input', () => {
  clearTimeout(_debounce);
  _debounce = setTimeout(() => {
    _query = searchInput.value.trim().toLowerCase();
    render();
  }, 150);
});

sortSelect.addEventListener('change', () => { _sort = sortSelect.value; render(); });

missingBtn.addEventListener('click', () => {
  _onlyMissing = !_onlyMissing;
  missingBtn.classList.toggle('active', _onlyMissing);
  render();
});

// ── render ─────────────────────────────────────────────────────────────────────

async function render() {
  const all      = await getAllThreads();
  const mediaIds = new Set(await getAllMediaIds().catch(() => []));
  for (const t of all) t._missing = countMissingMedia(t, mediaIds);

  const totalMissing = all.filter(t => t._missing > 0).length;
  missingBtn.textContent = totalMissing ? `⚠ ${totalMissing}` : '⚠';
  missingBtn.style.display = (totalMissing || _onlyMissing) ? '' : 'none';

  let threads = filterThreads(all, _query);
  if (_onlyMissing) threads = threads.filter(t => t._missing > 0);
  threads = sortThreads(threads, _sort);

  countLabel.textContent = _query || _onlyMissing
    ? `${threads.length} of ${all.length} saves`
    : `${all.length} saves`;

  timelineEl.innerHTML = '';

  if (!threads.length) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = all.length
      ? 'Nothing matches the current search / filter.'
      : 'No archived threads yet.\nOpen the extension popup and hit Sync.';
    timelineEl.appendChild(note);
    return;
  }

  let lastMonth = null;
  const frag = document.createDocumentFragment();

  for (const t of threads) {
    const month = monthLabel(sortTimestamp(t, _sort) * 1000);
    if (month !== lastMonth) {
      lastMonth = month;
      const label = document.createElement('div');
      label.className = 'month-label';
      label.textContent = month;
      frag.appendChild(label);
    }
    frag.appendChild(buildCard(t));
  }

  timelineEl.appendChild(frag);
}

function buildCard(t) {
  const card = document.createElement('a');
  card.className = 'card';
  card.href = `../reader/reader.html?code=${encodeURIComponent(t.code)}`;
  card.dataset.code = t.code;
  if (t._missing > 0) card.classList.add('has-missing');

  const head = document.createElement('div');
  head.className = 'card-head';

  const av = document.createElement('div');
  av.className = 'avatar-ph';
  av.textContent = (t.displayName || t.username || '?')[0].toUpperCase();
  head.appendChild(av);

  const who = document.createElement('div');
  who.className = 'who';
  who.innerHTML = `
    <div class="name">${esc(t.displayName || t.username)}</div>
    <div class="handle">@${esc(t.username)}</div>
  `;
  head.appendChild(who);

  const date = document.createElement('div');
  date.className = 'card-date';
  date.textContent = relativeTime(sortTimestamp(t, _sort) * 1000);
  date.title = new Date(t.takenAt * 1000).toLocaleString();
  head.appendChild(date);

  card.appendChild(head);

  if (t.text) {
    const text = document.createElement('div');
    text.className = 'card-text';
    text.textContent = t.text;
    card.appendChild(text);
  }

  // Thumbs container filled lazily (see IntersectionObserver)
  const mediaCount = countMediaRefs(t);
  if (mediaCount > 0) {
    const thumbs = document.createElement('div');
    thumbs.className = 'thumbs';
    thumbs.dataset.count = mediaCount;
    card.appendChild(thumbs);
  }

  const stats = document.createElement('div');
  stats.className = 'card-stats';
  const bits = [`♥ ${t.likeCount ?? 0}`];
  if ((t.replyCount ?? 0) > 0) bits.push(`💬 ${t.replyCount}`);
  if ((t.replies?.length ?? 0) > 0) bits.push(`${t.replies.length} archived`);
  if (t.sourceParent) bits.push('↳ from a reply');
  stats.innerHTML = bits.map(b => `<span>${esc(b)}</span>`).join('');
  if (t._missing > 0) {
    stats.innerHTML += `<span class="warn">⚠ ${t._missing} media missing</span>`;
  }
  card.appendChild(stats);

  _observer.observe(card);
  return card;
}

/** Fill in a card's avatar + media thumbnails from IndexedDB. */
async function loadCardMedia(card) {
  const code  = card.dataset.code;
  const media = await getMediaForPost(code);
  if (!media.length) return;

  const byId = Object.fromEntries(media.map(m => [m.id, m]));

  // Avatar
  const avatarRec = byId[`${code}/avatar/0`];
  if (avatarRec?.data) {
    const img = document.createElement('img');
    img.className = 'avatar';
    img.src = blobUrl(avatarRec);
    card.querySelector('.avatar-ph')?.replaceWith(img);
  }

  // Thumbs: root-post images + video posters (skip reply media + avatars)
  const thumbsEl = card.querySelector('.thumbs');
  if (!thumbsEl) return;

  const displayable = media
    .filter(m => !m.id.includes('/reply-') && (m.role === 'image' || m.role === 'thumbnail'))
    .sort((a, b) => a.id.localeCompare(b.id));

  const MAX = 3;
  for (const m of displayable.slice(0, MAX)) {
    if (!m.data) continue;
    const img = document.createElement('img');
    img.src = blobUrl(m);
    img.loading = 'lazy';
    thumbsEl.appendChild(img);
  }
  const total = Number(thumbsEl.dataset.count || displayable.length);
  if (total > MAX) {
    const more = document.createElement('div');
    more.className = 'thumb-more';
    more.textContent = `+${total - MAX}`;
    thumbsEl.appendChild(more);
  }
  if (!thumbsEl.children.length) thumbsEl.remove();
}

function blobUrl(m) {
  const url = URL.createObjectURL(new Blob([m.data], { type: m.mimeType ?? 'image/jpeg' }));
  // Timeline images stay visible indefinitely — revoke lazily after load
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
  return url;
}

// ── filter / sort (same semantics as the popup) ───────────────────────────────

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

function lastActivity(t) {
  if (t.lastActivityAt) return t.lastActivityAt;
  let latest = t.takenAt ?? 0;
  for (const r of t.replies ?? []) {
    if ((r.takenAt ?? 0) > latest) latest = r.takenAt;
  }
  return latest;
}

function sortTimestamp(t, sort) {
  switch (sort) {
    case 'updated':  return lastActivity(t);
    case 'archived': return Math.floor((t.archivedAt ?? 0) / 1000);
    default:         return t.takenAt ?? 0;
  }
}

function sortThreads(threads, sort) {
  const s = [...threads];
  switch (sort) {
    case 'oldest':   return s.sort((a, b) => (a.takenAt ?? 0) - (b.takenAt ?? 0));
    case 'updated':  return s.sort((a, b) => lastActivity(b) - lastActivity(a));
    case 'archived': return s.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
    default:         return s.sort((a, b) => (b.takenAt ?? 0) - (a.takenAt ?? 0));
  }
}

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

function countMediaRefs(t) {
  let n = 0;
  for (const item of t.threadItems ?? []) {
    n += (item.images?.length ?? 0) + (item.videos?.length ?? 0);
  }
  return n;
}

// ── utilities ──────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function monthLabel(ms) {
  return new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
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
