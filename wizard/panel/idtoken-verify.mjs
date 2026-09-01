// idtoken-verify.mjs — verify a Google / Microsoft OAuth ID token (RS256 JWT).
//
// This is the trust anchor of the automated device handshake (spec 2026-07-24,
// Section 1): the ROCK verifies the IdP's signature itself; the directory
// worker only ferries the token as a sealed proof. Zero dependencies, and the
// JWKS source is injectable so tests run offline against fixture keys while
// production uses the IdPs' published keys (fetchJwks below).
//
//   const r = await verifyIdToken(token, { email, audience, jwksSource, replayGuard })
//   r = { ok: true, email, claims } | { ok: false, reason }
//
// Checks, in order: shape → alg RS256 only → issuer allow-list (Microsoft:
// tenant must be PINNED via msTenants — any-tenant acceptance is the nOAuth
// hole) → key lookup by kid (one forced JWKS refetch on a miss: key rotation)
// → signature → audience → expiry/issued-at (300s skew) → email match
// (case-insensitive) + email_verified === true for Google (Entra omits the
// claim; there the pinned tenant is the anchor) → nonce binding (expectedNonce
// = the device fingerprint, so the SIGNED token commits to the KEY being
// enrolled — a hostile broker cannot swap the pubkey without breaking it) →
// optional replay guard.
import { createVerify, createPublicKey, createHash } from 'node:crypto';

const SKEW_S = 300;
const MAX_TOKEN_BYTES = 16384;

// Google's two issuer spellings + Microsoft v2 per-tenant issuers.
const MS_ISS_RE = /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/i;
const GOOGLE_ISS = new Set(['https://accounts.google.com', 'accounts.google.com']);

const no = (reason) => ({ ok: false, reason });

function b64urlJson(part) {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); }
  catch { return null; }
}

// Fixed-size TTL'd seen-set for replay protection. Keyed on the token hash so
// tokens without a jti are still covered. `now` injectable for tests.
export class ReplayGuard {
  constructor({ ttlMs = 10 * 60 * 1000, max = 5000, now = Date.now } = {}) {
    this.ttlMs = ttlMs; this.max = max; this.now = now; this.seen = new Map();
  }
  check(token) {                       // true = fresh (and now recorded), false = replay
    const key = createHash('sha256').update(String(token)).digest('hex');
    const t = this.now();
    for (const [k, exp] of this.seen) if (exp <= t) this.seen.delete(k);
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.max) this.seen.delete(this.seen.keys().next().value);
    this.seen.set(key, t + this.ttlMs);
    return true;
  }
}

export async function verifyIdToken(token, { email, audience, jwksSource, replayGuard, nowS, expectedNonce, msTenants } = {}) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_BYTES) return no('token missing or oversized');
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[2]) return no('not a signed JWT');
  const header = b64urlJson(parts[0]);
  const claims = b64urlJson(parts[1]);
  if (!header || !claims) return no('malformed token');

  if (header.alg !== 'RS256') return no(`refused alg ${String(header.alg)}: RS256 only`);

  const iss = String(claims.iss || '');
  const isGoogle = GOOGLE_ISS.has(iss);
  const msMatch = iss.match(MS_ISS_RE);
  if (!isGoogle && !msMatch) return no(`unknown issuer ${iss.slice(0, 80)}`);
  if (msMatch) {
    // nOAuth guard: ANY Microsoft tenant can mint a validly-signed token carrying an
    // arbitrary email claim, so the org must PIN which tenant(s) its members sign in
    // from. No pin configured = Microsoft sign-in not enabled: refuse to the manual path.
    const tenant = msMatch[1].toLowerCase();
    const pinned = (Array.isArray(msTenants) ? msTenants : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    if (!pinned.length) return no('Microsoft sign-in not enabled for this rock (no pinned tenant)');
    if (!pinned.includes(tenant)) return no(`Microsoft tenant ${tenant} is not this rock's tenant`);
  }

  let keys;
  try { keys = (await jwksSource(iss, header.kid))?.keys || []; }
  catch { return no('JWKS source unavailable'); }
  let jwk = keys.find((k) => k && k.kid === header.kid) || (keys.length === 1 && !header.kid ? keys[0] : null);
  if (!jwk) {
    // Key-rotation path: the kid may be newer than the cached JWKS. One forced refetch.
    try { keys = (await jwksSource(iss, header.kid, { forceRefresh: true }))?.keys || []; } catch { keys = []; }
    jwk = keys.find((k) => k && k.kid === header.kid) || null;
    if (!jwk) return no(`signing key ${String(header.kid)} not found in JWKS`);
  }

  let pub;
  try { pub = createPublicKey({ key: jwk, format: 'jwk' }); }
  catch { return no('signing key unusable'); }
  const okSig = createVerify('RSA-SHA256')
    .update(parts[0] + '.' + parts[1])
    .verify(pub, Buffer.from(parts[2], 'base64url'));
  if (!okSig) return no('signature verification failed');

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience || !aud.includes(audience)) return no('audience mismatch');

  const now = nowS ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= now - SKEW_S) return no('token expired');
  if (typeof claims.iat === 'number' && claims.iat > now + SKEW_S) return no('token issued in the future');

  const tokenEmail = String(claims.email || '').trim().toLowerCase();
  const wantEmail = String(email || '').trim().toLowerCase();
  if (!tokenEmail || !wantEmail || tokenEmail !== wantEmail) return no('email mismatch');
  // Google always emits email_verified: require it truthy. Entra v2 omits the claim
  // entirely (nOAuth), which is why the Microsoft path is anchored on the pinned
  // tenant above instead; an explicit false is refused everywhere.
  if (claims.email_verified === false || claims.email_verified === 'false') return no('email not verified by the identity provider');
  if (isGoogle && claims.email_verified !== true && claims.email_verified !== 'true') return no('email not verified by the identity provider');

  // Key binding: the sign-in flow puts the DEVICE FINGERPRINT in the OIDC nonce, so the
  // signed token commits to the key being enrolled. Without this, a hostile broker could
  // relay a genuine token while swapping the staged pubkey for its own.
  if (expectedNonce !== undefined) {
    const nonce = String(claims.nonce || '').trim().toUpperCase();
    if (!nonce || nonce !== String(expectedNonce).trim().toUpperCase()) return no('nonce mismatch: token does not commit to this device key');
  }

  if (replayGuard && !replayGuard.check(token)) return no('replay: token already used');

  return { ok: true, email: tokenEmail, claims };
}

// Production JWKS source: fetch + cache the IdPs' published keys. Injected in
// tests; used by the rock's reconcile in live boxes.
const JWKS_URLS = {
  google: 'https://www.googleapis.com/oauth2/v3/certs',
  microsoft: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
};
const jwksCache = new Map();          // url -> { at, body }
export function fetchJwksSource({ cacheMs = 6 * 60 * 60 * 1000, fetcher = fetch } = {}) {
  return async (iss, kid, { forceRefresh = false } = {}) => {
    const url = GOOGLE_ISS.has(iss) ? JWKS_URLS.google : JWKS_URLS.microsoft;
    const hit = jwksCache.get(url);
    if (!forceRefresh && hit && Date.now() - hit.at < cacheMs) return hit.body;
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`JWKS fetch ${res.status}`);
    const body = await res.json();
    jwksCache.set(url, { at: Date.now(), body });
    return body;
  };
}
