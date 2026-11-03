// adopted-brain-hygiene.test.mjs: nothing the engine writes as machine state
// reaches an adopted brain's git history.
// Run: node --test engine/adopted-brain-hygiene.test.mjs
//
// Adopt rehearsal T4 (2026-10-18), finding 3: cockpit/run-ledger.jsonl and
// custody-log.jsonl were committed into the person's repo, because the
// never-commit list named `run-ledger.json` and did not name the custody log at
// all. Hand-kept lists miss things, so this test does not trust the list: it
// brings a fixture adopted brain up the way a mineral does (box-up's own
// sections, the cockpit, a heartbeat, a scheduled skill drained by the kernel,
// a backup, the custody watch, the scheduler's first minute, the nightly
// brain-push, a device sighting) and then reads every path that ended up in git
// (the engine's own commits, plus `git add -A` on what is left). Each one must
// be the person's own, a piece of their config the engine writes on purpose,
// or what a job produced. Anything else is engine machine state that belongs
// in engine/lib/brain-ignore.txt, and the failure names it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../tests/tmp-dir.mjs';
import { brainIgnores, brainIgnoresAdopted } from './lib/brain-ignore.mjs';

const ENGINE = dirname(fileURLToPath(import.meta.url));
const IDENT = ['-c', 'user.name=person', '-c', 'user.email=person@x'];
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

// (a) The person's config, written by the engine on purpose and worth backing up.
const CONFIG = [
  /^cockpit\/(cadence|scripts|layout|auto-update|sharing|move-in)\.json$/,
  /^move-in\.md$/, /^dashboard\//, /^profile\.yaml$/, /^ownership\.json$/,
  /^box-name$/, /^open-folder$/, /^devices\/[^/]+\.yaml$/, /^onboarding-state\.json$/,
  /^\.gitignore$/,
  // (the encrypted snapshot was listed here as config until trap 80: on the first real
  // adopted brain it weighed 244 MB and blocked every push, so it never reaches git now)
];
// What a job produced (the dry-run daily writes its brief): the person's content.
const OUTPUT = [/^wiki\/daily-brief\.md$/];

function adoptedBrain() {
  const bare = tmpDir('hyg-origin-') + '.git';
  git('/', 'init', '-q', '--bare', '-b', 'master', bare);
  const d = tmpDir('hyg-brain-');
  git(d, 'init', '-q', '-b', 'master');
  mkdirSync(join(d, '.claude', 'skills', 'capture'), { recursive: true });
  writeFileSync(join(d, '.claude', 'skills', 'capture', 'SKILL.md'), '---\nname: capture\n---\nthe person\'s own\n');
  writeFileSync(join(d, '.claude', 'settings.json'), '{}\n');
  mkdirSync(join(d, 'cockpit'), { recursive: true });
  writeFileSync(join(d, 'cockpit', 'jobs.js'), '// the person\'s job runner\n');
  writeFileSync(join(d, 'CLAUDE.md'), '# the person\'s own\n');
  writeFileSync(join(d, 'profile.yaml'), 'identity:\n  user_short: "Pat"\ntimezone: "Australia/Sydney"\ncadence:\n  enabled: false\n');
  writeFileSync(join(d, 'ownership.json'), JSON.stringify({ adopted: true }, null, 2) + '\n');
  writeFileSync(join(d, '.gitignore'), 'node_modules/\n');
  git(d, 'add', '-A');
  git(d, ...IDENT, 'commit', '-q', '-m', 'the person\'s brain');
  git(d, 'remote', 'add', 'origin', bare);
  git(d, 'push', '-q', '-u', 'origin', 'master');
  return { d, base: git(d, 'rev-parse', 'HEAD') };
}

const BOXUP = readFileSync(join(ENGINE, 'box-up.sh'), 'utf8');
function slice(from, to) {
  const a = BOXUP.indexOf(from), b = BOXUP.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `box-up.sh markers moved: ${from} .. ${to}`);
  return BOXUP.slice(a, b);
}

function runScheduler(dir, env, ms = 3000) {
  return new Promise((resolve) => {
    const p = spawn('node', [join(ENGINE, 'cron', 'scheduler.mjs'), dir], { stdio: 'ignore', env });
    setTimeout(() => p.kill('SIGTERM'), ms);
    p.on('close', resolve);
  });
}

async function bringUp(d) {
  // HOME inside the fixture: nothing reads or writes the real home dir
  const env = { ...process.env, HOME: d };
  // box-up from the adopted check to the plugin seed (scaffold, seed-pages,
  // mineral-arm, open-folder, box scripts, device door), then the ignore repair,
  // the roster adopt and the boot dry-run drain
  const script = `set -uo pipefail\nBOX="$1"; ENGINE="$2"\n${slice('# ---- adopted brain?', '# ---- seed the pre-baked')}\n${slice('BRAIN_IGNORE="${AIOS_BRAIN_IGNORE', 'NAME="$(grep')}\n`;
  const r = spawnSync('bash', ['-c', script, 'box-up', d, ENGINE], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const run = (...a) => { const x = spawnSync('node', a, { encoding: 'utf8', env }); assert.equal(x.status, 0, `${a[0]}: ${x.stderr}`); };
  run(join(ENGINE, 'cockpit', 'box-cockpit.mjs'), d);
  run(join(ENGINE, 'heartbeat.mjs'), d);
  run(join(ENGINE, 'kernel', 'enqueue.mjs'), d, 'daily', '--source=cron');
  run(join(ENGINE, 'kernel', 'kernel.mjs'), d, '--once', '--dry-run');
  run(join(ENGINE, 'backup.mjs'), d);
  run(join(ENGINE, 'box', 'custody-watch.mjs'), d);
  run(join(ENGINE, 'appshell', 'skills-list.mjs'), d);
  // a device sighting, as sshd's key command appends it
  mkdirSync(join(d, 'devices'), { recursive: true });
  appendFileSync(join(d, 'devices', 'seen.log'), `${new Date().toISOString()} laptop\n`);
  await runScheduler(d, env);
  // a second heartbeat now that STATE.md exists: it must not be committed either
  run(join(ENGINE, 'heartbeat.mjs'), d);
  const bp = spawnSync('bash', [join(ENGINE, 'brain-push.sh'), d], { encoding: 'utf8', env });
  assert.equal(bp.status, 0, readFileSync(join(d, 'cockpit', 'brain-push.log'), 'utf8'));
  // and the next drain, which commits whatever the run before it left
  run(join(ENGINE, 'kernel', 'enqueue.mjs'), d, 'daily', '--source=cron');
  run(join(ENGINE, 'kernel', 'kernel.mjs'), d, '--once', '--dry-run');
}

// Every path that reached git since the person's commit, plus what `git add -A`
// would stage now (the ignore set box-up and the kernel applied is in force).
function pathsInGit(d, base) {
  git(d, 'add', '-A');
  return git(d, 'diff', '--cached', '--name-only', base).split('\n').filter(Boolean);
}

test('adopted brain: after a full bring-up, nothing in git is engine machine state', async () => {
  const { d, base } = adoptedBrain();
  await bringUp(d);
  const theirs = git(d, 'ls-tree', '-r', '--name-only', base).split('\n');
  const engineState = pathsInGit(d, base).filter((p) => !theirs.includes(p)
    && !CONFIG.some((re) => re.test(p)) && !OUTPUT.some((re) => re.test(p)));
  assert.deepEqual(engineState, [], `engine machine state reached the person's repo; add each to brain-ignore.txt (or classify it here as config):\n${engineState.join('\n')}`);
  // the two the rehearsal committed, by name
  for (const p of ['cockpit/run-ledger.jsonl', 'custody-log.jsonl']) {
    assert.equal(git(d, 'ls-files', '--', p), '', `${p} is not tracked`);
  }
});

test('adopted brain: what the engine already committed earlier is untracked by the next brain-push', async () => {
  const { d } = adoptedBrain();
  // what the rehearsal left: engine logs committed into the person's repo
  writeFileSync(join(d, 'custody-log.jsonl'), '{"event":"baseline"}\n');
  writeFileSync(join(d, 'cockpit', 'run-ledger.jsonl'), '{"job":"x"}\n');
  mkdirSync(join(d, 'state'), { recursive: true });
  writeFileSync(join(d, 'state', 'action_ledger.jsonl'), '{}\n');
  git(d, 'add', '-A');
  git(d, ...IDENT, 'commit', '-q', '-m', 'as the rehearsal left it');
  writeFileSync(join(d, '.gitignore'), brainIgnoresAdopted().join('\n') + '\n');
  const r = spawnSync('bash', [join(ENGINE, 'brain-push.sh'), d], { encoding: 'utf8' });
  assert.equal(r.status, 0, readFileSync(join(d, 'cockpit', 'brain-push.log'), 'utf8'));
  for (const p of ['custody-log.jsonl', 'cockpit/run-ledger.jsonl', 'state/action_ledger.jsonl']) {
    assert.equal(git(d, 'ls-files', '--', p), '', `${p} untracked`);
  }
  assert.ok(git(d, 'ls-files', '--', 'cockpit/jobs.js'), 'the person\'s own cockpit file stays tracked');
});

// STATE.md on an adopted brain. Putting it on the never-commit list would have
// untracked a STATE.md the person tracks themselves (brain-push untracks every
// entry), so the engine's copy lives in .kernel/STATE.md and theirs is theirs.
test('adopted brain: the person\'s own tracked STATE.md stays tracked and untouched through heartbeat and brain-push', () => {
  const { d } = adoptedBrain();
  writeFileSync(join(d, 'STATE.md'), '# my own state notes\n');
  git(d, 'add', 'STATE.md');
  git(d, ...IDENT, 'commit', '-q', '-m', 'my STATE.md');
  writeFileSync(join(d, '.gitignore'), brainIgnoresAdopted().join('\n') + '\n');
  const env = { ...process.env, HOME: d };
  for (let i = 0; i < 2; i++) {
    const hb = spawnSync('node', [join(ENGINE, 'heartbeat.mjs'), d], { encoding: 'utf8', env });
    assert.equal(hb.status, 0, hb.stderr);
    const bp = spawnSync('bash', [join(ENGINE, 'brain-push.sh'), d], { encoding: 'utf8', env });
    assert.equal(bp.status, 0, readFileSync(join(d, 'cockpit', 'brain-push.log'), 'utf8'));
  }
  assert.equal(readFileSync(join(d, 'STATE.md'), 'utf8'), '# my own state notes\n', 'never written over');
  assert.equal(git(d, 'ls-files', '--', 'STATE.md'), 'STATE.md', 'still tracked');
  assert.equal(git(d, 'show', 'HEAD:STATE.md'), '# my own state notes', 'and the committed copy is theirs');
  assert.ok(!brainIgnoresAdopted().includes('STATE.md'), 'not on the adopted never-commit list');
});

test('adopted brain: the engine\'s STATE.md reaches its readers at .kernel/STATE.md; a pebble keeps it at the root', async () => {
  const { stateMdPath, ADOPTED_STATE_MD } = await import('./box/state-md.mjs');
  const { buildBrainSection, ensureBrainClaudeMd } = await import('./box/brain-claude-md.mjs');
  const { d } = adoptedBrain();
  const hb = spawnSync('node', [join(ENGINE, 'heartbeat.mjs'), d], { encoding: 'utf8', env: { ...process.env, HOME: d } });
  assert.equal(hb.status, 0, hb.stderr);
  assert.equal(stateMdPath(d), join(d, '.kernel', 'STATE.md'));
  const page = readFileSync(join(d, ADOPTED_STATE_MD), 'utf8');
  assert.match(page, /^Generated by the heartbeat at /, 'the heartbeat wrote it');
  assert.match(page, /## /, 'with its sections');
  assert.equal(git(d, 'ls-files', '--', ADOPTED_STATE_MD), '', 'never committed');
  // the state-md job (CLI) writes the same place
  const cli = spawnSync('node', [join(ENGINE, 'box', 'state-md.mjs'), d], { encoding: 'utf8', env: { ...process.env, HOME: d } });
  assert.match(cli.stdout, /\.kernel\/STATE\.md/);
  // readers: the /explain skill and the CLAUDE.md block name it
  assert.match(readFileSync(join(ENGINE, 'skills', 'explain.md'), 'utf8'), /\/state\/\.kernel\/STATE\.md/);
  assert.match(buildBrainSection({ stateMd: ADOPTED_STATE_MD }), /read `\.kernel\/STATE\.md` first/);
  ensureBrainClaudeMd(d, { env: {} });
  assert.match(readFileSync(join(d, 'CLAUDE.md'), 'utf8'), /read `\.kernel\/STATE\.md` first/, 'the block, if the person takes it, points at our copy');
  // pebble: unchanged
  const peb = tmpDir('hyg-pebble-md-');
  writeFileSync(join(peb, 'profile.yaml'), 'identity:\n  user_short: "Pat"\n');
  writeFileSync(join(peb, 'ownership.json'), JSON.stringify({ owner: 'member' }) + '\n');
  spawnSync('node', [join(ENGINE, 'heartbeat.mjs'), peb], { encoding: 'utf8', env: { ...process.env, HOME: peb } });
  assert.equal(stateMdPath(peb), join(peb, 'STATE.md'));
  assert.match(readFileSync(join(peb, 'STATE.md'), 'utf8'), /^Generated by the heartbeat at /);
  assert.match(buildBrainSection(), /read `STATE\.md` first/);
});

test('pebble: unchanged, the adopted-only section is not in its never-commit set, in any reader', () => {
  const txt = readFileSync(join(ENGINE, 'lib', 'brain-ignore.txt'), 'utf8');
  const sec = txt.slice(txt.indexOf('adopted brain only'));
  const adoptedOnly = sec.split('\n').slice(1).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  assert.ok(adoptedOnly.includes('custody-log.jsonl') && adoptedOnly.includes('state/action_ledger.jsonl'));
  for (const e of adoptedOnly) {
    assert.ok(!brainIgnores().includes(e), `${e} must not reach a pebble (its ledgers are committed by design)`);
    assert.ok(brainIgnoresAdopted().includes(e), `${e} is ignored on an adopted brain`);
  }
  // the shell readers of the full set agree with the node one
  const full = (f) => {
    const line = readFileSync(join(ENGINE, f), 'utf8').split('\n').find((l) => /adopted brain only/.test(l) && /awk '/.test(l));
    assert.ok(line, `${f} reads the full set with the shared awk`);
    const awk = line.match(/awk '([^']+)'/)[1];
    return spawnSync('awk', [awk, join(ENGINE, 'lib', 'brain-ignore.txt')], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  };
  for (const f of ['brain-push.sh', 'connect-github.sh', 'box-up.sh']) assert.deepEqual(full(f), brainIgnores(), f);
});

test('pebble: the kernel still commits its ledger and state-view into the mineral\'s own brain', () => {
  const d = tmpDir('hyg-pebble-');
  git(d, 'init', '-q', '-b', 'main');
  writeFileSync(join(d, 'profile.yaml'), 'identity:\n  user_short: "Pat"\n');
  writeFileSync(join(d, 'ownership.json'), JSON.stringify({ owner: 'member' }) + '\n');
  execFileSync('node', [join(ENGINE, 'kernel', 'enqueue.mjs'), d, 'daily', '--source=cron']);
  execFileSync('node', [join(ENGINE, 'kernel', 'kernel.mjs'), d, '--once', '--dry-run']);
  assert.ok(git(d, 'ls-files', '--', 'state/action_ledger.jsonl'), 'a pebble versions its action ledger, as before');
});
