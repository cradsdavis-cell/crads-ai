#!/usr/bin/env node
// evict-member.mjs <slug> --reason "<short why>" — the ROCK's right to end an
// anchor tie (Mountain model, 2026-08-04: evict -> suspend -> delete, and evict
// destroys NOTHING). What happens, in load-bearing order:
//
//   1. deliver the notice + apply script down the inbox WHILE the row is still
//      active (push-down refuses non-active rows, so delivery must come first);
//      the box's org-sync applies it: re-anchor to the Mountain, notice kept
//      visible so the person's screen says WHO ended the tie and why
//   2. close the registry row (status left + key_dates.left; the row stays as
//      history) — the reflector then reflects `left`, the worker logs the
//      member-left billing event, and the seat's bill moves off this rock
//
// Both parties notify: the rock's reason rides the notice (step 1); the
// Mountain's what-happens-next rides the member-left event on the operator's
// ledger. The eviction is reversible in the only sense that matters: the box
// runs on, Mountain-anchored, and can re-join or re-anchor later by consent.
import { readFile, writeFile, mkdtemp, cp } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evictRow } from '../registry/evict.mjs';
import { resolveOrgGitHub, runGit } from '../factory/org-github.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const slug = args[0];
const ri = args.indexOf('--reason');
const reason = ri > -1 ? String(args[ri + 1] || '').slice(0, 160) : '';
if (!slug || !reason) { console.error('usage: evict-member <slug> --reason "<short why, shown to the person>"'); process.exit(2); }

const rowPath = path.join(repoRoot, 'registry', 'members', `${slug}.yaml`);
const text = await readFile(rowPath, 'utf8').catch(() => '');
if (!text) { console.error(`REFUSED: no registry row for ${slug}`); process.exit(1); }

const date = new Date().toISOString().slice(0, 10);
let closed;
try { closed = evictRow(text, { date }); }
catch (e) { console.error(`REFUSED: ${e.message}`); process.exit(1); }

// Finding 173 (run 5): the old regex here demanded end-of-line after the value,
// which no shipped org-policy line satisfies (every `  name:` carries a trailing
// comment), and it read the DNS slug where the person should see the display
// name. Same anchored-to-the-org-block, comment-stripping read the four good
// readers use, display_name first with name as the stated fallback.
const policyText = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
const orgField = (key) => (policyText.match(new RegExp(`^org:\\s*$[\\s\\S]*?^\\s+${key}:\\s*"?([^"\\n#]*)"?`, 'm')) || [])[1]?.trim() || '';
const orgSlug = orgField('display_name') || orgField('name') || 'this rock';

// 1. deliver the notice while the row is still active (order load-bearing)
const payload = await mkdtemp(path.join(tmpdir(), 'evict-'));
await writeFile(path.join(payload, 'notice.json'),
  JSON.stringify({ org: orgSlug, reason, date, re_anchor_to: 'crads-ai' }, null, 2) + '\n');
await cp(path.join(repoRoot, 'pebble-template', 'box', 'evict-apply.sh'), path.join(payload, 'evict-apply.sh'));
const push = await new Promise((res) => execFile('node',
  [path.join(repoRoot, 'orchestrator', 'push-down.mjs'), slug, payload, 'evict', '--allow-paused'],
  { cwd: repoRoot }, (err, so, se) => res({ err, so: String(so), se: String(se) })));
if (push.err) {
  console.error(`REFUSED: could not deliver the eviction notice (${push.se.trim() || push.err.message}); the row stays open — an eviction the person never hears about is not an eviction.`);
  process.exit(1);
}

// 2. close the row; the reflector + billing event follow from this
await writeFile(rowPath, closed);
const b = path.join(repoRoot, 'registry', 'build-index.mjs');
if (existsSync(b)) await new Promise((res) => execFile('node', [b], { cwd: repoRoot }, () => res())).catch(() => {});

// 3. commit + push the closed row (finding 174: End closed the row on disk,
// committed nothing, and a re-clone of the brain resurrected the membership).
// Same shape as anchor-reconcile's commit block; push is best-effort, the
// commit is not.
try {
  execFileSync('git', ['add', 'registry/'], { cwd: repoRoot, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=Evict', '-c', 'user.email=evict@rock.local',
    'commit', '-q', '-m', `evict: ${slug} left ${date} (${reason.slice(0, 80)})`], { cwd: repoRoot, stdio: 'pipe' });
  try {
    const { token: GH_TOKEN } = resolveOrgGitHub({ brainRoot: repoRoot });
    runGit(['push', '-q', 'origin', 'HEAD'], { cwd: repoRoot, token: GH_TOKEN });
  } catch { /* push rides the next sync; the commit is what finding 174 needed */ }
} catch { /* nothing to commit */ }

// 4. reflect the edge NOW rather than waiting up to 30 minutes for the cadence
// pass — the directory edge staying `active` after an eviction is the window
// where every surface disagrees. Fail-soft: the :11/:41 pass heals a miss.
if (existsSync(path.join(repoRoot, 'control', 'edges-reflect.mjs'))) {
  await new Promise((res) => execFile('node', [path.join(repoRoot, 'control', 'edges-reflect.mjs')], { cwd: repoRoot }, () => res())).catch(() => {});
}

console.log(`EVICTED: ${slug} — notice delivered (reason: "${reason}"), row closed (left ${date}, left_how evicted), committed, edge reflected.`);
console.log('The box runs on, re-anchored to the Mountain by its own apply step; its hosted-seat bill moves off this rock at the next reflect. Nothing was destroyed.');
