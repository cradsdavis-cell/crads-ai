#!/usr/bin/env node
// broker-register.mjs — one-time, idempotent: register THIS org with the thin central broker
// (D51 Phase 2, directory.crads-ai.com) so members' staged device keys can be pulled by
// invite-reconcile.mjs and the admin never pastes a key line by hand.
//
// What it does, in order:
//   1. If the repo .env already carries ORG_PULL_TOKEN, verify it against the broker
//      (GET /pending must answer 200) and exit 0: already registered.
//   2. Otherwise mint a fresh pull token, POST /register { org, rock_ssh_host,
//      org_display, pull_token } (first-write-wins; the broker stores only the SHA-256),
//      and append ORG_PULL_TOKEN to the repo .env (gitignored; NEVER committed).
//
// Fail-soft by design: any broker problem prints one line and exits 0 — the Phase-1
// manual paste-back keeps working, nothing central is required. The only non-zero exit
// is a local problem (no org handle / cannot write .env), which the caller should show.
//
// usage: node control/broker-register.mjs [--host <public-host-or-ip>]
//   --host: the address members' apps SSH to. Fallbacks, in order: this box's own public
//           IP (members SSH to the raw IP; the tunnel hostname only proxies the browser
//           port), then the url host in /state/deployment.yaml.
// SELF-HOST STRIP (2026-09-01): the central directory this script spoke to
// (directory.crads-ai.com) is deleted, along with the account system. It exits
// here — silently, 0 — so a rock that syncs this machinery on boot stops
// phoning a dead service on its reconcile cadence. The body below is kept for
// reference until the commons model replaces this leg. Authored upstream in
// brain-template; keep the two copies identical.
process.exit(0);

import { readFile, appendFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const hostArg = args.includes('--host') ? String(args[args.indexOf('--host') + 1] || '') : '';

const envText = await readFile(path.join(repoRoot, '.env'), 'utf8').catch(() => '');
const env = Object.fromEntries(envText.split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

const DIRECTORY_URL = process.env.CRADS_DIRECTORY_URL || env.CRADS_DIRECTORY_URL || 'https://directory.crads-ai.com';
const policy = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
const ORG = (policy.match(/^\s*name:\s*"?([^"\n#]+)"?/m) || [])[1]?.trim();
const DISPLAY = (policy.match(/^\s*display_name:\s*"?([^"\n#]+)"?/m) || [])[1]?.trim() || ORG;
if (!ORG) { console.error('ERROR: org-policy.yaml has no org name; cannot register.'); process.exit(1); }

async function broker(pathname, opts = {}, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(DIRECTORY_URL + pathname, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

// 1. Already registered with a working token? Then this is a no-op.
if (env.ORG_PULL_TOKEN) {
  try {
    const r = await broker(`/pending?org=${encodeURIComponent(ORG)}`, { headers: { authorization: `Bearer ${env.ORG_PULL_TOKEN}` } });
    if (r.ok) { console.log(`broker-register: already registered as "${ORG}" and the pull token works. Nothing to do.`); process.exit(0); }
    console.log(`broker-register: a pull token exists in .env but the broker refused it (${r.status}). The org handle may be registered with a lost token; this needs an operator to clear route:${ORG} at the broker. Manual paste-back keeps working meanwhile.`);
    process.exit(0);
  } catch {
    console.log('broker-register: broker unreachable; keeping the existing token. Manual paste-back keeps working.');
    process.exit(0);
  }
}

// 2. Fresh registration.
let host = hostArg;
if (!host) {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
    host = (await (await fetch('https://api.ipify.org', { signal: ctrl.signal })).text()).trim();
    clearTimeout(t);
    if (!/^[0-9.]{7,15}$/.test(host)) host = '';
  } catch { host = ''; }
}
if (!host) {
  const dep = await readFile('/state/deployment.yaml', 'utf8').catch(() => '');
  host = (dep.match(/^\s*url:\s*"?https?:\/\/([^/"\n]+)/m) || [])[1] || '';
}
if (!host) { console.error('ERROR: no --host given and this box could not learn its own public IP; pass --host <address members SSH to>.'); process.exit(1); }

const token = 'pt_' + randomBytes(24).toString('base64url');
try {
  const r = await broker('/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ org: ORG, rock_ssh_host: host, org_display: DISPLAY, pull_token: token }),
  });
  if (r.status === 409) {
    console.log(`broker-register: the handle "${ORG}" is already registered at the broker but this box holds no token for it. An operator must clear route:${ORG} at the broker before re-registering. Manual paste-back keeps working.`);
    process.exit(0);
  }
  if (!r.ok) { console.log(`broker-register: broker returned ${r.status}; not registered. Manual paste-back keeps working.`); process.exit(0); }
} catch {
  console.log('broker-register: broker unreachable; not registered. Manual paste-back keeps working.');
  process.exit(0);
}

// Token accepted: persist it (gitignored .env only — never committed, never in the registry).
await appendFile(path.join(repoRoot, '.env'), `${envText && !envText.endsWith('\n') ? '\n' : ''}ORG_PULL_TOKEN=${token}\n`);
console.log(`broker-register: registered "${ORG}" (host ${host}). Staged member devices will now appear in the panel automatically.`);
