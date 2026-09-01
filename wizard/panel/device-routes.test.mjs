// device-routes.test.mjs — the wizard-local device enrolment (self-host
// pivot, 2026-09-01) against injected fakes and scratch dirs. Nothing touches
// real SSH, the real ~/.ssh, or any infrastructure; the one shell that runs is
// a local `sh` against a temp directory, standing in for the box's container.
//   node --test wizard/panel/device-routes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { deviceRoutes } from './device-routes.mjs';

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF6zXyq1x2Qq0m7T3v9m4T8u5X6a7B8c9D0e1F2g3H4i owner@door';
const NEW_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHhZ9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2H1g0F new@laptop';
const HOSTKEY = '203.0.113.9 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBoxHostKeyBoxHostKeyBoxHostKeyBoxHostKeyBox';

function harness(over = {}) {
  const installs = [];
  const pins = [];
  const events = [];   // interleaved order proof: install / pin / probe
  const sshDir = tmpDir('dev-');
  const appKnownHosts = join(sshDir, 'app_known_hosts');
  const handle = deviceRoutes({
    sshDir,
    appKnownHostsPath: appKnownHosts,
    install: (o) => { installs.push({ ...o }); events.push('install:' + o.host); return { publicKey: PUB + '\n' }; },
    pin: (host, o) => { pins.push({ host, ...o }); events.push('pin:' + host); },
    probe: async () => { events.push('probe'); return { code: 0, stdout: 'chain-ok\n' }; },
    runSsh: async () => ({ code: 0, stdout: '', stderr: '' }),
    targets: () => [{ host: 'demo-box', org: 'demo', kind: 'member' }, { host: 'acme-rock', org: 'acme', kind: 'rock' }],
    sleep: async () => {},
    probeTries: 3,
    ...over,
  });
  const server = http.createServer((req, res) => { if (!handle(req, res, req.url.split('?')[0])) { res.writeHead(404); res.end(); } });
  // listen is async: the first call must WAIT for the bound port, or
  // server.address() is null and every test dies on an invalid URL.
  const ready = new Promise((r) => server.listen(0, '127.0.0.1', r));
  const call = async (method, path, body) => {
    await ready;
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  // closeAllConnections too: fetch's keep-alive sockets otherwise hold the
  // process open past the last test and the runner never exits.
  return { call, installs, pins, events, sshDir, appKnownHosts, close: () => { server.closeAllConnections?.(); server.close(); } };
}

// A stand-in for the box: run the approve command through a REAL local shell
// against a temp directory, so the idempotent-append logic is actually
// exercised rather than mimicked. The key rides opts.stdin, never the command.
function shellRunSsh(boxDir, record) {
  return async (host, cmd, opts = {}) => {
    record.push({ host, cmd, stdin: opts.stdin });
    const local = cmd.split('/state/ssh/member').join(boxDir);
    const r = spawnSync('sh', ['-c', local], { input: opts.stdin ?? '', encoding: 'utf8' });
    return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
}

test('offer: mints under the right alias, key before address, and answers one pubkey line', async (t) => {
  const h = harness(); t.after(h.close);
  const r = await h.call('POST', '/device/offer', { name: '  Demo ' });
  assert.equal(r.status, 200);
  assert.equal(r.body.alias, 'demo-box');
  assert.equal(r.body.pubkey, PUB, 'one trimmed line, exactly what the install will use');
  assert.deepEqual(h.installs, [{ slug: 'demo', host: '0.0.0.0', user: 'member' }],
    'minted with the placeholder address, the self-host wizard pattern');
});

test('offer: a bad name never reaches the installer', async (t) => {
  const h = harness(); t.after(h.close);
  for (const name of ['', 'Bad Name', 'x', '-edge', 'a'.repeat(40)]) {
    const r = await h.call('POST', '/device/offer', { name });
    assert.equal(r.status, 400, `refused: ${JSON.stringify(name)}`);
  }
  assert.equal(h.installs.length, 0);
});

test('approve: refuses garbage and injection attempts outright, never escapes them', async (t) => {
  const record = [];
  const h = harness({ runSsh: shellRunSsh(tmpDir('devbox-'), record) }); t.after(h.close);
  const bad = [
    'not a key at all',
    'ssh-rsa AAAAB3NzaC1yc2E stranger@rsa',                      // wrong type
    'ssh-ed25519 AAAA"; rm -rf / #',                             // quote + shell
    "ssh-ed25519 AAAA'; touch /tmp/pwned; '",                    // quote + shell
    'ssh-ed25519 AAAA $(reboot)',                                // substitution in comment
    NEW_KEY + '\nssh-ed25519 AAAAsecondline extra@line',         // second line
    NEW_KEY + '\ncommand="evil"',                                // embedded newline
    'ssh-ed25519 AAAA `id`',                                     // backticks
  ];
  for (const pubkey of bad) {
    const r = await h.call('POST', '/device/approve', { host: 'demo-box', pubkey });
    assert.equal(r.status, 400, `refused, not escaped: ${JSON.stringify(pubkey.slice(0, 40))}`);
  }
  assert.equal(record.length, 0, 'nothing invalid ever reaches the box');
});

test('approve: host must be a connected member identity on this machine', async (t) => {
  const h = harness(); t.after(h.close);
  assert.equal((await h.call('POST', '/device/approve', { host: 'ghost-box', pubkey: NEW_KEY })).status, 400);
  assert.equal((await h.call('POST', '/device/approve', { host: 'acme-rock', pubkey: NEW_KEY })).status, 400,
    'the append lands in the member lane, so a rock alias is refused');
});

test('approve: appends over stdin idempotently (a real shell proves the same key lands once)', async (t) => {
  const boxDir = tmpDir('devbox-');
  const record = [];
  const sshDir = tmpDir('dev-');
  writeFileSync(join(sshDir, 'config'), 'Host demo-box\n  HostName 203.0.113.9\n  User member\n');
  const h = harness({ sshDir, runSsh: shellRunSsh(boxDir, record) }); t.after(h.close);
  writeFileSync(h.appKnownHosts, HOSTKEY + '\n');

  const r1 = await h.call('POST', '/device/approve', { host: 'demo-box', pubkey: NEW_KEY + '\n' });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.ok, true);
  const r2 = await h.call('POST', '/device/approve', { host: 'demo-box', pubkey: NEW_KEY });
  assert.equal(r2.status, 200);

  const file = readFileSync(join(boxDir, 'authorized_keys'), 'utf8');
  assert.deepEqual(file.split('\n').filter(Boolean), [NEW_KEY], 'same key twice appends once');
  for (const c of record) {
    assert.ok(!c.cmd.includes(NEW_KEY), 'the key rides stdin, never the command string');
    assert.equal(c.stdin, NEW_KEY + '\n');
    assert.match(c.cmd, /grep -qxF/, 'the idempotence lives in the command itself');
    assert.match(c.cmd, />>/, 'append only, never a rewrite');
  }
});

test('approve: the bundle carries slug, address and the recorded host key; no record is said plainly', async (t) => {
  const boxDir = tmpDir('devbox-');
  const sshDir = tmpDir('dev-');
  writeFileSync(join(sshDir, 'config'), 'Host demo-box\n  HostName 203.0.113.9\n  User member\n');
  const h = harness({ sshDir, runSsh: shellRunSsh(boxDir, []) }); t.after(h.close);

  // no known_hosts entry yet: the bundle is honest about the missing pin
  const bare = await h.call('POST', '/device/approve', { host: 'demo-box', pubkey: NEW_KEY });
  assert.equal(bare.body.hostkeyIncluded, false);
  let payload = JSON.parse(Buffer.from(bare.body.bundle.replace(/^crads1:/, ''), 'base64').toString('utf8'));
  assert.deepEqual(payload, { slug: 'demo', host: '203.0.113.9' });

  writeFileSync(h.appKnownHosts, '198.51.100.7 ssh-ed25519 AAAAother\n' + HOSTKEY + '\n');
  const r = await h.call('POST', '/device/approve', { host: 'demo-box', pubkey: NEW_KEY });
  assert.equal(r.status, 200);
  assert.equal(r.body.hostkeyIncluded, true);
  assert.match(r.body.bundle, /^crads1:[A-Za-z0-9+/]+=*$/, 'one copyable versioned string');
  payload = JSON.parse(Buffer.from(r.body.bundle.replace(/^crads1:/, ''), 'base64').toString('utf8'));
  assert.deepEqual(payload, { slug: 'demo', host: '203.0.113.9', hostkey: HOSTKEY },
    'the right host key, not the first line in the file');
});

test('complete: refuses a slug mismatch instead of installing under the wrong name', async (t) => {
  const h = harness(); t.after(h.close);
  await h.call('POST', '/device/offer', { name: 'demo' });
  const bundle = 'crads1:' + Buffer.from(JSON.stringify({ slug: 'other', host: '203.0.113.9' })).toString('base64');
  const r = await h.call('POST', '/device/complete', { bundle });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /"other"/);
  assert.match(r.body.error, /"demo"/, 'names both sides of the mismatch');
  assert.equal(h.installs.length, 1, 'only the offer installed anything');
});

test('complete: refuses a bundle when this computer never made the key', async (t) => {
  const h = harness(); t.after(h.close);
  const bundle = 'crads1:' + Buffer.from(JSON.stringify({ slug: 'demo', host: '203.0.113.9' })).toString('base64');
  const r = await h.call('POST', '/device/complete', { bundle });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /first step/i);
});

test('complete: refuses malformed bundles with plain words', async (t) => {
  const h = harness(); t.after(h.close);
  await h.call('POST', '/device/offer', { name: 'demo' });
  for (const bundle of ['', 'nonsense', 'crads1:%%%not-base64', 'crads2:' + Buffer.from('{}').toString('base64'),
    'crads1:' + Buffer.from('{"slug":"demo"}').toString('base64'),
    'crads1:' + Buffer.from('{"slug":"Bad Slug","host":"203.0.113.9"}').toString('base64')]) {
    const r = await h.call('POST', '/device/complete', { bundle });
    assert.equal(r.status, 400, `refused: ${JSON.stringify(bundle.slice(0, 30))}`);
  }
});

test('complete happy path: install with the real address, pin from the bundle, probe last, in that order', async (t) => {
  const h = harness(); t.after(h.close);
  await h.call('POST', '/device/offer', { name: 'demo' });
  const bundle = 'crads1:' + Buffer.from(JSON.stringify({ slug: 'demo', host: '203.0.113.9', hostkey: HOSTKEY })).toString('base64');
  const r = await h.call('POST', '/device/complete', { bundle });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.alias, 'demo-box');
  assert.deepEqual(h.installs.map((i) => i.host), ['0.0.0.0', '203.0.113.9'],
    'key before address, then the Host block repaired to the bundle address');
  assert.deepEqual(h.pins.map((p) => p.host), ['203.0.113.9']);
  assert.deepEqual(h.events, ['install:0.0.0.0', 'install:203.0.113.9', 'pin:203.0.113.9', 'probe'],
    'the pin lands BEFORE the first connect');
  // the carried host key is on record where the bridge reads before dialling
  assert.match(readFileSync(h.appKnownHosts, 'utf8'), /BoxHostKey/);
});

test('complete: a box that never answers is reported honestly, with the identity kept for a retry', async (t) => {
  let asked = 0;
  const h = harness({ probe: async () => { asked++; return { code: 255, stdout: '', stderr: 'Permission denied' }; } });
  t.after(h.close);
  await h.call('POST', '/device/offer', { name: 'demo' });
  const bundle = 'crads1:' + Buffer.from(JSON.stringify({ slug: 'demo', host: '203.0.113.9' })).toString('base64');
  const r = await h.call('POST', '/device/complete', { bundle });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.alias, 'demo-box');
  assert.match(r.body.error, /did not answer/);
  assert.equal(asked, 3, 'the probe retries before giving up');
});

test('round trip: the bundle approve mints is the bundle complete accepts', async (t) => {
  // OLD machine: a shell-backed box, a config naming the address, a recorded pin
  const boxDir = tmpDir('devbox-');
  const oldSsh = tmpDir('dev-old-');
  writeFileSync(join(oldSsh, 'config'), 'Host demo-box\n  HostName 203.0.113.9\n  User member\n');
  const oldM = harness({ sshDir: oldSsh, runSsh: shellRunSsh(boxDir, []) }); t.after(oldM.close);
  writeFileSync(oldM.appKnownHosts, HOSTKEY + '\n');
  const approved = await oldM.call('POST', '/device/approve', { host: 'demo-box', pubkey: NEW_KEY });
  assert.equal(approved.status, 200);

  // NEW machine: separate scratch world entirely
  const newM = harness(); t.after(newM.close);
  await newM.call('POST', '/device/offer', { name: 'demo' });
  const done = await newM.call('POST', '/device/complete', { bundle: approved.body.bundle });
  assert.equal(done.status, 200);
  assert.equal(done.body.ok, true);
  assert.equal(done.body.alias, 'demo-box');
  assert.deepEqual(newM.pins.map((p) => p.host), ['203.0.113.9'], 'the carried host key was pinned before first contact');
});
