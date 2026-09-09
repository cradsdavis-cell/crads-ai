// brain-control-sync.test.mjs: the rock brain's control plane ships in the
// image and is re-synced into the brain at every boot (2026-08-26).
//   node --test provisioning/rock/brain-control-sync.test.mjs
//
// WHY THIS EXISTS. control/ and orchestrator/ are product machinery that lives
// inside the ORGANISATION'S own brain repo, whose .git is stripped and re-inited
// on the box in template mode. They had no remote, so every rock-side product
// change was unreachable on every rock already in the field, permanently. The
// fix is the pattern rock-machinery/ already states in its README: bake it, sync
// it at boot, version it with the image tag, so "Update and restart" updates it.
//
// The tests that matter here are the ones about what must NOT happen. This code
// copies files into a live customer's brain on every boot, and registry/members
// holds the member rows, which are the least replaceable thing on the box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BOOT = path.join(ROOT, 'provisioning/rock/boot-rock.sh');
const VENDOR = path.join(ROOT, 'scripts/vendor-brain-control.sh');
const bootSh = readFileSync(BOOT, 'utf8');

// The block under test, taken from the SHIPPED script rather than a copy, so
// this cannot pass against a boot-rock.sh that no longer contains it.
function syncBlock() {
  const start = bootSh.indexOf('CTRL_SRC="$AIOS_DIR/brain-control"');
  const end = bootSh.indexOf('# ---- vendor catalog (D57)');
  assert.ok(start > 0 && end > start, 'the control-plane sync block is no longer where this test looks for it');
  return bootSh.slice(start, end);
}

// Runs the block with the two helpers boot-rock defines above it, under the
// same `set -euo pipefail` the real script uses: a block that trips errexit
// would take the whole boot down, so the test must run it the same way.
function runSync(aiosDir, brainRoot) {
  const script = 'set -euo pipefail\n'
    + 'ok(){ printf "OK %s\\n" "$*"; }\n'
    + 'pend(){ printf "PEND %s\\n" "$*"; }\n'
    + `AIOS_DIR=${JSON.stringify(aiosDir)}\n`
    + `BRAIN_ROOT=${JSON.stringify(brainRoot)}\n`
    + syncBlock();
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
}

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

// A rock as it exists in the field: born before this change, with real tracked
// machinery, real member rows, and content of its own.
function existingRock() {
  const brain = tmpDir('bcs-brain-');
  const put = (rel, body) => {
    mkdirSync(path.join(brain, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(brain, rel), body);
  };
  put('control/catalog-reconcile.mjs', '// OLD reconcile\n');
  put('control/reconcile-all.mjs', '// OLD\n');
  put('orchestrator/push-down.mjs', '// OLD\n');
  put('registry/normalize-row.mjs', '// OLD normalize\n');
  put('registry/members/astrid.yaml', 'slug: astrid\nstatus: active\n');
  put('registry/members/juniper.yaml', 'slug: juniper\nstatus: active\n');
  put('notes/plan.md', 'the org wrote this\n');
  put('control/org-custom.mjs', 'the org wrote this too\n');
  git(brain, 'init', '-q', '-b', 'main');
  git(brain, '-c', 'user.email=a@b', '-c', 'user.name=a', 'add', '-A');
  git(brain, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'born');
  return brain;
}

// A stand-in for brain-template. Synthetic on purpose: this suite runs in CI,
// where no brain-template checkout exists, and the properties under test (what
// the overlay touches, what it refuses) are about the SHAPE of the tree, not
// about any particular machinery file's contents. The real repo is exercised by
// the vendor step at bake time, which refuses an unsound tree there.
function fakeTemplate() {
  const src = tmpDir('bcs-src-');
  const put = (rel, body) => {
    mkdirSync(path.join(src, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(src, rel), body);
  };
  put('control/catalog-reconcile.mjs', '// NEW catalog-reconcile\n');
  put('control/catalog-lib.mjs', '// NEW catalog-lib\n');
  put('control/reconcile-all.mjs', '// NEW reconcile-all\n');
  put('control/catalog-reconcile.test.mjs', '// a test, must not bake\n');
  put('orchestrator/push-down.mjs', '// NEW push-down\n');
  put('orchestrator/prune-down.mjs', '// NEW prune-down\n');
  put('registry/normalize-row.mjs', '// NEW normalize-row\n');
  put('registry/membership.mjs', '// NEW membership\n');
  put('registry/members/PLACEHOLDER.yaml', 'this is the template\'s own row, and must never be vendored\n');
  put('factory/org-github.mjs', '// NEW org-github\n');
  return src;
}

function vendorInto(src) {
  const out = tmpDir('bcs-out-');
  execFileSync('bash', [VENDOR], {
    env: { ...process.env, BRAIN_CONTROL_SRC: src, BRAIN_CONTROL_OUT: path.join(out, 'brain-control') },
    encoding: 'utf8',
  });
  return out;   // an $AIOS_DIR containing brain-control/
}

const bakedImage = () => vendorInto(fakeTemplate());

// The tree is COMMITTED to this repo, not cloned at bake time: brain-template is
// private and the workflow's GITHUB_TOKEN is scoped to ai-os, and a bake-time
// clone would anyway make the same commit produce different images at different
// times. So the committed tree IS the artefact, and it has to be sound in the
// repo, not merely producible by a script someone remembers to run.
test('the COMMITTED tree in this repo is sound and carries no member rows', () => {
  const out = path.join(ROOT, 'brain-control');
  assert.ok(existsSync(out), 'brain-control/ must be committed: the rock image COPYs it and the bake fails without it');
  for (const f of ['tree/control/catalog-reconcile.mjs', 'tree/control/catalog-lib.mjs',
    'tree/control/reconcile-all.mjs', 'tree/orchestrator/push-down.mjs',
    'tree/orchestrator/prune-down.mjs', 'tree/registry/normalize-row.mjs',
    'tree/registry/membership.mjs', 'tree/factory/org-github.mjs', 'SOURCE.txt']) {
    assert.ok(existsSync(path.join(out, f)), `${f} is missing from the committed tree`);
  }
  assert.ok(!existsSync(path.join(out, 'tree/registry/members')),
    'member rows must never be committed here, and never reach a customer brain');
  const tests = execFileSync('bash', ['-c', `find ${JSON.stringify(out)} -name '*.test.mjs' | wc -l`], { encoding: 'utf8' }).trim();
  assert.equal(tests, '0', 'tests are not product and must not bake');
  assert.match(readFileSync(path.join(out, 'SOURCE.txt'), 'utf8'), /^sha: [0-9a-f]{40}$/m,
    'SOURCE.txt must record which brain-template commit is baked, so a box can say what it is running');
});

// Every module control/ imports from outside itself must be IN the tree. This is
// the failure that would not show until :04 on a live rock, when the reconcile
// cron dies on a module-resolution error and a member's offer silently never
// lands.
test('every cross-directory import the machinery makes is vendored with it', () => {
  const out = path.join(ROOT, 'brain-control/tree');
  const files = execFileSync('bash', ['-c', `find ${JSON.stringify(out)}/control ${JSON.stringify(out)}/orchestrator -name '*.mjs'`],
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const missing = new Set();
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/from '\.\.\/([^']+)'/g)) {
      if (!existsSync(path.join(out, m[1]))) missing.add(m[1]);
    }
  }
  assert.deepEqual([...missing], [], 'the machinery imports these but they are not in the tree');
});

test('the vendored tree carries machinery and NEVER member rows', () => {
  const out = path.join(vendorInto(fakeTemplate()), 'brain-control');
  for (const f of ['tree/control/catalog-reconcile.mjs', 'tree/control/reconcile-all.mjs',
    'tree/orchestrator/push-down.mjs', 'tree/registry/normalize-row.mjs',
    'tree/factory/org-github.mjs', 'SOURCE.txt']) {
    assert.ok(existsSync(path.join(out, f)), `${f} should be vendored`);
  }
  assert.ok(!existsSync(path.join(out, 'tree/registry/members')),
    'member rows must never enter the vendored tree: a directory that is not vendored cannot be overwritten, whatever boot does');
  const tests = execFileSync('bash', ['-c', `find ${JSON.stringify(out)} -name '*.test.mjs' | wc -l`], { encoding: 'utf8' }).trim();
  assert.equal(tests, '0', 'tests are not product and must not bake');
});

test('the vendor refuses to build a half control plane', () => {
  const fake = tmpDir('bcs-src-');
  for (const d of ['control', 'orchestrator', 'registry', 'factory']) mkdirSync(path.join(fake, d), { recursive: true });
  writeFileSync(path.join(fake, 'control/reconcile-all.mjs'), '//\n');   // the others are missing
  let out = '', threw = false;
  try {
    execFileSync('bash', [VENDOR], { env: { ...process.env, BRAIN_CONTROL_SRC: fake }, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { threw = true; out = (e.stdout || '') + (e.stderr || ''); }
  assert.ok(threw, 'a half control plane must fail the bake, not ship');
  assert.match(out, /missing|refusing/i, out);
});

// Caught by a docker build that baked exactly ONE file. The vendor used to wipe
// its output and then validate, so any failed run (a bad ref, a half checkout, a
// test pointed at a stub source) destroyed a previously good tree and left the
// build context holding whatever it had managed to copy before it gave up. The
// bake does not notice: COPY of a nearly-empty directory succeeds.
test('a FAILED vendor leaves the last good tree exactly where it was', () => {
  const out = tmpDir('bcs-out-');
  const dest = path.join(out, 'brain-control');
  const vendor = (src) => execFileSync('bash', [VENDOR], {
    env: { ...process.env, BRAIN_CONTROL_SRC: src, BRAIN_CONTROL_OUT: dest },
    encoding: 'utf8', stdio: 'pipe',
  });
  vendor(fakeTemplate());
  const good = execFileSync('bash', ['-c', `find ${JSON.stringify(dest)} -type f | wc -l`], { encoding: 'utf8' }).trim();
  assert.ok(Number(good) > 5, `expected a real tree, got ${good} files`);

  const half = tmpDir('bcs-half-');
  for (const d of ['control', 'orchestrator', 'registry', 'factory']) mkdirSync(path.join(half, d), { recursive: true });
  writeFileSync(path.join(half, 'control/reconcile-all.mjs'), '//\n');
  assert.throws(() => vendor(half));

  const after = execFileSync('bash', ['-c', `find ${JSON.stringify(dest)} -type f | wc -l`], { encoding: 'utf8' }).trim();
  assert.equal(after, good, 'a failed vendor must not touch the tree that was already there');
  assert.ok(existsSync(path.join(dest, 'tree/control/catalog-reconcile.mjs')));
});

test('a boot on an existing rock updates machinery and leaves member rows byte-identical', () => {
  const brain = existingRock(), app = bakedImage();
  const before = readFileSync(path.join(brain, 'registry/members/astrid.yaml'), 'utf8');
  const out = runSync(app, brain);
  assert.match(out, /^OK brain control plane synced/m, out);

  // updated
  assert.match(readFileSync(path.join(brain, 'control/catalog-reconcile.mjs'), 'utf8'), /catalog-reconcile/);
  assert.doesNotMatch(readFileSync(path.join(brain, 'registry/normalize-row.mjs'), 'utf8'), /OLD normalize/);
  // untouched
  assert.equal(readFileSync(path.join(brain, 'registry/members/astrid.yaml'), 'utf8'), before);
  assert.ok(existsSync(path.join(brain, 'registry/members/juniper.yaml')));
  assert.equal(readFileSync(path.join(brain, 'notes/plan.md'), 'utf8'), 'the org wrote this\n');
  // an org's own file inside control/ is overwritten by nothing and survives
  assert.equal(readFileSync(path.join(brain, 'control/org-custom.mjs'), 'utf8'), 'the org wrote this too\n');
});

test('machinery leaves the organisation\'s git history; member rows stay in it', () => {
  const brain = existingRock(), app = bakedImage();
  runSync(app, brain);
  const tracked = git(brain, 'ls-files').split('\n');
  assert.equal(tracked.filter((f) => /^(control|orchestrator)\//.test(f)).length, 0,
    'the kernel runs `git add -A` on every drain, so machinery left tracked would be re-committed into the customer repo every boot');
  assert.equal(tracked.filter((f) => f.startsWith('registry/members/')).length, 2,
    'member rows must stay tracked: ignoring registry/ would stop them being backed up');
  assert.match(readFileSync(path.join(brain, '.gitignore'), 'utf8'), /^control\/$/m);
});

test('the sync is idempotent: a second boot changes nothing', () => {
  const brain = existingRock(), app = bakedImage();
  runSync(app, brain);
  const ignore1 = readFileSync(path.join(brain, '.gitignore'), 'utf8');
  runSync(app, brain);
  assert.equal(readFileSync(path.join(brain, '.gitignore'), 'utf8'), ignore1, '.gitignore must not grow on every boot');
});

test('an unsound baked tree is refused, and the rock keeps the machinery it had', () => {
  const brain = existingRock();
  const app = tmpDir('bcs-app-');
  mkdirSync(path.join(app, 'brain-control/tree/control'), { recursive: true });
  writeFileSync(path.join(app, 'brain-control/SOURCE.txt'), 'sha: deadbeef\n');
  writeFileSync(path.join(app, 'brain-control/tree/control/reconcile-all.mjs'), '//\n');   // incomplete
  const out = runSync(app, brain);
  assert.match(out, /^PEND .*unsound/m, out);
  assert.match(readFileSync(path.join(brain, 'control/catalog-reconcile.mjs'), 'utf8'), /OLD reconcile/,
    'a rock on its old control plane still reconciles; one on half a new one does not');
});

test('a tree carrying member rows is refused even if the vendor built it', () => {
  const brain = existingRock(), app = bakedImage();
  // the image and the script that made it can drift apart, so the applying end
  // checks too rather than trusting the bake
  mkdirSync(path.join(app, 'brain-control/tree/registry/members'), { recursive: true });
  writeFileSync(path.join(app, 'brain-control/tree/registry/members/attacker.yaml'), 'slug: nope\n');
  const out = runSync(app, brain);
  assert.match(out, /^PEND .*unsound/m, out);
  assert.ok(!existsSync(path.join(brain, 'registry/members/attacker.yaml')));
});

test('an image built without the control plane boots and says so', () => {
  const brain = existingRock();
  const out = runSync(tmpDir('bcs-app-'), brain);
  assert.match(out, /^PEND no baked brain control plane/m, out);
  assert.match(readFileSync(path.join(brain, 'control/catalog-reconcile.mjs'), 'utf8'), /OLD reconcile/);
});

test('the image actually carries it, and the one surviving authoring skill ships with it', () => {
  assert.match(readFileSync(path.join(ROOT, 'Dockerfile.rock'), 'utf8'), /^COPY brain-control\/ \.\/brain-control\/$/m);
  // engine/skills/ is re-synced into the brain on every boot; brain-template's
  // .claude/skills/ is frozen at birth. Authoring skills belong in the former.
  // write-prompt and write-folder left with the Library (2026-09-09); a skill
  // named here that no longer exists would break every rock's boot sync.
  const rockSkills = (bootSh.match(/^ROCK_SKILLS="\$\{ROCK_SKILLS:-([^}]*)\}"/m) || [])[1] || '';
  for (const s of ['write-prompt', 'write-folder']) {
    assert.ok(!rockSkills.split(/\s+/).includes(s), `${s} is gone and must not be listed`);
  }
  for (const s of ['write-page']) {
    assert.ok(rockSkills.split(/\s+/).includes(s), `${s} must be in ROCK_SKILLS or it never reaches a rock`);
    assert.ok(existsSync(path.join(ROOT, `engine/skills/${s}.md`)), `engine/skills/${s}.md is missing`);
  }
});
