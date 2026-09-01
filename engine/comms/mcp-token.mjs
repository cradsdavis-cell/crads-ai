#!/usr/bin/env node
// mcp-token.mjs: where an OAuth result LIVES on the box.
//
// The app does the OAuth (engine/comms/mcp-oauth-lib.mjs) and hands the result
// here. Two files, deliberately split by sensitivity:
//
//   .mcp.json                  the ACCESS token, as an Authorization header, so
//                              Claude Code simply sends it. Nothing has to
//                              understand the CLI's private credential store,
//                              which is undocumented, has already bitten us
//                              twice today, and can change without warning.
//   .kernel/mcp-oauth.json     the REFRESH material (refresh token, client id,
//                              token endpoint, expiry). Never in .mcp.json,
//                              because that file is read by every session and a
//                              refresh token is the long-lived credential.
//
//   node mcp-token.mjs <state-dir> set        (stdin: base64 JSON)
//   node mcp-token.mjs <state-dir> set-google (stdin: base64 JSON — BYO client)
//   node mcp-token.mjs <state-dir> forget <name>
import { readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const stateDir = path.resolve(process.argv[2] || '/state');
const cmd = process.argv[3] || 'show';
const arg = String(process.argv[4] || '');

const MCP_F = path.join(stateDir, '.mcp.json');
const OAUTH_F = path.join(stateDir, '.kernel', 'mcp-oauth.json');
const GCREDS_DIR = path.join(stateDir, '.kernel', 'google-creds');
const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
// keyed_at (when set-google ran ≈ when Google minted the token) identifies
// THIS key to every consumer — the status row, the live probe's ledger and
// dead marker. It is an identity, not a countdown: since the 2026-08-24
// Production reshape (wizard publishes the member's app), a key has no
// scheduled death and nothing derives an expiry from this value.

const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(0); };
const rd = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };

if (cmd === 'set') {
  let req = {};
  try { req = JSON.parse(Buffer.from(readFileSync(0, 'utf8').trim(), 'base64').toString('utf8')); }
  catch { out({ ok: false, error: 'expected base64 JSON on stdin' }); }

  const name = String(req.name || '').toLowerCase();
  if (!NAME_RE.test(name)) out({ ok: false, error: 'bad service name' });
  if (!req.access_token) out({ ok: false, error: 'no access token supplied' });
  let url;
  try { url = new URL(String(req.url || '')); } catch { out({ ok: false, error: 'bad server url' }); }
  if (url.protocol !== 'https:') out({ ok: false, error: 'only https servers can be connected' });

  // .mcp.json, MERGE. An operator server or another connection must survive.
  const doc = rd(MCP_F, {});
  doc.mcpServers = doc.mcpServers || {};
  const prev = doc.mcpServers[name] || {};
  doc.mcpServers[name] = {
    ...prev,
    type: prev.type || (/\/sse$/.test(url.pathname) ? 'sse' : 'http'),
    url: url.href,
    headers: { ...(prev.headers || {}), Authorization: `${req.token_type || 'Bearer'} ${req.access_token}` },
  };
  writeFileSync(MCP_F, JSON.stringify(doc, null, 2) + '\n');

  // refresh material, 0600: this is the long-lived credential
  const store = rd(OAUTH_F, {});
  store[name] = {
    url: url.href,
    token_endpoint: req.token_endpoint || store[name]?.token_endpoint || null,
    client_id: req.client_id || store[name]?.client_id || null,
    client_secret: req.client_secret || store[name]?.client_secret || null,
    // keep an existing refresh token when a refresh response omits one (many do)
    refresh_token: req.refresh_token || store[name]?.refresh_token || null,
    expires_at: req.expires_at ?? null,
    updated_at: Date.now(),
  };
  mkdirSync(path.dirname(OAUTH_F), { recursive: true });
  writeFileSync(OAUTH_F, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  chmodSync(OAUTH_F, 0o600);   // an existing file keeps its old mode through writeFileSync

  out({ ok: true, name, renews: !!store[name].refresh_token, expires_at: store[name].expires_at });
}

if (cmd === 'set-google') {
  // The BYO-Google landing: the app ran OAuth with the MEMBER'S OWN client
  // (docs/design-google-byo-connect.md) and hands the whole result here. It
  // does NOT become an Authorization header — Google tools are served by
  // workspace-mcp, which reads a credential file of its own documented shape:
  // filename = URL-quoted email, and the four refresh fields MUST be embedded
  // (google-auth refreshes off the file, never off env).
  let req = {};
  try { req = JSON.parse(Buffer.from(readFileSync(0, 'utf8').trim(), 'base64').toString('utf8')); }
  catch { out({ ok: false, error: 'expected base64 JSON on stdin' }); }

  const email = String(req.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) out({ ok: false, error: 'that does not look like an email address' });
  const cid = String(req.client_id || '');
  if (!/\.apps\.googleusercontent\.com$/.test(cid)) out({ ok: false, error: 'that client ID is not a Google OAuth client (expected ...apps.googleusercontent.com). Re-download the JSON from your Google console' });
  const secret = String(req.client_secret || '');
  if (!secret || /[\r\n]/.test(secret) || secret.length > 256) out({ ok: false, error: 'that client secret does not look right' });
  if (!req.refresh_token) out({ ok: false, error: 'Google did not include a refresh token, so this sign-in would die within the hour. Sign in again and approve the consent screen fully' });
  const scopes = Array.isArray(req.scopes) ? req.scopes.map(String) : [];
  if (!scopes.length || scopes.length > 64 || scopes.some((s) => s.length > 200 || !/^(openid$|https:\/\/www\.googleapis\.com\/auth\/)/.test(s))) {
    out({ ok: false, error: 'the granted scopes are missing or malformed' });
  }

  // workspace-mcp's filename rule: URL-quoted email with @ . _ - kept bare
  // (python urllib quote(safe="@._-")); encodeURIComponent additionally leaves
  // ! * ' ( ) bare, so re-escape those to match byte-for-byte.
  const fname = encodeURIComponent(email).replace(/%40/g, '@')
    .replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()) + '.json';
  mkdirSync(GCREDS_DIR, { recursive: true, mode: 0o700 });
  const credsFile = path.join(GCREDS_DIR, fname);
  writeFileSync(credsFile, JSON.stringify({
    token: String(req.access_token || ''),
    refresh_token: String(req.refresh_token),
    token_uri: 'https://oauth2.googleapis.com/token',
    client_id: cid,
    client_secret: secret,
    scopes,
    // tz-naive UTC, the shape workspace-mcp parses. Absent an expiry from the
    // app, a PAST one is seeded on purpose: the first tool call then refreshes
    // immediately, which live-proves client id + secret + refresh token as a
    // set instead of coasting an hour on the access token before failing.
    expiry: String(req.expiry || '1970-01-01T00:00:00'),
  }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(credsFile, 0o600);   // a re-key overwrites; writeFileSync keeps old modes

  // the key's IDENTITY, no secrets: keyed_at is what the status row and the
  // live probe's ledger key off (a re-key moves it, retiring both for free)
  const store = rd(OAUTH_F, {});
  store.google = { provider: 'google-byo', email, keyed_at: Date.now(), creds_file: credsFile, updated_at: Date.now() };
  mkdirSync(path.dirname(OAUTH_F), { recursive: true });
  writeFileSync(OAUTH_F, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  chmodSync(OAUTH_F, 0o600);
  out({ ok: true, name: 'google', email, keyed_at: store.google.keyed_at });
}

if (cmd === 'forget') {
  if (!NAME_RE.test(arg)) out({ ok: false, error: 'bad service name' });
  const doc = rd(MCP_F, {});
  if (doc.mcpServers?.[arg]?.headers) {
    // strip only OUR header; a member's own hand-set headers stay
    delete doc.mcpServers[arg].headers.Authorization;
    if (!Object.keys(doc.mcpServers[arg].headers).length) delete doc.mcpServers[arg].headers;
    writeFileSync(MCP_F, JSON.stringify(doc, null, 2) + '\n');
  }
  const store = rd(OAUTH_F, {});
  // A BYO-Google forget removes the KEY ITSELF: unlike a remote OAuth grant
  // (which the member revokes at the provider), the member's client secret +
  // refresh token live in a file on this box, and "disconnect" must mean that
  // file is gone — it is the promise the wizard copy makes.
  if (store[arg]?.provider === 'google-byo' && store[arg].creds_file) {
    try { unlinkSync(store[arg].creds_file); } catch { /* already gone */ }
  }
  delete store[arg];
  mkdirSync(path.dirname(OAUTH_F), { recursive: true });
  writeFileSync(OAUTH_F, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  out({ ok: true, name: arg });
}

if (cmd === 'show') {
  // Never the values. Only what a page needs to tell the truth about a row.
  const store = rd(OAUTH_F, {});
  const doc = rd(MCP_F, {});
  const now = Date.now();
  out({
    ok: true,
    services: Object.entries(store).map(([name, v]) => (v.provider === 'google-byo'
      ? { name, connected: !!doc.mcpServers?.[name], renews: true,
          // a published BYO key has no scheduled death; the live probe's dead
          // marker (read by mcp-connect status) carries the only expiry truth
          expires_at: null,
          expired: false }
      : { name,
          connected: !!doc.mcpServers?.[name]?.headers?.Authorization,
          renews: !!v.refresh_token,
          expires_at: v.expires_at ?? null,
          expired: !!(v.expires_at && v.expires_at < now),
        })),
  });
}

out({ ok: false, error: `unknown command: ${cmd}` });
