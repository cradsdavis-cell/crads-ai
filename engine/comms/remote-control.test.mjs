// remote-control.test.mjs — run: node --test engine/comms/remote-control.test.mjs
//
// Remote Control is the member's assistant from the Claude app on their phone
// (spec docs/superpowers/specs/2026-10-14-remote-control-design.md). On by
// default; the app's Phone card writes the only switch. What these pin:
//   - the gate (on unless the marker, Claude Code only, signed in only),
//   - the first-run seed (two keys, merged, never a replaced config),
//   - the status words the card shows, including the prompt-came-back case,
//   - off/stop take the phone sessions down with the server (process group),
//   - start-comms launches it with NO Telegram, once, in the brain root, with
//     the assistant's name, and stops it when switched off.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import {
  shouldRun, seed, status, readLog, assistantName, folder, off, on, stop, isEnabled,
  DISABLED_MARKER, PID_FILE, LOG_FILE,
} from './remote-control.mjs';

const ENGINE = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(import.meta.dirname, 'remote-control.mjs');

/** A mineral state dir: signed in by default, brain at <state>/brain. */
function mineral({ signedIn = true, brain = true, profile = '' } = {}) {
  const s = tmpDir('rc-');
  mkdirSync(path.join(s, '.claude-auth'), { recursive: true });
  mkdirSync(path.join(s, '.kernel'), { recursive: true });
  if (signedIn) writeFileSync(path.join(s, '.claude-auth', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"x"}}');
  if (brain) mkdirSync(path.join(s, 'brain'), { recursive: true });
  if (profile) writeFileSync(path.join(s, 'profile.yaml'), profile);
  return s;
}
const cfg = (s) => JSON.parse(readFileSync(path.join(s, '.claude-auth', '.claude.json'), 'utf8'));
const writeLog = (s, text) => writeFileSync(path.join(s, ...LOG_FILE), text);
/** A live process standing in for the server, leading its own group like setsid makes it. */
// Started through a shell that exits at once, so it is NOT this test's child: a
// killed direct child stays a zombie until reaped and still answers kill(pid, 0),
// which reads as "alive". The real server is a grandchild of start-comms too.
function fakeServer(s) {
  // exec -a gives it argv[0] "claude remote-control", so it passes the cmdline check.
  const pid = parseInt(execFileSync('bash', ['-c', 'setsid bash -c "exec -a \\"claude remote-control\\" sleep 60" >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }), 10);
  // setsid -> bash -> exec takes a moment; wait until /proc shows the new name.
  for (let i = 0; i < 60; i++) {
    try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').startsWith('claude remote-control')) break; } catch { /* not yet */ }
    execFileSync('sleep', ['0.02']);
  }
  writeFileSync(path.join(s, ...PID_FILE), String(pid));
  return pid;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('the gate: on by default', () => {
  test('a signed-in Claude Code mineral with no marker runs it', () => {
    const s = mineral();
    assert.deepEqual(shouldRun(s), { run: true, reason: 'on' });
    assert.equal(spawnSync('node', [SCRIPT, s, 'should-run']).status, 0);
  });
  test('the opt-out marker turns it off', () => {
    const s = mineral();
    off(s);
    assert.equal(isEnabled(s), false);
    assert.equal(shouldRun(s).reason, 'off');
    assert.equal(spawnSync('node', [SCRIPT, s, 'should-run']).status, 1);
    on(s);
    assert.equal(shouldRun(s).run, true);
  });
  test('not signed in to Claude: no launch (it would exit every two minutes)', () => {
    assert.equal(shouldRun(mineral({ signedIn: false })).reason, 'signed_out');
  });
  test('a mineral that thinks with OpenCode cannot use it', () => {
    const s = mineral({ profile: 'assistant:\n  harness: opencode\n' });
    assert.equal(shouldRun(s).reason, 'unsupported');
    assert.equal(status(s).state, 'unsupported');
  });
});

describe('seed: the two first-run answers, merged into the global config', () => {
  test('writes remoteDialogSeen and trust for the brain root, keeps everything else', () => {
    const s = mineral();
    const before = { oauthAccount: { emailAddress: 'm@example.com' }, hasCompletedOnboarding: true,
      projects: { '/elsewhere': { allowedTools: ['Read'] } } };
    writeFileSync(path.join(s, '.claude-auth', '.claude.json'), JSON.stringify(before));
    const r = seed(s);
    assert.equal(r.ok, true);
    const c = cfg(s);
    assert.equal(c.remoteDialogSeen, true);
    const root = realpathSync(path.join(s, 'brain'));
    assert.equal(c.projects[root].hasTrustDialogAccepted, true);
    assert.deepEqual(c.oauthAccount, before.oauthAccount, 'the sign-in account survives');
    assert.equal(c.hasCompletedOnboarding, true);
    assert.deepEqual(c.projects['/elsewhere'], { allowedTools: ['Read'] });
  });
  test('idempotent: a second seed changes nothing', () => {
    const s = mineral();
    seed(s);
    assert.deepEqual(seed(s).changed, []);
  });
  test('trusts the git root too when the brain is inside a repository', () => {
    const s = mineral();
    const repo = path.join(s, 'brain');
    execFileSync('git', ['init', '-q', repo]);
    mkdirSync(path.join(repo, 'wiki'));
    writeFileSync(path.join(s, 'deployment.yaml'), `brain_root: "${path.join(repo, 'wiki')}"\n`);
    seed(s);
    const c = cfg(s);
    assert.equal(c.projects[realpathSync(path.join(repo, 'wiki'))].hasTrustDialogAccepted, true);
    assert.equal(c.projects[realpathSync(repo)].hasTrustDialogAccepted, true);
  });
  test('an unreadable config is left alone, not replaced', () => {
    const s = mineral();
    writeFileSync(path.join(s, '.claude-auth', '.claude.json'), '{not json');
    assert.equal(seed(s).ok, false);
    assert.equal(readFileSync(path.join(s, '.claude-auth', '.claude.json'), 'utf8'), '{not json');
  });
  test('no brain folder: sessions start in the state dir, and that is what gets trusted', () => {
    const s = mineral({ brain: false });
    assert.equal(folder(s), realpathSync(s));
    seed(s);
    assert.equal(cfg(s).projects[realpathSync(s)].hasTrustDialogAccepted, true);
  });
});

describe('status: the words the Phone card shows', () => {
  test('on, but no server yet: down (the supervisor retries)', () => {
    assert.equal(status(mineral()).state, 'down');
  });
  test('switched off', () => {
    const s = mineral(); off(s);
    assert.equal(status(s).state, 'off');
  });
  test('signed out', () => {
    assert.equal(status(mineral({ signedIn: false })).state, 'signed_out');
  });
  test('running, not yet connected: starting; connected once the log says so', () => {
    const s = mineral();
    const pid = fakeServer(s);
    writeLog(s, 'Remote Control is launching\n');
    assert.equal(status(s).state, 'starting');
    writeLog(s, '\x1b[32m·✔︎· Connected · brain · main\x1b[0m\n    Capacity: 1/4\n');
    assert.equal(status(s).state, 'connected');
    process.kill(-pid, 'SIGKILL');
  });
  test('a first-run question coming back is an error, never "starting" forever', () => {
    const s = mineral();
    writeLog(s, 'Error: Workspace not trusted. Please run `claude` in /state/brain first to review and accept the workspace trust dialog.\n');
    const st = status(s);
    assert.equal(st.state, 'error');
    assert.match(st.detail, /Workspace not trusted/);
    assert.match(readLog(mineral()).error ?? '', /^$/);
  });
  test('the enable question coming back is an error too', () => {
    const s = mineral();
    writeLog(s, 'Take this session with you\nEnable Remote Control? (y/n) \n');
    assert.equal(status(s).state, 'error');
  });
});

describe('off and stop take the phone sessions down with the server', () => {
  test('off writes the marker and kills the whole process group', () => {
    const s = mineral();
    const pid = fakeServer(s);
    assert.equal(alive(pid), true);
    const r = off(s);
    assert.equal(r.stopped, true);
    assert.ok(existsSync(path.join(s, ...DISABLED_MARKER)));
    assert.equal(existsSync(path.join(s, ...PID_FILE)), false);
    for (let i = 0; i < 50 && alive(pid); i++) execFileSync('sleep', ['0.05']);
    assert.equal(alive(pid), false);
  });
  test('stop does not write the marker', () => {
    const s = mineral();
    fakeServer(s);
    stop(s);
    assert.equal(isEnabled(s), true);
  });
});

describe('the name on the phone', () => {
  test('box-name first, then the profile, then a plain fallback; nothing odd survives', () => {
    const s = mineral();
    assert.equal(assistantName(s), 'Crads assistant');
    writeFileSync(path.join(s, 'profile.yaml'), 'identity:\n  assistant_name: "Wren"\n');
    assert.equal(assistantName(s), 'Wren');
    writeFileSync(path.join(s, 'box-name'), 'Robin$(rm -rf /)\n');
    assert.equal(assistantName(s), 'Robinrm -rf');
  });
});

describe('start-comms launches it with no Telegram, once, and stops it when switched off', () => {
  // A fake `claude` on PATH records how it was started, prints the line the real
  // server prints, and waits like the real one, keeping a `remote-control` argv
  // so the cmdline check sees what it would see on a mineral.
  function withFakeClaude() {
    const bin = tmpDir('rc-bin-');
    const rec = path.join(bin, 'calls.log');
    writeFileSync(path.join(bin, 'claude'),
      `#!/usr/bin/env bash\necho "$PWD|$*" >> "${rec}"\necho "·✔︎· Connected · brain"\nexec -a "claude remote-control" sleep 60\n`);
    chmodSync(path.join(bin, 'claude'), 0o755);
    return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, rec };
  }
  const run = (s, env) => execFileSync('bash', [path.join(ENGINE, 'start-comms.sh'), s], { env, encoding: 'utf8' });
  const waitFor = (fn) => { for (let i = 0; i < 60 && !fn(); i++) execFileSync('sleep', ['0.05']); return fn(); };

  test('launch, no double launch, then off stops it', () => {
    const s = mineral();
    writeFileSync(path.join(s, 'box-name'), 'Wren\n');
    const { env, rec } = withFakeClaude();
    run(s, env);
    assert.ok(waitFor(() => existsSync(rec)), 'claude was launched with no Telegram connected');
    const [cwd, args] = readFileSync(rec, 'utf8').trim().split('|');
    assert.equal(realpathSync(cwd), realpathSync(path.join(s, 'brain')), 'sessions start in the brain root');
    assert.match(args, /^remote-control --name Wren --spawn same-dir --capacity 4$/);
    assert.equal(cfg(s).remoteDialogSeen, true, 'seeded before the launch');
    const pid = parseInt(readFileSync(path.join(s, ...PID_FILE), 'utf8'), 10);
    assert.ok(waitFor(() => status(s).state === 'connected'));
    run(s, env);
    assert.equal(readFileSync(rec, 'utf8').trim().split('\n').length, 1, 'a live server is not launched twice');
    off(s);
    run(s, env);
    assert.ok(waitFor(() => !alive(pid)));
    assert.equal(readFileSync(rec, 'utf8').trim().split('\n').length, 1, 'switched off: not relaunched');
  });

  test('signed out: start-comms stops a running server instead of leaving it stuck', () => {
    const s = mineral();
    const { env } = withFakeClaude();
    run(s, env);
    assert.ok(waitFor(() => existsSync(path.join(s, ...PID_FILE))));
    const pid = parseInt(readFileSync(path.join(s, ...PID_FILE), 'utf8'), 10);
    assert.ok(waitFor(() => alive(pid)));
    execFileSync('rm', ['-f', path.join(s, '.claude-auth', '.credentials.json')]);
    run(s, env);
    assert.ok(waitFor(() => !alive(pid)));
    assert.equal(isEnabled(s), true, 'signing out is not switching it off');
  });
});

describe('a stale pidfile naming an unrelated process', () => {
  // Found in the 2026-10-15 live cert: the pidfile is on /state and survives a
  // container restart, where pid numbers start over.
  test('is not "running" when no server exists: status says down', () => {
    const s = mineral();
    const other = parseInt(execFileSync('bash', ['-c', 'setsid sleep 60 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }), 10);
    writeFileSync(path.join(s, ...PID_FILE), String(other));
    writeLog(s, '·✔︎· Connected · brain\n');
    assert.equal(status(s).state, 'down', 'a live but unrelated pid is not the server');
    stop(s);
    assert.equal(alive(other), true, 'stop never signals a process that is not ours');
    process.kill(-other, 'SIGKILL');
  });
});

describe('a server the pidfile lost is adopted, not duplicated', () => {
  // Same live cert: with the pidfile wrong and the real server alive, a relaunch
  // was refused by Claude Code ("already served by a terminal claude
  // remote-control") and the card read "needs a look".
  test("a server running in THIS mineral's folder is found and its pid written back", () => {
    const s = mineral();
    const dir = realpathSync(path.join(s, 'brain'));
    const pid = parseInt(execFileSync('bash', ['-c', `cd '${dir}' && (setsid bash -c "exec -a \\"claude remote-control\\" sleep 60" >/dev/null 2>&1 & echo $!)`], { encoding: 'utf8' }), 10);
    for (let i = 0; i < 60; i++) {
      try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').startsWith('claude remote-control')) break; } catch { /* not yet */ }
      execFileSync('sleep', ['0.02']);
    }
    writeFileSync(path.join(s, ...PID_FILE), '1');   // stale: names some other process
    writeLog(s, '·✔︎· Connected · brain\n');
    assert.equal(status(s).state, 'connected');
    assert.equal(readFileSync(path.join(s, ...PID_FILE), 'utf8'), String(pid), 'adopted');
    assert.equal(spawnSync('node', [SCRIPT, s, 'alive']).status, 0);
    // and a log overwritten by the refused duplicate does not turn it into "needs a look"
    writeLog(s, 'Error: This folder is already served by a terminal `claude remote-control` on this device. Stop it first.\n');
    assert.equal(status(s).state, 'connected');
    process.kill(-pid, 'SIGKILL');
  });
  test("a server in another folder is never adopted", () => {
    const other = mineral();
    const dir = realpathSync(path.join(other, 'brain'));
    const pid = parseInt(execFileSync('bash', ['-c', `cd '${dir}' && (setsid bash -c "exec -a \\"claude remote-control\\" sleep 60" >/dev/null 2>&1 & echo $!)`], { encoding: 'utf8' }), 10);
    execFileSync('sleep', ['0.2']);
    const s = mineral();
    assert.equal(status(s).state, 'down');
    assert.equal(spawnSync('node', [SCRIPT, s, 'alive']).status, 1);
    process.kill(-pid, 'SIGKILL');
  });
});
