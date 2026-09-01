// updater.test.mjs: self-update check + swap dance (no network, no relaunch).
//   node --test wizard/panel/updater.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkForUpdate, applyUpdate, getBuildInfo } from './updater.mjs';
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
