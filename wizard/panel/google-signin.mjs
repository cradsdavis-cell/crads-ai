// google-signin.mjs — the interactive OAuth leg of the verified handshake (D58 spec
// 2026-07-24 § 1). System browser -> Google -> loopback redirect -> PKCE code
// exchange -> ID token. Zero dependencies; every side effect is injectable for tests.
//
// SECURITY CONTRACT (enforced rock-side in idtoken-verify.mjs): the OIDC `nonce`
// MUST be the device fingerprint of the key being enrolled. The rock verifies
// nonce == deviceFingerprint(staged pubkey), so a token minted here can only ever
// enrol THIS device's key. Callers pass nonce explicitly; there is no default.
//
// The public repository ships NO Google client. The Connect Google flow never
// needs one from here (it uses the client_secret_*.json the person drops in the
// app, google-connect-routes.mjs); this default is only for the identity
// handshake, and a deployment that uses it sets AIOS_OAUTH_AUDIENCE and
// AIOS_OAUTH_CLIENT_SECRET to its own installed-app client.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

export const GOOGLE_DESKTOP_CLIENT = {
  id: process.env.AIOS_OAUTH_AUDIENCE || '',
  secret: process.env.AIOS_OAUTH_CLIENT_SECRET || '',
};

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function pkcePair() {
  const verifier = randomBytes(48).toString('base64url');          // 64 chars, in [43,128]
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthUrl({ clientId, redirectUri, nonce, state, challenge, loginHint, scope = 'openid email profile', offline = false }) {
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', scope);
  // The identity path (D58) always sends a nonce because the rock verifies it
  // against the staged key. The BYO-token path has no id_token contract, so it
  // sends none; an unconditional String(nonce) here would leak "undefined".
  if (nonce !== undefined && nonce !== null && nonce !== '') u.searchParams.set('nonce', String(nonce));
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (offline) {
    // Google mints a refresh_token only for access_type=offline, and only on a
    // consent screen actually shown: without prompt=consent a repeat sign-in
    // returns an access token alone and the box dies within the hour.
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
  } else {
    u.searchParams.set('prompt', 'select_account');
  }
  if (loginHint) u.searchParams.set('login_hint', loginHint);
  return u.toString();
}

// Default browser opener per platform; injectable in tests and in the app shell.
// Command to open a URL in the OS default browser, per platform. CRITICAL (2026-07-24):
// Windows must NOT go through `cmd /c start`, because cmd treats every `&` in the URL as a
// command separator, so an OAuth URL is truncated at the first `&` (the browser gets only
// client_id and Google 400s "response_type missing"). rundll32 url.dll,FileProtocolHandler
// receives the URL as a single argument via CreateProcess with no shell parsing, so
// ampersands survive. macOS/Linux already pass the URL as one argv token. Pure + exported
// so the ampersand-safety is unit-tested without opening a real browser.
export function browserCommand(platform, url) {
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}

function defaultOpenBrowser(url) {
  const { cmd, args } = browserCommand(process.platform, url);
  return new Promise((resolve) => {
    try { const c = spawn(cmd, args, { detached: true, stdio: 'ignore' }); c.on('error', () => resolve(false)); c.unref(); resolve(true); }
    catch { resolve(false); }
  });
}

const DONE_PAGE = '<!doctype html><meta charset="utf-8"><title>Signed in</title>'
  + '<body style="font:16px system-ui;display:flex;height:100vh;align-items:center;justify-content:center">'
  + '<div><h2>Signed in.</h2><p>You can close this tab and go back to the Crads-AI app.</p></div>';
const FAIL_PAGE = (why) => '<!doctype html><meta charset="utf-8"><title>Sign-in problem</title>'
  + '<body style="font:16px system-ui;display:flex;height:100vh;align-items:center;justify-content:center">'
  + `<div><h2>Sign-in did not complete.</h2><p>${why} You can close this tab and try again from the app.</p></div>`;

// The loopback + PKCE + code-exchange core, shared by both entry points below.
// Returns the RAW token-endpoint JSON on success; each caller owns its own
// contract on top (identity demands an id_token, BYO demands access + refresh
// tokens). Extracted 2026-08-17 for the BYO-Google flow rather than duplicated,
// so the state-check and Windows-ampersand lessons stay in one place.
async function runCodeFlow({
  clientId, clientSecret, authParams,
  openBrowser, fetcher, timeoutMs, tokenUrl, port = 0,
}) {
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(24).toString('base64url');

  let settle;
  const outcome = new Promise((res) => { settle = res; });
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/oauth2cb') { res.writeHead(404); res.end(); return; }
    const gotState = u.searchParams.get('state');
    if (gotState !== state) {
      // Wrong or forged state: refuse THIS request but keep listening. Accepting it
      // would let any local page complete someone else's flow.
      res.writeHead(400, { 'content-type': 'text/html' }); res.end(FAIL_PAGE('The sign-in link did not match this session.'));
      return;
    }
    const err = u.searchParams.get('error');
    if (err) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(FAIL_PAGE('Access was denied.')); settle({ ok: false, reason: `sign-in denied or cancelled (${err})` }); return; }
    const code = u.searchParams.get('code');
    if (!code) { res.writeHead(400, { 'content-type': 'text/html' }); res.end(FAIL_PAGE('No sign-in code arrived.')); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(DONE_PAGE);
    settle({ ok: true, code });
  });

  await new Promise((res) => server.listen(port, '127.0.0.1', res));
  const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2cb`;
  const timer = setTimeout(() => settle({ ok: false, reason: `sign-in timed out after ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);

  try {
    await openBrowser(buildAuthUrl({ clientId, redirectUri, state, challenge, ...authParams }));
    const got = await outcome;
    if (!got.ok) return got;

    const body = new URLSearchParams({
      code: got.code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier,
    }).toString();
    let resp;
    try { resp = await fetcher(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }); }
    catch (e) { return { ok: false, reason: `code exchange failed: ${String(e.message || e)}` }; }
    if (!resp.ok) return { ok: false, reason: `code exchange refused (HTTP ${resp.status})` };
    const json = await resp.json().catch(() => ({}));
    return { ok: true, json };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

export async function signInWithGoogle({
  nonce, loginHint = '',
  clientId = GOOGLE_DESKTOP_CLIENT.id, clientSecret = GOOGLE_DESKTOP_CLIENT.secret,
  openBrowser = defaultOpenBrowser, fetcher = fetch, timeoutMs = 180000, tokenUrl = TOKEN_URL,
} = {}) {
  if (!nonce) return { ok: false, reason: 'a nonce (the device fingerprint) is required' };
  const r = await runCodeFlow({
    clientId, clientSecret, openBrowser, fetcher, timeoutMs, tokenUrl,
    authParams: { nonce, loginHint },
  });
  if (!r.ok) return r;
  if (!r.json.id_token) return { ok: false, reason: 'code exchange returned no id_token' };
  return { ok: true, idToken: r.json.id_token };
}

// The BYO-Google leg (docs/design-google-byo-connect.md): same loopback + PKCE
// machinery, but the MEMBER'S OWN client, the workspace scope union, and the
// full token record back. No nonce: there is no id_token contract here, the
// prize is the refresh_token, which only access_type=offline + prompt=consent
// produce. refresh_token is passed through as Google sent it (possibly absent)
// so the caller can name the failure precisely.
export async function signInForTokens({
  clientId, clientSecret, scopes, loginHint = '',
  openBrowser = defaultOpenBrowser, fetcher = fetch, timeoutMs = 180000, tokenUrl = TOKEN_URL, port = 0,
} = {}) {
  if (!clientId || !clientSecret) return { ok: false, reason: 'a client id and secret are required' };
  if (!Array.isArray(scopes) || !scopes.length) return { ok: false, reason: 'at least one scope is required' };
  const r = await runCodeFlow({
    clientId, clientSecret, openBrowser, fetcher, timeoutMs, tokenUrl, port,
    authParams: { scope: scopes.map(String).join(' '), offline: true, loginHint },
  });
  if (!r.ok) return r;
  const j = r.json;
  if (!j.access_token) return { ok: false, reason: 'code exchange returned no access token' };
  return {
    ok: true,
    tokens: { access_token: j.access_token, refresh_token: j.refresh_token, expires_in: j.expires_in, scope: j.scope },
  };
}
