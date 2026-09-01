#!/usr/bin/env node
// join-reconcile.mjs — the rock pulls REQUEST-TO-JOIN entries from the broker (D58 P4,
// spec § 6) and verifies each one's OAuth ID token ITSELF (the broker is a mailbox,
// never a verifier). Verified requests land in control/join-requests.json for the panel's
// "Requests to join" card, with the email taken FROM the verified token (there is no
// registry row to compare against yet, and no device key exists, so no nonce either).
// Verification failures are logged, dropped, and consumed at the broker so they cannot
// pile up. Dormant until AIOS_OAUTH_AUDIENCE is configured, exactly like auto-approve.
// Fail-silent on broker unreachability; exit 0 always.
// SELF-HOST STRIP (2026-09-01): the central directory this script spoke to
// (directory.crads-ai.com) is deleted, along with the account system. It exits
// here — silently, 0 — so a rock that syncs this machinery on boot stops
// phoning a dead service on its reconcile cadence. The body below is kept for
// reference until the commons model replaces this leg. Authored upstream in
// brain-template; keep the two copies identical.
process.exit(0);

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Org-binding nonce (2026-07-24 review): the member's sign-in put this into the OIDC
// nonce, so a token minted for another org will not match and cannot be replayed here.
// Keep in lockstep with member-connect.mjs joinNonce().
const joinNonce = (org) => createHash('sha256').update('crads-join:' + String(org).toLowerCase()).digest('hex');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries((await readFile(path.join(repoRoot, '.env'), 'utf8').catch(() => ''))
  .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

const DIRECTORY_URL = process.env.CRADS_DIRECTORY_URL || env.CRADS_DIRECTORY_URL || 'https://directory.crads-ai.com';
const PULL_TOKEN = process.env.ORG_PULL_TOKEN || env.ORG_PULL_TOKEN;
const { DEFAULT_OAUTH_AUDIENCE } = await import('./oauth-audience.mjs');
const AUDIENCE = process.env.AIOS_OAUTH_AUDIENCE || env.AIOS_OAUTH_AUDIENCE || DEFAULT_OAUTH_AUDIENCE;
const policy = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
const ORG = (policy.match(/^\s*name:\s*"?([^"\n#]+)"?/m) || [])[1]?.trim();

if (!PULL_TOKEN || !ORG || !AUDIENCE) {
  console.log('join-reconcile: dormant (needs ORG_PULL_TOKEN + org handle + AIOS_OAUTH_AUDIENCE).');
  process.exit(0);
}

const outPath = path.join(repoRoot, 'control', 'join-requests.json');

try {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  const r = await fetch(`${DIRECTORY_URL}/join-requests?org=${encodeURIComponent(ORG)}`, {
    headers: { authorization: `Bearer ${PULL_TOKEN}` }, signal: ctrl.signal,
  });
  clearTimeout(timer);
  if (!r.ok) { console.log(`join-reconcile: broker returned ${r.status}; keeping existing file.`); process.exit(0); }
  const body = await r.json();
  const incoming = (body.requests || []).filter((d) => d && /^[0-9a-f]{8,40}$/.test(String(d.id || '')));

  const { verifyIdToken, fetchJwksSource } = await import('./idtoken-verify.mjs');
  const jwksFile = process.env.AIOS_JWKS_FILE || env.AIOS_JWKS_FILE || '';
  const jwksSource = jwksFile ? async () => JSON.parse(await readFile(jwksFile, 'utf8')) : fetchJwksSource();
  const MS_TENANTS = String(process.env.AIOS_MS_TENANTS || env.AIOS_MS_TENANTS || '').split(',').map((t) => t.trim()).filter(Boolean);

  const consume = async (id) => {
    try {
      await fetch(`${DIRECTORY_URL}/join-consume`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${PULL_TOKEN}` },
        body: JSON.stringify({ org: ORG, id }),
      });
    } catch { /* broker optional */ }
  };

  let existing = [];
  try { existing = JSON.parse(await readFile(outPath, 'utf8')); } catch { existing = []; }
  if (!Array.isArray(existing)) existing = [];
  const known = new Set(existing.map((e) => e.id));

  const verified = [];
  for (const req of incoming) {
    // The email claim INSIDE the verified token is the identity; the staged email
    // field is display-only and never trusted.
    const tokenEmail = (() => {
      try { return String(JSON.parse(Buffer.from(String(req.id_token).split('.')[1], 'base64url').toString()).email || ''); } catch { return ''; }
    })();
    const v = tokenEmail
      ? await verifyIdToken(req.id_token, { email: tokenEmail, audience: AUDIENCE, jwksSource, msTenants: MS_TENANTS, expectedNonce: joinNonce(ORG) })
      : { ok: false, reason: 'no email claim in the token' };
    if (!v.ok) {
      // TRANSIENT failures (JWKS momentarily unreachable) must NOT delete a legitimate
      // request (2026-07-24 review): leave it for the next run. Only DEFINITIVE failures
      // (bad signature / audience / nonce / expiry / unverified email) are forged -> consume.
      const transient = /unavailable|jwks|fetch|network|timed out/i.test(String(v.reason));
      if (transient) { console.log(`join-reconcile: ${req.id} left for retry (${v.reason})`); continue; }
      console.log(`join-reconcile: dropped ${req.id} (${v.reason})`);
      await consume(req.id);
      continue;
    }
    verified.push({ id: req.id, name: String(req.name || '').slice(0, 80), email: v.email, at: req.at || 0 });
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(verified, null, 2));
  console.log(`join-reconcile: ${verified.length} verified request(s) waiting (${verified.map((v2) => v2.id.slice(0, 8)).join(', ') || 'none'}).`);

  // Notify hook for requests we have not seen before (panel-only otherwise).
  const fresh = verified.filter((v2) => !known.has(v2.id));
  if (fresh.length) {
    const { existsSync } = await import('node:fs');
    const notifyScript = path.join(repoRoot, 'control', 'notify.mjs');
    if (existsSync(notifyScript)) {
      const { execFile } = await import('node:child_process');
      for (const f of fresh) {
        await new Promise((res) => execFile('node', [notifyScript,
          `request to join: ${f.name} (${f.email}, verified) is asking to join. Approve or decline from the panel.`],
        { cwd: repoRoot, timeout: 30000 }, () => res()));
      }
    }
  }
} catch (e) {
  console.log(`join-reconcile: broker unreachable (${e.name}); nothing changed.`);
  process.exit(0);
}
