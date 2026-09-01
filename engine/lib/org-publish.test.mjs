// engine/lib/org-publish.test.mjs — snapshot filter, provenance validator, dry publish.
// Run: node --test engine/lib/org-publish.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { isEnclavePage, buildSnapshot, validateExtracts, writeDryExtracts, PROVENANCE_RE, publish } from './org-publish.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

function seedState() {
  const state = tmpDir('obstate-');
  mkdirSync(path.join(state, 'wiki', 'personal'), { recursive: true });
  mkdirSync(path.join(state, 'wiki', 'projects'), { recursive: true });
  writeFileSync(path.join(state, 'wiki', 'log.md'), '# Log\n- 2026-07-20 kicked off ACME rollout\n');
  writeFileSync(path.join(state, 'wiki', 'projects', 'acme.md'), '# ACME\nRollout phase 2.\n');
  writeFileSync(path.join(state, 'wiki', 'personal', 'salary.md'), 'TRAP_SALARY_XK91\n');
  writeFileSync(path.join(state, 'wiki', 'gripe.md'), '---\nenclave: true\n---\nTRAP_GRIPE_ZQ77\n');
  return state;
}

test('isEnclavePage reads the frontmatter flag', () => {
  assert.equal(isEnclavePage('---\nenclave: true\n---\nbody'), true);
  assert.equal(isEnclavePage('---\ntitle: x\n---\nenclave: true in body does not count'), false);
  assert.equal(isEnclavePage('no frontmatter'), false);
});

test('buildSnapshot copies wiki minus personal/ and enclave-flagged pages, wires the guard', async () => {
  const state = seedState();
  const work = tmpDir('obwork-');
  const r = await buildSnapshot(state, work);
  assert.ok(existsSync(path.join(work, 'wiki', 'projects', 'acme.md')));
  assert.ok(existsSync(path.join(work, 'wiki', 'log.md')));
  assert.ok(!existsSync(path.join(work, 'wiki', 'personal')));
  assert.ok(!existsSync(path.join(work, 'wiki', 'gripe.md')));
  assert.equal(r.excluded >= 2, true);
  const settings = JSON.parse(readFileSync(path.join(work, '.claude', 'settings.json'), 'utf8'));
  const hook = settings.hooks.PreToolUse[0];
  assert.match(hook.matcher, /Read/);
  assert.match(hook.hooks[0].command, /enclave-guard\.mjs/);
  assert.match(hook.hooks[0].command, new RegExp(path.join(state, 'wiki', 'personal').replace(/[/\\]/g, '.')));
});

test('buildSnapshot skips .md symlinks pointing into personal/ — content never appears in snapshot', async (t) => {
  try {
    const state = seedState();
    const work = tmpDir('obwork-');
    // Create a .md symlink at wiki root pointing into wiki/personal/
    symlinkSync(path.join(state, 'wiki', 'personal', 'salary.md'), path.join(state, 'wiki', 'leaked.md'));
    const r = await buildSnapshot(state, work);
    // Symlink should not be copied; target content should not appear in snapshot
    assert.ok(!existsSync(path.join(work, 'wiki', 'leaked.md')));
    const allContent = readFileSync(path.join(work, 'wiki', 'log.md'), 'utf8') +
                       readFileSync(path.join(work, 'wiki', 'projects', 'acme.md'), 'utf8');
    assert.ok(!allContent.includes('TRAP_SALARY_XK91'), 'leaked salary content should not appear in snapshot');
    assert.equal(r.excluded >= 3, true); // at least salary.md, gripe.md, leaked.md symlink
  } catch (e) {
    if (e.code === 'ENOTSUP') t.skip(); // symlinks not supported on this platform
    throw e;
  }
});

test('buildSnapshot skips directory symlinks named personal-link — traversal blocked', async (t) => {
  try {
    const state = seedState();
    const work = tmpDir('obwork-');
    // Create a directory symlink at wiki root pointing to wiki/personal
    symlinkSync(path.join(state, 'wiki', 'personal'), path.join(state, 'wiki', 'personal-link'));
    const r = await buildSnapshot(state, work);
    // Directory symlink should not be traversed or copied
    assert.ok(!existsSync(path.join(work, 'wiki', 'personal-link')));
    const allContent = readFileSync(path.join(work, 'wiki', 'log.md'), 'utf8') +
                       readFileSync(path.join(work, 'wiki', 'projects', 'acme.md'), 'utf8');
    assert.ok(!allContent.includes('TRAP_SALARY_XK91'), 'personal content via symlink should not appear');
    assert.equal(r.excluded >= 3, true); // at least salary.md, gripe.md, personal-link symlink
  } catch (e) {
    if (e.code === 'ENOTSUP') t.skip(); // symlinks not supported on this platform
    throw e;
  }
});

test('PROVENANCE_RE accepts the exact spec format and rejects drift', () => {
  assert.match('source: lena/wiki/log.md · 2026-07-25', PROVENANCE_RE);
  assert.doesNotMatch('source: lena/wiki/log.md - 2026-07-25', PROVENANCE_RE);
  assert.doesNotMatch('Source: lena/wiki/log.md · 2026-07-25', PROVENANCE_RE);
});

test('validateExtracts flags pages with no provenance line', async () => {
  const dir = tmpDir('obval-');
  writeFileSync(path.join(dir, 'good.md'), '# G\nfact\n\nsource: lena/wiki/log.md · 2026-07-25\n');
  writeFileSync(path.join(dir, 'bad.md'), '# B\nunattributed claim\n');
  const r = await validateExtracts(dir);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, ['bad.md']);
});

test('writeDryExtracts produces namespaced, provenance-stamped extracts from the snapshot', async () => {
  const state = seedState();
  const work = tmpDir('obwork2-');
  await buildSnapshot(state, work);
  const org = tmpDir('oborg-');
  const r = await writeDryExtracts(work, org, 'testbox', '2026-07-25');
  const updates = readFileSync(path.join(org, 'members', 'testbox', 'updates.md'), 'utf8');
  assert.match(updates, /## 2026-07-25/);
  assert.match(updates, /ACME rollout/);
  assert.match(updates, PROVENANCE_RE);
  const entity = readFileSync(path.join(org, 'members', 'testbox', 'entities', 'acme.md'), 'utf8');
  assert.match(entity, /Rollout phase 2/);
  assert.match(entity, PROVENANCE_RE);
  assert.ok(r.files.length >= 2);
  const all = r.files.map((f) => readFileSync(f, 'utf8')).join('\n');
  assert.ok(!all.includes('TRAP_SALARY_XK91') && !all.includes('TRAP_GRIPE_ZQ77'));
});

// --- Task 4: publish orchestrator -----------------------------------------------------
// Bare init with -b main so the empty-repo clone's symbolic HEAD (and thus its local
// branch once the first commit lands) is deterministically 'main' regardless of the
// box's git config default-branch setting — see task-4 ambiguity resolution #2.
function gitInit(dir, bare = false) {
  execFileSync('git', bare ? ['init', '--bare', '-q', '-b', 'main', dir] : ['init', '-q', dir]);
}

function seedOrgState() {
  const state = seedState();                       // from Task 2
  const bare = tmpDir('oborigin-') + '/org-brain.git';
  gitInit(bare, true);
  const clone = path.join(state, 'org', 'brain');
  mkdirSync(path.join(state, 'org'), { recursive: true });
  execFileSync('git', ['clone', '-q', bare, clone]);
  const gitEnv = { ...process.env, GIT_COMMITTER_NAME: 'box', GIT_COMMITTER_EMAIL: 'box@local', GIT_AUTHOR_NAME: 'box', GIT_AUTHOR_EMAIL: 'box@local' };
  execFileSync('git', ['-C', clone, 'commit', '-q', '--allow-empty', '-m', 'init'], { env: gitEnv });
  execFileSync('git', ['-C', clone, 'push', '-q', 'origin', 'HEAD:main']);
  writeFileSync(path.join(state, 'org', 'config.json'), JSON.stringify({ slug: 'testbox', remote: bare }));
  writeFileSync(path.join(state, 'profile.yaml'), 'identity:\n  timezone: "Australia/Sydney"\n');
  return { state, bare, clone };
}

test('publish (dry) writes extracts, stamps, commits and pushes to origin', async () => {
  const { state, bare } = seedOrgState();
  const r = await publish(state, { dryRun: true });
  assert.equal(r.ok, true);
  const files = execFileSync('git', ['-C', bare, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
  assert.match(files, /members\/testbox\/updates\.md/);
  assert.match(files, /members\/testbox\/\.stamp/);
  const show = execFileSync('git', ['-C', bare, 'log', 'main', '-1', '--format=%s'], { encoding: 'utf8' });
  assert.match(show, /^publish\(testbox\):/);
});

test('publish is a clean no-op when org brain is not configured', async () => {
  const state = seedState();
  const r = await publish(state, { dryRun: true });
  assert.equal(r.ok, true);
  assert.match(r.output, /not configured/);
});

test('publish with a broken remote still commits locally (queued)', async () => {
  const { state, clone } = seedOrgState();
  execFileSync('git', ['-C', clone, 'remote', 'set-url', 'origin', '/nonexistent/nowhere.git']);
  const r = await publish(state, { dryRun: true });
  assert.equal(r.ok, true);
  assert.match(r.output, /queued/);
  const local = execFileSync('git', ['-C', clone, 'log', '-1', '--format=%s'], { encoding: 'utf8' });
  assert.match(local, /^publish\(testbox\):/);
});

test('live path hands the snapshot workdir and org dir to claude', async () => {
  const { state } = seedOrgState();
  let seen = null;
  const fakeClaude = async (args, opts) => {
    seen = { args, opts };
    // fake model writes one valid extract so validation passes
    const memberDir = path.join(state, 'org', 'brain', 'members', 'testbox');
    mkdirSync(memberDir, { recursive: true });
    writeFileSync(path.join(memberDir, 'updates.md'),
      `# Updates from testbox\n\n## 2026-07-25\n- fact\n\nsource: testbox/wiki/log.md · 2026-07-25\n`);
    return 'wrote extracts';
  };
  const r = await publish(state, { dryRun: false, runClaude: fakeClaude });
  assert.equal(r.ok, true);
  assert.ok(seen, 'claude was invoked');
  assert.equal(seen.args[0], '-p');
  assert.match(seen.args[1], /org-publish job for member box "testbox"/);
  assert.match(seen.opts.cwd, /org-publish-work/);
  assert.ok(existsSync(path.join(seen.opts.cwd, '.claude', 'settings.json')));
});

// --- Review fix: heartbeat vs extracts commit split (Finding 1) -----------------------
// Uses the LIVE path (fake runClaude), not dryRun, deliberately: writeDryExtracts (Task 3)
// unconditionally PREPENDS a new "## <date>" section on every call regardless of whether
// the underlying wiki content changed, so calling it twice against an unchanged wiki on
// the same date produces a real (duplicated) content diff — not the "nothing new" case
// this finding is about. The live contract is exactly "if nothing is new, change nothing"
// (see livePrompt), so a fake runClaude that writes nothing on the second call is the
// faithful way to simulate "unchanged wiki, second run" without tripping over that
// separate (pre-existing, out-of-scope-here) Task-3 non-idempotency quirk.
test('publish emits a heartbeat commit, not an extracts commit, when a second run has no content changes', async () => {
  const { state, bare } = seedOrgState();
  const memberDir = path.join(state, 'org', 'brain', 'members', 'testbox');
  const writeValidExtract = async () => {
    mkdirSync(memberDir, { recursive: true });
    writeFileSync(path.join(memberDir, 'updates.md'),
      `# Updates from testbox\n\n## 2026-07-25\n- fact\n\nsource: testbox/wiki/log.md · 2026-07-25\n`);
    return 'wrote extracts';
  };
  const noopClaude = async () => 'no changes'; // model correctly wrote nothing new

  const r1 = await publish(state, { dryRun: false, runClaude: writeValidExtract });
  assert.equal(r1.ok, true);
  assert.doesNotMatch(r1.output, /heartbeat/);
  const show1 = execFileSync('git', ['-C', bare, 'log', 'main', '-1', '--format=%s'], { encoding: 'utf8' });
  assert.match(show1, /^publish\(testbox\): extracts for/);

  const r2 = await publish(state, { dryRun: false, runClaude: noopClaude });
  assert.equal(r2.ok, true);
  assert.match(r2.output, /heartbeat/);
  const show2 = execFileSync('git', ['-C', bare, 'log', 'main', '-1', '--format=%s'], { encoding: 'utf8' });
  assert.match(show2, /^publish\(testbox\): heartbeat/);
});

// --- Review fix: validation-failure revert path coverage (Finding 2) ------------------
test('publish reverts the member dir and rejects when validation fails — bad.md never lands, no commit lands', async () => {
  const { state, bare } = seedOrgState();
  const before = execFileSync('git', ['-C', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  const badClaude = async () => {
    const memberDir = path.join(state, 'org', 'brain', 'members', 'testbox');
    mkdirSync(path.join(memberDir, 'entities'), { recursive: true });
    writeFileSync(path.join(memberDir, 'entities', 'bad.md'), '# Bad\nunattributed claim, no provenance line\n');
    return 'wrote extracts';
  };
  await assert.rejects(
    () => publish(state, { dryRun: false, runClaude: badClaude }),
    /provenance validation failed/
  );
  assert.ok(!existsSync(path.join(state, 'org', 'brain', 'members', 'testbox', 'entities', 'bad.md')),
    'bad.md should have been removed by the revert (git clean -fd)');
  const after = execFileSync('git', ['-C', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  assert.equal(after, before, 'origin main must not have gained a commit from the rejected publish');
});
