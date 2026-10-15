// own-server.test.mjs: "a server you already have" against a fake ssh runner.
//   node --test wizard/provision/own-server.test.mjs
// Nothing here reaches a network: the runner IS the server. The real thing was
// proven on a stand-in Ubuntu 24.04 server (see own-server.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OwnServerClient, parseOwnServer, setupScript, SETUP_MODULES } from './own-server.mjs';
import { provisionSelfHost, destroySelfHost } from './engine.mjs';
import { PROVIDERS } from './providers.mjs';

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF6zXyq1x2Qq0m7T3v9m4T8u5X6a7B8c9D0e1F2g3H4i owner@wizard';
const TOKEN = JSON.stringify({ host: '203.0.113.10', user: 'ubuntu', slug: 'mel' });

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
const client = (fake, token = TOKEN) => new OwnServerClient(token, { sshDir: '/tmp/keys', runner: fake.runner });

test('details: host, login and the mineral name; port is always 22; bad input is refused in words', () => {
  assert.deepEqual(parseOwnServer(TOKEN), { host: '203.0.113.10', user: 'ubuntu', port: 22, slug: 'mel' });
  assert.equal(parseOwnServer({ host: 'box.example.com', slug: 'mel' }).user, 'ubuntu', 'ubuntu is the default login');
  assert.equal(parseOwnServer({ host: 'myserver.tail1234.ts.net', user: 'sam', slug: 'mel' }).host, 'myserver.tail1234.ts.net');
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
