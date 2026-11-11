// host-docker.test.mjs: trap 83, the app half. Members' servers filled to 100%
// with old software versions and the only other fix was root in the Hetzner web
// console. The app now clears them through the server's Docker, over the
// member's own SSH key. These tests pin WHAT it may delete (only untagged Crads
// images no container uses, never forced) and that the road really works past
// a ForceCommand (a throwaway sshd + a fake Docker, when sshd is installed).
//   node --test wizard/panel/host-docker.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { parseHttpResponse, clearOldVersions, transportReason, cleanupHost } from './host-docker.mjs';
import { createPanelServer } from './panel-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const id = (c) => 'sha256:' + c.repeat(64);

test('parses an HTTP/1.0 answer, a chunked one, and refuses garbage', () => {
  const r = parseHttpResponse(Buffer.from('HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":true}'));
  assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true });
  const c = parseHttpResponse('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n[1,2\r\n1\r\n]\r\n0\r\n\r\n');
  assert.deepEqual(c.json, [1, 2]);
  assert.equal(parseHttpResponse('Permission denied (publickey).'), null);
  assert.equal(parseHttpResponse('HTTP/1.0 200 OK\r\nContent-'), null, 'an incomplete head is not an answer yet');
});

// A fake Docker: the dangling list, image configs, and deletes it records.
function fakeDocker(images, { conflict = [] } = {}) {
  const calls = [];
  const request = async (method, path) => {
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path.startsWith('/images/json?filters=')) {
      assert.deepEqual(JSON.parse(decodeURIComponent(path.split('=')[1])), { dangling: ['true'] }, 'asks for dangling images only');
      return { res: { status: 200, json: images.map(({ env, ...i }) => i) } };
    }
    const m = path.match(/^\/images\/(sha256:[0-9a-f]{64})(\/json)?$/);
    const img = m && images.find((i) => i.Id === m[1]);
    if (method === 'GET' && m && m[2]) return { res: { status: img ? 200 : 404, json: img ? { Config: { Env: img.env || [] } } : null } };
    if (method === 'DELETE' && m && !m[2]) return { res: { status: conflict.includes(m[1]) ? 409 : 200, json: [] } };
    return { res: { status: 404, json: null } };
  };
  return { request, calls };
}

test('clears only untagged Crads images that no container uses, one by one, never forced', async () => {
  const crads = ['PATH=/usr/bin', 'AIOS_IMAGE_TAG=sha-abc'];
  const d = fakeDocker([
    { Id: id('a'), RepoTags: [], Containers: 0, Size: 3_400_000_000, env: crads },          // old version: goes
    { Id: id('b'), RepoTags: [], Containers: 1, Size: 3_400_000_000, env: crads },          // in use: stays
    { Id: id('c'), RepoTags: [], Containers: 0, Size: 900_000_000, env: ['PATH=/usr/bin'] }, // the owner's own: stays
    { Id: id('d'), RepoTags: ['ghcr.io/x/crads-pebble:v2'], Containers: 0, Size: 1, env: crads }, // tagged: stays
    { Id: id('e'), RepoTags: ['<none>:<none>'], Containers: 0, Size: 3_000_000_000, env: crads },  // Docker says no
    { Id: 'not-an-id', RepoTags: [], Containers: 0, Size: 1, env: crads },                  // malformed: ignored
  ], { conflict: [id('e')] });
  const r = await clearOldVersions(d.request);
  assert.deepEqual(r, { ok: true, removed: 1, freedBytes: 3_400_000_000, kept: 2 });
  const deletes = d.calls.filter((c) => c.startsWith('DELETE'));
  assert.deepEqual(deletes, [`DELETE /images/${id('a')}`, `DELETE /images/${id('e')}`]);
  assert.ok(d.calls.every((c) => !/force/.test(c)), 'never forced: Docker itself refuses an image in use');
  assert.ok(!d.calls.includes(`GET /images/${id('b')}/json`), 'an image a container uses is not even looked at');
  assert.ok(!d.calls.some((c) => /prune/.test(c)), 'no blanket prune: an adopted server keeps its owner\'s images');
});

test('an unreachable Docker is an answer, not a throw', async () => {
  assert.deepEqual((await clearOldVersions(async () => ({ error: 'no answer from Docker' }))).ok, false);
  assert.equal(transportReason({ stderr: 'channel 0: open failed: administratively prohibited: open failed' }), 'refused');
  assert.equal(transportReason({ stderr: 'stdio forwarding failed' }), 'refused', 'what OpenSSH 9.6 says when sshd refuses');
  assert.equal(transportReason({ stderr: 'Stdio forwarding request failed: Session open refused by peer' }), 'refused', 'the same, through a shared connection');
  assert.equal(transportReason({ stderr: 'member@1.2.3.4: Permission denied (publickey).' }), 'not-let-in');
  assert.equal(transportReason({ stderr: 'ssh: connect to host 1.2.3.4 port 22: Connection timed out' }), 'unreachable');
});

// ---- the real road: a ForceCommand sshd, and a fake Docker on a unix socket ----
const SSHD = ['/usr/sbin/sshd', '/usr/local/sbin/sshd'].find((p) => existsSync(p));
const USER = (() => { try { return execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();

async function rig({ disableForwarding = false } = {}) {
  const t = tmpDir('hostdock-');
  const home = join(t, 'home'); mkdirSync(join(home, '.ssh'), { recursive: true, mode: 0o700 });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(t, 'hostkey')]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(t, 'userkey')]);
  writeFileSync(join(t, 'authorized_keys'), readFileSync(join(t, 'userkey.pub')));
  writeFileSync(join(t, 'enter'), '#!/bin/sh\necho "you only ever land in the container"\n'); chmodSync(join(t, 'enter'), 0o755);
  const port = 20000 + Math.floor(Math.random() * 20000);
  writeFileSync(join(t, 'sshd_config'), [
    `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(t, 'hostkey')}`, `AuthorizedKeysFile ${join(t, 'authorized_keys')}`,
    'PasswordAuthentication no', 'UsePAM no', 'StrictModes no', `PidFile ${join(t, 'sshd.pid')}`,
    `ForceCommand ${join(t, 'enter')}`, ...(disableForwarding ? ['DisableForwarding yes'] : []), '',
  ].join('\n'));
  writeFileSync(join(t, 'ssh_config'), [
    'Host jane01-box', '  HostName 127.0.0.1', `  Port ${port}`, `  User ${USER}`, `  IdentityFile ${join(t, 'userkey')}`, '  IdentitiesOnly yes', '',
  ].join('\n'));
  // The fake Docker: one old Crads version, one image of the owner's.
  const deleted = [];
  const imgs = { [id('a')]: ['AIOS_IMAGE_TAG=sha-old'], [id('c')]: ['PATH=/bin'] };
  const sock = join(t, 'docker.sock');
  const docker = http.createServer((req, res) => {
    const send = (code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); };
    if (req.url === '/_ping') { res.writeHead(200, { 'content-length': 2 }); res.end('OK'); return; }
    if (req.url.startsWith('/images/json')) { send(200, Object.keys(imgs).map((Id) => ({ Id, RepoTags: [], Containers: 0, Size: 3_000_000_000 }))); return; }
    const m = req.url.match(/^\/images\/(sha256:[0-9a-f]{64})(\/json)?$/);
    if (m && m[2]) { send(200, { Config: { Env: imgs[m[1]] } }); return; }
    if (m && req.method === 'DELETE') { deleted.push(m[1]); send(200, [{ Deleted: m[1] }]); return; }
    send(404, { message: 'no' });
  });
  await new Promise((r) => docker.listen(sock, r));
  execFileSync(SSHD, ['-f', join(t, 'sshd_config'), '-E', join(t, 'sshd.log')]);
  await new Promise((r) => setTimeout(r, 400));
  const stop = () => { try { process.kill(Number(readFileSync(join(t, 'sshd.pid'), 'utf8'))); } catch { /* gone */ } docker.close(); };
  return { t, home, sock, deleted, stop, configPath: join(t, 'ssh_config') };
}

test('the app reaches the host\'s Docker past the ForceCommand and clears only the old Crads version', { skip: !SSHD || !USER ? 'no sshd on this machine' : false, timeout: 30000 }, async () => {
  const r = await rig();
  const oldHome = process.env.HOME; process.env.HOME = r.home;   // the app's own known_hosts + mux live under HOME
  try {
    const out = await cleanupHost('jane01-box', { configPath: r.configPath, socket: r.sock });
    assert.deepEqual(out, { ok: true, removed: 1, freedBytes: 3_000_000_000, kept: 0 });
    assert.deepEqual(r.deleted, [id('a')], 'the owner\'s image is untouched');
  } finally { process.env.HOME = oldHome; r.stop(); }
});

test('a server that refuses forwarding gets a plain "refused", and nothing is deleted', { skip: !SSHD || !USER ? 'no sshd on this machine' : false, timeout: 30000 }, async () => {
  const r = await rig({ disableForwarding: true });
  const oldHome = process.env.HOME; process.env.HOME = r.home;
  try {
    const out = await cleanupHost('jane01-box', { configPath: r.configPath, socket: r.sock });
    assert.equal(out.ok, false); assert.equal(out.error, 'refused', out.detail);
    assert.deepEqual(r.deleted, []);
  } finally { process.env.HOME = oldHome; r.stop(); }
});

test('an ssh too old for -W to a socket falls back to a private 127.0.0.1 forward, closed afterwards', { skip: !SSHD || !USER ? 'no sshd on this machine' : false, timeout: 30000 }, async () => {
  const r = await rig();
  // An old Windows ssh.exe: refuses -W <path>, does everything else.
  const old = join(r.t, 'old-ssh');
  writeFileSync(old, '#!/bin/sh\nfor a in "$@"; do [ "$a" = "-W" ] && { echo "Bad stdio forwarding specification \'/x\'" >&2; exit 255; }; done\nexec ssh "$@"\n');
  chmodSync(old, 0o755);
  const oldHome = process.env.HOME; process.env.HOME = r.home;
  try {
    const out = await cleanupHost('jane01-box', { configPath: r.configPath, socket: r.sock, sshExe: old });
    assert.deepEqual(out, { ok: true, removed: 1, freedBytes: 3_000_000_000, kept: 0 });
    assert.deepEqual(r.deleted, [id('a')]);
    await new Promise((res) => setTimeout(res, 300));
    const left = execFileSync('sh', ['-c', `pgrep -f "127.0.0.1:[0-9]*:${r.sock}" || true`], { encoding: 'utf8' }).trim();
    assert.equal(left, '', 'the forward does not outlive the cleanup');
  } finally { process.env.HOME = oldHome; r.stop(); }
});

// ---- the route and the page ----
const listen = (opts) => new Promise((resolve) => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html>x</html>', ...opts });
  s.on('listening', () => resolve(s));
});
const post = (s, body, ct = 'application/json') => fetch(`http://127.0.0.1:${s.address().port}/host-cleanup`,
  { method: 'POST', headers: { 'content-type': ct }, body: JSON.stringify(body) });

test('/host-cleanup: a configured server only, never a folder on this computer, JSON only', async () => {
  const seen = [];
  const targets = [{ host: 'jane01-box', org: 'jane01', kind: 'member' }, { host: 'notes-local', kind: 'local', path: '/x' }];
  const s = await listen({ bridge: { targets: () => targets, stream: () => { throw new Error('not used'); },
    hostCleanup: async (h) => { seen.push(h); return { ok: true, removed: 2, freedBytes: 7, kept: 0 }; } } });
  try {
    assert.deepEqual(await (await post(s, { host: 'jane01-box' })).json(), { ok: true, removed: 2, freedBytes: 7, kept: 0 });
    assert.deepEqual(await (await post(s, { host: 'notes-local' })).json(), { ok: false, error: 'local' });
    assert.equal((await post(s, { host: 'someone-else-box' })).status, 400);
    assert.equal((await post(s, { host: 'jane01-box' }, 'text/plain')).status, 415, 'a cross-origin simple POST cannot fire it');
    assert.deepEqual(seen, ['jane01-box']);
  } finally { s.close(); }
  const old = await listen({ bridge: { targets: () => targets, stream: () => { throw new Error('not used'); } } });
  try { assert.deepEqual(await (await post(old, { host: 'jane01-box' })).json(), { ok: false, error: 'unsupported' }); }
  finally { old.close(); }
});

test('the page clears old versions after an update, once a day on open, and when the assistant is down', () => {
  const html = readFileSync(join(HERE, 'member.html'), 'utf8');
  assert.match(html, /fetch\('\/host-cleanup'/);
  assert.match(html, /loadDashboard\(true\);\s*clearOldVersions\('update'\);/, 'after a verified update');
  assert.match(html, /loadMoveIn\(\); clearOldVersions\('open'\);/, 'on open (rising edge)');
  assert.match(html, /if \(boxDown\(r\)\) clearOldVersions\('down'\);/, 'a full disk is the usual reason the assistant is down');
  assert.match(html, /24 \* 3600e3/, 'open is throttled to once a day per server');
  assert.match(html, /id="cleanBanner"/);
});
