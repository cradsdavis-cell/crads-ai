// updater-handoff.test.mjs
//
// The update path is the one place in this app that can leave a member with NOTHING:
// it deletes the running version's file, starts a different binary, and exits. Every
// test here is about that. The success case is easy; the cases worth pinning are the
// ones where the new version does not come up, because the old behaviour ("spawn and
// exit 400ms later") had no way to even notice, let alone recover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { applyUpdate } from './updater.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const BIG = Buffer.alloc(11 * 1024 * 1024, 7);   // clears the implausibly-small rail

function rig({ newInstanceComesUp, publishesUrl = 'http://127.0.0.1:59999/' }) {
  const dir = tmpDir('handoff-');
  const target = join(dir, 'Crads-AI.exe');
  const runFile = join(dir, 'app.json');
  writeFileSync(target, Buffer.from('OLD VERSION'));
  writeFileSync(runFile, JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:50001/', door: 'd' }));
  const exits = [];
  const spawned = [];
  return {
    dir, target, runFile, exits, spawned,
    opts: {
      target, runFile, force: true, exitDelayMs: 0, pollMs: 1, handoffTimeoutMs: 60,
      exeUrl: 'http://example/x.exe',
      fetch: async (url) => {
        if (url === 'http://example/x.exe') return { ok: true, arrayBuffer: async () => BIG };
        // the probe of the new instance's url
        if (!newInstanceComesUp) throw new Error('ECONNREFUSED');
        return { status: 200 };
      },
      spawn: (cmd, args, o) => {
        spawned.push({ cmd, env: o && o.env });
        // A real new instance boots and writes its own run file. Model both worlds.
        if (newInstanceComesUp) writeFileSync(runFile, JSON.stringify({ pid: process.pid + 1, url: publishesUrl }));
        return { pid: 999999, unref() {} };
      },
      spawnSync: () => ({}),
      exit: (c) => exits.push(c),
      retireOthers: false,
    },
  };
}

test('the new instance is started WITHOUT a window, which is what makes it a handoff', async () => {
  const r = rig({ newInstanceComesUp: true });
  try {
    await applyUpdate({ ...r.opts });
    assert.equal(r.spawned.length, 1);
    assert.equal(r.spawned[0].env.AIOS_NO_LAUNCH, '1',
      'without this the newcomer opens its own window and you get two');
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('success: reports the new url, then exits', async () => {
  const r = rig({ newInstanceComesUp: true, publishesUrl: 'http://127.0.0.1:51234/' });
  const seen = [];
  try {
    const out = await applyUpdate({ ...r.opts, onState: (s) => seen.push(s) });
    assert.equal(out.url, 'http://127.0.0.1:51234/');
    // Every LEG is announced, and the two long ones are announced BEFORE they
    // run (2026-08-24). This used to be ['starting','ready'], both emitted after
    // the download and the swap were already done, so a watcher saw total
    // silence through the slowest part and could not tell a working download
    // from a dead process except by timing out. The page's deadline is now a
    // no-progress budget that these phases keep resetting, so the ORDER here is
    // the contract, not decoration.
    assert.deepEqual(seen.map((s) => s.phase), ['downloading', 'installing', 'starting', 'ready']);
    assert.equal(seen[seen.length - 1].url, 'http://127.0.0.1:51234/');
    // The exit is DEFERRED on purpose: applyUpdate returns as soon as the new url is
    // known, so /update-handoff can answer 'ready' while this process is still up long
    // enough for the page to navigate off it. Exiting synchronously here would race
    // the very handoff we just waited for, so the test has to wait for the timer too.
    assert.deepEqual(r.exits, [], 'must not have exited the instant it returned');
    await new Promise((res) => setTimeout(res, 10));
    assert.deepEqual(r.exits, [0], 'the old process must exit once the page has somewhere to go');
    assert.equal(readFileSync(r.target, 'utf8').length, BIG.length, 'new version is in place');
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('failure: the OLD exe is put back', async () => {
  const r = rig({ newInstanceComesUp: false });
  try {
    const out = await applyUpdate({ ...r.opts });
    assert.equal(out.rolledBack, true);
    assert.equal(readFileSync(r.target, 'utf8'), 'OLD VERSION',
      'a member left with a broken binary is worse off than one who never updated');
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('failure: this process does NOT exit, so the member keeps a working app', async () => {
  const r = rig({ newInstanceComesUp: false });
  try {
    await applyUpdate({ ...r.opts });
    assert.deepEqual(r.exits, [], 'exiting here is precisely how you end up with no app at all');
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('failure: the run file is restored, so the next launch can still find us', async () => {
  const r = rig({ newInstanceComesUp: false });
  try {
    await applyUpdate({ ...r.opts });
    const back = JSON.parse(readFileSync(r.runFile, 'utf8'));
    assert.equal(back.pid, process.pid);
    assert.equal(back.url, 'http://127.0.0.1:50001/');
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('failure: the banner is told, in words, and told it is safe', async () => {
  const r = rig({ newInstanceComesUp: false });
  const seen = [];
  try {
    await applyUpdate({ ...r.opts, onState: (s) => seen.push(s) });
    const last = seen[seen.length - 1];
    assert.equal(last.phase, 'failed');
    assert.match(last.reason, /did not start/);
    assert.match(last.reason, /put back/);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('failure leaves no half-swapped debris behind', async () => {
  const r = rig({ newInstanceComesUp: false });
  try {
    await applyUpdate({ ...r.opts });
    assert.equal(existsSync(r.target + '.new'), false, 'a stranded .new is an 88MB orphan');
    assert.equal(existsSync(r.target + '.failed'), false);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('a download that never arrives changes nothing at all', async () => {
  const r = rig({ newInstanceComesUp: true });
  try {
    await assert.rejects(
      applyUpdate({ ...r.opts, fetch: async () => ({ ok: false, status: 503 }) }),
      /download failed/);
    assert.equal(readFileSync(r.target, 'utf8'), 'OLD VERSION');
    assert.equal(r.spawned.length, 0, 'nothing should have been started');
    assert.deepEqual(r.exits, []);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

// ---- every failure names itself (2026-08-24) --------------------------------
// The bug this pins cost a real incident five rounds of guesswork. Before today
// ONLY the "new version did not come up" path reported a reason; every other
// throw (download refused, file locked, nothing installed) went to console.error
// inside a process the Windows launcher runs with no console, so the reason was
// destroyed as it was produced and the page could only say "could not be
// started". A failure that cannot say why is the thing being fixed, so the
// REASON reaching the banner is the contract, not the throw.
test('a refused download tells the banner WHY, not just that it failed', async () => {
  const r = rig({ newInstanceComesUp: true });
  const seen = [];
  try {
    await assert.rejects(applyUpdate({
      ...r.opts,
      fetch: async () => ({ ok: false, status: 403 }),
      onState: (s) => seen.push(s),
    }));
    const failed = seen.filter((s) => s.phase === 'failed');
    assert.equal(failed.length, 1, 'exactly one failure report');
    assert.match(failed[0].reason, /download failed \(403\)/, 'the banner gets the real reason');
    assert.deepEqual(seen.map((s) => s.phase), ['downloading', 'failed'],
      'it announced the download, then named the failure: no silent gap');
    assert.equal(readFileSync(r.target, 'utf8'), 'OLD VERSION', 'and nothing was touched');
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('a blocked file write is reported too, with the OS error carried through', async () => {
  const r = rig({ newInstanceComesUp: true });
  const seen = [];
  try {
    // the shape of the Windows failure we could never see: the swap is refused
    await assert.rejects(applyUpdate({
      ...r.opts,
      target: join(r.dir, 'no-such-dir', 'Crads-AI.exe'),
      onState: (s) => seen.push(s),
    }));
    const failed = seen.filter((s) => s.phase === 'failed');
    assert.equal(failed.length, 1);
    assert.ok(failed[0].reason && failed[0].reason.length > 0, 'a reason, never an empty shrug');
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});
