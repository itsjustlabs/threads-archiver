/**
 * Content script bridge — injected into threads.com pages.
 *
 * Runs same-origin inside a Threads tab so fetch() carries all cookies
 * automatically and there are no CORS complications.
 *
 * Idempotent: the window.__threadsArchiverBridge guard prevents double-registration
 * when both manifest auto-injection and chrome.scripting.executeScript run.
 */

if (!window.__threadsArchiverBridge) {
  window.__threadsArchiverBridge = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'BRIDGE_PING':
        sendResponse({ ok: true });
        return false;

      case 'BRIDGE_META':
        handleMeta().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;

      case 'BRIDGE_GQL':
        handleGQL(msg.body, msg.friendlyName).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
  });

  console.log('[archiver bridge] Ready on', location.href);
}

// ── meta-params ───────────────────────────────────────────────────────────────
// Threads embeds these tokens in the HTML bootstrap scripts (same format as
// all Meta apps). We fetch /saved fresh so we always get real script content,
// not a cached SPA shell from the current page's innerHTML.

async function handleMeta() {
  let html;
  try {
    // Same-origin fetch — cookies included, no CORS, guaranteed real HTML
    const res = await fetch('https://www.threads.com/saved', {
      headers: { 'Accept': 'text/html' },
    });
    html = await res.text();
    console.log('[archiver bridge] Fetched /saved — HTML length:', html.length);
  } catch (e) {
    console.warn('[archiver bridge] /saved fetch failed, using current page HTML:', e.message);
    html = document.documentElement.innerHTML;
  }

  const ex = (re, fb = '') => { const m = html.match(re); return m?.[1] ?? fb; };

  const meta = {
    lsd:   ex(/"LSD",\[\],\{"token":"([^"]+)"/),
    __hs:  ex(/"haste_session":"([^"]+)"/),
    __rev: ex(/"client_revision":(\d+)/),
    __s:   ex(/"session_id":"([^"]+)"/),
    __hsi: ex(/"hsi":"([^"]+)"/),
    __dyn: ex(/"dynamic_js_bundle":"([^"]+)"/),
    __csr: ex(/"client_sr_version":"([^"]+)"/),
  };

  // Log a non-sensitive summary so you can verify in the Threads tab's console
  console.log('[archiver bridge] Meta-params extracted:', {
    lsd:   meta.lsd   ? meta.lsd.slice(0, 10) + '…'  : '(EMPTY)',
    __hs:  meta.__hs  ? meta.__hs.slice(0, 10) + '…' : '(EMPTY)',
    __rev: meta.__rev || '(EMPTY)',
  });

  return {
    ok:        true,
    meta,
    dsUserId:  getCookieVal('ds_user_id'),
    csrfToken: getCookieVal('csrftoken'),
  };
}

// ── GQL fetch ─────────────────────────────────────────────────────────────────

async function handleGQL(body, friendlyName) {
  const csrf = getCookieVal('csrftoken');
  // lsd is included in the body; X-FB-LSD mirrors what the page itself sends.
  const lsd  = (new URLSearchParams(body)).get('lsd') ?? '';
  const res  = await fetch('https://www.threads.com/graphql/query', {
    method: 'POST',
    headers: {
      'Content-Type':       'application/x-www-form-urlencoded',
      'X-CSRFToken':        csrf,
      'X-IG-App-ID':        '238260118697367',
      'X-FB-LSD':           lsd,
      'X-FB-Friendly-Name': friendlyName ?? 'ThreadsArchiverBridge',
      'Accept':             '*/*',
    },
    body,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} from GraphQL`);
  const text = await res.text();
  const json = JSON.parse(text.replace(/^for \(;;\);/, ''));

  // Log the top-level shape so you can see it in the Threads tab console
  console.log(`[archiver bridge] ${friendlyName ?? 'GQL'} response:`,
    json?.errors?.length ? `${json.errors.length} error(s)` : 'ok',
    'data keys:', Object.keys(json?.data ?? {}));

  return { ok: true, json };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function getCookieVal(name) {
  const match = document.cookie
    .split(';')
    .map(c => c.trim())
    .find(c => c.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : '';
}
