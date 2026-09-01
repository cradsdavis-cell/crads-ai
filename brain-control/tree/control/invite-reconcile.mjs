#!/usr/bin/env node
// invite-reconcile.mjs — the rock pulls its org's STAGED member device keys from the thin
// central broker (D51 Phase 2) and writes them where the panel's "Approve a device" reads, so
// the admin no longer pastes the key line. The exact mirror of heartbeat-pull.mjs: a small,
// fail-silent, read-only pull on a rock cron. NOTHING is auto-installed — the two-party
// FINGERPRINT approval still runs in the panel; this only removes the manual paste.
//
// Reads: org handle from org-policy.yaml (org.name); ORG_PULL_TOKEN + CRADS_DIRECTORY_URL from
// the repo .env / env. Writes: control/pending-devices.json (public keys + codes only).
// Fail-silent: if the broker is undeployed/unreachable, it leaves the file as-is and Phase-1
// manual paste-back keeps working.
// SELF-HOST STRIP (2026-09-01): the central directory this script spoke to
// (directory.crads-ai.com) is deleted, along with the account system. It exits
// here — silently, 0 — so a rock that syncs this machinery on boot stops
// phoning a dead service on its reconcile cadence. The body below is kept for
// reference until the commons model replaces this leg. Authored upstream in
// brain-template; keep the two copies identical.
process.exit(0);

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries((await readFile(path.join(repoRoot, '.env'), 'utf8').catch(() => ''))
  .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

const DIRECTORY_URL = process.env.CRADS_DIRECTORY_URL || env.CRADS_DIRECTORY_URL || 'https://directory.crads-ai.com';
const PULL_TOKEN = process.env.ORG_PULL_TOKEN || env.ORG_PULL_TOKEN;
const policy = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
const ORG = (policy.match(/^\s*name:\s*"?([^"\n#]+)"?/m) || [])[1]?.trim();

const out = path.join(repoRoot, 'control', 'pending-devices.json');
async function write(list) { await mkdir(path.dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(list, null, 2)); }

if (!PULL_TOKEN || !ORG) {
  // Not registered with the broker (Phase-1 org): nothing to reconcile. Leave the file empty.
  await write([]);
  console.log('invite-reconcile: no ORG_PULL_TOKEN / org handle — Phase-1 org, manual paste-back stands.');
  process.exit(0);
}

try {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  const r = await fetch(`${DIRECTORY_URL}/pending?org=${encodeURIComponent(ORG)}`, {
    headers: { authorization: `Bearer ${PULL_TOKEN}` }, signal: ctrl.signal,
  });
  clearTimeout(timer);
  if (!r.ok) { console.log(`invite-reconcile: broker returned ${r.status}; keeping existing pending file.`); process.exit(0); }
  const body = await r.json();
  // Anchored pubkey shape (a prefix-only test allowed YAML key-smuggling; review 2026-07-24).
  const PUBKEY_RE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9@._ -]{1,64})?$/;
  let pending = (body.pending || []).filter((d) => d && d.slug && PUBKEY_RE.test(String(d.pubkey || '').trim()) && /^[A-Z2-7]{6}$/.test(d.fingerprint || ''));

  // D58 (spec 2026-07-24 § 1): staged redeems carrying an OAuth ID token are verified HERE
  // (rock-side, never trusting the broker) and auto-approved. Everything else, and every
  // verification failure, stays in pending-devices.json for the panel's manual readback.
  // Audience = the app's OAuth client id (env/.env); AIOS_JWKS_FILE injects fixture keys for
  // certification runs while the real client ids are still unregistered (BLOCKERS.md).
  const { DEFAULT_OAUTH_AUDIENCE } = await import('./oauth-audience.mjs');
  const AUDIENCE = process.env.AIOS_OAUTH_AUDIENCE || env.AIOS_OAUTH_AUDIENCE || DEFAULT_OAUTH_AUDIENCE;
  if (AUDIENCE && pending.some((d) => d.id_token)) {
    try {
      const { autoApprove } = await import('./auto-approve.mjs');
      const { fetchJwksSource } = await import('./idtoken-verify.mjs');
      const jwksFile = process.env.AIOS_JWKS_FILE || env.AIOS_JWKS_FILE || '';
      const jwksSource = jwksFile
        ? async () => JSON.parse(await readFile(jwksFile, 'utf8'))
        : fetchJwksSource();
      const { execFile } = await import('node:child_process');
      const runner = (cmd, args, opts) => new Promise((res, rej) => execFile(cmd, args, { ...opts, timeout: 120000 }, (e, so, se) => (e ? rej(new Error(se || e.message)) : res({ code: 0, stdout: so }))));
      const byFp = Object.fromEntries(pending.map((d) => [d.slug, d.fingerprint]));
      const MS_TENANTS = String(process.env.AIOS_MS_TENANTS || env.AIOS_MS_TENANTS || '').split(',').map((t) => t.trim()).filter(Boolean);
      const out = await autoApprove({ repoRoot, pending, audience: AUDIENCE, jwksSource, runner, msTenants: MS_TENANTS, log: console.log });
      pending = out.remaining;
      if (out.approved.length) {
        console.log(`invite-reconcile: auto-approved ${out.approved.join(', ')}.`);
        // P1.5 notify hook: an org that configured control/notify.mjs hears about each
        // auto-enrolled device (panel-only otherwise). Fail-silent, never blocks reconcile.
        const notifyScript = path.join(repoRoot, 'control', 'notify.mjs');
        const { existsSync } = await import('node:fs');
        if (existsSync(notifyScript)) {
          // Say WHICH proof let them in. Since 2026-08-09 a device can enrol on
          // the invite token alone (Sam: "the link is the proof"), so a notice
          // that always claimed "verified sign-in" would be false half the time
          // — and this notice is the whole of an admin's awareness now that the
          // approval ceremony is gone.
          for (const slug of out.approved) {
            const d = (out.details || []).find((x) => x.slug === slug) || {};
            const how = d.proven === 'invite_token'
              ? 'let in by their invite link'
              : 'let in by verified sign-in';
            await runner('node', [notifyScript,
              `device joined: ${slug} ${how} (code ${d.fingerprint || byFp[slug] || '?'}). They are on your People page; revoke there if that was not them.`],
            { cwd: repoRoot }).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.log(`invite-reconcile: auto-approve skipped (${String(e.message || e)}); manual approval stands.`);
    }
  }
  await write(pending);
  console.log(`invite-reconcile: ${pending.length} pending device(s) staged for approval.`);
} catch (e) {
  // Fail-silent: the broker is optional. Phase-1 paste-back is unaffected.
  console.log(`invite-reconcile: broker unreachable (${e.name}); Phase-1 manual paste-back stands.`);
  process.exit(0);
}
