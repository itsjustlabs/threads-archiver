/**
 * Compatibility probe: when Threads stops answering our requests, work out
 * which part of our request it no longer accepts.
 *
 * The /saved page's own requests keep working when ours break, so the probe
 * captures one (scrolling the page so it asks for more saved posts), replays
 * it to confirm it works, and then replays it again once per difference from
 * our request, with just that one field, header set or variable swapped for
 * ours. The swaps that break it are the cause. On Oct 21 that would have been
 * "__user"; on Oct 14, "variables.first".
 *
 * Runs automatically on a compatibility failure (at most once per Threads
 * build per day, unless turned off in Backup & settings) or on demand.
 * Reports name fields only; values, which include session tokens, never
 * leave the page.
 */

export const DIAG_MODE_KEY   = 'diagnosticsMode';     // 'auto' (default) | 'off'
export const PROBE_LAST_KEY  = 'compatProbeLast';     // { rev, at } of the last automatic run
export const PROBE_REPORTS_KEY = 'compatReports';     // newest first
const KEEP_REPORTS   = 5;
const AUTO_EVERY_MS  = 24 * 60 * 60_000;

export async function diagnosticsMode() {
  const { [DIAG_MODE_KEY]: mode = 'auto' } = await chrome.storage.local.get(DIAG_MODE_KEY);
  return mode;
}

/** Whether an automatic run is allowed now for this Threads build. */
export async function autoProbeDue(rev) {
  if (await diagnosticsMode() === 'off') return false;
  const { [PROBE_LAST_KEY]: last } = await chrome.storage.local.get(PROBE_LAST_KEY);
  return !(last && last.rev === rev && Date.now() - last.at < AUTO_EVERY_MS);
}

export async function getReports() {
  const { [PROBE_REPORTS_KEY]: reports = [] } = await chrome.storage.local.get(PROBE_REPORTS_KEY);
  return reports;
}

/**
 * @param {object} o
 * @param {number} o.tabId      a loaded Threads /saved tab
 * @param {string} o.queryName  friendly name of the query that failed
 * @param {string} o.ourBody    the failing request body (stays in the page)
 * @param {string} o.trigger    'auto' | 'manual'
 * @param {string} o.rev        Threads client build, for the once-per-build limit
 */
export async function runCompatProbe({ tabId, queryName, ourBody, trigger, rev }) {
  const startedAt = Date.now();
  if (trigger === 'auto') await chrome.storage.local.set({ [PROBE_LAST_KEY]: { rev, at: startedAt } });

  // A hidden tab doesn't render, so the page's infinite scroll never asks for
  // more. Bring it forward for the probe, then put back what was in front.
  const tab = await chrome.tabs.get(tabId);
  const [prev] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  await chrome.tabs.update(tabId, { active: true });
  await new Promise(r => setTimeout(r, 1500));

  let result;
  try {
    [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      world:  'MAIN',
      args:   [queryName, ourBody ?? '', OUR_HEADERS],
      func:   probeInPage,
    });
  } catch (e) {
    result = { outcome: 'error', error: String(e?.message ?? e).slice(0, 200) };
  } finally {
    if (prev?.id && prev.id !== tabId) await chrome.tabs.update(prev.id, { active: true }).catch(() => {});
  }

  const report = {
    at: startedAt, trigger, query: queryName, rev,
    ...(result ?? { outcome: 'error', error: 'no result from the page' }),
  };
  report.summary = summarize(report);

  const reports = [report, ...(await getReports())].slice(0, KEEP_REPORTS);
  await chrome.storage.local.set({ [PROBE_REPORTS_KEY]: reports });
  console.log('[archiver] Compatibility probe: ' + JSON.stringify(report));
  return report;
}

// Headers the bridge sends (content/bridge.js handleGQL), lower-cased.
const OUR_HEADERS = ['accept', 'content-type', 'x-csrftoken', 'x-fb-friendly-name', 'x-fb-lsd', 'x-ig-app-id'];

function summarize(r) {
  switch (r.outcome) {
    case 'cause-found':
      return `Threads no longer accepts our ${r.breaking.join(', ')}`;
    case 'combination':
      return 'Our request fails, but no single difference explains it';
    case 'our-request-works':
      return 'Our request matches what Threads accepts (if syncing still fails, the difference is in how it is sent)';
    case 'headers':
      return 'Threads now needs headers the page sends and we don’t';
    case 'no-request-to-compare':
      return 'The page\u2019s request works; there was no request of ours to compare';
    case 'no-page-request':
      return 'The page made no request to compare with';
    case 'control-failed':
      return 'The page’s own request failed too; Threads may be down or the session challenged';
    default:
      return 'Probe failed: ' + (r.error ?? 'unknown error');
  }
}

/**
 * Runs in the Threads page (MAIN world); must be self-contained. Returns
 * names, counts and outcomes only.
 */
async function probeInPage(wantName, ourBody, ourHeaderNames) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const parse = text => {
    try {
      const j = JSON.parse(String(text).replace(/^for \(;;\);/, ''));
      return { dataKeys: Object.keys(j.data ?? {}), errorCount: (j.errors ?? []).length };
    } catch { return { dataKeys: [], errorCount: -1 }; }
  };

  // 1. Capture the page's own request for this query.
  const captured = [];
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__probe = { method, url: String(url), headers: [] };
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    this.__probe?.headers.push([String(k), String(v)]);
    return origHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      const text = (body instanceof FormData || body instanceof URLSearchParams)
        ? new URLSearchParams(body).toString() : typeof body === 'string' ? body : '';
      const name = new URLSearchParams(text).get('fb_api_req_friendly_name');
      if (name && this.__probe) {
        const entry = { ...this.__probe, name, body: text };
        captured.push(entry);
        this.addEventListener('load', () => { entry.status = this.status; Object.assign(entry, parse(this.responseText)); });
      }
    } catch {}
    return origSend.apply(this, arguments);
  };
  const isGood = c => c.status === 200 && c.dataKeys?.length > 0;
  const wanted = c => c.name === wantName && isGood(c);
  // The page paginates saved posts on scroll, so this captures the pagination
  // query; any of the page's saved-posts requests is fine to compare with.
  const usable = c => /SavedPage/.test(c.name) && isGood(c);
  try {
    for (let i = 0; i < 8 && !captured.some(c => wanted(c) || usable(c)); i++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      for (const el of document.querySelectorAll('*')) {
        if (el.scrollHeight > el.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
          el.scrollTop = el.scrollHeight;
        }
      }
      await sleep(2500);
    }
  } finally {
    XMLHttpRequest.prototype.open = origOpen;
    XMLHttpRequest.prototype.send = origSend;
    XMLHttpRequest.prototype.setRequestHeader = origHeader;
  }
  const page = captured.find(wanted) ?? captured.find(usable);
  if (!page) return { outcome: 'no-page-request', pageRequests: captured.map(c => c.name).slice(0, 10) };

  // 2. Replays. "Works" = same top-level data as the page's own answer and no
  //    more errors (the page's answer often carries a couple of field errors).
  let requests = 0;
  const send = (body, headers) => new Promise(resolve => {
    requests++;
    const x = new XMLHttpRequest();
    origOpen.call(x, page.method, page.url);
    for (const [k, v] of headers) origHeader.call(x, k, v);
    x.onload = () => resolve({ status: x.status, ...parse(x.responseText) });
    x.onerror = () => resolve({ status: 0, dataKeys: [], errorCount: -1 });
    origSend.call(x, body);
  });
  const control = await send(page.body, page.headers);
  const works = r => r.status === 200 && r.errorCount >= 0 &&
    JSON.stringify(r.dataKeys) === JSON.stringify(control.dataKeys) && r.errorCount <= control.errorCount;
  if (!(control.status === 200 && control.dataKeys.length)) {
    return { outcome: 'control-failed', pageQuery: page.name, requests };
  }
  const ourHeaders = page.headers.filter(([k]) => ourHeaderNames.includes(k.toLowerCase()));
  await sleep(700);
  const headersOk = works(await send(page.body, ourHeaders));
  let ourBodyOk = null;
  if (ourBody) { await sleep(700); ourBodyOk = works(await send(ourBody, page.headers)); }

  if (!headersOk) {
    return { outcome: 'headers', pageQuery: page.name, requests,
             headersPageOnly: page.headers.map(([k]) => k.toLowerCase()).filter(k => !ourHeaderNames.includes(k)) };
  }
  if (!ourBody || ourBodyOk) {
    return { outcome: ourBody ? 'our-request-works' : 'no-request-to-compare', pageQuery: page.name, requests };
  }

  // 3. One swap per difference. fb_dtsg and jazoest are checked as a pair:
  //    jazoest is a checksum of fb_dtsg, so one alone is always wrong.
  const pageP = new URLSearchParams(page.body);
  const ourP  = new URLSearchParams(ourBody);
  const units = [];
  const skip = new Set(['variables', 'fb_dtsg', 'jazoest', 'doc_id', 'fb_api_req_friendly_name']);
  for (const k of new Set([...pageP.keys(), ...ourP.keys()])) {
    if (!skip.has(k) && pageP.get(k) !== ourP.get(k)) units.push({ name: k, fields: [k] });
  }
  if (pageP.get('fb_dtsg') !== ourP.get('fb_dtsg') || pageP.get('jazoest') !== ourP.get('jazoest')) {
    units.push({ name: 'fb_dtsg+jazoest', fields: ['fb_dtsg', 'jazoest'] });
  }
  let pageVars = {}, ourVars = {};
  try { pageVars = JSON.parse(pageP.get('variables') || '{}'); } catch {}
  try { ourVars  = JSON.parse(ourP.get('variables') || '{}'); } catch {}
  // Only variables the page's query also takes; ours may be for another query.
  for (const k of Object.keys(pageVars)) {
    if (k === 'after') continue;   // a cursor: the page's points into its own list
    if (JSON.stringify(pageVars[k]) !== JSON.stringify(ourVars[k])) units.push({ name: `variables.${k}`, variable: k });
  }

  const MAX_SWAPS = 20;
  const breaking = [], harmless = [];
  for (const u of units.slice(0, MAX_SWAPS)) {
    const b = new URLSearchParams(page.body);
    if (u.variable) {
      const v = { ...pageVars };
      if (u.variable in ourVars) v[u.variable] = ourVars[u.variable]; else delete v[u.variable];
      b.set('variables', JSON.stringify(v));
    } else {
      for (const f of u.fields) { if (ourP.has(f)) b.set(f, ourP.get(f)); else b.delete(f); }
    }
    await sleep(700);   // gentle: this runs while Threads is already unhappy with us
    (works(await send(b.toString(), page.headers)) ? harmless : breaking).push(u.name);
  }
  return {
    outcome: breaking.length ? 'cause-found' : 'combination',
    pageQuery: page.name, requests, breaking, harmless,
    untested: units.slice(MAX_SWAPS).map(u => u.name),
  };
}
