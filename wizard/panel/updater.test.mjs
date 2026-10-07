// updater.test.mjs: self-update check + swap dance (no network, no relaunch).
//   node --test wizard/panel/updater.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { checkForUpdate, applyUpdate, getBuildInfo, macInstalledTarget, macRelaunch, MAC_RESTART_EXIT } from './updater.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const okJson = (obj) => Promise.resolve({ ok: true, json: () => Promise.resolve(obj) });

test('checkForUpdate: same sha no update, new sha update, offline silent, dev silent', async () => {
  const cur = { sha: 'aaa', built_at: 'x' };
  assert.equal((await checkForUpdate(cur, { fetch: () => okJson({ sha: 'aaa' }) })).available, false);
  const up = await checkForUpdate(cur, { fetch: () => okJson({ sha: 'bbb' }) });
  assert.equal(up.available, true);
  assert.equal(up.latest.sha, 'bbb');
  assert.equal((await checkForUpdate(cur, { fetch: () => Promise.reject(new Error('nope')) })).available, false);
  assert.equal((await checkForUpdate(null, { fetch: () => okJson({ sha: 'bbb' }) })).available, false);
});

test('getBuildInfo: env override for dev/tests, null without SEA', () => {
  process.env.AIOS_BUILD_INFO = '{"sha":"envsha"}';
  assert.equal(getBuildInfo(null).sha, 'envsha');
  delete process.env.AIOS_BUILD_INFO;
  assert.equal(getBuildInfo(null), null);
});

test('applyUpdate: swap dance replaces target, keeps .old, no relaunch', async () => {
  const dir = tmpDir('upd-');
  const target = join(dir, 'Crads-AI.exe');
  writeFileSync(target, 'OLD BINARY');
  const fresh = Buffer.from('NEW BINARY');
  const r = await applyUpdate({
    target, force: true, relaunch: false,
    fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(fresh.buffer.slice(fresh.byteOffset, fresh.byteOffset + fresh.byteLength)) }),
  });
  assert.equal(r.target, target);
  assert.equal(readFileSync(target, 'utf8'), 'NEW BINARY');
  assert.equal(readFileSync(target + '.old', 'utf8'), 'OLD BINARY');
  assert.ok(!existsSync(target + '.new'));
});

test('applyUpdate: refuses a failed download, target untouched', async () => {
  const dir = tmpDir('upd-');
  const target = join(dir, 'Crads-AI.exe');
  writeFileSync(target, 'KEEP ME');
  await assert.rejects(
    () => applyUpdate({ target, force: true, relaunch: false, fetch: () => Promise.resolve({ ok: false, status: 503 }) }),
    /download failed/);
  assert.equal(readFileSync(target, 'utf8'), 'KEEP ME');
});

test('applyUpdate: relaunch deletes the run file BEFORE spawning (2026-07-23 race fix)', async () => {
  const dir = tmpDir('upd-');
  const target = join(dir, 'Crads-AI.exe');
  const runFile = join(dir, 'app.json');
  writeFileSync(target, 'OLD BINARY');
  writeFileSync(runFile, '{"pid":1,"url":"http://127.0.0.1:1/"}');
  const events = [];
  const fresh = Buffer.from('NEW BINARY');
  // Since the 2026-07-30 handoff, the exit is no longer unconditional: this process
  // waits for the replacement to publish a url and answer on it, and does NOT exit if
  // it never does (it rolls back instead, see updater-handoff.test.mjs). So the fake
  // spawn has to behave like a real newcomer, or this test would be asserting the
  // rollback path while claiming to test the run-file ordering.
  await applyUpdate({
    target, force: true, runFile,
    pollMs: 1, handoffTimeoutMs: 500, exitDelayMs: 0,
    fetch: (url) => (String(url).startsWith('http://127.0.0.1')
      ? Promise.resolve({ status: 200 })                        // the handoff probe
      : Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(fresh.buffer.slice(fresh.byteOffset, fresh.byteOffset + fresh.byteLength)) })),
    spawn: () => {
      events.push({ what: 'spawn', runFileGone: !existsSync(runFile) });
      writeFileSync(runFile, JSON.stringify({ pid: process.pid + 1, url: 'http://127.0.0.1:2/' }));
      return { unref: () => {} };
    },
    exit: () => events.push({ what: 'exit' }),
  });
  assert.equal(events[0].what, 'spawn');
  assert.equal(events[0].runFileGone, true, 'run file must be gone before the replacement boots, or it probes the dying instance and exits');
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(events[1], { what: 'exit' });
});

test('macInstalledTarget: updates the running copy in either Applications folder, else ~/Applications', () => {
  const home = '/Users/pat';
  const exe = (bundle) => `${bundle}/Contents/MacOS/crads-ai`;
  // Dragged into /Applications: the copy that runs is the copy to update (the 2026-09-29 bug).
  assert.equal(macInstalledTarget({ execPath: exe('/Applications/Crads-AI.app'), home }), '/Applications/Crads-AI.app');
  assert.equal(macInstalledTarget({ execPath: exe('/Users/pat/Applications/Crads-AI.app'), home }), '/Users/pat/Applications/Crads-AI.app');
  // A renamed bundle still updates in place.
  assert.equal(macInstalledTarget({ execPath: exe('/Applications/Crads-AI 2.app'), home }), '/Applications/Crads-AI 2.app');
  // Downloads / translocated quarantine path / dev binary: selfInstall's ~/Applications copy.
  assert.equal(macInstalledTarget({ execPath: exe('/Users/pat/Downloads/Crads-AI.app'), home }), '/Users/pat/Applications/Crads-AI.app');
  assert.equal(macInstalledTarget({ execPath: exe('/private/var/folders/xy/T/AppTranslocation/ABC/d/Crads-AI.app'), home }), '/Users/pat/Applications/Crads-AI.app');
  assert.equal(macInstalledTarget({ execPath: '/usr/local/bin/node', home }), '/Users/pat/Applications/Crads-AI.app');
  // A lookalike folder name is not /Applications.
  assert.equal(macInstalledTarget({ execPath: exe('/ApplicationsX/Crads-AI.app'), home }), '/Users/pat/Applications/Crads-AI.app');
});

test('applyUpdate (mac): a read-only Applications folder refuses in plain words, before any download', async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root ignores folder permissions');
  const dir = tmpDir('upd-mac-ro-');
  const target = join(dir, 'Crads-AI.app');
  mkdirSync(join(target, 'Contents', 'MacOS'), { recursive: true });
  chmodSync(dir, 0o555);
  let fetched = false;
  const states = [];
  try {
    await assert.rejects(
      () => applyUpdate({ platform: 'darwin', target, relaunch: false, onState: (s) => states.push(s),
        fetch: () => { fetched = true; return Promise.resolve({ ok: false, status: 500 }); } }),
      /can't change .*Applications folder in your home folder/);
  } finally { chmodSync(dir, 0o755); }
  assert.equal(fetched, false);
  assert.equal(states.at(-1).phase, 'failed');
  assert.ok(existsSync(join(target, 'Contents', 'MacOS')), 'running copy untouched');
});

test('applyUpdate (mac): no bundle at the target still names itself', async () => {
  const dir = tmpDir('upd-mac-none-');
  await assert.rejects(
    () => applyUpdate({ platform: 'darwin', target: join(dir, 'Crads-AI.app'), relaunch: false, fetch: () => { throw new Error('should not fetch'); } }),
    /no installed copy to update/);
});

test('mac relaunch under the window host: no `open`, exit with the restart code for the host', async () => {
  const dir = tmpDir('upd-mac-host-');
  const runFile = join(dir, 'app.json');
  writeFileSync(runFile, '{"pid":1,"url":"http://127.0.0.1:1/"}');
  const spawned = [];
  const r = await new Promise((resolve) => {
    const out = macRelaunch({ target: '/Users/pat/Applications/Crads-AI.app', hosted: true, runFile, delayMs: 0,
      spawn: (...a) => { spawned.push(a); return {}; }, exit: (code) => resolve({ out, code }) });
  });
  assert.equal(r.out.relaunch, 'host');
  assert.equal(r.code, MAC_RESTART_EXIT);
  assert.equal(MAC_RESTART_EXIT, 75, 'the host (mac-host/main.swift) matches on 75; change both or neither');
  assert.deepEqual(spawned, [], '`open` on a running bundle id only re-activates the old host');
  assert.equal(existsSync(runFile), false, 'the run file is cleared before the new copy starts');
});

test('mac relaunch without the host: open the bundle and leave cleanly, as before', async () => {
  const dir = tmpDir('upd-mac-bare-');
  const spawned = [];
  const code = await new Promise((resolve) => {
    macRelaunch({ target: '/Applications/Crads-AI.app', runFile: join(dir, 'app.json'), delayMs: 0,
      spawn: (cmd, args) => { spawned.push([cmd, args]); return { unref() {} }; }, exit: resolve });
  });
  assert.deepEqual(spawned, [['open', ['/Applications/Crads-AI.app']]]);
  assert.equal(code, 0);
});

test('the mac host and the updater agree on the restart code', () => {
  const swift = readFileSync(new URL('../assets/mac-host/main.swift', import.meta.url), 'utf8');
  assert.match(swift, new RegExp(`let RESTART_EXIT: Int32 = ${MAC_RESTART_EXIT}\\b`));
});
