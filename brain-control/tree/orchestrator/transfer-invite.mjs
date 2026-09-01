#!/usr/bin/env node
// transfer-invite.mjs <slug> invite|revoke
// D60 O5b: stage (or withdraw) the member->org custody INVITATION for a MEMBER-OWNED
// box. The transfer-grant transport, direction reversed: writes transfer/to-org.json
// plus the two box scripts the accept leg needs (transfer-accept.sh, org-brain-wire.sh)
// into inbox-<slug>; the box's org-sync pulls them, and the member accepts by running
// the delivered script from their own app (consent = member action on their own box).
// Nothing here carries a secret: the deploy key is minted ON the box at accept time
// and only its PUBLIC half ever travels (up, via the heartbeat repo).
//
// Refusals (exit 1, nothing pushed): no registry row; row owner is "org" (custody is
// already the rock's; there is nothing to transfer in this direction).
// Revoke removes exactly the invite set and never touches O5a's transfer/to-member.json.
// Auth: ORG_GH_OWNER + ORG_GH_TOKEN (env or repo .env), the push-member-key fallback
// chain. Tests inject INBOX_REMOTE_URL to point at a local bare remote.
import { readFile, mkdir, writeFile, rm, stat, copyFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOrgGitHub, refusal, plainRemote, runGit } from '../factory/org-github.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = process.argv[2];
const action = process.argv[3];
if (!slug || !/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(slug) || !['invite', 'revoke'].includes(action)) {
  console.error('usage: transfer-invite <slug> invite|revoke'); process.exit(2);
}

const { owner: OWNER, token: TOKEN } = resolveOrgGitHub({ brainRoot: repoRoot });
if (!OWNER || !TOKEN) { console.error(refusal({ what: 'offer this transfer' })); process.exit(2); }

// The row must exist AND be member-owned. Absent owner defaults member (pre-O1 rows are
// member-owned by definition, so they MAY be invited).
const rowPath = path.join(repoRoot, 'registry', 'members', `${slug}.yaml`);
const row = await readFile(rowPath, 'utf8').catch(() => { console.error(`REFUSED: no registry row for ${slug}`); process.exit(1); });
const owner = (row.match(/^owner:\s*"?([a-z0-9-]+)"?/m) || [, 'member'])[1];
if (owner !== 'member') {
  console.error(`REFUSED: ${slug} is org-owned; the brain is already the rock's, there is nothing to transfer in this direction.`);
  process.exit(1);
}

// Clone-or-pull the inbox working copy, write/remove the invite set, push.
const clone = path.join(repoRoot, 'state', 'inboxes', slug);
const remote = process.env.INBOX_REMOTE_URL || plainRemote(OWNER, `inbox-${slug}`);
const git = (args, cwd = clone) => runGit(args, { cwd, token: TOKEN });
let cloned = false; try { await stat(path.join(clone, '.git')); cloned = true; } catch {}
if (!cloned) { await mkdir(path.dirname(clone), { recursive: true }); runGit(['clone', remote, clone], { token: TOKEN }); }
else { git(['remote', 'set-url', 'origin', remote]); git(['pull', '--ff-only', 'origin', 'main']); }

const tdir = path.join(clone, 'transfer');
const INVITE_SET = ['to-org.json', 'transfer-accept.sh', 'org-brain-wire.sh'];
if (action === 'invite') {
  await mkdir(tdir, { recursive: true });
  // T2.3: carry the org's directory slug so the box can record the owner POINTER
  // (owner_slug) at accept time, not just the binary. Fallback: the GH owner.
  const pol = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
  const orgSlug = (pol.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim() || OWNER;
  await writeFile(path.join(tdir, 'to-org.json'),
    JSON.stringify({ invited: new Date().toISOString().slice(0, 10), repo: `${OWNER}/${slug}-brain`, org_slug: orgSlug }) + '\n');
  for (const s of ['transfer-accept.sh', 'org-brain-wire.sh']) {
    await copyFile(path.join(repoRoot, 'pebble-template', 'box', s), path.join(tdir, s));
    await chmod(path.join(tdir, s), 0o755);
  }
} else {
  for (const f of INVITE_SET) await rm(path.join(tdir, f), { force: true });
}

git(['add', '-A']);
const dirty = git(['status', '--porcelain']).trim();
if (!dirty) { console.log(`transfer invitation already ${action === 'invite' ? 'current' : 'absent'} for ${slug}.`); process.exit(0); }
git(['-c', 'user.name=Rock Brain', '-c', 'user.email=transfer-invite@rock.local', 'commit', '-q', '-m', `transfer-invite: ${slug} ${action}`]);
git(['push', 'origin', 'main']);
console.log(action === 'invite'
  ? `invited: ${slug} can now accept in their app (their box mints its own key; only the public half travels). The member keeps any personal repo they already own.`
  : `revoked: the pending transfer invitation for ${slug} is withdrawn.`);
