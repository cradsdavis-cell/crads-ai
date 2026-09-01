// Test fixtures for idtoken-verify: a locally-generated RSA keypair + a mint()
// that produces RS256 ID tokens shaped like Google's. Keys are generated fresh
// per test run (nothing secret is committed); the JWKS source is injected into
// the verifier, so these fixtures exercise the full signature path offline.
import { generateKeyPairSync, createSign, createHash } from 'node:crypto';

export const FIXTURE_KID = 'fixture-key-1';

export function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  return { publicKey, privateKey, jwk: { ...jwk, kid: FIXTURE_KID, alg: 'RS256', use: 'sig' } };
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// Mint an ID token. Overrides merge into the payload; header overrides via opts.header.
export function mintIdToken(privateKey, payload = {}, opts = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: FIXTURE_KID, typ: 'JWT', ...(opts.header || {}) };
  const body = {
    iss: 'https://accounts.google.com',
    aud: 'test-client-id',
    sub: '1234567890',
    email: 'jane@example.com',
    email_verified: true,
    iat: now, exp: now + 3600,
    jti: 'jti-' + createHash('sha256').update(JSON.stringify(payload) + Math.random()).digest('hex').slice(0, 16),
    ...payload,
  };
  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(body));
  const sig = createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return signingInput + '.' + b64url(sig);
}

// An injectable JWKS source over the fixture key.
export function fixtureJwksSource(jwk) {
  return async () => ({ keys: [jwk] });
}
