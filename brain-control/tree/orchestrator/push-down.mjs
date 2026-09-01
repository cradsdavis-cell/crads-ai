#!/usr/bin/env node
// push-down.mjs <slug> <payload-dir> <dest-subpath>
// One-way delivery: copy payload-dir into the pebble's inbox repo under dest-subpath,
// commit, push. REFUSES unless registry status is active. NEVER reads/fetches a pebble box.
// The inverse of the member's own backup: there, the box pushes to its own remote;
// here, the ROCK pushes to a repo the pebble only reads.
//
// Auth: ORG_GH_OWNER + ORG_GH_TOKEN (process env or repo .env). Legacy names
// IC_ORG / IC_ORG_TOKEN from the first deployment's generation are honoured,
// then GH_OWNER / GITHUB_TOKEN as staged by the rock's factory env
// (provisioning.env.local) -- same chain as push-member-key.mjs and
// factory/stamp-pebble.sh.
import { readFile, cp, mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pushConsent } from '../registry/consent.mjs';
import { extractRow } from '../registry/normalize-row.mjs';
import { fileURLToPath } from 'node:url';
import { resolveOrgGitHub, refusal, plainRemote, runGit } from '../factory/org-github.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
// --allow-paused (evict, 2026-08-04 review): the eviction NOTICE is a lifecycle
// message, not content, and the commonest eviction follows a pause for
// non-payment — so this one flag lets delivery reach a PAUSED row (status and
// delivery_pause both). Everything else (left, invited, consent gates) refuses
// exactly as before; nothing but evict-member passes it.
const ALLOW_PAUSED = args.includes('--allow-paused');
const [slug, payloadDir, destSub] = args.filter((a) => a !== '--allow-paused');
if (!slug || !payloadDir || !destSub) { console.error('usage: push-down <slug> <payload-dir> <dest-subpath>'); process.exit(2); }

const { owner: OWNER, token: TOKEN } = resolveOrgGitHub({ brainRoot: repoRoot });
if (!OWNER || !TOKEN) { console.error(refusal({ what: 'deliver content to a member box' })); process.exit(2); }

// Membership gate.
//
// ONE INBOX (spec 2026-08-17 § 3): a JOINED tie has a channel but no seat, so
// this read used to throw `no registry row` and the catalogue could never reach
// them. A tie record stands in, and deliberately satisfies the gates below
// trivially rather than growing its own vocabulary of them:
//   - status: a tie exists or it does not; tie-reconcile drops `left` ties, and
//     an ended tie has its record removed, so a present record is active.
//   - delivery_pause: that is the ANCHOR's tap on a box it hosts and bills.
//     A joined member is neither hosted nor billed here, so there is nothing to
//     pause and inventing one would be a control with no meaning behind it.
//   - consent: consent rides OWNERSHIP, and this rock owns nothing of a joined
//     member's. Their box pulls what it is offered and installs nothing on its
//     own (always-pickup), which is the consent.
// If a tie ever needs a pause, it gets a field on the tie record and a line
// here, not a registry row.
const rowPath = path.join(repoRoot, 'registry', 'members', `${slug}.yaml`);
const tiePath = path.join(repoRoot, 'registry', 'ties', `${slug}.json`);
const seatRow = await readFile(rowPath, 'utf8').catch(() => null);
if (seatRow === null && !(await readFile(tiePath, 'utf8').catch(() => null))) {
  throw new Error(`no registry row for ${slug}`);
}
const row = seatRow ?? 'status: "active"\n';
const status = (row.match(/^status:\s*"?(\w+)"?/m) || [, 'unknown'])[1];
if (status !== 'active' && !(ALLOW_PAUSED && status === 'paused')) {
  console.error(`REFUSED: ${slug} status is '${status}', not active. push-down is off.`);
  process.exit(1);
}

// T2.6: the anchor's per-box DELIVERY PAUSE. One tap gates every content leg
// (push-skill + install-pack ride this transport). Seat, registry row and
// heartbeats persist; pulse never touches a box. The anchor's own call, no
// consent needed (ruled 2026-07-27); push-member-key stays ungated (revoke).
if (!ALLOW_PAUSED && (row.match(/^delivery_pause:\s*"?(\w*)"?/m) || [, ''])[1] === 'true') {
  console.error(`REFUSED: delivery to ${slug} is paused by the anchor. Content and installs stop; seat, registry and heartbeat persist. Resume by setting delivery_pause off.`);
  process.exit(1);
}

// T2.5 (supersedes the O6 inline gate): consent rides OWNERSHIP. The anchor
// pushing to a box it OWNS needs no consent; a box owned by the member OR by a
// DIFFERENT org (the pointer, T1.1) is consent-gated. Resolution keeps the O6
// shape: row field -> org-policy member_defaults -> ALLOW (the absent-
// everything default is load-bearing for live pre-field rows). The old inline
// \w+ owner read also truncated pointer slugs at hyphens; registry/consent.mjs
// normalizes properly. push-member-key stays deliberately NOT gated (revoke).
{
  const policy = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
  const anchorSlug = (policy.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim() || '';
  const policyDefault = (policy.match(/^\s{2}infra_push_consent:\s*"?(\w+)"?/m) || [, ''])[1];
  const gate = pushConsent({ row: extractRow(row) , anchorSlug, policyDefault });
  if (!gate.allowed) {
    console.error(`REFUSED: ${slug}: ${gate.why}.`);
    process.exit(1);
  }
}

// Local working clone (gitignored: state/inboxes/<slug>). Rock-write only.
const clone = path.join(repoRoot, 'state', 'inboxes', slug);
const remote = process.env.INBOX_REMOTE_URL || plainRemote(OWNER, `inbox-${slug}`);
const git = (args, cwd = clone) => runGit(args, { cwd, token: TOKEN });
let cloned = false; try { await stat(path.join(clone, '.git')); cloned = true; } catch {}
if (!cloned) { await mkdir(path.dirname(clone), { recursive: true }); runGit(['clone', remote, clone], { token: TOKEN }); }
else { git(['remote', 'set-url', 'origin', remote]); git(['pull', '--ff-only', 'origin', 'main']); }

// Additive copy (never a read of the pebble; the pebble is not a source here).
const dest = path.join(clone, destSub);
await mkdir(dest, { recursive: true });
await cp(payloadDir, dest, { recursive: true });

git(['add', '-A']);
const dirty = git(['status', '--porcelain']).trim();
if (!dirty) { console.log('nothing to push (already current).'); process.exit(0); }
git(['-c', 'user.name=Rock Brain', '-c', 'user.email=push-down@rock.local', 'commit', '-q', '-m', `push-down: ${destSub}`]);
git(['push', 'origin', 'main']);
console.log(`pushed ${destSub} -> inbox-${slug}. (no read-back path exists.)`);
