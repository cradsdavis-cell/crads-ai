// crads-account.mjs — the ONE Crads account, app side (T5 of the ties+account
// pass, 2026-08-10). The site (crads-ai.com) is the account home: Google SSO,
// email/password, magic links, forgot-password, Stripe — all of it lives there.
// This module is how the desktop app borrows that account:
//
//   signInWithCrads({ nonce, scope })  — the drop-in for signInWithGoogle at
//     every gate. Silent first (disk session → 1h RS256 app token, no UI),
//     interactive second (system browser → consent page → one-time code →
//     loopback), Google fallback third (while the site issuer is unarmed, so
//     no gate ever goes darker than it was before this module existed).
//   getAppToken({ nonce, scope })      — silent-only mint for background work
//     (the seeded _communityMine refresh); never opens a browser.
//   readSession() / currentEmail()     — who the app is, from disk.
//   signOut()                          — forget the machine.
//
// The session lives at ~/.crads-ai-session.json (0600): a ~60-day site session
// JWT plus the most recent plain app token. Tokens carrying a nonce or scope
// are minted per use and never cached — the nonce IS the binding (joinNonce
// ties a token to one org; the device fingerprint ties an enrolment to one
// key). Revocation is the site's state_version check at every mint: change
// your password and every machine is signed out within the 1-hour token life.
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const SITE_URL = process.env.CRADS_SITE_URL || 'https://crads-ai.com';
const sessionPathOf = (opts = {}) => opts.sessionPath || join(homedir(), '.crads-ai-session.json');
// reuse a cached plain token only while it has comfortable life left
const REUSE_FLOOR_MS = 5 * 60 * 1000;

export function readSession(opts = {}) {
  try {
    const s = JSON.parse(readFileSync(sessionPathOf(opts), 'utf8'));
    if (!s || typeof s.session_jwt !== 'string' || !s.session_jwt || typeof s.email !== 'string') return null;
    return s;
  } catch { return null; }
}

export function currentEmail(opts = {}) {
  const s = readSession(opts);
  return s ? s.email : '';
}

export function signOut(opts = {}) {
  try { unlinkSync(sessionPathOf(opts)); } catch { /* already signed out */ }
}

function writeSession(opts, session) {
  const p = sessionPathOf(opts);
  try { mkdirSync(dirname(p), { recursive: true }); } catch { /* exists */ }
  writeFileSync(p, JSON.stringify(session, null, 2) + '\n', { mode: 0o600 });
}

// Silent mint. Returns { ok, idToken, email } or { ok:false, reason } — the
// signInWithGoogle result shape, so call sites and their stubs carry over.
export async function getAppToken(opts = {}) {
  const fetcher = opts.fetcher || fetch;
  const site = opts.siteUrl || SITE_URL;
  const s = readSession(opts);
  if (!s) return { ok: false, reason: 'sign-in-needed' };
  const nonce = opts.nonce === undefined ? '' : String(opts.nonce);
  const scope = opts.scope === undefined ? '' : String(opts.scope);
  // a plain (unbound) token can be reused across reads; a bound one cannot
  if (!nonce && !scope && s.app_token && (s.app_token_exp || 0) - Date.now() > REUSE_FLOOR_MS) {
    return { ok: true, idToken: s.app_token, email: s.email };
  }
  let r;
  try {
    r = await fetcher(`${site}/api/auth/app-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${s.session_jwt}` },
      body: JSON.stringify({ ...(nonce ? { nonce } : {}), ...(scope ? { scope } : {}) }),
    });
  } catch (e) { return { ok: false, reason: `could not reach ${site}: ${String(e.message || e)}` }; }
  if (r.status === 401) {
    // state_version moved or the session aged out: this machine signs in again.
    // The stale file stays until a successful interactive sign-in overwrites it,
    // so a transient mis-answer can never sign the machine out by accident.
    return { ok: false, reason: 'sign-in-needed' };
  }
  if (!r.ok) return { ok: false, reason: `the account server refused (HTTP ${r.status})` };
  const body = await r.json().catch(() => ({}));
  if (!body.app_token) return { ok: false, reason: 'the account server returned no token' };
  if (!nonce && !scope) {
    writeSession(opts, { ...s, app_token: body.app_token, app_token_exp: body.app_token_exp || 0 });
  }
  return { ok: true, idToken: body.app_token, email: s.email };
}

function defaultOpenBrowser(url) {
  const table = {
    darwin: { cmd: 'open', args: [url] },
    win32: { cmd: 'cmd', args: ['/c', 'start', '', url.replace(/&/g, '^&')] },
  };
  const { cmd, args } = table[process.platform] || { cmd: 'xdg-open', args: [url] };
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

// Interactive sign-in: system browser → crads-ai.com consent page → one-time
// 120s code to our loopback → redeem for the 60-day session. Never called with
// a live session unless the silent mint said sign-in-needed.
export async function interactiveSignIn(opts = {}) {
  const fetcher = opts.fetcher || fetch;
  const site = opts.siteUrl || SITE_URL;
  const openBrowser = opts.openBrowser || defaultOpenBrowser;
  const timeoutMs = opts.timeoutMs || 180000;
  const state = randomBytes(24).toString('base64url');

  let settle;
  const outcome = new Promise((res) => { settle = res; });
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/cb') { res.writeHead(404); res.end(); return; }
    if (u.searchParams.get('state') !== state) {
      // wrong or forged state: refuse THIS request but keep listening
      res.writeHead(400, { 'content-type': 'text/html' }); res.end(FAIL_PAGE('The sign-in link did not match this session.'));
      return;
    }
    const code = u.searchParams.get('code');
    if (!code) { res.writeHead(400, { 'content-type': 'text/html' }); res.end(FAIL_PAGE('No sign-in code arrived.')); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(DONE_PAGE);
    settle({ ok: true, code });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const timer = setTimeout(() => settle({ ok: false, reason: `sign-in timed out after ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);

  try {
    await openBrowser(`${site}/account/app-login?port=${port}&state=${encodeURIComponent(state)}`);
    const got = await outcome;
    if (!got.ok) return got;
    let r;
    try {
      r = await fetcher(`${site}/api/auth/app-redeem`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: got.code }),
      });
    } catch (e) { return { ok: false, reason: `code redeem failed: ${String(e.message || e)}` }; }
    if (!r.ok) return { ok: false, reason: `code redeem refused (HTTP ${r.status})` };
    const body = await r.json().catch(() => ({}));
    if (!body.session_jwt || !body.email) return { ok: false, reason: 'redeem returned no session' };
    writeSession(opts, {
      email: body.email, session_jwt: body.session_jwt,
      app_token: body.app_token || '', app_token_exp: body.app_token_exp || 0,
      saved_at: new Date().toISOString(),
    });
    return { ok: true, idToken: body.app_token || '', email: body.email };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

// The drop-in gate. Contract-compatible with signInWithGoogle: resolves to
// { ok, idToken } (+ email) or { ok:false, reason }. Order:
//   1. silent app-token mint off the disk session (no UI, the common case)
//   2. interactive browser sign-in at crads-ai.com, then mint with the asked
//      nonce/scope (the redeem token is unbound, so a bound ask mints again)
//   3. Google fallback — while the site issuer is unarmed (no signing key in
//      Vercel yet) or unreachable, the old gate still works. The worker accepts
//      both issuers through the whole migration, so this can never strand a
//      member. Remove once the account path is certified live.
export async function signInWithCrads(opts = {}) {
  const silent = await getAppToken(opts);
  if (silent.ok) return silent;
  const inter = await interactiveSignIn(opts).catch((e) => ({ ok: false, reason: String(e.message || e) }));
  if (inter.ok) {
    if (opts.nonce || opts.scope) return getAppToken(opts);   // bind the fresh session to the ask
    return inter;
  }
  const fallback = opts.googleFallback
    || (opts.googleFallback === null ? null : (await import('./google-signin.mjs')).signInWithGoogle);
  if (!fallback) return inter;
  const nonce = opts.nonce || randomBytes(12).toString('hex');
  const g = await fallback({ nonce }).catch((e) => ({ ok: false, reason: String(e.message || e) }));
  if (g.ok) return g;
  return { ok: false, reason: `crads: ${inter.reason || 'sign-in did not complete'}; google: ${g.reason || 'sign-in did not complete'}` };
}
