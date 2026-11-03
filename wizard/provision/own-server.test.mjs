// own-server.test.mjs: "a server you already have" against a fake ssh runner.
//   node --test wizard/provision/own-server.test.mjs
// Nothing here reaches a network: the runner IS the server. The real thing was
// proven on a stand-in Ubuntu 24.04 server (see own-server.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OwnServerClient, parseOwnServer, setupScript, SETUP_MODULES, busyReasons, publicPorts, TAKEOVER_CHANGES, confirmsTakeover } from './own-server.mjs';
import { readFileSync } from 'node:fs';
import { provisionSelfHost, destroySelfHost } from './engine.mjs';
import { PROVIDERS } from './providers.mjs';
import { renderSelfHostCloudInit } from './selfhost-cloudinit.mjs';
import { createHash } from 'node:crypto';

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF6zXyq1x2Qq0m7T3v9m4T8u5X6a7B8c9D0e1F2g3H4i owner@wizard';
const TOKEN = JSON.stringify({ host: '203.0.113.10', user: 'ubuntu', slug: 'mel' });
// What the start route hands the build once the person has typed the address
// (THE TAKEOVER CONFIRMATION, 2026-10-19).
const CONFIRMED = JSON.stringify({ host: '203.0.113.10', user: 'ubuntu', slug: 'mel', confirmHost: '203.0.113.10' });

const GOOD = { uid: '1000', sudo: 'ok', os: 'ubuntu', version: '24.04', arch: 'aarch64', mem_mb: '3820', cpus: '2', disk_gb: '35', cloudinit: 'yes', systemd: 'yes', existing: 'no' };
const facts = (over = {}) => Object.entries({ ...GOOD, ...over }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';

function fakeServer({ check = facts(), checkCode = 0, checkErr = '', setupOut = 'crads-step: users_groups\ncrads-setup-ok\n', setupCode = 0 } = {}) {
  const calls = [];
  const runner = async (o) => {
    calls.push(o);
    if (o.command === 'bash -s') return { code: checkCode, stdout: check, stderr: checkErr };
    return { code: setupCode, stdout: setupOut, stderr: '' };
  };
  return { runner, calls };
}
const client = (fake, token = CONFIRMED) => new OwnServerClient(token, { sshDir: '/tmp/keys', runner: fake.runner });

test('details: host, login and the mineral name; port is always 22; bad input is refused in words', () => {
  assert.deepEqual(parseOwnServer(TOKEN), { host: '203.0.113.10', user: 'ubuntu', port: 22, slug: 'mel' });
  assert.equal(parseOwnServer({ host: 'box.example.com', slug: 'mel' }).user, 'ubuntu', 'ubuntu is the default login');
  assert.equal(parseOwnServer({ host: 'myserver.tail1234.ts.net', user: 'pat', slug: 'mel' }).host, 'myserver.tail1234.ts.net');
  assert.equal(parseOwnServer({ host: '[2001:db8::5]', slug: 'mel' }).host, '2001:db8::5');
  assert.match(parseOwnServer({ host: 'bad host; rm', slug: 'mel' }).error, /address/);
  assert.match(parseOwnServer({ host: '203.0.113.10', user: 'Root Name', slug: 'mel' }).error, /login name/);
  assert.match(parseOwnServer('not json').error, /did not arrive/);
  assert.equal(parseOwnServer({ host: '203.0.113.10', port: 2222, slug: 'mel' }).port, 22, 'another port would lock the server out after setup');
});

test('the check reads the machine over ssh with this mineral\'s key, and passes a fit server', async () => {
  const f = fakeServer();
  const v = await client(f).validateToken();
  assert.equal(v.ok, true);
  assert.equal(f.calls[0].keyPath, '/tmp/keys/mel-box.key', 'the mineral\'s own key, minted by /provision/own-key');
  assert.equal(f.calls[0].user, 'ubuntu');
  assert.equal(f.calls[0].port, 22);
  assert.equal(v.facts.arch, 'aarch64');
  const [t] = await client(f).listServerTypes();
  assert.deepEqual([t.id, t.cores, t.memoryGb, t.arch], ['own', 2, 4, 'arm']);
});

test('every unfit machine is refused with a reason a person can act on, before anything changes', async () => {
  const reason = async (over, extra = {}) => (await client(fakeServer({ check: facts(over), ...extra })).validateToken()).reason;
  assert.match(await reason({ sudo: 'no' }), /passwordless sudo/);
  assert.match(await reason({ os: 'debian', version: '12' }), /Ubuntu 24\.04/);
  assert.match(await reason({ version: '20.04' }), /Ubuntu 24\.04/);
  assert.match(await reason({ arch: 'armv7l' }), /x86_64|aarch64/);
  assert.match(await reason({ cloudinit: 'no' }), /apt install cloud-init/);
  assert.match(await reason({ mem_mb: '1900' }), /at least 4 GB/, 'a 2 GB machine is too small (measured 2026-10-15)');
  assert.match(await reason({ disk_gb: '8' }), /free disk/);
  for (const r of [await reason({}, { checkCode: 255, checkErr: 'ubuntu@203.0.113.10: Permission denied (publickey).' }),
    await reason({}, { checkCode: 255, checkErr: 'ssh: connect to host 203.0.113.10 port 22: Connection refused' }),
    await reason({}, { checkCode: 255, checkErr: 'ssh: connect to host 203.0.113.10 port 22: Connection timed out' })]) {
    assert.ok(r && !/—/.test(r), r);
  }
  assert.match(await reason({}, { checkCode: 255, checkErr: 'Permission denied (publickey).' }), /key shown above/);
  assert.match(await reason({}, { checkCode: 255, checkErr: 'Connection refused' }), /port 22/);
  assert.match(await reason({}, { checkCode: 255, checkErr: 'Connection timed out' }), /Tailscale/);
});

test('a server that already runs other things is refused before anything changes (busy-server guard, 2026-10-18)', async () => {
  const check = async (over) => client(fakeServer({ check: facts(over) })).validateToken();
  const quiet = { listen: '0.0.0.0:22,[::]:22,0.0.0.0:111,127.0.0.1:7780,127.0.0.53%lo:53,100.100.10.20:48439,[fd7a:115c:a1e0::1]:39634,[fe80::1%eth0]:5353', busy_cron: '0', busy_containers: '', busy_repos: '0' };
  const ok = await check(quiet);
  assert.equal(ok.ok, true, 'SSH, rpcbind, loopback, link-local and Tailscale listeners are not "busy"');
  assert.equal((await check({ ...quiet, existing: 'yes', busy_containers: '' })).ok, true, 'a re-run on our own mineral still passes');

  // The shape measured on a real busy server: every signal at once.
  const busy = await check({ listen: '*:8080,0.0.0.0:22,0.0.0.0:9000,0.0.0.0:9001,127.0.0.1:4620', busy_cron: '1', busy_containers: 'web,worker', busy_repos: '5', disk_gb: '4' });
  assert.equal(busy.ok, false);
  assert.match(busy.reason, /already runs other things/);
  assert.match(busy.reason, /scheduled jobs/);
  assert.match(busy.reason, /web, worker/);
  assert.match(busy.reason, /ports 8080, 9000, 9001/);
  assert.match(busy.reason, /5 git projects/);
  assert.match(busy.reason, /changed nothing/);
  assert.match(busy.reason, /"Yes, my assistant is already on it"/, 'since adopt: the refusal points at the card\'s other answer');
  assert.doesNotMatch(busy.reason, /free disk/, 'the busy reason wins over a disk reason: it is the one that matters');
  assert.doesNotMatch(busy.reason, /\u2014/, 'no em dashes in member copy');

  // Each signal alone is enough.
  for (const over of [{ busy_cron: '2' }, { busy_containers: 'web' }, { listen: '0.0.0.0:443' }, { listen: '[::]:3000' }, { busy_repos: '1' }]) {
    assert.equal((await check({ ...quiet, ...over })).ok, false, JSON.stringify(over));
  }
  // An older check script (no busy lines at all) is not refused on that account.
  assert.equal((await check({})).ok, true);
});

test('busy-server helpers: listeners read as ports, our own container never counts', () => {
  assert.deepEqual(publicPorts('*:8080,0.0.0.0:22,[::]:8080,192.0.2.5:9000,127.0.0.1:1,100.64.0.9:7,100.128.0.9:8'), ['8', '8080', '9000'], '100.128/10 is outside Tailscale\'s range');
  assert.deepEqual(busyReasons({ busyContainers: ['ai-os'] }), []);
  assert.deepEqual(busyReasons({ busyCron: 1 }), ['a login with scheduled jobs']);
});

test('the setup script hands our file to the machine\'s own cloud-init, module by module, then runs the commands', () => {
  const s = setupScript('#cloud-config\nruncmd:\n  - echo hi\n');
  assert.ok(s.includes(`for m in ${SETUP_MODULES.join(' ')}`), 'the modules run in the listed order');
  assert.deepEqual(SETUP_MODULES, ['users_groups', 'write_files', 'timezone', 'package_update_upgrade_install', 'runcmd'], 'users before the files they own; packages before the commands that use them');
  assert.match(s, /cloud-init single --name "\$m" --frequency always --file "\$d\/user-data\.yaml"/);
  assert.match(s, /sh "\$s"/, 'the written runcmd script is run directly (no current instance on a hand-made server)');
  assert.ok(!s.includes('scripts_user'), 'never scripts_user: it would re-run the provider\'s own first-boot scripts');
  assert.match(s, /crads-setup-ok/);
  const b64 = s.match(/<<'CRADS_B64'\n([\s\S]*?)\nCRADS_B64/)[1].replace(/\n/g, '');
  assert.equal(Buffer.from(b64, 'base64').toString(), '#cloud-config\nruncmd:\n  - echo hi\n', 'the file arrives byte for byte');
});

test('setup runs as root on stdin, and a failed step is named', async () => {
  const f = fakeServer();
  const c = client(f);
  const r = await c.createServer({ name: 'aios-mel', userData: '#cloud-config\n' });
  assert.deepEqual(r, { id: '203.0.113.10', ip: '203.0.113.10', actionId: null });
  const setup = f.calls.find((x) => x.command !== 'bash -s');
  assert.match(setup.command, /sudo -n bash -s/);
  assert.ok(!setup.command.includes('cloud-config'), 'the file rides stdin, never the command line');
  assert.ok(setup.timeoutMs >= 20 * 60_000, 'Docker\'s install and the first pull get room on a small machine');
  const bad = fakeServer({ setupOut: 'crads-step: runcmd\ncrads-failed: commands\n', setupCode: 43 });
  await assert.rejects(client(bad).createServer({ userData: 'x' }), (e) => e.code === 'setup_failed' && /stopped at "commands"/.test(e.message));
});

test('the engine drives it through the registry: check, (no key upload), set up, running; remove only forgets', async () => {
  const f = fakeServer();
  const state = {};
  const steps = [];
  const r = await provisionSelfHost({
    token: TOKEN, boxName: 'mel', ownerPubKey: PUB, state, provider: 'own',
    onStep: (s) => steps.push(s),
    overrides: { client: client(f), image: 'ghcr.io/x/crads-pebble:v2', sleep: async () => {} },
  });
  assert.equal(r.ip, '203.0.113.10');
  assert.deepEqual(steps, ['validate-token', 'ensure-ssh-key', 'create-server', 'wait-running', 'done']);
  const setup = f.calls.find((x) => x.command !== 'bash -s');
  const sent = Buffer.from(setup.input.match(/<<'CRADS_B64'\n([\s\S]*?)\nCRADS_B64/)[1].replace(/\n/g, ''), 'base64').toString();
  assert.ok(sent.includes(PUB), 'the same cloud-init a cloud build boots with, owner key and all');
  assert.ok(sent.includes('fallocate -l 2G /swapfile'), 'swap included');
  const d = await destroySelfHost({ state, provider: 'own', client: client(f) });
  assert.equal(d.destroyed, true);
  assert.equal(f.calls.filter((x) => x.command !== 'bash -s').length, 1, 'removing never runs anything on the person\'s machine');
});

test('the registry entry: ownServer, no secrets asked, listed, and a reason for every step', () => {
  const P = PROVIDERS.own;
  assert.equal(P.ownServer, true);
  assert.ok(!P.preview, 'listed since the end-to-end test passed (2026-10-15)');
  assert.deepEqual(P.credentialFields.map((x) => x.key), ['host', 'user']);
  assert.ok(P.credentialFields.every((x) => x.secret === false), 'nothing secret is asked for');
  assert.ok(P.tokenSteps.length >= 3);
  assert.ok(P.tokenSteps.join(' ').includes('Tailscale'));
  assert.ok(!JSON.stringify(P).includes('—'));
});

// The adopt fork (2026-10-18) must not move a single byte of what a server used
// for this alone receives. The hash below was taken from the renderer at
// e053baa (before the fork) and from this tree, with the one random slot (the
// inert code-server password) made deterministic; both gave this value. If the
// dedicated template changes ON PURPOSE, take the new hash in the same commit.
// 2026-11-03 (trap 82): the unit pulls new software only when the member pressed Update.
const DEDICATED_SHA256 = 'c8589bf1ba4bedae504d65018b2df91212ef2de822752fbb2f95f6de80c74fe5';
function deterministic(fn) {
  const real = globalThis.crypto.getRandomValues;
  let n = 0;
  globalThis.crypto.getRandomValues = (a) => { for (let i = 0; i < a.length; i++) a[i] = (n++ * 7) & 255; return a; };
  try { return fn(); } finally { globalThis.crypto.getRandomValues = real; }
}

test('a dedicated build is byte-identical to before the adopt fork, and the engine still sends exactly that', async () => {
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const direct = deterministic(() => renderSelfHostCloudInit({ boxName: 'mel', ownerPubKey: PUB, image: 'ghcr.io/cradsdavis-cell/crads-pebble:v2' }));
  assert.equal(sha(direct), DEDICATED_SHA256);
  // through the engine, for an own server answered "No": the client renders nothing of its own
  const f = fakeServer();
  assert.equal(await client(f).renderUserData({ boxName: 'mel', ownerPubKey: PUB, image: 'x' }), null);
  let sent = null;
  const c = client(f);
  const create = c.createServer.bind(c);
  c.createServer = async (o) => { sent = o.userData; return create(o); };
  const real = globalThis.crypto.getRandomValues;
  let n = 0;
  globalThis.crypto.getRandomValues = (a) => { for (let i = 0; i < a.length; i++) a[i] = (n++ * 7) & 255; return a; };
  try {
    await provisionSelfHost({ token: TOKEN, boxName: 'mel', ownerPubKey: PUB, state: {}, provider: 'own', overrides: { client: c, image: 'ghcr.io/cradsdavis-cell/crads-pebble:v2', sleep: async () => {} } });
  } finally { globalThis.crypto.getRandomValues = real; }
  assert.equal(sha(sent), DEDICATED_SHA256, 'the engine hands a dedicated own server the same bytes');
});

// THE TAKEOVER CONFIRMATION (2026-10-19). Even a quiet server is taken over by
// setup, so the check says exactly what changes, and setup never runs on an
// address the person has not typed.

test('a fit server\'s check answers the exact list of what setup changes, with its address', async () => {
  const v = await client(fakeServer(), TOKEN).validateToken();
  assert.equal(v.ok, true);
  assert.deepEqual(v.takeover, { host: '203.0.113.10', changes: TAKEOVER_CHANGES });
  const busy = await client(fakeServer({ check: facts({ listen: '0.0.0.0:8080' }) }), TOKEN).validateToken();
  assert.equal(busy.takeover, undefined, 'a refused check confirms nothing');
});

test('setup never runs without the typed address, or with a different one; nothing reaches the server', async () => {
  for (const token of [TOKEN, JSON.stringify({ host: '203.0.113.10', user: 'ubuntu', slug: 'mel', confirmHost: '203.0.113.11' })]) {
    const f = fakeServer();
    await assert.rejects(client(f, token).createServer({ userData: 'x' }), (e) => e.code === 'not_confirmed' && /Nothing has been changed/.test(e.message));
    assert.equal(f.calls.length, 0, 'refused before the check, let alone setup');
  }
  // through the engine: the build stops at create-server with nothing set up
  const f = fakeServer();
  const state = {};
  await assert.rejects(provisionSelfHost({ token: TOKEN, boxName: 'mel', ownerPubKey: PUB, state, provider: 'own', overrides: { client: client(f, TOKEN), image: 'ghcr.io/x/crads-pebble:v2', sleep: async () => {} } }), (e) => /type the server\u2019s address/.test(e.message));
  assert.ok(!f.calls.some((x) => x.command !== 'bash -s'), 'setup never ran');
  assert.equal(state.serverId, undefined);
});

test('the typed address is matched the way a person types it, and only to the server\'s own address', () => {
  assert.equal(confirmsTakeover({ host: '203.0.113.10' }, ' 203.0.113.10 '), true);
  assert.equal(confirmsTakeover({ host: 'Box.Example.com' }, 'box.example.COM'), true);
  assert.equal(confirmsTakeover({ host: '2001:db8::1' }, '[2001:db8::1]'), true);
  assert.equal(confirmsTakeover({ host: '203.0.113.10' }, '203.0.113.1'), false);
  assert.equal(confirmsTakeover({ host: '203.0.113.10' }, ''), false);
  assert.equal(confirmsTakeover({ host: '' }, ''), false, 'nothing confirms nothing');
  assert.equal(parseOwnServer(TOKEN).confirmHost, undefined, 'unconfirmed details carry no confirmation');
});

test('an adopt build needs no confirmation: it leaves the firewall, logins and clock as they are', () => {
  // adopt-host.mjs owns that setup; the guard is for the takeover only
  const c = client(fakeServer(), JSON.stringify({ host: '203.0.113.10', user: 'pat', slug: 'mel', mode: 'adopt', brainRoot: '~/brain' }));
  assert.equal(c.adopt, true);
});

test('every change on the list is one the setup file really makes, and the list has no em dash', () => {
  const t = readFileSync(new URL('../../provisioning/managed/cloud-init.template.yaml', import.meta.url), 'utf8');
  const pinned = [
    [/firewall/, /ufw default deny incoming/],
    [/password sign-in/, /PasswordAuthentication no/],
    [/Australia\/Sydney/, /^timezone: Australia\/Sydney$/m],
    [/Docker\u2019s own package source/, /download\.docker\.com\/linux\/ubuntu/],
    [/aios.*member/, /- name: aios[\s\S]*- name: member/],
    [/2 GB swap/, /fallocate -l 2G \/swapfile/],
  ];
  assert.equal(TAKEOVER_CHANGES.length, pinned.length);
  pinned.forEach(([line, inFile], i) => {
    assert.match(TAKEOVER_CHANGES[i], line);
    assert.match(t, inFile, `setup no longer does what line ${i + 1} says`);
  });
  assert.ok(!TAKEOVER_CHANGES.join(' ').includes('\u2014'));
});
