// brain-root.test.mjs — pins for THE brain-root resolver (2026-08-17
// hardening) plus the guard that keeps it singular: a repo grep that fails
// the moment anyone hand-copies the resolution chain again. Five readers
// independently missed the member-born leg before extraction (finding 107);
// this file is what makes reader eight impossible to ship quietly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrainRoot, ensureBrainRootStamped, isOrgBox, BRAIN_ROOT_SH, BRAIN_ROOT_STAMP_SH } from './brain-root.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = () => tmpDir('brain-root-');
const w = (p, s) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, s); };
const noEnv = { env: {} };

// ---- resolveBrainRoot: the four box shapes ---------------------------------

test('born rock: no deployment line, /state/brain exists -> /state/brain', () => {
  const sd = tmp();
  mkdirSync(path.join(sd, 'brain'));
  assert.equal(resolveBrainRoot(sd, noEnv), path.join(sd, 'brain'));
});

test('member-born rock (ingrid shape): empty deployment.yaml, no brain dir -> the box root', () => {
  const sd = tmp();
  w(path.join(sd, 'deployment.yaml'), '');
  assert.equal(resolveBrainRoot(sd, noEnv), sd);
});

test('pebble: no deployment.yaml at all -> the box root', () => {
  const sd = tmp();
  assert.equal(resolveBrainRoot(sd, noEnv), sd);
});

test('stated brain_root wins when it exists; falls back to the box root when it does not', () => {
  const sd = tmp();
  const moved = path.join(sd, 'elsewhere');
  mkdirSync(moved);
  mkdirSync(path.join(sd, 'brain'));   // a decoy: stated beats the default
  w(path.join(sd, 'deployment.yaml'), `# staged\nbrain_root: ${moved}\n`);
  assert.equal(resolveBrainRoot(sd, noEnv), moved);
  w(path.join(sd, 'deployment.yaml'), 'brain_root: /nonexistent/road\n');
  assert.equal(resolveBrainRoot(sd, noEnv), sd);
});

test('baked env leg: $BRAIN_ROOT beats the default, loses to a stated value (boot-rock precedence)', () => {
  const sd = tmp();
  const baked = path.join(sd, 'baked');
  mkdirSync(baked);
  assert.equal(resolveBrainRoot(sd, { env: { BRAIN_ROOT: baked } }), baked);
  const stated = path.join(sd, 'stated');
  mkdirSync(stated);
  w(path.join(sd, 'deployment.yaml'), `brain_root: ${stated}\n`);
  assert.equal(resolveBrainRoot(sd, { env: { BRAIN_ROOT: baked } }), stated);
});

// ---- ensureBrainRootStamped: the scheduler backfill ------------------------

test('backfill stamps a member-born rock (org-policy at the box root) with the box root', () => {
  const sd = tmp();
  w(path.join(sd, 'deployment.yaml'), '');
  w(path.join(sd, 'org-policy.yaml'), 'name: ingrid\n');
  const r = ensureBrainRootStamped(sd, noEnv);
  assert.deepEqual(r, { stamped: true, root: sd });
  assert.match(readFileSync(path.join(sd, 'deployment.yaml'), 'utf8'), new RegExp(`^brain_root: ${sd}$`, 'm'));
  // idempotent: the second boot changes nothing
  assert.deepEqual(ensureBrainRootStamped(sd, noEnv), { stamped: false, reason: 'already-stated' });
});

test('backfill stamps a born rock (org-policy under <box>/brain) with <box>/brain', () => {
  const sd = tmp();
  w(path.join(sd, 'brain', 'org-policy.yaml'), 'name: eve\n');
  const r = ensureBrainRootStamped(sd, noEnv);
  assert.deepEqual(r, { stamped: true, root: path.join(sd, 'brain') });
});

test('backfill never touches a pebble — no deployment.yaml is created', () => {
  const sd = tmp();
  assert.deepEqual(ensureBrainRootStamped(sd, noEnv), { stamped: false, reason: 'not-org' });
  assert.throws(() => readFileSync(path.join(sd, 'deployment.yaml')));
});

test('backfill appends below existing config, guarding the missing trailing newline', () => {
  const sd = tmp();
  w(path.join(sd, 'deployment.yaml'), 'domain: ingrid.crads-ai.com');   // no trailing \n
  w(path.join(sd, 'org-policy.yaml'), 'name: ingrid\n');
  ensureBrainRootStamped(sd, noEnv);
  const dep = readFileSync(path.join(sd, 'deployment.yaml'), 'utf8');
  assert.equal(dep, `domain: ingrid.crads-ai.com\nbrain_root: ${sd}\n`);
});

// ---- the shell forms: run them for real, chrooted onto a fixture -----------
// The fragments hardcode /state (they run on a box). Rewriting the path to a
// fixture dir exercises the REAL string bash+node will run, not a paraphrase.

const onFixture = (sh, sd) => sh.replaceAll('/state', sd);

test('BRAIN_ROOT_SH agrees with resolveBrainRoot on all four shapes, and exports $BR', () => {
  for (const shape of ['born', 'member-born', 'pebble', 'stated']) {
    const sd = tmp();
    if (shape === 'born') mkdirSync(path.join(sd, 'brain'));
    if (shape === 'member-born') w(path.join(sd, 'deployment.yaml'), '');
    if (shape === 'stated') { mkdirSync(path.join(sd, 'moved')); w(path.join(sd, 'deployment.yaml'), `brain_root: ${sd}/moved\n`); }
    const out = execFileSync('bash', ['-c', onFixture(BRAIN_ROOT_SH, sd) + 'node -e "process.stdout.write(process.env.BR)"'],
      { encoding: 'utf8', env: { ...process.env, BRAIN_ROOT: '' } });
    assert.equal(out, resolveBrainRoot(sd, noEnv), `shell and JS disagree on the ${shape} shape`);
  }
});

test('BRAIN_ROOT_STAMP_SH stamps the resolved root at mint time, idempotently', () => {
  const sd = tmp();
  w(path.join(sd, 'deployment.yaml'), '');
  const cmd = onFixture(BRAIN_ROOT_SH + BRAIN_ROOT_STAMP_SH, sd);
  execFileSync('bash', ['-c', cmd], { env: { ...process.env, BRAIN_ROOT: '' } });
  assert.equal(readFileSync(path.join(sd, 'deployment.yaml'), 'utf8'), `brain_root: ${sd}\n`);
  execFileSync('bash', ['-c', cmd], { env: { ...process.env, BRAIN_ROOT: '' } });   // second flip retry
  assert.equal(readFileSync(path.join(sd, 'deployment.yaml'), 'utf8'), `brain_root: ${sd}\n`);
});

// ---- the guard: no stray re-implementations --------------------------------
// Any runtime file matching brain_root regex-reading signatures is a hand
// copy of the resolver. Allowed: this module, *.test.mjs (string pins), and
// provisioning/ (BIRTH-time resolution, where the existence fallback would be
// wrong because the brain does not exist yet — see the module header).

test('the resolution chain exists exactly once in runtime code', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      // `.claude` holds gitignored tooling state, including agent worktrees that
      // each carry a full copy of the repo. Walking into those reports this
      // module's own legitimate copies as hand-written duplicates, so the guard
      // fails on any machine that has used a worktree and passes in CI, which is
      // exactly backwards. Ignored trees are not runtime code.
      if (['.git', 'node_modules', '.superpowers', '.claude'].includes(name)) continue;
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(mjs|sh)$/.test(name) || /\.test\.mjs$/.test(name)) continue;
      const rel = path.relative(REPO, p);
      if (rel === path.join('engine', 'lib', 'brain-root.mjs') || rel.startsWith('provisioning' + path.sep)) continue;
      const src = readFileSync(p, 'utf8');
      if (/brain_root:\\?s|\^brain_root:/.test(src)) offenders.push(rel);
    }
  };
  walk(REPO);
  assert.deepEqual(offenders, [], `hand-copied brain-root resolution in: ${offenders.join(', ')} — import engine/lib/brain-root.mjs instead`);
});

// ---- isOrgBox: the ownership leg -------------------------------------------
test('isOrgBox: ownership.json tier "rock" is an org with no policy file anywhere', () => {
  const sd = tmpDir('br-');
  writeFileSync(path.join(sd, 'ownership.json'), JSON.stringify({ tier: 'rock', owner: 'org' }));
  assert.equal(isOrgBox(sd, noEnv), true);
});

test('isOrgBox: a member-tier ownership.json is not an org, nor is a bare pebble', () => {
  const sd = tmpDir('br-');
  writeFileSync(path.join(sd, 'ownership.json'), JSON.stringify({ tier: 'member', owner: 'member' }));
  assert.equal(isOrgBox(sd, noEnv), false);
  const bare = tmpDir('br-');
  assert.equal(isOrgBox(bare, noEnv), false);
});

test('backfill stamps an ownership-only member-born rock — the boxes it exists for carry no policy file', () => {
  // ingrid and milk-and-honey are the backfill's own stated purpose, and the
  // self-registration flow gives them ownership.json ONLY. A policy-gated
  // backfill answered 'not-org' on exactly them and stamped nothing anywhere.
  const sd = tmpDir('br-');
  writeFileSync(path.join(sd, 'deployment.yaml'), '');
  writeFileSync(path.join(sd, 'ownership.json'), JSON.stringify({ tier: 'rock', owner: 'org', owner_slug: 'milk-and-honey' }));
  const r = ensureBrainRootStamped(sd, noEnv);
  assert.deepEqual(r, { stamped: true, root: sd });
  assert.match(readFileSync(path.join(sd, 'deployment.yaml'), 'utf8'), /^brain_root: /m);
});
