// mcp-oauth-lib.mjs: OAuth for MCP servers, ours, with no CLI in the middle.
//
// WHY THIS EXISTS (2026-08-09, Sam: "why can't I get this to work in the
// Crads-AI app separate from claude?"). The first build drove `claude mcp login`,
// an interactive CLI: spawn it detached, fake a terminal with script(1), keep it
// alive across two separate SSH calls, poll a transcript for the URL, pipe the
// member's paste back through a FIFO. Six fragile parts to drive one ordinary
// HTTP conversation, and every failure that reached Sam came from the scaffolding
// rather than from OAuth. Worse, the CLI's callback listener lives on the BOX,
// which the member's browser cannot reach, which is the whole reason a paste step
// existed at all.
//
// Doing it ourselves removes all of it: the APP registers its own client with its
// own localhost redirect, so the browser lands somewhere real and the flow
// completes with no paste, no terminal, and no dependence on another tool's
// private credential format.
//
// Verified against live servers before this was written: canva and notion both
// publish registration + authorize + token endpoints with PKCE S256, and both
// issued a client_id for a redirect_uri we chose (201, refresh_token granted).
//
// Pure and fetch-injected on purpose: every branch here is testable without a
// network, and the network parts live at the edges.
import { createHash, randomBytes } from 'node:crypto';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// PKCE (RFC 7636). S256 only: `plain` is advertised by these servers but offers
// no protection, and there is no reason to ever pick it.
export function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()), method: 'S256' };
}

export const newState = () => b64url(randomBytes(16));

// Metadata discovery. The MCP server names its authorization server(s); each one
// then publishes its own endpoints. Both hops are tried in the order the specs
// give, and a server that skips the protected-resource doc (common) falls back to
// its own origin, which is what the live servers actually do.
//
// The protected-resource doc is looked up for the server's PATH first (RFC 9728
// section 3.1: /.well-known/oauth-protected-resource/<path>), then for the
// origin. Asana is why (2026-10-17): its origin doc names its retiring v1 auth
// server (mcp.asana.com), while /v2/mcp's own doc names app.asana.com, the one
// that actually issues v2 tokens. Origin-only lookup signed v2 in against v1.
export async function discover(fetchFn, serverUrl) {
  const u = new URL(serverUrl);
  const origin = u.origin;
  const tail = u.pathname.replace(/\/+$/, '');
  const prDocs = (tail && tail !== '/' ? [`${origin}/.well-known/oauth-protected-resource${tail}`] : [])
    .concat(`${origin}/.well-known/oauth-protected-resource`);
  let asBase = origin, prScopes = [];
  for (const doc of prDocs) {
    try {
      const pr = await fetchFn(doc);
      if (!pr.ok) continue;
      const j = await pr.json();
      if (Array.isArray(j.authorization_servers) && j.authorization_servers[0]) {
        asBase = j.authorization_servers[0];
        prScopes = Array.isArray(j.scopes_supported) ? j.scopes_supported.filter((x) => typeof x === 'string' && x) : [];
        break;
      }
    } catch { /* absent is normal; try the next, then fall back to the origin */ }
  }

  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    try {
      const r = await fetchFn(`${asBase.replace(/\/+$/, '')}${path}`);
      if (!r.ok) continue;
      const m = await r.json();
      if (m.authorization_endpoint && m.token_endpoint) return { ...m, _as: asBase, _prScopes: prScopes };
    } catch { /* try the next */ }
  }
  throw new Error('this server does not advertise an OAuth endpoint we can use');
}

// Dynamic client registration (RFC 7591). We register OUR redirect, which is the
// step that lets the browser land on the app instead of on the box.
export async function register(fetchFn, meta, redirectUri, clientName = 'Crads-AI') {
  if (!meta.registration_endpoint) {
    // Google is the live example: no registration endpoint, so a client must be
    // pre-registered by a human. Say which, plainly, so the caller can too.
    throw new Error('this provider does not allow apps to register themselves, so it needs a client ID set up by hand');
  }
  const r = await fetchFn(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',   // public client; PKCE is the protection
    }),
  });
  if (!r.ok) throw new Error(`the provider refused to register this app (${r.status})`);
  const j = await r.json();
  if (!j.client_id) throw new Error('the provider registered no client id');
  return { clientId: j.client_id, clientSecret: j.client_secret || null };
}

export function authorizeUrl({ meta, clientId, redirectUri, challenge, state, resource, scope }) {
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  // RFC 8707: name the MCP server as the resource, or a provider that hosts many
  // can mint a token for the wrong one.
  if (resource) u.searchParams.set('resource', resource);
  if (scope) u.searchParams.set('scope', scope);
  return u.href;
}

// SCOPE FALLBACK (2026-11-11, Sam's ruling, Perplexity). We send no scope by
// default and each provider grants its own defaults: that is how every
// one-click service in the catalogue signed in until now. Perplexity refuses a
// request with no scope at all ("The scope of your request is missing", 400).
// The MCP spec's answer is to ask for every scope the protected-resource doc
// lists, but applied to everyone that would have widened ~40 working sign-ins,
// several to admin (Pipedrive, Shortcut, Prisma, Stytch; PostHog lists 238).
// So the spec's list is a FALLBACK: preflight the scopeless URL, and only a
// provider that refuses it for want of a scope is asked again with the list.
// offline_access rides along when the authorization server offers it, because
// a connection that cannot refresh dies at its first expiry.
export function fallbackScope(meta) {
  const list = [...new Set((meta && meta._prScopes) || [])];
  if (!list.length) return null;
  const asScopes = Array.isArray(meta.scopes_supported) ? meta.scopes_supported : [];
  if (asScopes.includes('offline_access') && !list.includes('offline_access')) list.push('offline_access');
  return list.join(' ');
}

// Does this authorize URL get refused for want of a scope? Read without
// following redirects. A provider can say so two ways: an error page/JSON
// (Perplexity: 400 invalid_request "...scope...") or a redirect straight back
// to our redirect_uri carrying error=invalid_scope. Anything else, including
// any failure to ask, is "no": the member then sees exactly today's flow.
export async function refusesWithoutScope(fetchFn, url, redirectUri) {
  try {
    const r = await Promise.race([
      fetchFn(url, { redirect: 'manual' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ]);
    const loc = (r.headers && typeof r.headers.get === 'function' && r.headers.get('location')) || '';
    if (loc && redirectUri && loc.startsWith(redirectUri)) {
      const q = new URL(loc).searchParams;
      const err = q.get('error') || '';
      return err === 'invalid_scope' || (err === 'invalid_request' && /scope/i.test(q.get('error_description') || ''));
    }
    if (r.status !== 400) return false;
    let body = '';
    if (typeof r.text === 'function') body = await r.text();
    else if (typeof r.json === 'function') body = JSON.stringify(await r.json());
    let err = '', desc = body;
    try { const j = JSON.parse(body); err = String(j.error || ''); desc = String(j.error_description || j.message || ''); } catch { /* an HTML page */ }
    if (err === 'invalid_scope') return true;
    return /scope/i.test(desc) && /(missing|required|requested|no scope|empty)/i.test(desc);
  } catch { return false; }
}

export async function exchange(fetchFn, meta, { code, clientId, clientSecret, redirectUri, verifier, resource }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier,
  });
  if (resource) body.set('resource', resource);
  if (clientSecret) body.set('client_secret', clientSecret);
  const r = await fetchFn(meta.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  if (!r.ok) throw new Error(`the provider would not issue a token (${r.status})`);
  return await r.json();
}

export async function refresh(fetchFn, meta, { refreshToken, clientId, clientSecret, resource }) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
  if (resource) body.set('resource', resource);
  if (clientSecret) body.set('client_secret', clientSecret);
  const r = await fetchFn(meta.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  if (!r.ok) throw new Error(`refresh refused (${r.status})`);
  return await r.json();
}

// What we keep. `expires_at` is absolute, because a relative lifetime is useless
// to a job that reads this file hours later. A provider that returns no
// expires_in gets null, which downstream MUST treat as "cannot tell", never as
// "expired" (a wrongly-expired connection is a working one we broke).
export function tokenRecord(json, now = Date.now()) {
  if (!json || !json.access_token) throw new Error('the provider returned no access token');
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || null,
    // canonical scheme: some providers say "bearer" (or Slack's "user") and
    // some servers then refuse a lowercase header (see mcp-token.mjs authScheme)
    token_type: /^dpop$/i.test(String(json.token_type || '').trim()) ? 'DPoP' : 'Bearer',
    expires_at: Number.isFinite(json.expires_in) ? now + Number(json.expires_in) * 1000 : null,
    scope: json.scope || null,
  };
}

// The state parameter is the CSRF defence for the whole flow, so compare it in
// constant time and treat any mismatch as hostile rather than as a retry.
export function stateMatches(expected, got) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(got || ''));
  if (a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
