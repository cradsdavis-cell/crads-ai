// adopted-brain.test.mjs: the engine bends around a brain the person already had.
// Run: node --test engine/adopted-brain.test.mjs
//
// Spec docs/superpowers/specs/2026-10-17-adopt-existing-server.md § Engine changes
// and § Test plan T2. The first adopted brain is a repo on `master` with its own
// `capture`, `daily`, `followup`, `inbox` and `weekly` skills, a tracked .claude/
// and cockpit/, a tracked backups/ holding its own encrypted snapshot, other
// writers pushing the same remote, and a person who sometimes rebases by hand.
// Before these changes the engine would have overwritten those skills, untracked
// those dirs, aborted the rebase, pushed `main` and settled conflicts with
// `merge -s ours`.
//
// One fixture carries every clash on purpose. Each rule is proven with
// `adopted: true` in ownership.json, and, wherever the old behaviour was
// destructive, the SAME fixture without the flag is run too, so the test shows
// that the flag is what changes the outcome and that a pebble still gets exactly
// what it always got.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../tests/tmp-dir.mjs';
import { isAdopted } from './lib/mineral-identity.mjs';
import { brainIgnoresFor, brainIgnores, brainRequired, brainIgnoresAdopted } from './lib/brain-ignore.mjs';
import { syncSkills, ENGINE_MARKER, ADOPTED_ONLY } from './kernel/lib/skills.mjs';
import { clearRebase, commitAll, dirtyPaths, syncPush, KERNEL_REBASE_MARK } from './kernel/lib/git.mjs';
import { enqueue, kpaths } from './kernel/lib/queue.mjs';
import { ensureOpenFolder, NO_LINK_NAME } from './lib/open-folder.mjs';

const ENGINE = dirname(fileURLToPath(import.meta.url));
const ENGINE_SKILLS = join(ENGINE, 'skills');
const KERNEL = join(ENGINE, 'kernel', 'kernel.mjs');
const CLASHES = ['capture', 'daily', 'followup', 'inbox', 'weekly'];
const IDENT = ['-c', 'user.name=person', '-c', 'user.email=person@x'];

const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: r.stderr || '' };
};
const ok = (cwd, ...a) => {
  const r = git(cwd, ...a);
  assert.equal(r.code, 0, `git ${a.join(' ')} failed: ${r.err}`);
  return r.out;
};
const sentinel = (name) => `---\nname: ${name}\ndescription: the person's own ${name}\n---\nSENTINEL ${name}: written by the person, never by the engine\n`;
const tracked = (cwd, p) => git(cwd, 'ls-files', '--', p).out.split('\n').filter(Boolean);
const remoteTip = (bare, branch) => git(bare, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`).out;

// The fixture: a bare origin on master and a brain cloned from it with every clash.
function fixture({ adopted = true, gitignore } = {}) {
  const bare = tmpDir('adopt-origin-') + '.git';
  ok('/', 'init', '-q', '--bare', '-b', 'master', bare);
  const brain = tmpDir('adopt-brain-');
  ok(brain, 'init', '-q', '-b', 'master');
  for (const n of CLASHES) {
    mkdirSync(join(brain, '.claude', 'skills', n), { recursive: true });
    writeFileSync(join(brain, '.claude', 'skills', n, 'SKILL.md'), sentinel(n));
  }
  writeFileSync(join(brain, '.claude', 'settings.json'), '{ "the": "person\'s settings" }\n');
  mkdirSync(join(brain, 'cockpit'), { recursive: true });
  writeFileSync(join(brain, 'cockpit', 'jobs.js'), '// the person\'s own job runner\n');
  mkdirSync(join(brain, 'backups'), { recursive: true });
  writeFileSync(join(brain, 'backups', 'their-snapshot.enc'), 'THEIR OWN CIPHERTEXT\n');
  writeFileSync(join(brain, 'CLAUDE.md'), '# The person\'s own CLAUDE.md\n');
  writeFileSync(join(brain, 'shared.md'), 'base\n');
  writeFileSync(join(brain, 'profile.yaml'), 'identity:\n  user_short: "Pat"\n');
  writeFileSync(join(brain, 'ownership.json'), JSON.stringify(adopted ? { adopted: true } : { owner: 'member' }, null, 2) + '\n');
  // As the kernel or box-up would leave it: the credential floor present, so
  // brain-push's refusal is not what a test is measuring.
  writeFileSync(join(brain, '.gitignore'), gitignore ?? brainRequired().join('\n') + '\n');
  ok(brain, 'add', '-A');
  ok(brain, ...IDENT, 'commit', '-q', '-m', 'the person\'s brain');
  ok(brain, 'remote', 'add', 'origin', bare);
  ok(brain, 'push', '-q', '-u', 'origin', 'master');
  return { bare, brain };
}

// Another writer (a laptop session, a worktree) pushes master.
function otherWriter(bare, file, content) {
  const w = tmpDir('adopt-other-');
  ok('/', 'clone', '-q', bare, w);
  mkdirSync(dirname(join(w, file)), { recursive: true });
  writeFileSync(join(w, file), content);
  ok(w, 'add', '-A');
  ok(w, ...IDENT, 'commit', '-q', '-m', `other writer: ${file}`);
  ok(w, 'push', '-q', 'origin', 'master');
  return ok(w, 'rev-parse', 'HEAD');
}

// A rebase the person started by hand and stopped on a conflict.
function manualRebase(brain) {
  ok(brain, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(brain, 'shared.md'), 'feature version\n');
  ok(brain, ...IDENT, 'commit', '-q', '-am', 'feature edit');
  ok(brain, 'checkout', '-q', 'master');
  writeFileSync(join(brain, 'shared.md'), 'master version\n');
  ok(brain, ...IDENT, 'commit', '-q', '-am', 'master edit');
  ok(brain, 'checkout', '-q', 'feature');
  assert.notEqual(git(brain, ...IDENT, 'rebase', 'master').code, 0, 'precondition: the rebase stops on a conflict');
  const gd = ok(brain, 'rev-parse', '--absolute-git-dir');
  assert.ok(existsSync(join(gd, 'rebase-merge')), 'precondition: a rebase is in progress');
  return gd;
}

// --- the flag itself ---------------------------------------------------------

const IS_ADOPTED_LINE = `is_adopted() { grep -Eq '"adopted"[[:space:]]*:[[:space:]]*true([^A-Za-z0-9_]|$)' "$1/ownership.json" 2>/dev/null; }`;

test('is_adopted: one identical line in every shell reader, and the same answer as isAdopted()', () => {
  for (const f of ['brain-push.sh', 'connect-github.sh', 'box-up.sh']) {
    const src = readFileSync(join(ENGINE, f), 'utf8');
    assert.ok(src.split('\n').includes(IS_ADOPTED_LINE), `${f} must carry the is_adopted line verbatim`);
  }
  // pretty (how mineral-identity writes it) and compact JSON both; the shell line is
  // grep, so it must agree with the JSON reader on every shape the engine writes
  const cases = [[{ adopted: true }, true], ['{"adopted":true,"tier":"pebble"}', true], ['{"adopted":true}', true], [{ adopted: 'true' }, false], [{ adopted: 1 }, false], [{ adopted: false }, false], [{ owner: 'member' }, false], [null, false]];
  for (const [rec, want] of cases) {
    const d = tmpDir('adopt-flag-');
    if (rec) writeFileSync(join(d, 'ownership.json'), typeof rec === 'string' ? rec : JSON.stringify(rec, null, 2));
    const sh = spawnSync('bash', ['-c', `${IS_ADOPTED_LINE}\nis_adopted "$1"`, 'x', d]).status === 0;
    assert.equal(isAdopted(d), want, `isAdopted(${JSON.stringify(rec)})`);
    assert.equal(sh, want, `is_adopted for ${JSON.stringify(rec)}`);
  }
});

// --- 1. skills ---------------------------------------------------------------

test('skills: the person\'s skills are never written; clashing engine skills install as crads-<name>', async () => {
  const { brain } = fixture();
  const n = await syncSkills(brain, ENGINE_SKILLS);
  assert.ok(n > 0);
  for (const name of CLASHES) {
    assert.equal(readFileSync(join(brain, '.claude', 'skills', name, 'SKILL.md'), 'utf8'), sentinel(name), `${name} is the person's`);
    assert.ok(!existsSync(join(brain, '.claude', 'skills', name, ENGINE_MARKER)), `no marker dropped into ${name}`);
    const ours = join(brain, '.claude', 'skills', `crads-${name}`);
    assert.ok(existsSync(join(ours, ENGINE_MARKER)), `crads-${name} carries the marker`);
    assert.match(readFileSync(join(ours, 'SKILL.md'), 'utf8'), new RegExp(`^name: crads-${name}$`, 'm'), 'and answers to its own name');
  }
  // a non-clashing engine skill is prefixed too (rehearsal finding 2), marked as ours
  assert.ok(existsSync(join(brain, '.claude', 'skills', 'crads-onboard', ENGINE_MARKER)));
  assert.ok(!existsSync(join(brain, '.claude', 'skills', 'onboard')), 'no engine skill under a bare name');
  // a re-sync (every update) refreshes ours and still leaves theirs alone
  writeFileSync(join(brain, '.claude', 'skills', 'crads-capture', 'SKILL.md'), 'stale');
  await syncSkills(brain, ENGINE_SKILLS);
  assert.notEqual(readFileSync(join(brain, '.claude', 'skills', 'crads-capture', 'SKILL.md'), 'utf8'), 'stale');
  assert.equal(readFileSync(join(brain, '.claude', 'skills', 'capture', 'SKILL.md'), 'utf8'), sentinel('capture'));
});

test('skills: a crads-<name> the person made themselves is left alone too', async () => {
  const { brain } = fixture();
  mkdirSync(join(brain, '.claude', 'skills', 'crads-daily'), { recursive: true });
  writeFileSync(join(brain, '.claude', 'skills', 'crads-daily', 'SKILL.md'), 'mine as well');
  await syncSkills(brain, ENGINE_SKILLS);
  assert.equal(readFileSync(join(brain, '.claude', 'skills', 'crads-daily', 'SKILL.md'), 'utf8'), 'mine as well');
  assert.equal(readFileSync(join(brain, '.claude', 'skills', 'daily', 'SKILL.md'), 'utf8'), sentinel('daily'));
});

const engineNames = () => readdirSync(ENGINE_SKILLS).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));

test('skills: on an adopted brain EVERY engine skill installs as crads-<name>, answering to that name; /move-in keeps its own', async () => {
  const { brain } = fixture();
  await syncSkills(brain, ENGINE_SKILLS);
  const dir = join(brain, '.claude', 'skills');
  for (const name of engineNames()) {
    const target = ADOPTED_ONLY.includes(name) ? name : `crads-${name}`;
    assert.ok(existsSync(join(dir, target, ENGINE_MARKER)), `${target} carries the marker`);
    assert.match(readFileSync(join(dir, target, 'SKILL.md'), 'utf8'), new RegExp(`^name: ${target}$`, 'm'), `${target} answers to its own name`);
    if (!ADOPTED_ONLY.includes(name) && !CLASHES.includes(name)) assert.ok(!existsSync(join(dir, name)), `no bare ${name}`);
  }
  // the rehearsal's case: these two landed under their bare names and were committed
  for (const name of ['propose-change', 'write-page']) {
    assert.ok(!existsSync(join(dir, name)), `${name} must not appear under its bare name`);
    assert.ok(existsSync(join(dir, `crads-${name}`)));
  }
  // and the never-commit list covers every one of them
  const { brain: b2 } = fixture({ gitignore: brainIgnoresAdopted().join('\n') + '\n' });
  await syncSkills(b2, ENGINE_SKILLS);
  ok(b2, 'add', '-A');
  const added = ok(b2, 'status', '--porcelain').split('\n').filter(Boolean);
  assert.deepEqual(added.filter((l) => l.includes('.claude/skills/')), [], `engine skills reached the person's index:\n${added.join('\n')}`);
});

test('skills: a bare-named engine copy from an earlier engine (marked) is retired for its crads- twin; an unmarked dir is never touched', async () => {
  const { brain } = fixture();
  const dir = join(brain, '.claude', 'skills');
  // what the engine before this change installed: write-page and onboard under their own names, marked
  for (const name of ['write-page', 'onboard']) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\n---\nold engine copy\n`);
    writeFileSync(join(dir, name, ENGINE_MARKER), 'engine skill\n');
  }
  // a file the person dropped into one of ours stays, with the dir around it
  writeFileSync(join(dir, 'onboard', 'notes.md'), 'mine\n');
  // a bare dir WITHOUT the marker is the person's, whatever its name
  mkdirSync(join(dir, 'propose-change'), { recursive: true });
  writeFileSync(join(dir, 'propose-change', 'SKILL.md'), sentinel('propose-change'));
  await syncSkills(brain, ENGINE_SKILLS);
  assert.ok(!existsSync(join(dir, 'write-page')), 'the marked bare copy is gone');
  assert.ok(existsSync(join(dir, 'crads-write-page', ENGINE_MARKER)), 'its crads- twin is written');
  assert.ok(!existsSync(join(dir, 'onboard', 'SKILL.md')) && !existsSync(join(dir, 'onboard', ENGINE_MARKER)), 'our two files leave');
  assert.equal(readFileSync(join(dir, 'onboard', 'notes.md'), 'utf8'), 'mine\n', 'the person\'s file and its dir stay');
  assert.equal(readFileSync(join(dir, 'propose-change', 'SKILL.md'), 'utf8'), sentinel('propose-change'), 'an unmarked dir is never touched');
  assert.ok(existsSync(join(dir, 'crads-propose-change', ENGINE_MARKER)));
});

test('skills: an adopted brain with a move-in of its own gets ours as crads-move-in', async () => {
  const { brain } = fixture();
  mkdirSync(join(brain, '.claude', 'skills', 'move-in'), { recursive: true });
  writeFileSync(join(brain, '.claude', 'skills', 'move-in', 'SKILL.md'), sentinel('move-in'));
  await syncSkills(brain, ENGINE_SKILLS);
  assert.equal(readFileSync(join(brain, '.claude', 'skills', 'move-in', 'SKILL.md'), 'utf8'), sentinel('move-in'));
  assert.match(readFileSync(join(brain, '.claude', 'skills', 'crads-move-in', 'SKILL.md'), 'utf8'), /^name: crads-move-in$/m);
});

test('skills-list on an adopted brain: crads-* (marked) read as engine, the person\'s own as member', async () => {
  const { brain } = fixture();
  await syncSkills(brain, ENGINE_SKILLS);
  const r = spawnSync('node', [join(ENGINE, 'appshell', 'skills-list.mjs'), brain], { encoding: 'utf8', env: { ...process.env, AIOS_ENGINE_SKILLS_DIR: ENGINE_SKILLS } });
  assert.equal(r.status, 0, r.stderr);
  const { skills } = JSON.parse(r.stdout.replace(/^SKILLS_STATE /, ''));
  const src = Object.fromEntries(skills.map((s) => [s.id, s.source]));
  for (const name of CLASHES) assert.equal(src[name], 'member', `${name} is the person's`);
  for (const name of engineNames()) {
    const id = ADOPTED_ONLY.includes(name) ? name : `crads-${name}`;
    assert.equal(src[id], 'engine', `${id} is the engine's`);
  }
});

test('skills, pebble: unchanged, every engine skill overwrites its own name and no marker is written', async () => {
  const { brain } = fixture({ adopted: false });
  await syncSkills(brain, ENGINE_SKILLS);
  const engineCapture = readFileSync(join(ENGINE_SKILLS, 'capture.md'), 'utf8');
  assert.equal(readFileSync(join(brain, '.claude', 'skills', 'capture', 'SKILL.md'), 'utf8'), engineCapture);
  assert.ok(!existsSync(join(brain, '.claude', 'skills', 'crads-capture')));
  const markers = readdirSync(join(brain, '.claude', 'skills')).filter((d) => existsSync(join(brain, '.claude', 'skills', d, ENGINE_MARKER)));
  assert.deepEqual(markers, []);
});

// --- 2. ignore repair and untracking -------------------------------------------

test('ignore: an adopted brain gets everything but .claude/ and cockpit/; a pebble the full list', () => {
  const a = fixture().brain, p = fixture({ adopted: false }).brain;
  const set = brainIgnoresFor(a);
  assert.deepEqual(set, brainIgnoresAdopted());
  assert.deepEqual(brainIgnoresFor(p), brainIgnores());
  for (const e of brainRequired()) assert.ok(set.includes(e), `the credential floor (${e}) is always there`);
  assert.ok(!set.includes('.claude/') && !set.includes('cockpit/'), 'the person\'s own dirs stay theirs');
  // adopt rehearsal 2026-10-18: these reached the person's repo when the set was the floor only
  for (const e of ['.opencode-auth/', 'node_modules/', '.claude/skills/move-in/', '.claude/skills/crads-*/', 'cockpit/data.json', 'cockpit/connectors.json']) {
    assert.ok(set.includes(e), `${e} is ignored on an adopted brain`);
  }
  assert.ok(!brainRequired().includes('.claude/') && !brainRequired().includes('cockpit/'), 'the floor never carries .claude/ or cockpit/');
});

test('ignore: the shell readers and the node reader agree on the adopted set', () => {
  for (const f of ['brain-push.sh', 'connect-github.sh', 'box-up.sh']) {
    const src = readFileSync(join(ENGINE, f), 'utf8');
    const line = src.split('\n').find((l) => /awk '\/\^# --- \/\{s=\(\$0 ~ \/adopted brain, which tracks\//.test(l));
    assert.ok(line, `${f} reads the adopted set with the shared awk`);
    const awk = line.match(/awk '([^']+)'/)[1];
    const sh = spawnSync('awk', [awk, join(ENGINE, 'lib', 'brain-ignore.txt')], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    assert.deepEqual(sh, brainIgnoresAdopted(), f);
  }
  const helper = (f) => readFileSync(join(ENGINE, f), 'utf8').split('\n').find((l) => l.startsWith('untrack_entry()'));
  assert.ok(helper('brain-push.sh') && helper('brain-push.sh') === helper('connect-github.sh'), 'one untrack_entry line in both pushers');
});

test('brain-push.sh in move-in mode commits and pushes nothing (the app runs it on every open)', () => {
  const { bare, brain } = fixture();
  writeFileSync(join(brain, 'ownership.json'), JSON.stringify({ adopted: true, moving_in: true }) + '\n');
  writeFileSync(join(brain, 'note.md'), 'half-written\n');
  const head = ok(brain, 'rev-parse', 'HEAD');
  const remoteBefore = remoteTip(bare, 'master');
  const r = spawnSync('bash', [join(ENGINE, 'brain-push.sh'), brain], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(ok(brain, 'rev-parse', 'HEAD'), head, 'no commit while moving in');
  assert.equal(remoteTip(bare, 'master'), remoteBefore, 'nothing pushed while moving in');
  assert.match(readFileSync(join(brain, 'cockpit', 'brain-push.log'), 'utf8'), /moving in/);
});

test('brain-push.sh on an adopted brain: engine files stay out, a tracked .env.example stays in', () => {
  const { brain } = fixture();
  writeFileSync(join(brain, '.env.example'), 'TOKEN=\n');
  ok(brain, 'add', '-f', '.env.example');
  ok(brain, ...IDENT, 'commit', '-q', '-m', 'their template');
  mkdirSync(join(brain, '.opencode-auth', 'config'), { recursive: true });
  writeFileSync(join(brain, '.opencode-auth', 'config', 'auth.json'), '{"secret":"x"}\n');
  writeFileSync(join(brain, 'cockpit', 'data.json'), '{}\n');
  writeFileSync(join(brain, 'cockpit', 'connectors.json'), '{}\n');
  mkdirSync(join(brain, '.claude', 'skills', 'move-in'), { recursive: true });
  writeFileSync(join(brain, '.claude', 'skills', 'move-in', 'SKILL.md'), '---\nname: move-in\n---\n');
  const r = spawnSync('bash', [join(ENGINE, 'brain-push.sh'), brain], { encoding: 'utf8' });
  assert.equal(r.status, 0, readFileSync(join(brain, 'cockpit', 'brain-push.log'), 'utf8'));
  // brain-push repairs .gitignore only through the kernel/box-up; apply the adopted set as they would
  writeFileSync(join(brain, '.gitignore'), brainIgnoresAdopted().join('\n') + '\n');
  spawnSync('bash', [join(ENGINE, 'brain-push.sh'), brain], { encoding: 'utf8' });
  for (const p of ['.opencode-auth/config/auth.json', 'cockpit/data.json', 'cockpit/connectors.json', '.claude/skills/move-in/SKILL.md']) {
    assert.equal(tracked(brain, p).length, 0, `${p} must not be in the person's repo`);
  }
  assert.equal(tracked(brain, '.env.example').length, 1, 'a template the person tracks stays tracked');
});

test('kernel drain: sentinels survive, .claude/ and cockpit/ stay tracked and un-ignored', () => {
  const { brain } = fixture();
  execFileSync('node', [KERNEL, brain, '--once', '--dry-run'], { encoding: 'utf8' });
  const gi = readFileSync(join(brain, '.gitignore'), 'utf8').split('\n');
  for (const req of brainRequired()) assert.ok(gi.includes(req), `floor entry ${req} repaired`);
  assert.ok(!gi.includes('.claude/') && !gi.includes('cockpit/'), `.gitignore must not hide the person's dirs:\n${gi.join('\n')}`);
  for (const name of CLASHES) assert.equal(readFileSync(join(brain, '.claude', 'skills', name, 'SKILL.md'), 'utf8'), sentinel(name));
  assert.ok(tracked(brain, '.claude/settings.json').length && tracked(brain, 'cockpit/jobs.js').length);
});

test('brain-push.sh: nothing of the person\'s is untracked, and it pushes master', () => {
  const { bare, brain } = fixture();
  writeFileSync(join(brain, 'note.md'), 'tonight\n');
  ok(brain, 'add', 'note.md');
  ok(brain, ...IDENT, 'commit', '-q', '-m', 'the person\'s own commit');
  const r = spawnSync('bash', [join(ENGINE, 'brain-push.sh'), brain], { encoding: 'utf8' });
  const log = readFileSync(join(brain, 'cockpit', 'brain-push.log'), 'utf8');
  assert.equal(r.status, 0, log);
  assert.doesNotMatch(log, /untracked/, log);
  for (const p of ['.claude/settings.json', 'cockpit/jobs.js', 'backups/their-snapshot.enc', ...CLASHES.map((n) => `.claude/skills/${n}/SKILL.md`)]) {
    assert.equal(tracked(brain, p).length, 1, `${p} still tracked`);
  }
  assert.equal(remoteTip(bare, 'master'), ok(brain, 'rev-parse', 'HEAD'), 'master carries the person\'s commit');
  assert.equal(remoteTip(bare, 'main'), '', 'no main branch invented on the remote');
});

test('brain-push.sh, pebble: unchanged, the full list is untracked (the flag is what spares them)', () => {
  const { brain } = fixture({ adopted: false, gitignore: brainIgnores().join('\n') + '\n' });
  spawnSync('bash', [join(ENGINE, 'brain-push.sh'), brain], { encoding: 'utf8' });
  assert.deepEqual(tracked(brain, '.claude'), []);
  assert.deepEqual(tracked(brain, 'cockpit'), []);
});

test('brain-push.sh: a rebase the person has in progress is not committed onto, and the run says so as a failure', () => {
  const { brain } = fixture();
  const gd = manualRebase(brain);
  const r = spawnSync('bash', [join(ENGINE, 'brain-push.sh'), brain], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(readFileSync(join(brain, 'cockpit', 'brain-push.log'), 'utf8'), /rebase or merge is in progress/);
  assert.ok(existsSync(join(gd, 'rebase-merge')), 'the rebase is still there');
});

test('connect-github.sh, already reachable: edits nothing, untracks nothing of the person\'s', () => {
  const { brain } = fixture({ gitignore: '' });
  const dir = tmpDir('adopt-cgh-');
  writeFileSync(join(dir, 'gh'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(join(dir, 'git'), '#!/usr/bin/env bash\nfor a in "$@"; do [ "$a" = "push" ] && exit 0; done\nexec /usr/bin/git "$@"\n');
  execFileSync('chmod', ['+x', join(dir, 'gh'), join(dir, 'git')]);
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'lib', 'brain-ignore.txt'), readFileSync(join(ENGINE, 'lib', 'brain-ignore.txt')));
  writeFileSync(join(dir, 'run.sh'), readFileSync(join(ENGINE, 'connect-github.sh')));
  const out = spawnSync('bash', [join(dir, 'run.sh')], { encoding: 'utf8', env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, STATE_DIR: brain } });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  // Since trap 77 (2026-10-20) an adopted brain's .gitignore is the person's own
  // and connect-github does not edit it at all; the kernel and box-up repair the
  // credential floor (pinned above), and brain-push refuses without it.
  assert.equal(readFileSync(join(brain, '.gitignore'), 'utf8'), '', 'the person\'s .gitignore is untouched');
  assert.ok(tracked(brain, '.claude/settings.json').length && tracked(brain, 'cockpit/jobs.js').length, out.stdout + out.stderr);
});

// --- 3. push the current branch; stop on conflict -------------------------------

test('syncPush: pushes the branch the brain is on (master), not main', async () => {
  const { bare, brain } = fixture();
  const before = await dirtyPaths(brain);
  writeFileSync(join(brain, 'note.md'), 'x\n');
  await commitAll(brain, 'job', { before });
  const r = await syncPush(brain);
  assert.equal(r.pushed, true, JSON.stringify(r));
  assert.equal(r.branch, 'master');
  assert.equal(remoteTip(bare, 'master'), ok(brain, 'rev-parse', 'HEAD'));
  assert.equal(remoteTip(bare, 'main'), '');
});

test('syncPush: another writer\'s non-conflicting commit is kept, ours replays on top', async () => {
  const { bare, brain } = fixture();
  const theirs = otherWriter(bare, 'laptop.md', 'from the laptop\n');
  const before = await dirtyPaths(brain);
  writeFileSync(join(brain, 'note.md'), 'x\n');
  await commitAll(brain, 'job', { before });
  const r = await syncPush(brain);
  assert.equal(r.pushed, true, JSON.stringify(r));
  assert.equal(git(bare, 'merge-base', '--is-ancestor', theirs, 'refs/heads/master').code, 0, 'their commit is in master');
  assert.ok(!existsSync(join(brain, KERNEL_REBASE_MARK)), 'the kernel mark is cleared');
});

test('syncPush: a conflicting remote commit stops the push and reports; nothing is overridden', async () => {
  const { bare, brain } = fixture();
  const theirs = otherWriter(bare, 'shared.md', 'the laptop\'s version\n');
  const before = await dirtyPaths(brain);
  writeFileSync(join(brain, 'shared.md'), 'the box\'s version\n');
  const ours = await commitAll(brain, 'job', { before });
  assert.ok(ours, 'precondition: the run\'s own edit is committed');
  const r = await syncPush(brain);
  assert.equal(r.pushed, false);
  assert.equal(r.blocked, true);
  assert.equal(r.conflict, true);
  assert.match(r.reason, /conflict/);
  assert.equal(remoteTip(bare, 'master'), theirs, 'the remote still holds the other writer\'s commit, untouched');
  assert.equal(ok(brain, 'rev-parse', 'HEAD'), ours, 'our commit is still on master, unreplayed');
  assert.equal(ok(brain, 'symbolic-ref', '--short', 'HEAD'), 'master', 'and the brain is back on its branch');
  const gd = ok(brain, 'rev-parse', '--absolute-git-dir');
  assert.ok(!existsSync(join(gd, 'rebase-merge')) && !existsSync(join(brain, KERNEL_REBASE_MARK)), 'no rebase state left behind');
  assert.ok(!ok(brain, 'log', '--format=%s', '-3').includes('Merge'), 'no merge -s ours');
});

test('kernel drain: a blocked push lands as the brain-push row the Health page reads', async () => {
  // The adopted ignore set, as box-up leaves it, so the engine's own logs are not
  // uncommitted edits (those would stop the push one step earlier, tested below).
  const { bare, brain } = fixture({ gitignore: brainIgnoresAdopted().join('\n') + '\n' });
  // The dry daily writes wiki/daily-brief.md; another writer already pushed one.
  // (An edit that was in the folder before the drain is the person's and is not
  // committed at all on an adopted brain, so it cannot be what conflicts.)
  otherWriter(bare, 'wiki/daily-brief.md', 'the laptop\'s brief\n');
  await enqueue(brain, { skill: 'daily', args: {}, source: 'cli' });
  execFileSync('node', [KERNEL, brain, '--once', '--dry-run'], { encoding: 'utf8' });
  const rows = readFileSync(join(brain, 'cockpit', 'run-ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const push = rows.filter((r) => r.job === 'brain-push');
  assert.equal(push.length, 1, JSON.stringify(rows));
  assert.equal(push[0].status, 'fail');
  assert.match(push[0].error, /conflict/);
});

test('syncPush, pebble: unchanged, a conflicting remote edit still converges box-wins on main', async () => {
  // the pebble's contract, pinned again beside the adopted one (git.test.mjs owns it)
  const bare = tmpDir('peb-origin-') + '.git';
  ok('/', 'init', '-q', '--bare', '-b', 'main', bare);
  const box = tmpDir('peb-box-');
  ok(box, 'init', '-q', '-b', 'main');
  writeFileSync(join(box, 'shared.md'), 'base\n');
  ok(box, 'add', '-A'); ok(box, ...IDENT, 'commit', '-q', '-m', 'base');
  ok(box, 'remote', 'add', 'origin', bare); ok(box, 'push', '-q', 'origin', 'main');
  const w = tmpDir('peb-other-');
  ok('/', 'clone', '-q', bare, w);
  writeFileSync(join(w, 'shared.md'), 'org\n'); ok(w, ...IDENT, 'commit', '-q', '-am', 'org'); ok(w, 'push', '-q', 'origin', 'main');
  writeFileSync(join(box, 'shared.md'), 'box\n');
  await commitAll(box, 'job');
  const r = await syncPush(box);
  assert.equal(r.pushed, true, JSON.stringify(r));
  assert.equal(r.blocked, undefined);
  assert.equal(git(bare, 'show', 'refs/heads/main:shared.md').out, 'box');
});

// --- 4. the person's rebase survives -------------------------------------------

test('rebase: a manual rebase survives clearRebase, commitAll, syncPush and a whole kernel drain', async () => {
  const { brain } = fixture();
  const gd = manualRebase(brain);
  const head = ok(brain, 'rev-parse', 'HEAD');
  await clearRebase(brain);
  assert.equal(await commitAll(brain, 'job'), null, 'nothing is committed onto their rebase');
  const r = await syncPush(brain);
  assert.equal(r.pushed, false);
  assert.match(r.reason, /in progress/);
  await enqueue(brain, { skill: 'daily', args: {}, source: 'cli' });
  execFileSync('node', [KERNEL, brain, '--once', '--dry-run'], { encoding: 'utf8' });
  assert.ok(existsSync(join(gd, 'rebase-merge')), 'the rebase is still in progress');
  assert.equal(ok(brain, 'rev-parse', 'HEAD'), head, 'HEAD has not moved');
  assert.match(readFileSync(join(brain, 'shared.md'), 'utf8'), /<<<<<<<|=======/, 'their conflict is still on disk for them to resolve');
});

test('rebase: one the kernel itself started (its mark present) is still cleared', async () => {
  const { brain } = fixture();
  const gd = manualRebase(brain);
  mkdirSync(join(brain, '.kernel'), { recursive: true });
  writeFileSync(join(brain, KERNEL_REBASE_MARK), '1\n');
  await clearRebase(brain);
  assert.ok(!existsSync(join(gd, 'rebase-merge')), 'the kernel\'s own leftover is aborted');
  assert.ok(!existsSync(join(brain, KERNEL_REBASE_MARK)), 'and the mark goes with it');
});

test('rebase, pebble: unchanged, any rebase state is aborted on the next drain', async () => {
  const { brain } = fixture({ adopted: false });
  const gd = manualRebase(brain);
  await clearRebase(brain);
  assert.ok(!existsSync(join(gd, 'rebase-merge')));
});

// --- 5. backup -------------------------------------------------------------------

const runBackup = (brain) => spawnSync('node', [join(ENGINE, 'backup.mjs'), brain], { encoding: 'utf8' });

test('backup: lands in backups/crads/, theirs untouched, their staged work not swept into the commit', () => {
  const { brain } = fixture();
  mkdirSync(join(brain, 'secrets'), { recursive: true });
  writeFileSync(join(brain, 'secrets', 'telegram_bot_token'), 'tok\n');
  writeFileSync(join(brain, 'wip.md'), 'half written\n');
  ok(brain, 'add', 'wip.md');
  const r = runBackup(brain);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(existsSync(join(brain, 'backups', 'crads', 'state-snapshot.tar.gz.enc')));
  assert.ok(existsSync(join(brain, 'backups', 'crads', 'heartbeat.json')));
  assert.ok(!existsSync(join(brain, 'backups', 'state-snapshot.tar.gz.enc')), 'nothing of ours at the top of their backups/');
  assert.equal(readFileSync(join(brain, 'backups', 'their-snapshot.enc'), 'utf8'), 'THEIR OWN CIPHERTEXT\n');
  assert.equal(tracked(brain, 'backups/crads/state-snapshot.tar.gz.enc').length, 1, 'ours is committed');
  assert.deepEqual(ok(brain, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['backups/crads/state-snapshot.tar.gz.enc']);
  assert.equal(ok(brain, 'diff', '--cached', '--name-only'), 'wip.md', 'their staged file is still staged, not committed');
});

test('backup, pebble: unchanged, the snapshot still lands at backups/ where restore looks', () => {
  const { brain } = fixture({ adopted: false });
  const r = runBackup(brain);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(existsSync(join(brain, 'backups', 'state-snapshot.tar.gz.enc')));
  assert.ok(!existsSync(join(brain, 'backups', 'crads')));
});

// --- 6. box-up -------------------------------------------------------------------
//
// box-up.sh is the container entrypoint and ends by holding the container open,
// so it cannot run whole in a test. These run its REAL text, section by section,
// sliced between the script's own markers.

const BOXUP = readFileSync(join(ENGINE, 'box-up.sh'), 'utf8');
function slice(from, to) {
  const a = BOXUP.indexOf(from), b = BOXUP.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `box-up.sh markers moved: ${from} .. ${to}`);
  return BOXUP.slice(a, b);
}
const runSections = (box, ...parts) => {
  const script = `set -euo pipefail\nBOX="$1"; ENGINE="$2"\n${parts.join('\n')}\n`;
  const r = spawnSync('bash', ['-c', script, 'box-up', box, ENGINE], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};
const SCAFFOLD = () => slice('# ---- adopted brain?', 'node "$ENGINE/appshell/seed-pages.mjs"');
const BOX_SCRIPTS = () => slice('install_box_scripts() {', '# ---- derive the member door');
const GITIGNORE = () => slice('BRAIN_IGNORE="${AIOS_BRAIN_IGNORE', 'if [ "$(git -C "$BOX" rev-parse --show-toplevel');

test('box-up: no wiki scaffold, profile + onboarding (phase done) only if missing, box scripts under .kernel/bin, floor-only ignore', () => {
  const { brain } = fixture();
  const before = readFileSync(join(brain, 'profile.yaml'), 'utf8');
  runSections(brain, SCAFFOLD(), BOX_SCRIPTS(), GITIGNORE());
  assert.ok(!existsSync(join(brain, 'wiki')), 'no wiki/ scaffold in the person\'s brain');
  assert.equal(readFileSync(join(brain, 'profile.yaml'), 'utf8'), before, 'their profile.yaml untouched');
  assert.equal(JSON.parse(readFileSync(join(brain, 'onboarding-state.json'), 'utf8')).phase, 'done');
  const rootScripts = readdirSync(brain).filter((f) => f.endsWith('.sh'));
  assert.deepEqual(rootScripts, [], 'no .sh files dropped into the repo root');
  assert.ok(existsSync(join(brain, '.kernel', 'bin', 'org-sync.sh')));
  const gi = readFileSync(join(brain, '.gitignore'), 'utf8').split('\n');
  assert.ok(!gi.includes('.claude/') && !gi.includes('cockpit/'));
  for (const req of brainRequired()) assert.ok(gi.includes(req));
  assert.match(BOXUP, /\[ "\$ADOPTED" = 1 \] \|\| node "\$ENGINE\/box\/brain-claude-md\.mjs"/, 'CLAUDE.md block is not written on an adopted brain');
});

test('box-up: an adopted brain with no profile gets one, and onboarding starts finished', () => {
  const { brain } = fixture();
  execFileSync('rm', [join(brain, 'profile.yaml')]);
  runSections(brain, SCAFFOLD());
  assert.ok(existsSync(join(brain, 'profile.yaml')));
  assert.equal(JSON.parse(readFileSync(join(brain, 'onboarding-state.json'), 'utf8')).phase, 'done');
});

test('box-up, pebble: unchanged, wiki scaffold, interview onboarding, scripts in the root, full ignore', () => {
  const { brain } = fixture({ adopted: false });
  runSections(brain, SCAFFOLD(), BOX_SCRIPTS(), GITIGNORE());
  assert.ok(existsSync(join(brain, 'wiki', 'people')) && existsSync(join(brain, 'wiki', 'priorities.md')));
  assert.equal(JSON.parse(readFileSync(join(brain, 'onboarding-state.json'), 'utf8')).phase, 'interview');
  assert.ok(existsSync(join(brain, 'org-sync.sh')));
  const gi = readFileSync(join(brain, '.gitignore'), 'utf8').split('\n');
  assert.ok(gi.includes('.claude/') && gi.includes('cockpit/'));
});

test('open-folder: an adopted brain gets the name file only, no link; a link from an earlier boot is retired', () => {
  const { brain } = fixture();
  symlinkSync('.', join(brain, 'control-centre'));
  writeFileSync(join(brain, 'open-folder'), 'control-centre\n');
  const r = ensureOpenFolder(brain, { env: {} });
  assert.equal(r.name, NO_LINK_NAME);
  assert.equal(r.link, null);
  assert.equal(readFileSync(join(brain, 'open-folder'), 'utf8'), `${NO_LINK_NAME}\n`);
  assert.ok(!existsSync(join(brain, 'control-centre')) && !lstatExists(join(brain, 'control-centre')), 'our old link is gone');
});

test('open-folder, pebble: unchanged, the mineral-named link is made', () => {
  const { brain } = fixture({ adopted: false });
  const r = ensureOpenFolder(brain, { env: {} });
  assert.equal(r.action, 'created');
  assert.ok(lstatSync(join(brain, r.name)).isSymbolicLink());
});

function lstatExists(p) { try { lstatSync(p); return true; } catch { return false; } }

// --- 6. never a blind `git add -A` on the shared tree (trap 77, 2026-10-20) ------
// The folder is shared with the server's jobs and the person's sessions, so what
// is uncommitted in it is somebody's work in progress.
function inProgress(brain) {
  writeFileSync(join(brain, 'shared.md'), 'half-edited by a session on the server\n');
  writeFileSync(join(brain, 'invoice.pdf'), '%PDF-1.4 not ours\n');
  writeFileSync(join(brain, 'staged.md'), 'staged by the person\n');
  ok(brain, 'add', 'staged.md');
}

test('kernel drain: the job\'s own output is committed, nobody else\'s work in progress is', async () => {
  const { brain } = fixture();
  inProgress(brain);
  await enqueue(brain, { skill: 'daily', args: {}, source: 'cli' });
  execFileSync('node', [KERNEL, brain, '--once', '--dry-run'], { encoding: 'utf8' });
  const files = ok(brain, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
  assert.deepEqual(files, ['wiki/daily-brief.md'], `the job's commit names its own output only: ${files}`);
  assert.match(ok(brain, 'log', '-1', '--format=%s'), /^job\(daily\)/, 'made by the job\'s own commit, not swept up later');
  assert.equal(readdirSync(kpaths(brain).failed).length, 0, 'and the job did not fail');
  const st = ok(brain, 'status', '--porcelain');
  assert.ok(ok(brain, 'diff', '--name-only').split('\n').includes('shared.md'), 'their edit is still an edit');
  assert.match(st, /^\?\? invoice\.pdf$/m, 'their file is still untracked');
  assert.match(st, /^A  staged\.md$/m, 'what they staged is still staged, not committed under our message');
});

test('commitAll on an adopted brain: no "before", no commit (never everything)', async () => {
  const { brain } = fixture();
  inProgress(brain);
  const head = ok(brain, 'rev-parse', 'HEAD');
  assert.equal(await commitAll(brain, 'job'), null);
  assert.equal(ok(brain, 'rev-parse', 'HEAD'), head);
});

test('commitAll on an adopted brain: a file already dirty before the run stays theirs, even if the run touched it', async () => {
  const { brain } = fixture();
  inProgress(brain);
  const before = await dirtyPaths(brain);
  writeFileSync(join(brain, 'shared.md'), 'half-edited, then the job appended\n');
  writeFileSync(join(brain, 'gone.md'), 'x\n');
  ok(brain, 'add', 'gone.md'); ok(brain, ...IDENT, 'commit', '-q', '-m', 'their gone.md', '--', 'gone.md');
  const before2 = await dirtyPaths(brain);
  rmSync(join(brain, 'gone.md'));
  writeFileSync(join(brain, 'job out.md'), 'a name with a space\n');
  const sha = await commitAll(brain, 'job', { before: new Set([...before, ...before2]) });
  assert.ok(sha);
  assert.deepEqual(ok(brain, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort(), ['gone.md', 'job out.md']);
  assert.ok(ok(brain, 'diff', '--name-only').split('\n').includes('shared.md'), 'their edit is still only an edit');
});

test('commitAll, pebble: unchanged, still everything', async () => {
  const { brain } = fixture({ adopted: false });
  inProgress(brain);
  assert.ok(await commitAll(brain, 'job'));
  assert.equal(ok(brain, 'status', '--porcelain'), '');
});

test('brain-push.sh on an adopted brain: commits nothing, untracks nothing, writes no upstream; pushes what is committed', () => {
  const { bare, brain } = fixture();
  ok(brain, 'branch', '--unset-upstream');
  writeFileSync(join(brain, 'mine.md'), 'committed by the person\n');
  ok(brain, 'add', 'mine.md'); ok(brain, ...IDENT, 'commit', '-q', '-m', 'theirs');
  inProgress(brain);
  const head = ok(brain, 'rev-parse', 'HEAD');
  const status = ok(brain, 'status', '--porcelain');
  const cfg = readFileSync(join(brain, '.git', 'config'), 'utf8');
  const r = spawnSync('bash', [join(ENGINE, 'brain-push.sh'), brain], { encoding: 'utf8' });
  const log = readFileSync(join(brain, 'cockpit', 'brain-push.log'), 'utf8');
  assert.equal(r.status, 0, log);
  assert.equal(ok(brain, 'rev-parse', 'HEAD'), head, 'no commit');
  const now = ok(brain, 'status', '--porcelain').split('\n').filter((l) => !l.endsWith('cockpit/brain-push.log')).join('\n');
  assert.equal(now, status, 'the work in progress is exactly as it was (its own log aside)');
  assert.equal(readFileSync(join(brain, '.git', 'config'), 'utf8'), cfg, 'no upstream written into the shared config');
  assert.equal(remoteTip(bare, 'master'), head, 'the person\'s commit is pushed');
});

test('brain-push.sh on an adopted brain: a credential the repo already tracks is named, not untracked', () => {
  const { brain } = fixture();
  writeFileSync(join(brain, '.mcp.json'), '{}\n');
  ok(brain, 'add', '-f', '.mcp.json'); ok(brain, ...IDENT, 'commit', '-q', '-m', 'their mcp');
  spawnSync('bash', [join(ENGINE, 'brain-push.sh'), brain], { encoding: 'utf8' });
  assert.equal(tracked(brain, '.mcp.json').length, 1, 'the shared index is not changed under the person');
  assert.match(readFileSync(join(brain, 'cockpit', 'brain-push.log'), 'utf8'), /WARNING: your repository tracks \.mcp\.json/);
});

test('box-up commit_brain: an adopted brain is never snapshotted on stop, a pebble still is', () => {
  const src = readFileSync(join(ENGINE, 'box-up.sh'), 'utf8');
  const body = src.slice(src.indexOf('commit_brain(){'), src.indexOf('\n}', src.indexOf('commit_brain(){')));
  const add = body.indexOf('git -C "$BOX" add -A');
  assert.ok(add > 0);
  assert.match(body.slice(0, add), /if \[ "\$ADOPTED" != 1 \] && \[ -n "\$\(git -C "\$BOX" status --porcelain/, 'the add -A is behind the adopted guard');
});

test('syncPush on an adopted brain: behind the remote with someone\'s edits in the folder stops plainly, edits untouched', async () => {
  const { bare, brain } = fixture();
  otherWriter(bare, 'laptop.md', 'from the laptop\n');
  const before = await dirtyPaths(brain);
  writeFileSync(join(brain, 'job.md'), 'ours\n');
  const ours = await commitAll(brain, 'job', { before });
  writeFileSync(join(brain, 'shared.md'), 'half-edited by a session on the server\n');
  const r = await syncPush(brain);
  assert.equal(r.pushed, false);
  assert.equal(r.blocked, true);
  assert.equal(r.behind, true);
  assert.match(r.reason, /uncommitted changes that are not Crads-AI's/);
  assert.equal(readFileSync(join(brain, 'shared.md'), 'utf8'), 'half-edited by a session on the server\n', 'never stashed or reset');
  assert.equal(ok(brain, 'rev-parse', 'HEAD'), ours);
  assert.equal(ok(brain, 'stash', 'list'), '', 'no stash made');
});
