/**
 * Threads internal GraphQL client — routes all requests through the
 * content script bridge (content/bridge.js) running in a Threads tab.
 *
 * Why: fetch() from a service worker is cross-origin to threads.com, so
 * it needs CORS + credential handling that Threads doesn't support for
 * arbitrary origins. The content script runs inside a Threads tab, so
 * its fetch() calls are same-origin — cookies automatic, no CORS.
 */

// ── query definitions ─────────────────────────────────────────────────────────
// docId + provider values below are a snapshot (verified live 2026-07-10).
// Meta rotates doc_ids and provider sets. At sync time, worker.js tries to
// resolve fresh values from the page's Relay module registry
// (require('<module>').params) and passes them via setMetaParams({ queries }).
// The snapshot is only the fallback for modules not loaded on the current page.

const P = n => `__relay_internal__pv__Barcelona${n}relayprovider`;

// Shared provider flags (27) required by the saved-page queries.
const SAVED_PROVIDERS = {
  [P('IsLoggedIn')]:                     true,
  [P('HasPrivateRepliesDeprecation')]:   true,
  [P('HasDearAlgoConsumption')]:         true,
  [P('HasEventBadge')]:                  false,
  [P('GenAIRepliesEnabled')]:            false,
  [P('IsSearchDiscoveryEnabled')]:       true,
  [P('HasCommunities')]:                 true,
  [P('HasGameScoreShare')]:              true,
  [P('HasPublicViewCountCard')]:         true,
  [P('HasCommunityEntityCard')]:         true,
  [P('HasScorecardCommunity')]:          true,
  [P('HasSportTeamAllegianceCard')]:     true,
  [P('HasMusic')]:                       true,
  [P('HasNewspaperLinkStyle')]:          false,
  [P('HasMessaging')]:                   false,
  [P('HasPodcastTextFragments')]:        false,
  [P('ShouldFulfillLightboxQuery')]:     false,
  [P('HasViewerReplied')]:               true,
  [P('HasGhostPostEmojiActivation')]:    false,
  [P('OptionalCookiesEnabled')]:         true,
  [P('HasDearAlgoWebProduction')]:       true,
  [P('HasWebFavicons')]:                 true,
  [P('IsCrawler')]:                      false,
  [P('HasCommunityTopContributors')]:    false,
  [P('CanSeeSponsoredContent')]:         false,
  [P('ShouldShowFediverseM075Features')]: true,
  [P('IsInternalUser')]:                 false,
};

// Post-page query needs the 27 above + 4 more (31 total).
const POST_PAGE_PROVIDERS = {
  ...SAVED_PROVIDERS,
  [P('HasPermalinkIndentation')]:        false,
  [P('HasPostAuthorNotifControls')]:     true,
  [P('ShouldShowFediverseM1Features')]:  true,
  [P('HasPermalinkPodcastCard')]:        false,
};

export const QUERY_DEFS = {
  SAVED_VIEWER: {
    name:      'BarcelonaSavedPageViewerQuery',
    module:    'BarcelonaSavedPageViewerQuery.graphql',
    docId:     '28630728353184508',
    providers: SAVED_PROVIDERS,
  },
  SAVED_REFETCH: {
    name:      'BarcelonaSavedPageRefetchableQuery',
    module:    'BarcelonaSavedPageRefetchableQuery.graphql',
    docId:     '27876850938599212',
    providers: SAVED_PROVIDERS,
  },
  THREAD_DETAIL: {
    name:      'BarcelonaPostPageDirectQuery',
    module:    'BarcelonaPostPageDirectQuery.graphql',
    docId:     '36740430502268116',
    providers: POST_PAGE_PROVIDERS,
  },
  REPLY_COUNTS: {
    name:      'useBarcelonaBatchedDynamicPostCountsSubscriptionQuery',
    module:    'useBarcelonaBatchedDynamicPostCountsSubscriptionQuery.graphql',
    docId:     '27196539320018072',
    providers: {},
  },
};

// ── bridge tab state ──────────────────────────────────────────────────────────
// Set by background/worker.js before any sync begins.

let _bridgeTabId = null;
let _metaCache   = null;

export function setBridgeTab(tabId) {
  _bridgeTabId = tabId;
  _metaCache   = null;
}

/** Called by worker.js with params extracted from the page's MAIN world. */
export function setMetaParams(params) {
  _metaCache = params;
}

export class AuthError extends Error {
  constructor(msg) { super(msg); this.name = 'AuthError'; }
}

// ── bridge messaging ──────────────────────────────────────────────────────────

async function sendBridge(msg) {
  if (!_bridgeTabId) throw new Error('No bridge tab — call setBridgeTab() first.');
  let res;
  try {
    res = await chrome.tabs.sendMessage(_bridgeTabId, msg);
  } catch (e) {
    throw new Error(`Bridge unreachable (tab ${_bridgeTabId}): ${e.message}`);
  }
  if (!res?.ok) throw new Error(res?.error ?? 'Unknown bridge error');
  return res;
}

// ── meta-params ───────────────────────────────────────────────────────────────

async function fetchMetaParams() {
  if (_metaCache) return _metaCache;
  throw new Error('Meta-params not initialized — call setMetaParams() before gqlQuery().');
}

// ── core GQL request ──────────────────────────────────────────────────────────

/**
 * Resolve the effective { docId, name, providers } for a query key:
 * dynamic values extracted from the live page win; snapshot is fallback.
 */
function resolveQuery(key) {
  const def = QUERY_DEFS[key];
  if (!def) throw new Error(`Unknown query key: ${key}`);
  const dyn = _metaCache?.queries?.[key];
  return {
    live:      Boolean(dyn?.docId),
    name:      dyn?.name  ?? def.name,
    docId:     dyn?.docId ?? def.docId,
    providers: (dyn?.providers && Object.keys(dyn.providers).length)
      ? dyn.providers
      : def.providers,
  };
}

export async function gqlQuery(queryKey, variables = {}) {
  const meta = await fetchMetaParams();
  const q    = resolveQuery(queryKey);

  const body = new URLSearchParams({
    doc_id:    q.docId,
    variables: JSON.stringify({ ...variables, ...q.providers }),
    fb_api_req_friendly_name: q.name,
    fb_api_caller_class:      'RelayModern',
    server_timestamps:        'true',
    lsd:       meta.lsd    ?? '',
    __a:       '1',
    __hs:      meta.__hs   ?? '',
    __rev:     meta.__rev  ?? '',
    __s:       meta.__s    ?? '',
    __hsi:     meta.__hsi  ?? '',
    __dyn:     meta.__dyn  ?? '',
    __csr:     meta.__csr  ?? '',
    av:        meta._dsUserId,
    __user:    meta._dsUserId,
  });

  const res  = await sendBridge({ type: 'BRIDGE_GQL', body: body.toString(), friendlyName: q.name });
  const json = res.json;

  if (json?.data?.xdt_text_app_viewer === null) {
    _metaCache = null;
    throw new AuthError('Session expired — please log in to Threads and try again.');
  }

  // Meta returns HTTP 200 + {"errors":[{"message":"execution error"...}], "data":null}
  // when the doc_id is stale or variables don't match the persisted query.
  if (!json?.data && json?.errors?.length) {
    const source = q.live
      ? 'read live from the Threads /saved page, so Threads may have renamed or changed this query'
      : 'built-in fallback — the live value could not be read from the Threads /saved tab';
    throw new Error(`GraphQL execution error for ${q.name} (doc_id ${q.docId}, ${source}).`);
  }

  return json;
}

// ── saved posts pagination ────────────────────────────────────────────────────

export async function fetchAllSaved(onPage) {
  // Viewer query takes NO plain variables — provider flags only.
  let json  = await gqlQuery('SAVED_VIEWER');
  let saved = json?.data?.xdt_text_app_viewer?.saved_media;
  if (!saved) throw new AuthError('Could not fetch saved posts — are you logged in to Threads?');

  await onPage(saved.edges ?? []);

  let cursor  = saved.page_info?.end_cursor;
  let hasNext = saved.page_info?.has_next_page;

  while (hasNext && cursor) {
    // Refetch query paginates with { first, after } (NOT count/cursor).
    json    = await gqlQuery('SAVED_REFETCH', { first: 20, after: cursor });
    saved   = json?.data?.xdt_text_app_viewer?.saved_media;
    if (!saved) break;
    await onPage(saved.edges ?? []);
    cursor  = saved.page_info?.end_cursor;
    hasNext = saved.page_info?.has_next_page;
  }
}

// ── shortcode → numeric pk ───────────────────────────────────────────────────
// BarcelonaPostPageDirectQuery's postID is the numeric media pk, not the
// URL shortcode. Standard Instagram base64url decode.

const SHORTCODE_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function codeToPk(code) {
  let n = 0n;
  for (const c of code) {
    const i = SHORTCODE_ALPHABET.indexOf(c);
    if (i === -1) throw new Error(`Invalid shortcode char '${c}' in ${code}`);
    n = n * 64n + BigInt(i);
  }
  return n.toString();
}

// ── thread detail ─────────────────────────────────────────────────────────────

/**
 * Fetch full thread detail for a post.
 * @param postPk numeric media pk (use codeToPk(code) if you only have the shortcode)
 * @returns { containing_thread, reply_threads } — synthesized from the new
 *          BarcelonaPostPageDirectQuery shape, where data.data.edges[0] is the
 *          containing thread and the remaining edges are reply threads.
 */
export async function fetchThreadDetail(postPk) {
  const json  = await gqlQuery('THREAD_DETAIL', {
    postID:     String(postPk),
    sort_order: 'TOP',
  });
  const edges = json?.data?.data?.edges;
  if (!Array.isArray(edges) || !edges.length) return null;

  return {
    containing_thread: edges[0]?.node ?? null,
    reply_threads:     edges.slice(1).map(e => e.node).filter(Boolean),
  };
}

// ── reply counts (delta detection) ───────────────────────────────────────────

export async function fetchCounts(postIds) {
  const json  = await gqlQuery('REPLY_COUNTS', { post_ids: postIds });
  // Current shape: data.data.posts[]. (Older shape was
  // data.xdt_api__v1__media__batch.items — kept as fallback.)
  const items = json?.data?.data?.posts
             ?? json?.data?.xdt_api__v1__media__batch?.items
             ?? [];
  const out   = {};
  for (const item of items) {
    out[item.pk] = {
      replyCount: item.text_post_app_info?.direct_reply_count ?? 0,
      likeCount:  item.like_count ?? 0,
    };
  }
  return out;
}

// ── media download ────────────────────────────────────────────────────────────
// Media URLs are CDN (scontent-*.cdninstagram.com) — no auth needed, so these
// fetch directly from the service worker (no bridge needed).

const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

export async function downloadMedia(url) {
  try {
    const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
    const len  = parseInt(head?.headers?.get('content-length') ?? '0', 10);
    if (len > MAX_MEDIA_BYTES) {
      console.warn(`[archiver] Skipping ${url}: ${len} bytes > 100 MB limit`);
      return null;
    }
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_MEDIA_BYTES) {
      console.warn(`[archiver] Discarding ${url}: body was ${buf.byteLength} bytes`);
      return null;
    }
    return buf;
  } catch (e) {
    console.warn(`[archiver] Failed to download ${url}:`, e.message);
    return null;
  }
}

// ── raw-edge normalizer ───────────────────────────────────────────────────────

export function normalizePost(node) {
  const post = node?.thread_items?.[0]?.post ?? node;
  const user = post?.user ?? {};

  // Each thread item carries its own author: when the saved post is a reply,
  // thread_items includes the parent post(s), possibly by OTHER authors.
  const threadItems = (node?.thread_items ?? []).map(item => {
    const p = item.post ?? {};
    const u = p.user ?? {};
    return {
      text:        p.caption?.text ?? '',
      code:        p.code ?? '',
      username:    u.username ?? '',
      displayName: u.full_name ?? u.username ?? '',
      avatarUrl:   u.profile_pic_url ?? null,
      avatarId:    null,
      images:      extractImages(p),
      videos:      extractVideos(p),
    };
  });

  const replies = (node?.reply_thread_items ?? []).map(item => {
    const p = item.post ?? {};
    const u = p.user ?? {};
    return {
      pk: p.pk ?? '', code: p.code ?? '', username: u.username ?? '',
      text: p.caption?.text ?? '', takenAt: p.taken_at ?? 0,
      likeCount:  p.like_count ?? 0,
      replyCount: p.text_post_app_info?.direct_reply_count ?? 0,
      avatarUrl:  u.profile_pic_url ?? null,
      avatarId:   null,
      images: extractImages(p), videos: extractVideos(p),
    };
  });

  return {
    code:          post.code        ?? '',
    pk:            post.pk          ?? '',
    username:      user.username    ?? '',
    displayName:   user.full_name   ?? user.username ?? '',
    profilePicUrl: user.profile_pic_url ?? null,
    text:          post.caption?.text ?? '',
    takenAt:       post.taken_at    ?? 0,
    likeCount:     post.like_count  ?? 0,
    replyCount:    post.text_post_app_info?.direct_reply_count ?? 0,
    threadItems,
    replies,
    profilePicId:   null,
    maxReplyPk:     null,
    archivedAt:     0,
    lastCheckedAt:  0,
    detailFetched:  false,
  };
}

function bestImage(versions) {
  if (!Array.isArray(versions) || !versions.length) return null;
  return versions.reduce((best, v) => (v.width ?? 0) > (best.width ?? 0) ? v : best);
}

/**
 * Extract still-image refs from a post.
 *
 * A post (or carousel item) that has video_versions ALSO has image_versions2 —
 * that image is the video's poster/thumbnail, not a separate media item
 * (Threads renders it as one item). Poster frames are attached to the video
 * ref in extractVideos() instead of being returned here.
 */
export function extractImages(post) {
  const urls = [];
  if (!post.video_versions?.length && post.image_versions2?.candidates?.length) {
    const img = bestImage(post.image_versions2.candidates);
    if (img?.url) urls.push({ url: img.url, width: img.width, height: img.height });
  }
  if (post.carousel_media?.length) {
    for (const m of post.carousel_media) {
      if (m.video_versions?.length) continue; // carousel video — handled in extractVideos
      const img = bestImage(m.image_versions2?.candidates ?? []);
      if (img?.url) urls.push({ url: img.url, width: img.width, height: img.height });
    }
  }
  return urls;
}

/** Extract video refs (top-level and carousel), each with its poster frame. */
export function extractVideos(post) {
  const urls = [];

  const pushVideo = (container) => {
    const vid = container.video_versions?.[0];
    if (!vid?.url) return;
    urls.push({
      url: vid.url, width: vid.width, height: vid.height,
      durationMs: container.video_duration ? Math.round(container.video_duration * 1000) : null,
      posterUrl:  bestImage(container.image_versions2?.candidates ?? [])?.url ?? null,
    });
  };

  if (post.video_versions?.length) pushVideo(post);
  for (const m of post.carousel_media ?? []) {
    if (m.video_versions?.length) pushVideo(m);
  }
  return urls;
}
