// local-bridge.test.mjs: the no-server face's transport (2026-09-11).
//   node --test wizard/panel/local-bridge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { localBridge, shellFor, composeBridge } from './local-bridge.mjs';
import { LOCAL_MARK } from './local-verbs.mjs';

const run = (bridge, host, cmd, o = {}) => new Promise((resolve) => {
  const out = [], err = [];
  const h = bridge.stream(host, cmd, { ...o, onStdout: (l) => out.push(l), onStderr: (l) => err.push(l) });
  h.on('error', (e) => resolve({ code: -1, out, err: [...err, String(e.message || e)] }));
  h.on('close', (code) => resolve({ code, out, err }));
});

const brain = () => { const d = join(tmpDir('lb-'), 'brain'); mkdirSync(join(d, 'wiki'), { recursive: true }); return d; };

test('the shell choice is explicit per platform: bash -lc, or cmd.exe /d /s /c on Windows', () => {
  const nix = shellFor('linux');
  assert.equal(nix.exe, 'bash');
  assert.deepEqual(nix.args('echo hi'), ['-lc', 'echo hi']);
  assert.equal(shellFor('darwin').exe, 'bash');
  const win = shellFor('win32');
  assert.match(win.exe, /cmd(\.exe)?$/i);
  assert.deepEqual(win.args('whoami'), ['/d', '/s', '/c', 'whoami']);
});

test('a shell command runs with cwd = the brain folder, line-framed, stdin honoured, close carries the exit code', async () => {
  const d = brain();
  const bridge = localBridge({ targets: () => [{ host: 'me-local', org: 'me', kind: 'local', path: d }] });
  const r = await run(bridge, 'me-local', 'pwd; printf "a\\r\\nb"; cat; exit 3', { stdin: '\nfrom-stdin' });
  assert.equal(r.code, 3);
  assert.equal(r.out[0], d, 'cwd is the folder');
  assert.deepEqual(r.out.slice(1), ['a', 'b', 'from-stdin'], 'CRLF stripped, tail flushed, stdin delivered');
});

test('a host that is not a registered brain is refused in words, not dialled', async () => {
  const bridge = localBridge({ targets: () => [] });
  const r = await run(bridge, 'ghost-local', 'echo never');
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, []);
  assert.match(r.err.join('\n'), /no local brain called ghost-local/);
});

test('hardTimeoutMs kills a runaway command and says so', async () => {
  const d = brain();
  const bridge = localBridge({ targets: () => [{ host: 'me-local', org: 'me', kind: 'local', path: d }] });
  const t0 = Date.now();
  const r = await run(bridge, 'me-local', 'sleep 20', { hardTimeoutMs: 300 });
  assert.ok(Date.now() - t0 < 5000, 'did not wait for the sleep');
  assert.notEqual(r.code, 0);
  assert.match(r.err.join('\n'), /exceeded 300ms/);
});

test('a __local__ marker runs in-process and never reaches a shell', async () => {
  const d = brain();
  writeFileSync(join(d, 'wiki', 'hello.md'), '# Hello\n');
  const bridge = localBridge({ targets: () => [{ host: 'me-local', org: 'me', kind: 'local', path: d }] });
  const r = await run(bridge, 'me-local', LOCAL_MARK + JSON.stringify({ verb: 'brain-list', args: {} }));
  assert.equal(r.code, 0);
  assert.deepEqual(r.out, ['hello.md']);
  const bad = await run(bridge, 'me-local', LOCAL_MARK + 'not json');
  assert.equal(bad.code, 1);
  assert.match(bad.err.join('\n'), /unreadable local verb/);
  const unknown = await run(bridge, 'me-local', LOCAL_MARK + JSON.stringify({ verb: 'telegram-link', args: {} }));
  assert.equal(unknown.code, 1, 'a verb outside the table is refused even through the marker');
});

test('the bridge has NO tty: a terminal on your own computer is your own terminal', () => {
  const bridge = localBridge({ targets: () => [] });
  assert.equal(bridge.tty, undefined);
});

test('composeBridge routes by host: local targets stream locally, the rest over the ssh bridge, tty is ssh-only', async () => {
  const d = brain();
  const sshCalls = [];
  const ssh = {
    targets: () => [{ host: 'acme-box', org: 'acme', kind: 'member' }],
    stream: (host, cmd, o = {}) => { sshCalls.push([host, cmd]); const { EventEmitter } = process.getBuiltinModule('node:events'); const ee = new EventEmitter(); setImmediate(() => { o.onStdout('ssh-ran'); ee.emit('close', 0); }); return ee; },
    tty: () => 'a-tty',
  };
  const local = localBridge({ targets: () => [{ host: 'me-local', org: 'me', kind: 'local', path: d }] });
  const both = composeBridge({ ssh, local });
  assert.deepEqual(both.targets().map((t) => t.host), ['acme-box', 'me-local']);
  const a = await run(both, 'acme-box', 'whoami');
  assert.deepEqual(a.out, ['ssh-ran']);
  const b = await run(both, 'me-local', 'echo local');
  assert.deepEqual(b.out, ['local']);
  assert.deepEqual(sshCalls, [['acme-box', 'whoami']], 'the local command never touched ssh');
  assert.equal(both.tty('acme-box'), 'a-tty');
});
