#!/usr/bin/env node
// transfer-member-verify.mjs <slug>
// Verified Complete, to-member leg (verb-interview ruling 2026-08-03): the
// org's transfer-complete used to flip the registry on a human promise ("only
// confirm once they have taken ownership"), because nothing org-visible
// recorded the member's acceptance. Now own-brain publishes an acceptance
// receipt to heartbeat-<slug> (the one repo the box writes and the org reads,
// the same channel transfer-accept already uses for the to-org leg), and this
// script is the check: exit 0 when the receipt exists and parses, exit 1 with
// plain words when it does not. transfer-complete runs it before the flip.
//
// Auth + read mechanism mirror transfer-org-complete.mjs exactly (read-only
// clone/pull with the org token; tests inject HEARTBEAT_REMOTE_URL).
import { readFile, mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOrgGitHub, refusal, plainRemote, runGit } from '../factory/org-github.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = process.argv[2];
if (!slug || !/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(slug)) {
  console.error('usage: transfer-member-verify <slug>'); process.exit(2);
}

const { owner: OWNER, token: TOKEN } = resolveOrgGitHub({ brainRoot: repoRoot });
if (!OWNER || !TOKEN) { console.error(refusal({ what: 'verify this transfer' })); process.exit(2); }

const rowPath = path.join(repoRoot, 'registry', 'members', `${slug}.yaml`);
const rowYaml = await readFile(rowPath, 'utf8').catch(() => { console.error(`REFUSED: no registry row for ${slug}`); process.exit(1); });
// Which grant are we completing? The receipt below has to answer THIS one.
const grantDate = (String(rowYaml).match(/^pending_transfer:\s*"to-member\s+([0-9-]+)"/m) || [, ''])[1];

const work = path.join(repoRoot, 'state', 'heartbeats-work', slug);
const remote = process.env.HEARTBEAT_REMOTE_URL || plainRemote(OWNER, `heartbeat-${slug}`);
const git = (args, cwd = work) => runGit(args, { cwd, token: TOKEN });
let cloned = false; try { await stat(path.join(work, '.git')); cloned = true; } catch { /* fresh */ }
if (!cloned) { await mkdir(path.dirname(work), { recursive: true }); runGit(['clone', remote, work], { token: TOKEN }); }
else { git(['remote', 'set-url', 'origin', remote]); git(['pull', '--ff-only', 'origin', 'main']); }

const raw = (await readFile(path.join(work, 'transfer', 'owned-by-member.json'), 'utf8').catch(() => '')).trim();
if (!raw) {
  console.error(`REFUSED: ${slug} has not finished taking ownership yet (no acceptance receipt on the heartbeat channel). They complete the Own my brain step in their app first; nothing has moved.`);
  process.exit(1);
}
let rec;
try { rec = JSON.parse(raw); } catch {
  console.error('REFUSED: the acceptance receipt is malformed; ask them to re-run Own my brain in their app.');
  process.exit(1);
}
if (rec.owned !== 'member') {
  console.error('REFUSED: the receipt on the channel does not record member ownership; not completing.');
  process.exit(1);
}
// A RECEIPT IS NOT REUSABLE, the member half. own-brain publishes this marker at
// the end of EVERY successful run and nothing ever deletes it, so once a member
// had taken ownership once, a LATER transfer-to-member could complete on that
// same receipt with the member doing nothing at all. Same defect as the to-org
// direction; both halves have to be bound or the round trip just moves which
// side is free. Receipts that name their grant are matched exactly; older ones
// carry only a date and must not PREDATE this grant, which rejects every
// carried-over receipt since a stale one necessarily does.
if (grantDate) {
  const bound = rec.granted ? rec.granted === grantDate : (rec.at && rec.at >= grantDate);
  if (!bound) {
    console.error(`REFUSED: the receipt on ${slug}'s channel answers an EARLIER grant `
      + `(receipt ${rec.granted || rec.at || 'undated'}, this grant staged ${grantDate}). `
      + `Ownership does not carry over between transfers: ask them to run Own my brain for this one.`);
    process.exit(1);
  }
}
console.log(`verified: ${slug} took ownership${rec.at ? ` on ${rec.at}` : ''}${rec.repo ? ` (their copy lives at ${rec.repo})` : ''}.`);
