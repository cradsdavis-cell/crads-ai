// move-routes.test.mjs: the door's move routes, and above all the gates on
// "Delete the old server" (ruling 3, 2026-10-14). Fake provider, fake moves,
// a real git folder for the at-the-moment-of-delete re-check.
//   node --test wizard/panel/move-routes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { moveRoutes, monthlyWords } from './move-routes.mjs';
import { PROVIDERS } from '../provision/providers.mjs';

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, ...ID } }).trim();

function brainFolder(root) {
  const f = join(root, 'Crads-AI', 'ana');
  mkdirSync(join(f, 'wiki'), { recursive: true });
  writeFileSync(join(f, 'profile.yaml'), 'identity:\n  assistant_name: "Ana"\n');
  writeFileSync(join(f, 'wiki', 'a.md'), '# a\n');
  execFileSync('git', ['init', '-q', '-b', 'master', f]);
  g(f, 'add', '-A'); g(f, 'commit', '-q', '-m', 'x');
  return f;
}

function rig(over = {}) {
  const root = tmpDir('moveroutes-');
  const sshDir = join(root, 'ssh'); mkdirSync(sshDir);
  const calls = [];
  const folder = brainFolder(root);
  const client = {
    validateToken: async () => ({ ok: true }),
    listServerTypes: async () => [{ id: 93, name: 'cax21', prices: { hel1: 10.49 } }, { id: 92, name: 'cax11', prices: { hel1: 5.99 } }],
    describeServer: async () => ({ serverType: 'cax11', location: 'hel1' }),
    deleteServer: async (id) => { calls.push(['delete', id]); },
    deleteSshKey: async (id) => { calls.push(['delete-key', id]); },
  };
  const forgot = [];
  const targets = [
    { host: 'ana-box', org: 'ana', kind: 'member' },
    { host: 'ana-local', org: 'ana', kind: 'local', path: folder, name: 'Ana' },
  ];
  const handle = moveRoutes({
    targets: () => targets, sshDir, home: root,
    makeClient: () => client,
    forget: (a) => { forgot.push(a); return {}; },
    transportFor: () => ({}),
    moveDown: async ({ folder: to }) => ({ ok: true, verified: true, path: folder, commit: g(folder, 'rev-parse', 'HEAD'), files: 2, dropped: [], to }),
    moveUp: async () => ({ ok: true, verified: true }),
    ...over,
  });
  const server = http.createServer((req, res) => { if (!handle(req, res, req.url.split('?')[0])) { res.writeHead(404); res.end(); } });
  const ready = new Promise((r) => server.listen(0, '127.0.0.1', r));
  const call = async (method, path, body) => {
    await ready;
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const record = (state) => writeFileSync(join(sshDir, 'ana-box.provision.json'), JSON.stringify(state));
  return { call, calls, forgot, folder, root, sshDir, record, client, close: () => { server.closeAllConnections?.(); server.close(); } };
}

async function settle(call) {
  for (let i = 0; i < 200; i++) {
    const s = (await call('GET', '/move/status')).body;
    if (s.phase !== 'running') return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('never settled');
}

test('monthly words read the provider’s own list', () => {
  assert.equal(monthlyWords(PROVIDERS.hetzner, 5.99), '€5.99 a month');
  assert.equal(monthlyWords(PROVIDERS.digitalocean, 48), '$48.00 a month');
  assert.equal(monthlyWords(PROVIDERS.hetzner, null), null);
});

test('the plan says which way a mineral moves', async () => {
  const r = rig();
  try {
    const up = (await r.call('GET', '/move/plan?from=ana-local')).body;
    assert.equal(up.direction, 'up'); assert.equal(up.name, 'Ana');
    r.record({ provider: 'hetzner', serverId: 7 });
    const down = (await r.call('GET', '/move/plan?from=ana-box')).body;
    assert.equal(down.direction, 'down'); assert.equal(down.default_path, join(r.root, 'Crads-AI', 'ana'));
    assert.equal(down.provider, 'Hetzner'); assert.equal(down.built_here, true);
    assert.equal((await r.call('GET', '/move/plan?from=nobody-box')).status, 400);
  } finally { r.close(); }
});

test('starts only for identities this computer has, the right way round', async () => {
  const r = rig();
  try {
    assert.equal((await r.call('POST', '/move/up/start', { from: 'ana-box', to: 'ana-box' })).status, 400, 'a server is not a folder');
    assert.equal((await r.call('POST', '/move/up/start', { from: 'ana-local', to: 'stranger-box' })).status, 400);
    assert.equal((await r.call('POST', '/move/down/start', { from: 'ana-local' })).status, 400, 'a folder is not a server');
    assert.equal((await r.call('POST', '/move/down/start', { from: 'ana-box', path: 'relative' })).status, 400);
    assert.equal((await r.call('POST', '/move/up/start', { from: 'ana-local', to: 'ana-box' })).status, 200);
    assert.equal((await settle(r.call)).phase, 'done');
  } finally { r.close(); }
});

test('the quote names the server and its monthly price, from the build record or the provider', async () => {
  const r = rig();
  try {
    assert.equal((await r.call('POST', '/move/quote', { alias: 'ana-box', token: 't' })).status, 404, 'no build record: this computer cannot delete it');
    r.record({ provider: 'hetzner', serverId: 7, serverIp: '203.0.113.9', serverType: 'cax21', location: 'hel1' });
    const q = (await r.call('POST', '/move/quote', { alias: 'ana-box', token: 't' })).body;
    assert.equal(q.server, 'aios-ana'); assert.equal(q.provider, 'Hetzner'); assert.equal(q.cost_words, '€10.49 a month');
    // a record from before machine types were recorded asks the provider
    r.record({ provider: 'hetzner', serverId: 7 });
    assert.equal((await r.call('POST', '/move/quote', { alias: 'ana-box', token: 't' })).body.cost_words, '€5.99 a month');
    assert.equal((await r.call('POST', '/move/quote', { alias: 'ana-box', token: '' })).status, 400, 'the token is asked for again');
    r.client.validateToken = async () => ({ ok: false, reason: 'unauthorized' });
    assert.equal((await r.call('POST', '/move/quote', { alias: 'ana-box', token: 'bad' })).status, 401);
  } finally { r.close(); }
});

test('DELETE: never before a verified move down, never without the server’s name, never if the copy no longer checks out', async () => {
  const r = rig();
  try {
    r.record({ provider: 'hetzner', serverId: 7, sshKeyId: 31, serverType: 'cax11', location: 'hel1' });
    const del = (body) => r.call('POST', '/move/delete', { alias: 'ana-box', token: 't', ...body });
    assert.equal((await del({ confirm: 'aios-ana' })).status, 409, 'no move down this session');
    assert.equal(r.calls.length, 0);
    assert.equal((await r.call('POST', '/move/down/start', { from: 'ana-box' })).status, 200);
    const s = await settle(r.call);
    assert.equal(s.phase, 'done'); assert.equal(s.result.deletable, true);
    assert.equal((await del({ confirm: 'yes' })).status, 400, 'the confirm must name the server');
    // the folder changes under it: the copy no longer holds the checked commit
    const keep = join(r.root, 'keep');
    execFileSync('cp', ['-a', r.folder, keep]);
    rmSync(r.folder, { recursive: true, force: true });
    const gone = await del({ confirm: 'aios-ana' });
    assert.equal(gone.status, 409); assert.match(gone.body.error, /no longer holds the brain/);
    assert.equal(r.calls.length, 0, 'nothing deleted');
    execFileSync('cp', ['-a', keep, r.folder]);
    // all gates pass: the wizard's own delete path, the record removed, the alias forgotten
    const ok = await del({ confirm: 'aios-ana' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(r.calls, [['delete', 7], ['delete-key', 31]], 'the server and its SSH key, by the ids in the build record');
    assert.equal(ok.body.key_removed, true);
    assert.ok(!existsSync(join(r.sshDir, 'ana-box.provision.json')));
    assert.deepEqual(r.forgot, ['ana-box']);
    assert.equal((await del({ confirm: 'aios-ana' })).status, 404, 'and it cannot be deleted twice');
  } finally { r.close(); }
});

test('a failed move down is never a reason to offer a delete', async () => {
  const r = rig({ moveDown: async () => { const { MoveRefusal } = await import('./brain-move.mjs'); throw new MoveRefusal('the copy does not match the server'); } });
  try {
    r.record({ provider: 'hetzner', serverId: 7 });
    await r.call('POST', '/move/down/start', { from: 'ana-box' });
    const s = await settle(r.call);
    assert.equal(s.phase, 'failed'); assert.match(s.error, /does not match/);
    assert.equal((await r.call('POST', '/move/delete', { alias: 'ana-box', token: 't', confirm: 'aios-ana' })).status, 409);
    assert.equal(r.calls.length, 0);
  } finally { r.close(); }
});

test('DELETE keeps an SSH key another build record on this computer still uses', async () => {
  const r = rig();
  try {
    r.record({ provider: 'hetzner', serverId: 7, sshKeyId: 31 });
    writeFileSync(join(r.sshDir, 'other-box.provision.json'), JSON.stringify({ provider: 'hetzner', serverId: 8, sshKeyId: 31 }));
    await r.call('POST', '/move/down/start', { from: 'ana-box' });
    await settle(r.call);
    const ok = await r.call('POST', '/move/delete', { alias: 'ana-box', token: 't', confirm: 'aios-ana' });
    assert.equal(ok.status, 200);
    assert.deepEqual(r.calls, [['delete', 7]]);
    assert.equal(ok.body.key_removed, null);
  } finally { r.close(); }
});
