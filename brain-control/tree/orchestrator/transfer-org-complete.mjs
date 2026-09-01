#!/usr/bin/env node
// transfer-org-complete.mjs <slug>
// D60 O5b, the org's final leg: read the PUBLIC deploy key the member's box minted
// and published to heartbeat-<slug> (transfer-accept), validate its shape, and
// register it as a READ-WRITE deploy key on the org's <slug>-brain repo so the
// box's kernel pushes start landing. HTTP 422 "key is already in use" counts as
// idempotent success. The private half never existed anywhere but the box.
//
// Refusals (exit 1): no registry row; no pubkey on the heartbeat repo (the member
// has not accepted yet); pubkey fails the anchored ssh-ed25519 shape.
// Auth: ORG_GH_OWNER + ORG_GH_TOKEN (env or repo .env), the usual fallback chain.
// Tests inject HEARTBEAT_REMOTE_URL (local bare remote) + GITHUB_API_URL (HTTP stub).
import { readFile, mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOrgGitHub, refusal, plainRemote, runGit } from '../factory/org-github.mjs';

// The anchored shape push-member-key.mjs enforces: full-line ssh-ed25519, no smuggling.
const PUBKEY_RE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9@._ -]{1,64})?$/;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = process.argv[2];
if (!slug || !/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(slug)) {
  console.error('usage: transfer-org-complete <slug>'); process.exit(2);
}

const { owner: OWNER, token: TOKEN } = resolveOrgGitHub({ brainRoot: repoRoot });
if (!OWNER || !TOKEN) { console.error(refusal({ what: 'complete this transfer' })); process.exit(2); }

const rowPath = path.join(repoRoot, 'registry', 'members', `${slug}.yaml`);
const rowYaml = await readFile(rowPath, 'utf8').catch(() => { console.error(`REFUSED: no registry row for ${slug}`); process.exit(1); });
// Which invitation are we completing? The marker below has to belong to THIS one.
const inviteDate = (String(rowYaml).match(/^pending_transfer:\s*"to-org\s+([0-9-]+)"/m) || [, ''])[1];

// Read-only clone/pull of the heartbeat repo (the org owns it; the box only ever
// writes it). The pubkey the accept leg published lives at transfer/….pub.
const work = path.join(repoRoot, 'state', 'heartbeats-work', slug);
const remote = process.env.HEARTBEAT_REMOTE_URL || plainRemote(OWNER, `heartbeat-${slug}`);
const git = (args, cwd = work) => runGit(args, { cwd, token: TOKEN });
let cloned = false; try { await stat(path.join(work, '.git')); cloned = true; } catch {}
if (!cloned) { await mkdir(path.dirname(work), { recursive: true }); runGit(['clone', remote, work], { token: TOKEN }); }
else { git(['remote', 'set-url', 'origin', remote]); git(['pull', '--ff-only', 'origin', 'main']); }

const pub = (await readFile(path.join(work, 'transfer', 'org_brain_deploy_key.pub'), 'utf8').catch(() => '')).trim();
if (!pub) { console.error(`REFUSED: ${slug} has not accepted yet (no public key on the heartbeat channel). They accept in their app first.`); process.exit(1); }
if (!PUBKEY_RE.test(pub)) { console.error(`REFUSED: the published key is not a valid anchored ssh-ed25519 line (malformed shape); not registering it.`); process.exit(1); }
// The pubkey alone is not acceptance: the accept leg publishes it BEFORE flipping
// ownership, so a crash in between leaves a key with no consent. The post-flip
// accepted.json marker is the acceptance evidence (2026-07-25 gate, finding 4).
const marker = (await readFile(path.join(work, 'transfer', 'accepted.json'), 'utf8').catch(() => '')).trim();
if (!marker) { console.error(`REFUSED: ${slug} has not accepted yet (their box has not confirmed the custody flip). They re-run the accept in their app.`); process.exit(1); }
// A RECEIPT IS NOT REUSABLE. Both completion checks are file-existence tests
// against the heartbeat repo, and nothing ever deletes what they read. So after
// one full round trip (member -> org -> back to member), the ORIGINAL acceptance
// was still sitting there, and a SECOND transfer-to-org could complete on it
// with the member never being asked again: custody moved on a consent given for
// a different invitation, possibly months earlier. Bind the receipt to the
// invitation it answers. New boxes stamp `invited` and are matched exactly;
// older markers carry only a date, so require that it is not OLDER than this
// invitation, which is enough to reject every stale receipt (they predate it).
if (inviteDate) {
  let m = {};
  try { m = JSON.parse(marker); } catch { /* an unparseable marker is handled below */ }
  const bound = m.invited ? m.invited === inviteDate : (m.accepted && m.accepted >= inviteDate);
  if (!bound) {
    console.error(`REFUSED: the acceptance on ${slug}'s channel answers an EARLIER invitation `
      + `(accepted ${m.invited || m.accepted || 'unknown'}, this invitation staged ${inviteDate}). `
      + `Consent does not carry over between transfers: ask them to accept this one in their app.`);
    process.exit(1);
  }
}

const api = process.env.GITHUB_API_URL || 'https://api.github.com';
const r = await fetch(`${api}/repos/${OWNER}/${slug}-brain/keys`, {
  method: 'POST',
  headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'box-rw-brain', key: pub, read_only: false }),
});
if (r.status === 201) {
  console.log(`registered: the box's key is live on ${OWNER}/${slug}-brain (read-write). Its pushes land from the next kernel cycle.`);
} else if (r.status === 422) {
  const body = await r.json().catch(() => ({}));
  console.log(`already registered (${(body.message || 'key is already in use').toString().slice(0, 80)}). Nothing to do.`);
} else {
  const body = await r.text().catch(() => '');
  console.error(`GitHub refused the key (HTTP ${r.status}): ${body.slice(0, 200)}`);
  process.exit(1);
}
