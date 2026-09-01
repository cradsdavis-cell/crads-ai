#!/usr/bin/env node
// push-ask.mjs <slug> <ask-read|ask-install|reframe> [--framework X] [--intensity overlay|integrate|rebuild] [--note "..."] [--withdraw]
// Slice 2 (pebble agency, verb-interview rulings 2026-08-03): a rock's
// permission question or framework offer to a MEMBER-OWNED box rides the
// box's own inbox channel (asks/<kind>.json in inbox-<slug>), the same
// transport transfer-invite uses; the person answers from their console and
// the answer comes back up the heartbeat repo (ask-answers-reconcile reads
// it). The directory fabric stays org-to-org; this is the member lane.
//
// Refusals (exit 1, nothing pushed): no registry row; org-owned row (the
// rock owns that box's consent already: flip the grant in
// governance, do not ask yourself). --withdraw removes the ask file.
import { readFile, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOrgGitHub, refusal, plainRemote, runGit } from '../factory/org-github.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const slug = args[0]; const kind = args[1];
const KINDS = ['ask-read', 'ask-install', 'reframe'];
if (!slug || !/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(slug) || !KINDS.includes(kind)) {
  console.error(`usage: push-ask <slug> <${KINDS.join('|')}> [--framework X] [--intensity I] [--note N] [--withdraw]`); process.exit(2);
}
const opt = (name) => { const i = args.indexOf(`--${name}`); return i > -1 ? String(args[i + 1] || '') : ''; };
const withdraw = args.includes('--withdraw');
const framework = opt('framework').slice(0, 80);
const intensity = opt('intensity') || 'overlay';
const note = opt('note').slice(0, 240);
if (kind === 'reframe' && !withdraw && !framework) { console.error('a reframe offer names the framework (--framework)'); process.exit(2); }
if (!['overlay', 'integrate', 'rebuild'].includes(intensity)) { console.error('intensity must be overlay, integrate or rebuild'); process.exit(2); }

const { owner: OWNER, token: TOKEN } = resolveOrgGitHub({ brainRoot: repoRoot });
if (!OWNER || !TOKEN) { console.error(refusal({ what: 'send this to a member box' })); process.exit(2); }

const rowPath = path.join(repoRoot, 'registry', 'members', `${slug}.yaml`);
const row = await readFile(rowPath, 'utf8').catch(() => { console.error(`REFUSED: no registry row for ${slug}`); process.exit(1); });
const owner = (row.match(/^owner:\s*"?([a-z0-9-]+)"?/m) || [, 'member'])[1];
if (owner !== 'member') {
  console.error(`REFUSED: ${slug} is org-owned; its consent is the rock's own. Flip the grant in governance instead of asking yourself.`);
  process.exit(1);
}

const pol = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
const orgSlug = (pol.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim() || OWNER;

const clone = path.join(repoRoot, 'state', 'inboxes', slug);
const remote = process.env.INBOX_REMOTE_URL || plainRemote(OWNER, `inbox-${slug}`);
const git = (a, cwd = clone) => runGit(a, { cwd, token: TOKEN });
let cloned = false; try { await stat(path.join(clone, '.git')); cloned = true; } catch { /* fresh */ }
if (!cloned) { await mkdir(path.dirname(clone), { recursive: true }); runGit(['clone', remote, clone], { token: TOKEN }); }
else { git(['remote', 'set-url', 'origin', remote]); git(['pull', '--ff-only', 'origin', 'main']); }

const adir = path.join(clone, 'asks');
const file = path.join(adir, `${kind}.json`);
if (withdraw) {
  await rm(file, { force: true });
} else {
  await mkdir(adir, { recursive: true });
  await writeFile(file, JSON.stringify({
    kind, from: orgSlug, asked: new Date().toISOString().slice(0, 10),
    ...(note ? { note } : {}),
    ...(kind === 'reframe' ? { framework, intensity } : {}),
  }) + '\n');
}
git(['add', '-A']);
if (!git(['status', '--porcelain']).trim()) { console.log(`ask already ${withdraw ? 'absent' : 'current'} for ${slug}.`); process.exit(0); }
git(['-c', 'user.name=Rock Brain', '-c', 'user.email=push-ask@rock.local', 'commit', '-q', '-m', `push-ask: ${slug} ${kind}${withdraw ? ' withdraw' : ''}`]);
git(['push', 'origin', 'main']);
console.log(withdraw
  ? `withdrawn: the ${kind} ask to ${slug} is off their inbox.`
  : `asked: ${kind} is on ${slug}'s inbox. They answer from their console; the answer lands on the next console read here.`);
