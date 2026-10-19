// build-box.test.mjs: finishing a build the app stopped watching (adopt
// rehearsal T4, finding 9). Fakes only: no ssh, no real ~/.ssh, no server.
//   node --test wizard/panel/build-box.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { repairUnfinished, scheduleRepair } from './build-box.mjs';
import { provisionRoutes } from './provision-routes.mjs';

function scratch({ hosts = {}, records = {} } = {}) {
  const sshDir = tmpDir('bbrepair-');
  mkdirSync(sshDir, { recursive: true });
  const cfg = Object.entries(hosts).map(([alias, ip]) => `Host ${alias}\n  HostName ${ip}\n  User member\n`).join('\n');
  writeFileSync(join(sshDir, 'config'), cfg);
  for (const [slug, state] of Object.entries(records)) {
    writeFileSync(join(sshDir, `${slug}-box.provision.json`), JSON.stringify(state));
  }
  const rec = (slug) => JSON.parse(readFileSync(join(sshDir, `${slug}-box.provision.json`), 'utf8'));
  return { sshDir, rec };
}

function fakeDeps(sshDir, over = {}) {
  const calls = { probe: [], pin: [], register: [], open: [], sync: [] };
  const loadState = (slug) => { try { return JSON.parse(readFileSync(join(sshDir, `${slug}-box.provision.json`), 'utf8')); } catch { return {}; } };
  const saveState = (slug, s) => writeFileSync(join(sshDir, `${slug}-box.provision.json`), JSON.stringify(s));
  const deps = {
    sshDir,
    settingsPath: join(sshDir, 'claude-settings.json'),
    probe: async (alias) => { calls.probe.push(alias); return { code: 0, stdout: 'chain-ok\n' }; },
    pin: (ip, o) => calls.pin.push([ip, o.sshDir]),
    register: (entry) => calls.register.push(entry),
    openFolder: async (alias) => { calls.open.push(alias); return { code: 0, stdout: '/state/ana\n' }; },
    syncStartDir: (alias, out) => calls.sync.push([alias, out]),
    loadState, saveState,
    ...over,
  };
  return { deps, calls };
}

test('an unbooted record whose mineral now answers is pinned, registered, start-dir synced, then marked booted', async () => {
  const { sshDir, rec } = scratch({ hosts: { 'ana-box': '203.0.113.9' }, records: { ana: { provider: 'hetzner', serverId: 1, serverIp: '203.0.113.9' } } });
  const { deps, calls } = fakeDeps(sshDir);
  const r = await repairUnfinished(deps);
  assert.deepEqual(r, { repaired: ['ana-box'], waiting: [] });
  assert.deepEqual(calls.pin, [['203.0.113.9', sshDir]], 'pinned at the address the alias dials');
  assert.deepEqual(calls.register, [{ id: 'ana-box', name: 'ana', sshHost: 'ana-box', startDirectory: '/state' }]);
  assert.deepEqual(calls.sync, [['ana-box', '/state/ana\n']]);
  const s = rec('ana');
  assert.equal(s.booted, true);
  assert.equal(s.serverId, 1, 'the rest of the engine record is kept');
});

test('idempotent: a booted record is never probed or touched', async () => {
  const { sshDir } = scratch({ hosts: { 'ana-box': '203.0.113.9' }, records: { ana: { serverId: 1, booted: true } } });
  const { deps, calls } = fakeDeps(sshDir);
  const before = readFileSync(join(sshDir, 'ana-box.provision.json'), 'utf8');
  const r = await repairUnfinished(deps);
  assert.deepEqual(r, { repaired: [], waiting: [] });
  assert.equal(calls.probe.length + calls.pin.length + calls.register.length, 0);
  assert.equal(readFileSync(join(sshDir, 'ana-box.provision.json'), 'utf8'), before);
  // and a second pass after a repair is a no-op too
  const two = scratch({ hosts: { 'bo-box': '198.51.100.4' }, records: { bo: { serverId: 2 } } });
  const d2 = fakeDeps(two.sshDir);
  await repairUnfinished(d2.deps);
  await repairUnfinished(d2.deps);
  assert.equal(d2.calls.pin.length, 1, 'repaired once, then left alone');
});

test('a mineral still booting is left unmarked and reported as waiting', async () => {
  const { sshDir, rec } = scratch({ hosts: { 'ana-box': '203.0.113.9' }, records: { ana: { serverId: 1 } } });
  const { deps, calls } = fakeDeps(sshDir, { probe: async () => ({ code: 255, stdout: '', stderr: 'Connection refused' }) });
  const r = await repairUnfinished(deps);
  assert.deepEqual(r, { repaired: [], waiting: ['ana-box'] });
  assert.equal(calls.pin.length, 0, 'nothing is pinned before a verified connect (trap 3)');
  assert.equal(calls.register.length, 0);
  assert.equal(rec('ana').booted, undefined);
});

test('no address to dial (forgotten Host block, or the pre-birth placeholder): skipped, no probe', async () => {
  const { sshDir } = scratch({ hosts: { 'bo-box': '0.0.0.0' }, records: { ana: { serverId: 1 }, bo: { serverId: 2 } } });
  const { deps, calls } = fakeDeps(sshDir);
  const r = await repairUnfinished(deps);
  assert.deepEqual(r, { repaired: [], waiting: [] });
  assert.equal(calls.probe.length, 0);
});

test('best-effort: a throwing probe, a refusing register or a broken record never throws', async () => {
  const { sshDir, rec } = scratch({ hosts: { 'ana-box': '203.0.113.9', 'bo-box': '198.51.100.4' }, records: { ana: { serverId: 1 }, bo: { serverId: 2 } } });
  writeFileSync(join(sshDir, 'cy-box.provision.json'), '{not json');
  const { deps } = fakeDeps(sshDir, {
    probe: async (alias) => { if (alias === 'ana-box') throw new Error('spawn ssh ENOENT'); return { code: 0, stdout: 'chain-ok' }; },
    register: () => { throw new Error('settings refused'); },
  });
  const r = await repairUnfinished(deps);
  assert.deepEqual(r.repaired, ['bo-box'], 'a settings refusal does not undo the repair (same as a build)');
  assert.deepEqual(r.waiting, ['ana-box']);
  assert.equal(rec('bo').booted, true);
  // no ssh dir at all
  assert.deepEqual(await repairUnfinished({ ...deps, sshDir: join(sshDir, 'nope') }), { repaired: [], waiting: [] });
});

test('a slug a live build owns is left to that build', async () => {
  const { sshDir, rec } = scratch({ hosts: { 'ana-box': '203.0.113.9' }, records: { ana: { serverId: 1 } } });
  const { deps, calls } = fakeDeps(sshDir, { busy: (slug) => slug === 'ana' });
  await repairUnfinished(deps);
  assert.equal(calls.probe.length, 0);
  assert.equal(rec('ana').booted, undefined);
});

test('provisionRoutes exposes the repair over its own record (the one writer)', async () => {
  const { sshDir, rec } = scratch({ hosts: { 'ana-box': '203.0.113.9' }, records: { ana: { serverId: 1 } } });
  const pins = [];
  const handle = provisionRoutes({
    sshDir,
    settingsPath: join(sshDir, 'claude-settings.json'),
    probe: async () => ({ code: 0, stdout: 'chain-ok\n' }),
    pin: (ip) => pins.push(ip),
    register: () => {},
    syncStartDir: () => {},
    openFolder: async () => ({ code: 1 }),
  });
  const r = await handle.repairUnbooted();
  assert.deepEqual(r.repaired, ['ana-box']);
  assert.deepEqual(pins, ['203.0.113.9']);
  assert.equal(rec('ana').booted, true);
});

test('scheduleRepair: first run delayed, re-asks only while something is waiting, stops at the deadline', async () => {
  let t = 0;
  const timers = [];
  const setTimer = (fn, ms) => { const h = { fn, ms, unref() { h.unrefd = true; } }; timers.push(h); return h; };
  const answers = [{ repaired: [], waiting: ['ana-box'] }, { repaired: [], waiting: ['ana-box'] }, { repaired: ['ana-box'], waiting: [] }];
  let runs = 0;
  scheduleRepair(async () => answers[runs++], { firstMs: 8000, everyMs: 100, forMs: 1000, setTimer, now: () => t });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 8000);
  assert.equal(timers[0].unrefd, true, 'never holds the app open');
  await timers[0].fn();
  assert.equal(timers.length, 2, 'waiting: asks again');
  assert.equal(timers[1].ms, 100);
  await timers[1].fn();
  await timers[2].fn();
  assert.equal(runs, 3);
  assert.equal(timers.length, 3, 'nothing waiting: done');

  // deadline: a mineral that never answers stops being asked about
  const timers2 = [];
  let t2 = 0;
  scheduleRepair(async () => ({ repaired: [], waiting: ['x-box'] }), {
    firstMs: 1, everyMs: 400, forMs: 1000, now: () => t2,
    setTimer: (fn, ms) => { timers2.push({ fn, ms }); return null; },
  });
  for (let i = 0; i < 10 && i < timers2.length; i++) { t2 += timers2[i].ms; await timers2[i].fn(); }
  assert.ok(timers2.length <= 4, `bounded by forMs (${timers2.length} timers)`);

  // a throwing repair counts as nothing waiting
  const timers3 = [];
  scheduleRepair(async () => { throw new Error('boom'); }, { setTimer: (fn, ms) => { timers3.push({ fn, ms }); return null; } });
  await timers3[0].fn();
  assert.equal(timers3.length, 1);
});
