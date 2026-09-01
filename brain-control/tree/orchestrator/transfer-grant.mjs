#!/usr/bin/env node
// transfer-grant.mjs <slug> grant|revoke
// D60 O5a: stage (or withdraw) the org->member custody grant for an ORG-OWNED box.
// Writes transfer/to-member.json into inbox-<slug> via the push-member-key transport;
// the box's org-sync pulls the inbox, and own-brain's receive branch requires this
// file before it will hand custody to the member. Content is non-sensitive.
//
// Refusals (exit 1, nothing pushed): no registry row; row not owner:"org" (a
// member-owned brain already belongs to the member; there is nothing to transfer).
// Auth: ORG_GH_OWNER + ORG_GH_TOKEN (env or repo .env), push-member-key fallback chain.
// Tests inject INBOX_REMOTE_URL to point at a local bare remote.
import { readFile, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOrgGitHub, refusal, plainRemote, runGit } from '../factory/org-github.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = process.argv[2];
const action = process.argv[3];
if (!slug || !/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(slug) || !['grant', 'revoke'].includes(action)) {
  console.error('usage: transfer-grant <slug> grant|revoke'); process.exit(2);
}

const { owner: OWNER, token: TOKEN } = resolveOrgGitHub({ brainRoot: repoRoot });
if (!OWNER || !TOKEN) { console.error(refusal({ what: 'grant this transfer' })); process.exit(2); }

// The row must exist AND be org-owned: ANY non-member owner (the pointer form,
// T1.6 finding 5) or the legacy 'org'. Absent owner defaults member (pre-O1 rows).
const rowPath = path.join(repoRoot, 'registry', 'members', `${slug}.yaml`);
const row = await readFile(rowPath, 'utf8').catch(() => { console.error(`REFUSED: no registry row for ${slug}`); process.exit(1); });
const owner = (row.match(/^owner:\s*"?([a-z0-9-]+)"?/m) || [, 'member'])[1];
if (owner === 'member') {
  console.error(`REFUSED: ${slug} is member-owned (owner=${owner}); their brain already belongs to them, there is nothing to transfer.`);
  process.exit(1);
}

// Clone-or-pull the inbox working copy, write/remove the one grant file, push.
const clone = path.join(repoRoot, 'state', 'inboxes', slug);
const remote = process.env.INBOX_REMOTE_URL || plainRemote(OWNER, `inbox-${slug}`);
const git = (args, cwd = clone) => runGit(args, { cwd, token: TOKEN });
let cloned = false; try { await stat(path.join(clone, '.git')); cloned = true; } catch {}
if (!cloned) { await mkdir(path.dirname(clone), { recursive: true }); runGit(['clone', remote, clone], { token: TOKEN }); }
else { git(['remote', 'set-url', 'origin', remote]); git(['pull', '--ff-only', 'origin', 'main']); }

const grantPath = path.join(clone, 'transfer', 'to-member.json');
if (action === 'grant') {
  await mkdir(path.join(clone, 'transfer'), { recursive: true });
  await writeFile(grantPath, JSON.stringify({ granted: new Date().toISOString().slice(0, 10) }) + '\n');
} else {
  await rm(grantPath, { force: true });
}

git(['add', '-A']);
const dirty = git(['status', '--porcelain']).trim();
if (!dirty) { console.log(`transfer grant already ${action === 'grant' ? 'current' : 'absent'} for ${slug}.`); process.exit(0); }
git(['-c', 'user.name=Rock Brain', '-c', 'user.email=transfer-grant@rock.local', 'commit', '-q', '-m', `transfer-grant: ${slug} ${action}`]);
git(['push', 'origin', 'main']);
console.log(action === 'grant'
  ? `granted: ${slug} can now take ownership of their brain in their app (fresh copy under their account; the rock keeps its repo).`
  : `revoked: the pending transfer grant for ${slug} is withdrawn.`);
