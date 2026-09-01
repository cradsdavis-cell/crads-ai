#!/usr/bin/env node
// leave-reconcile.mjs · slice 2 (2026-08-03): "leaving never needs permission".
// A member-owned box leaves its home rock by publishing leave.json to its
// heartbeat repo (the pebble's app arms it with a typed confirm). This
// reconcile is the rock's side of the fact, not a consent step: the row flips
// left, the door key detaches (push-member-key delivers the empty set for a
// left row), the edge reflects, the rock is notified once. Idempotent by
// slug|at; rows already left are skipped. Registry commit/push rides the
// caller's cadence (git-sync). The box and its brain are the member's and are
// not touched: only the rock's channel ends.
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOrgGitHub, plainRemote, runGit } from '../factory/org-github.mjs';
import { setScalar } from '../registry/set-field.mjs';

// A row write is not visible until the INDEX is rebuilt: the panel's Fleet
// health reads registry/index.json, not the yaml files. Every panel verb that
// touches a row runs build-index; these appliers did not, so a member who had
// LEFT still showed as ACTIVE on Fleet health, with Pause/Transfer/Leave
// offered against a box whose door key was already detached (seen live
// 2026-08-03). Fail-soft: a missing builder must never strand an applied row.
const rebuildIndex = async (root) => {
  const b = path.join(root, 'registry', 'build-index.mjs');
  if (!existsSync(b)) return;
  await new Promise((res) => execFile('node', [b], { cwd: root }, () => res())).catch(() => {});
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
const ORG = (policy.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim();
if (!ORG) { console.log('leave-reconcile: dormant (no org handle).'); process.exit(0); }
// Dormant, not refusing: see the note in ask-answers-reconcile.mjs.
const { owner: OWNER, token: TOKEN } = resolveOrgGitHub({ brainRoot: repoRoot });
if (!OWNER || !TOKEN) { console.log('leave-reconcile: dormant (no org GH auth).'); process.exit(0); }

const ledgerPath = path.join(repoRoot, 'control', 'leave-applied.json');
const applied = JSON.parse(await readFile(ledgerPath, 'utf8').catch(() => '[]'));
const notify = async (msg) => {
  const script = path.join(repoRoot, 'control', 'notify.mjs');
  if (!existsSync(script)) return;
  await new Promise((res) => execFile('node', [script, msg], { cwd: repoRoot }, () => res())).catch(() => {});
};

const files = await readdir(path.join(repoRoot, 'registry', 'members')).catch(() => []);
let left = 0;
for (const f of files) {
  if (!f.endsWith('.yaml') || f.startsWith('_')) continue;
  const slug = f.replace(/\.yaml$/, '');
  const p = path.join(repoRoot, 'registry', 'members', f);
  const rowText = await readFile(p, 'utf8').catch(() => '');
  if (!rowText) continue;
  const owner = (rowText.match(/^owner:\s*"?([a-z0-9-]+)"?/m) || [, 'member'])[1];
  const status = (rowText.match(/^status:\s*"?([a-z]+)"?/m) || [, 'active'])[1];
  if (owner !== 'member' || status === 'left') continue;

  const work = path.join(repoRoot, 'state', 'heartbeats-work', slug);
  const remote = process.env.HEARTBEAT_REMOTE_URL || plainRemote(OWNER, `heartbeat-${slug}`);
  try {
    const git = (a, cwd = work) => runGit(a, { cwd, token: TOKEN });
    let cloned = false; try { await stat(path.join(work, '.git')); cloned = true; } catch { /* fresh */ }
    if (!cloned) { await mkdir(path.dirname(work), { recursive: true }); runGit(['clone', remote, work], { token: TOKEN }); }
    else { git(['remote', 'set-url', 'origin', remote]); git(['pull', '--ff-only', 'origin', 'main']); }
  } catch { continue; }

  const raw = (await readFile(path.join(work, 'leave.json'), 'utf8').catch(() => '')).trim();
  if (!raw) continue;
  let mark; try { mark = JSON.parse(raw); } catch { continue; }
  const key = `${slug}|${mark.at || ''}`;
  if (applied.includes(key)) continue;

  let y = rowText;
  y = y.replace(/^status:.*$/m, 'status: "left"');
  if (/^  left:/m.test(y)) y = y.replace(/^  left:.*$/m, `  left: "${mark.at || new Date().toISOString().slice(0, 10)}"`);
  // The tombstone (run-6 audit, 2026-08-17): a leave is the member's own call
  // and touches nothing of theirs — the row should say so, not leave the
  // Pebbles card guessing whether the mineral still exists.
  y = setScalar(y, 'left_how', 'left');
  y = setScalar(y, 'left_mineral', 'member-held; their box and brain are untouched');
  await writeFile(p, y);
  // door detach + edge truth, both fail-soft (rerun heals)
  await new Promise((res) => execFile('node', [path.join(repoRoot, 'orchestrator', 'push-member-key.mjs'), slug], { cwd: repoRoot }, () => res())).catch(() => {});
  if (existsSync(path.join(repoRoot, 'control', 'edges-reflect.mjs'))) {
    await new Promise((res) => execFile('node', [path.join(repoRoot, 'control', 'edges-reflect.mjs')], { cwd: repoRoot }, () => res())).catch(() => {});
  }
  await notify(`left: ${slug} left the rock (their own call, effective immediately). Their box and brain are theirs; your channel is detached. Rejoin is always an invite away.`);
  applied.push(key);
  left++;
}
await rebuildIndex(repoRoot);
await writeFile(ledgerPath, JSON.stringify(applied.slice(-500)) + '\n');
// Commit the closed rows (finding 174's sibling: "commit/push rides the caller's
// cadence" was true of no caller — the scheduler's reconcile pass never commits,
// so a left row could sit uncommitted until a re-clone resurrected it).
if (left) {
  try {
    execFileSync('git', ['add', 'registry/'], { cwd: repoRoot, stdio: 'pipe' });
    execFileSync('git', ['-c', 'user.name=Reconcile', '-c', 'user.email=reconcile@rock.local',
      'commit', '-q', '-m', `leave-reconcile: ${left} member(s) left`], { cwd: repoRoot, stdio: 'pipe' });
    try { runGit(['push', '-q', 'origin', 'HEAD'], { cwd: repoRoot, token: TOKEN }); } catch { /* carried later */ }
  } catch { /* nothing to commit */ }
}
console.log(`leave-reconcile: ${left} left applied.`);
