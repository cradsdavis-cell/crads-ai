// member-connect.test.mjs: the member first-run flow (D44).
//   node --test wizard/panel/member-connect.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { installMemberAccess, createMemberConnectServer, removeIdentityAccess, removeHostBlock, parseInviteLink } from './member-connect.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const tmp = () => tmpDir('pp-mc-');

// factory#2: build a v1 invite link fragment from its decoded fields.
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const inviteLink = (org, slug, payload) => `https://crads-ai.com/join#v1.${org}.${slug}.${b64url(payload)}`;

test('parseInviteLink: extended link carries tierName + tierDescription', () => {
  const r = parseInviteLink(inviteLink('acme', 'jane01', 'jane01.example.com|203.0.113.5|member|tok123|standard|Full access to all content'));
  assert.equal(r.slug, 'jane01');
  assert.equal(r.host, 'jane01.example.com');
  assert.equal(r.sip, '203.0.113.5');
  assert.equal(r.token, 'tok123');
  assert.equal(r.tierName, 'standard');
  assert.equal(r.tierDescription, 'Full access to all content');
});

test('parseInviteLink: legacy link (no tier fields) returns empty tier strings, no throw', () => {
  const r = parseInviteLink(inviteLink('acme', 'jane01', 'jane01.example.com|203.0.113.5|member|tok123'));
  assert.equal(r.token, 'tok123');
  assert.equal(r.tierName, '');
  assert.equal(r.tierDescription, '');
});

test('/redeem returns tierName + tierDescription for an extended link', async () => {
  const s = await new Promise((resolve) => {
    const srv = createMemberConnectServer({ port: 0, host: '127.0.0.1', htmlText: '<html>connect</html>',
      claudeSettingsPath: join(tmp(), 'settings.json'), sshDir: tmp() });
    srv.on('listening', () => resolve(srv));
  });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/redeem`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ link: inviteLink('acme', 'jane01', 'jane01.example.com|203.0.113.5|member|tok|core|Online content access only') }),
    });
    const j = await r.json();
    assert.equal(j.tierName, 'core');
    assert.equal(j.tierDescription, 'Online content access only');
  } finally { s.close(); }
});

test('installMemberAccess: mints key + pub + Host block', () => {
  const sshDir = tmp();
  const r = installMemberAccess({ slug: 'jane01', host: 'jane01.example.com', user: 'member' }, sshDir);
  assert.equal(r.reused, false);
  assert.equal(r.configUpdated, true);
  assert.match(r.publicKey, /^ssh-ed25519 [A-Za-z0-9+/=]+ jane01-box\n$/);
  assert.match(readFileSync(r.keyPath, 'utf8'), /BEGIN OPENSSH PRIVATE KEY/);
  assert.ok(existsSync(r.keyPath + '.pub'));
  if (process.platform !== 'win32') {
    assert.equal(statSync(r.keyPath).mode & 0o777, 0o600, 'private key must be 0600');
  }
  const cfg = readFileSync(join(sshDir, 'config'), 'utf8');
  assert.match(cfg, /^Host jane01-box$/m);
  assert.match(cfg, /HostName jane01\.example\.com/);
  assert.match(cfg, /User member/);
  assert.match(cfg, /IdentityFile .*jane01-box\.key/);
});

test('installMemberAccess: idempotent re-run reuses the key, no duplicate block', () => {
  const sshDir = tmp();
  const a = installMemberAccess({ slug: 'jane01', host: 'jane01.example.com' }, sshDir);
  const b = installMemberAccess({ slug: 'jane01', host: 'jane01.example.com' }, sshDir);
  assert.equal(b.reused, true);
  assert.equal(b.configUpdated, false);
  assert.equal(a.publicKey, b.publicKey, 'the same key must be reused');
  const cfg = readFileSync(join(sshDir, 'config'), 'utf8');
  assert.equal(cfg.match(/^Host jane01-box$/mg).length, 1, 'exactly one Host block');
});

test('removeIdentityAccess: inverse of install, keeps every other block, drops the Claude entry, idempotent', () => {
  const sshDir = tmp();
  const settings = join(sshDir, 'claude-settings.json');
  writeFileSync(settings, JSON.stringify({ theme: 'dark', sshConfigs: [
    { id: 'jane01-box', name: 'jane', sshHost: 'jane01-box' },
    { id: 'acme-rock', name: 'acme', sshHost: 'acme-rock' },
  ] }));
  installMemberAccess({ slug: 'jane01', host: 'jane01.example.com' }, sshDir);
  installMemberAccess({ slug: 'other', host: 'other.example.com' }, sshDir);
  appendFileSync(join(sshDir, 'config'), 'Host github.com\n  User git\n');

  const r = removeIdentityAccess('jane01-box', sshDir, settings);
  assert.equal(r.configUpdated, true);
  assert.equal(r.keysRemoved, 4, 'ssh pair + vault pair: a retired machine keeps no half that opens the box');
  assert.equal(r.claudeRemoved, true);
  const cfg = readFileSync(join(sshDir, 'config'), 'utf8');
  assert.doesNotMatch(cfg, /^Host jane01-box$/m, 'removed block gone');
  assert.doesNotMatch(cfg, /jane01\.example\.com/, 'removed block body gone');
  assert.match(cfg, /^Host other-box$/m, 'sibling wizard block kept');
  assert.match(cfg, /^Host github\.com$/m, 'hand-written block kept');
  assert.ok(!existsSync(join(sshDir, 'jane01-box.key')), 'private key deleted');
  assert.ok(!existsSync(join(sshDir, 'jane01-box.key.pub')), 'public key deleted');
  assert.ok(!existsSync(join(sshDir, 'jane01-box.vault.key')), 'vault private half deleted');
  assert.ok(!existsSync(join(sshDir, 'jane01-box.vault.pub')), 'vault public half deleted');
  assert.ok(existsSync(join(sshDir, 'other-box.key')), 'sibling key kept');
  assert.ok(existsSync(join(sshDir, 'other-box.vault.key')), 'sibling vault key kept');
  const s = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(s.theme, 'dark', 'unrelated settings untouched');
  assert.deepEqual(s.sshConfigs.map((c) => c.id), ['acme-rock'], 'only the removed id dropped');

  const r2 = removeIdentityAccess('jane01-box', sshDir, settings);
  assert.equal(r2.configUpdated, false);
  assert.equal(r2.keysRemoved, 0);
  assert.equal(r2.keysStuck, 0);
  assert.throws(() => removeIdentityAccess('github.com', sshDir, settings), /wizard-installed/);
  assert.throws(() => removeIdentityAccess('x; rm -rf /-rock', sshDir, settings), /wizard-installed/);
});

test('removeIdentityAccess: deletes keys locked read-only at install time (Windows EPERM regression)', () => {
  const sshDir = tmp();
  const settings = join(sshDir, 'claude-settings.json');
  const r = installMemberAccess({ slug: 'jane01', host: 'jane01.example.com' }, sshDir);
  // Mimic the install-time lock: on Windows chmod 0400 sets the read-only
  // attribute (unlinkSync then throws EPERM), on POSIX it drops the write bit.
  chmodSync(r.keyPath, 0o400);
  chmodSync(r.keyPath + '.pub', 0o400);

  const gone = removeIdentityAccess('jane01-box', sshDir, settings);
  // 4 = ssh pair unlinked + vault.pub unlinked + vault.key retired aside
  assert.equal(gone.keysRemoved, 4, 'locked keys must be unlocked and removed');
  assert.equal(gone.keysStuck, 0);
  assert.ok(!existsSync(r.keyPath), 'private key really gone from disk');
  assert.ok(!existsSync(r.keyPath + '.pub'), 'public key really gone from disk');
});

test('removeIdentityAccess: reports keys it could not delete instead of swallowing',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    const sshDir = tmp();
    const settings = join(sshDir, 'claude-settings.json');
    const r = installMemberAccess({ slug: 'jane01', host: 'jane01.example.com' }, sshDir);
    chmodSync(sshDir, 0o500);   // POSIX: unlink needs a writable directory
    try {
      const gone = removeIdentityAccess('jane01-box', sshDir, settings);
      assert.equal(gone.keysRemoved, 0);
      // ssh pair + vault.pub cannot unlink, vault.key cannot rename: all 4 counted
      assert.equal(gone.keysStuck, 4, 'undeletable keys must be counted, not reported as gone');
      assert.ok(existsSync(r.keyPath), 'key is in fact still on disk');
    } finally { chmodSync(sshDir, 0o700); }
  });

test('installMemberAccess: validation refuses bad slug/host/user', () => {
  const sshDir = tmp();
  for (const args of [
    { slug: 'UPPER', host: 'ok.example.com' },
    { slug: 'x', host: 'ok.example.com' },                    // too short
    { slug: 'a/../b', host: 'ok.example.com' },
    { slug: 'jane01', host: 'not a host!' },
    { slug: 'jane01', host: 'ok.example.com', user: 'bad user' },
    { slug: 'jane01', host: 'ok.example.com', user: '-flag' },
  ]) {
    assert.throws(() => installMemberAccess(args, sshDir), /must/, JSON.stringify(args));
  }
  assert.ok(!existsSync(join(sshDir, 'config')), 'refusals must write nothing');
});

// ---------------------------------------------------------------- server
const listen = (opts) => new Promise((resolve) => {
  const s = createMemberConnectServer({ port: 0, host: '127.0.0.1', htmlText: '<html>connect</html>',
    claudeSettingsPath: join(tmp(), 'settings.json'),   // hermetic: never the real ~/.claude
    ...opts });
  s.on('listening', () => resolve(s));
});
const post = (s, path, body) => fetch(`http://127.0.0.1:${s.address().port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('server: generate + test round-trip with an injected runner', async () => {
  const sshDir = tmp();
  const calls = [];
  const s = await listen({
    sshDir,
    runner: (host, cmd) => { calls.push({ host, cmd }); return Promise.resolve({ code: 0, stdout: 'member\n', stderr: '' }); },
  });
  try {
    const page = await fetch(`http://127.0.0.1:${s.address().port}/`);
    assert.match(await page.text(), /connect/);

    const gen = await post(s, '/generate', { slug: 'jane01', host: 'jane01.example.com', user: 'member' });
    assert.equal(gen.status, 200);
    const g = await gen.json();
    assert.match(g.publicKey, /^ssh-ed25519 /);

    const bad = await post(s, '/generate', { slug: 'NOPE', host: 'x' });
    assert.equal(bad.status, 400);

    const t = await post(s, '/test', { slug: 'jane01' });
    const tr = await t.json();
    assert.equal(tr.ok, true);
    // R18: a passing whoami is followed by ONE more round trip asking the box
    // which folder Claude Code should open (the mineral-named link in /state).
    assert.deepEqual(calls, [{ host: 'jane01-box', cmd: 'whoami' }, { host: 'jane01-box', cmd: 'cat /state/open-folder 2>/dev/null || echo state' }]);

    const tbad = await post(s, '/test', { slug: 'NOPE' });
    assert.equal(tbad.status, 400);
  } finally { s.close(); }
});

test('R18: /test points the Claude Code entry at the folder the box names', async () => {
  const settings = join(tmp(), 'settings.json');
  const s = await listen({
    sshDir: tmp(), claudeSettingsPath: settings,
    runner: (host, cmd) => Promise.resolve({ code: 0, stdout: cmd === 'whoami' ? 'member\n' : 'jane01\n', stderr: '' }),
  });
  try {
    await post(s, '/generate', { slug: 'jane01', host: 'jane01.example.com', user: 'member' });
    let e = JSON.parse(readFileSync(settings, 'utf8')).sshConfigs.find((c) => c.id === 'jane01-box');
    assert.equal(e.startDirectory, '/state', 'registered at /state until the box has been asked');
    const t = await post(s, '/test', { slug: 'jane01' });
    assert.equal((await t.json()).ok, true);
    e = JSON.parse(readFileSync(settings, 'utf8')).sshConfigs.find((c) => c.id === 'jane01-box');
    assert.equal(e.startDirectory, '/state/jane01', 'the mineral-named folder, read from /state/open-folder');
  } finally { s.close(); }
});

test('R18: a box with no open-folder yet (answers "state") keeps /state', async () => {
  const settings = join(tmp(), 'settings.json');
  const s = await listen({
    sshDir: tmp(), claudeSettingsPath: settings,
    runner: (host, cmd) => Promise.resolve({ code: 0, stdout: cmd === 'whoami' ? 'member\n' : 'state\n', stderr: '' }),
  });
  try {
    await post(s, '/generate', { slug: 'jane01', host: 'jane01.example.com', user: 'member' });
    await post(s, '/test', { slug: 'jane01' });
    const e = JSON.parse(readFileSync(settings, 'utf8')).sshConfigs.find((c) => c.id === 'jane01-box');
    assert.equal(e.startDirectory, '/state');
  } finally { s.close(); }
});

test('server: failed ssh test reports not-ok with output', async () => {
  const s = await listen({
    sshDir: tmp(),
    runner: () => Promise.resolve({ code: 255, stdout: '', stderr: 'Permission denied (publickey)\n' }),
  });
  try {
    const t = await post(s, '/test', { slug: 'jane01' });
    const tr = await t.json();
    assert.equal(tr.ok, false);
    assert.match(tr.output, /Permission denied/);
  } finally { s.close(); }
});

test('installOperatorAccess: one operator login, alias is <org>-rock (D46)', async () => {
  const { installOperatorAccess } = await import('./member-connect.mjs');
  const sshDir = tmp();
  const r = installOperatorAccess({ org: 'acme', host: 'rock.example.com', role: 'admin' }, sshDir);
  assert.equal(r.alias, 'acme-rock');
  const cfg = readFileSync(join(sshDir, 'config'), 'utf8');
  assert.match(cfg, /^Host acme-rock$/m);
  assert.match(cfg, /User aios-op/);
  const a = installOperatorAccess({ org: 'acme2', host: 'p.example.com' }, sshDir);
  assert.match(readFileSync(join(sshDir, 'config'), 'utf8'), /User aios-op/, 'admin is the default');
  assert.match(a.publicKey, /acme2-rock\n$/);
  // Support was deleted 2026-08-05. REFUSED, never coerced: silently installing an
  // aios-op alias for someone who asked for Support would hand them more access than
  // they asked for, and an aios-support alias would point at a login that is gone.
  assert.throws(() => installOperatorAccess({ org: 'acme', host: 'p.example.com', role: 'support' }, sshDir), /Support role has been removed/);
  assert.throws(() => installOperatorAccess({ org: 'acme', host: 'p.example.com', role: 'root' }, sshDir), /role/);
});

test('server: kind=operator generate + test route to the -rock alias', async () => {
  const calls = [];
  const s = await listen({
    sshDir: tmp(),
    runner: (host, cmd) => { calls.push(host); return Promise.resolve({ code: 0, stdout: 'x\n', stderr: '' }); },
  });
  try {
    const g = await post(s, '/generate', { kind: 'operator', slug: 'acme', host: 'rock.example.com', role: 'admin' });
    assert.equal(g.status, 200);
    assert.equal((await g.json()).alias, 'acme-rock');
    await post(s, '/test', { slug: 'acme', kind: 'operator' });
    assert.deepEqual([...new Set(calls)], ['acme-rock'], 'every round trip (whoami, then the R18 open-folder read) dials the -rock alias');
  } finally { s.close(); }
});

test('D52 nav: /door /dashboard /panel redirect when live, 404 otherwise; onConnected fires on a passing test only', async () => {
  const urls = { door: '', member: '', panel: '' };
  const connected = [];
  let code = 255;
  const s = await listen({
    sshDir: tmp(),
    urls: { door: () => urls.door, member: () => urls.member, panel: () => urls.panel },
    onConnected: (x) => connected.push(x),
    runner: () => Promise.resolve({ code, stdout: code === 0 ? 'member\n' : '', stderr: code === 0 ? '' : 'denied\n' }),
  });
  const get = (path) => fetch(`http://127.0.0.1:${s.address().port}${path}`, { redirect: 'manual' });
  try {
    for (const p of ['/door', '/dashboard', '/panel']) assert.equal((await get(p)).status, 404, `${p} must 404 while down`);
    urls.door = 'http://127.0.0.1:9990/'; urls.member = 'http://127.0.0.1:9991/'; urls.panel = 'http://127.0.0.1:9992/';
    assert.equal((await get('/door')).headers.get('location'), urls.door);
    assert.equal((await get('/dashboard')).headers.get('location'), urls.member);
    assert.equal((await get('/panel')).headers.get('location'), urls.panel);

    await post(s, '/test', { slug: 'jane01' });                       // failing test: no hook
    assert.deepEqual(connected, []);
    code = 0;
    await post(s, '/test', { slug: 'jane01' });                       // passing member test
    await post(s, '/test', { slug: 'acme', kind: 'operator' });       // passing operator test
    assert.deepEqual(connected, [
      { kind: 'member', alias: 'jane01-box' },
      { kind: 'operator', alias: 'acme-rock' },
    ]);
  } finally { s.close(); }
});

test('D56 claude-settings: upsert by id, preserve other keys, refuse corrupt files', async () => {
  const { registerClaudeSshConfig } = await import('./claude-settings.mjs');
  const dir = tmp();
  const p = join(dir, 'settings.json');

  // fresh file
  const a = registerClaudeSshConfig({ id: 'jane01-box', name: 'My assistant (jane01)', sshHost: 'jane01-box', startDirectory: '/state' }, p);
  assert.equal(a.ok, true);
  let obj = JSON.parse(readFileSync(p, 'utf8'));
  assert.deepEqual(obj.sshConfigs, [{ id: 'jane01-box', name: 'My assistant (jane01)', sshHost: 'jane01-box', startDirectory: '/state' }]);

  // preserves unrelated keys + upserts by id
  obj.theme = 'dark';
  const { writeFileSync } = await import('node:fs');
  writeFileSync(p, JSON.stringify(obj));
  const b = registerClaudeSshConfig({ id: 'jane01-box', name: 'renamed', sshHost: 'jane01-box', startDirectory: '/state' }, p);
  assert.equal(b.ok, true);
  assert.equal(b.replaced, true);
  obj = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(obj.theme, 'dark');
  assert.equal(obj.sshConfigs.length, 1);
  assert.equal(obj.sshConfigs[0].name, 'renamed');

  // corrupt file: untouched + refused
  writeFileSync(p, '{not json');
  const c = registerClaudeSshConfig({ id: 'x', sshHost: 'x' }, p);
  assert.equal(c.ok, false);
  assert.equal(readFileSync(p, 'utf8'), '{not json', 'a corrupt settings file must never be overwritten');
});

test('D56: /generate registers the connection with the right start folder', async () => {
  const dir = tmp();
  const settings = join(dir, 'settings.json');
  const s = await listen({ sshDir: tmp(), claudeSettingsPath: settings, runner: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }) });
  try {
    await post(s, '/generate', { slug: 'jane01', host: 'jane01.example.com', user: 'member' });
    let cfgs = JSON.parse(readFileSync(settings, 'utf8')).sshConfigs;
    assert.deepEqual(cfgs[0], { id: 'jane01-box', name: 'My assistant (jane01)', sshHost: 'jane01-box', startDirectory: '/state' });
    await post(s, '/generate', { kind: 'operator', slug: 'acme', host: 'p.example.com', role: 'admin' });
    cfgs = JSON.parse(readFileSync(settings, 'utf8')).sshConfigs;
    const op = cfgs.filter((c) => c.id === 'acme-rock')[0];
    // R18 (2026-08-23): a rock lands in /state too; the folder named after the
    // rock is registered by /test once the box has said what it is called.
    assert.deepEqual(op, { id: 'acme-rock', name: 'acme (rock)', sshHost: 'acme-rock', startDirectory: '/state' });
  } finally { s.close(); }
});

test('self-heal: a private key whose .pub is missing is recovered, key reused, no error', async () => {
  const { installMemberAccess } = await import('./member-connect.mjs');
  const { generateDeployKeypair } = await import('../engine.mjs');
  const dir = tmp();
  // simulate an interrupted setup: private key present, .pub gone
  const kp = generateDeployKeypair('jane01-box');
  writeFileSync(join(dir, 'jane01-box.key'), kp.privateKey, { mode: 0o600 });
  const r = installMemberAccess({ slug: 'jane01', host: 'jane01.example.com' }, dir);
  assert.equal(r.reused, true, 'the existing key is reused, not clobbered');
  assert.equal(r.publicKey, kp.publicKey, 'the recovered .pub matches the private key');
  assert.ok(existsSync(join(dir, 'jane01-box.key.pub')), '.pub was restored on disk');
  assert.ok(!existsSync(join(dir, 'jane01-box.key.orphan-' )), 'nothing moved aside');
});

test('self-heal fallback: a foreign/unreadable key is retired aside and a fresh one minted', async () => {
  const { installMemberAccess } = await import('./member-connect.mjs');
  const { readdirSync } = await import('node:fs');
  const dir = tmp();
  writeFileSync(join(dir, 'jane01-box.key'), 'not an openssh key at all', { mode: 0o600 });
  const r = installMemberAccess({ slug: 'jane01', host: 'jane01.example.com' }, dir);
  assert.equal(r.reused, false, 'unreadable key is not reused');
  assert.match(r.publicKey, /^ssh-ed25519 /, 'a fresh key was minted');
  assert.ok(existsSync(join(dir, 'jane01-box.key.pub')), 'fresh .pub written');
  assert.ok(readdirSync(dir).some((f) => f.startsWith('jane01-box.key.orphan-')), 'foreign key retired aside, not deleted');
});

test('owed item (g): a passing /test pins the verified host key into the USER known_hosts', async () => {
  const dir = tmpDir('mc-pin-');
  const appKH = join(dir, 'app-known-hosts');
  // our bridge already learned the box under accept-new (two key types),
  // plus a line for an unrelated host that must never leak into the pin
  writeFileSync(appKH, [
    '203.0.113.9 ssh-ed25519 AAAAC3realkeyblob',
    '203.0.113.9 ecdsa-sha2-nistp256 AAAAE2othertype',
    'unrelated.example.com ssh-ed25519 AAAAC3not-this-one',
  ].join('\n') + '\n');
  // the USER file carries a STALE entry for the same address (recycled IP)
  // and an unrelated + hashed line that must both survive untouched
  writeFileSync(join(dir, 'known_hosts'), [
    '203.0.113.9 ssh-ed25519 AAAAC3STALEOLDKEY',
    'keeper.example.com ssh-rsa AAAAB3keepme',
    '|1|hashedsalt=|hashedhost= ssh-ed25519 AAAAC3hashedline',
  ].join('\n') + '\n');
  const s = await listen({
    sshDir: dir, appKnownHosts: appKH,
    runner: () => Promise.resolve({ code: 0, stdout: 'member\n', stderr: '' }),
  });
  try {
    await post(s, '/generate', { slug: 'jane01', host: '203.0.113.9', user: 'member' });
    const t = await post(s, '/test', { slug: 'jane01' });
    assert.equal((await t.json()).ok, true);
    const user = readFileSync(join(dir, 'known_hosts'), 'utf8');
    assert.ok(!user.includes('AAAAC3STALEOLDKEY'), 'the stale entry for the box is gone');
    assert.ok(user.includes('AAAAC3realkeyblob') && user.includes('AAAAE2othertype'), 'both verified key lines pinned');
    assert.ok(!user.includes('not-this-one'), 'unrelated app entries never leak');
    assert.ok(user.includes('keepme') && user.includes('hashedline'), 'unrelated + hashed user lines survive');
  } finally { s.close(); }
});

test('owed item (g): a FAILED /test pins nothing (only verified keys reach the user file)', async () => {
  const dir = tmpDir('mc-pin-');
  const appKH = join(dir, 'app-known-hosts');
  writeFileSync(appKH, '203.0.113.9 ssh-ed25519 AAAAC3realkeyblob\n');
  const s = await listen({
    sshDir: dir, appKnownHosts: appKH,
    runner: () => Promise.resolve({ code: 255, stdout: '', stderr: 'denied' }),
  });
  try {
    await post(s, '/generate', { slug: 'jane01', host: '203.0.113.9', user: 'member' });
    await post(s, '/test', { slug: 'jane01' });
    const user = (() => { try { return readFileSync(join(dir, 'known_hosts'), 'utf8'); } catch { return ''; } })();
    assert.ok(!user.includes('AAAAC3realkeyblob'), 'an unverified key never lands in the user file');
  } finally { s.close(); }
});

test('forgetting an identity retires the vault key, never destroys it', async () => {
  // The vault private key is the ONLY thing that can open cold envelopes already
  // sealed to this device (vault.mjs has deliberately no decrypt path without
  // it). Unlinking it orphaned every cold secret permanently, and this path is
  // reachable from the door's "Forget this assistant on this computer" while the
  // box is merely mid-restart, behind a dialog stating nothing is destroyed.
  const { writeFileSync: wf, readdirSync, existsSync: ex } = await import('node:fs');
  const { join: j } = await import('node:path');
  const { removeIdentityAccess } = await import('./member-connect.mjs');

  const sshDir = tmpDir('forget-');
  const alias = 'jane01-box';
  for (const f of [`${alias}.key`, `${alias}.key.pub`, `${alias}.vault.key`, `${alias}.vault.pub`]) {
    wf(j(sshDir, f), `material for ${f}\n`);
  }
  removeIdentityAccess(alias, sshDir, j(sshDir, 'settings.json'));

  assert.ok(!ex(j(sshDir, `${alias}.key`)), 'the ssh key is access and goes');
  assert.ok(!ex(j(sshDir, `${alias}.vault.pub`)), 'the public half goes');
  assert.ok(!ex(j(sshDir, `${alias}.vault.key`)), 'the live vault key is out of the way');
  const retired = readdirSync(sshDir).filter((f) => f.startsWith(`${alias}.vault.key.retired-`));
  assert.equal(retired.length, 1, `the vault key must be RETIRED, not deleted: ${readdirSync(sshDir).join(', ')}`);
});

test('/redeem with an aios-op invite installs the OPERATOR identity: -rock alias, aios-op user', async () => {
  const sshDir = tmp();
  const setPath = join(tmp(), 'settings.json');
  const s = await new Promise((resolve) => {
    const srv = createMemberConnectServer({ port: 0, host: '127.0.0.1', htmlText: '<html>connect</html>',
      claudeSettingsPath: setPath, sshDir,
      // A SIGN-IN PROVIDER, because the solo lane became account-bound (Harriet's audit
      // 2026-08-21, point 5) and these invites are minted on it. These tests are about WHICH
      // SSH IDENTITY gets installed, not about the gate, so they supply the token the gate
      // now asks for rather than asserting the gate away.
      idTokenProvider: async () => 'test.id.token',
    });
    srv.on('listening', () => resolve(srv));
  });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/redeem`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ link: inviteLink('crads-solo', 'acme', 'acme.crads-ai.com|203.0.113.5|aios-op|tok') }),
    });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.alias, 'acme-rock', 'the -rock alias is what flips the app into the org panel');
    const cfg = readFileSync(join(sshDir, 'config'), 'utf8');
    assert.ok(cfg.includes('Host acme-rock'), 'operator Host block missing');
    assert.ok(cfg.includes('User aios-op'), 'a rock is opened as aios-op, never member');
    const set = JSON.parse(readFileSync(setPath, 'utf8'));
    const entry = set.sshConfigs.find((c) => c.id === 'acme-rock');
    assert.ok(entry, 'Claude Code entry missing');
    assert.equal(entry.startDirectory, '/state', 'R18: an operator session lands in /state like every face; /test upgrades it to the rock-named folder');
    assert.equal(entry.name, 'acme (rock)');
  } finally { s.close(); }
});

test('/redeem with a member invite is unchanged by the operator routing', async () => {
  const sshDir = tmp();
  const s = await new Promise((resolve) => {
    const srv = createMemberConnectServer({ port: 0, host: '127.0.0.1', htmlText: '<html>connect</html>',
      claudeSettingsPath: join(tmp(), 'settings.json'), sshDir,
      // A SIGN-IN PROVIDER, because the solo lane became account-bound (Harriet's audit
      // 2026-08-21, point 5) and these invites are minted on it. These tests are about WHICH
      // SSH IDENTITY gets installed, not about the gate, so they supply the token the gate
      // now asks for rather than asserting the gate away.
      idTokenProvider: async () => 'test.id.token',
    });
    srv.on('listening', () => resolve(srv));
  });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/redeem`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ link: inviteLink('crads-solo', 'jane01', 'jane01.crads-ai.com|203.0.113.6|member|tok') }),
    });
    const j = await r.json();
    assert.equal(j.alias, 'jane01-box');
    const cfg = readFileSync(join(sshDir, 'config'), 'utf8');
    assert.ok(cfg.includes('Host jane01-box') && cfg.includes('User member'));
  } finally { s.close(); }
});

// ------------------------------------------- the self-serve ROCK claim (2026-08-10)
// Hit live on test-org-4. `/redeem` routes an aios-op invite to the OPERATOR
// identity (`<slug>-rock`) and registers it in Claude Code immediately, but
// both of member-connect.html's `/test` calls hardcoded kind:'member', so the
// whoami went to a `<slug>-box` that a rock claim never installs. It could not
// pass, which meant approvedUi() never fired (the page polled "your rock hasn't
// approved this device" forever, even once approved) and, the real damage,
// pinHostForUser() never ran: the connection sat registered-but-un-pinned and
// the app, which reads only ~/.ssh/known_hosts, answered "Host denied
// (verification failed)".

test('rock claim: /redeem hands back the kind and the page test PINS the verified key', async () => {
  const sshDir = tmp();
  const appKH = join(sshDir, 'app-known-hosts');
  // our bridge learned the rock's key under accept-new during the connect test
  writeFileSync(appKH, '203.0.113.5 ssh-ed25519 AAAAC3rockhostkey\n');
  const calls = [];
  const connected = [];
  const s = await listen({
    sshDir, appKnownHosts: appKH,
    onConnected: (x) => connected.push(x),
    stageWithDirectory: async () => false,
    // see the note above: the solo lane asks for a sign-in now, and these tests are about
    // the kind/alias handed back and the host-key pin, not about the gate. Without this the
    // redeem 401s, nothing is installed, and the assertions below would pass vacuously.
    idTokenProvider: async () => 'test.id.token',
    runner: (host) => { calls.push(host); return Promise.resolve({ code: 0, stdout: 'aios-op\n', stderr: '' }); },
  });
  try {
    const r = await (await post(s, '/redeem', {
      link: inviteLink('crads-solo', 'test-org-4', 'test-org-4.crads-ai.com|203.0.113.5|aios-op|tok'),
    })).json();
    assert.equal(r.alias, 'test-org-4-rock');
    assert.equal(r.kind, 'operator', 'the page cannot infer the kind: the invite hash is gone by now');

    // exactly the call member-connect.html makes, with what /redeem just handed it
    const t = await (await post(s, '/test', { slug: r.slug, kind: r.kind })).json();
    assert.equal(t.ok, true, 'a rock claim must be testable, or approvedUi() never fires');
    assert.deepEqual([...new Set(calls)], ['test-org-4-rock'], 'a rock is tested over its -rock alias');
    assert.deepEqual(connected, [{ kind: 'operator', alias: 'test-org-4-rock' }]);
    const user = readFileSync(join(sshDir, 'known_hosts'), 'utf8');
    assert.ok(user.includes('AAAAC3rockhostkey'),
      'the verified rock key must reach ~/.ssh/known_hosts, the only file the app reads');
  } finally { s.close(); }
});

test('rock claim: a caller that mislabels the kind still pins, and reports what it actually tested', async () => {
  // Braces to the belt above: the ssh config gets the last word on which identity
  // this machine has for a slug, so no future caller can re-open the un-pinned
  // "Host denied" hole by guessing 'member'. The kind reported to onConnected
  // follows the alias that won, never the form, so the wrong dashboard cannot open.
  const sshDir = tmp();
  const appKH = join(sshDir, 'app-known-hosts');
  writeFileSync(appKH, '203.0.113.5 ssh-ed25519 AAAAC3rockhostkey\n');
  const calls = [];
  const connected = [];
  const s = await listen({
    sshDir, appKnownHosts: appKH,
    onConnected: (x) => connected.push(x),
    stageWithDirectory: async () => false,
    // see the note above: the solo lane asks for a sign-in now, and these tests are about
    // the kind/alias handed back and the host-key pin, not about the gate. Without this the
    // redeem 401s, nothing is installed, and the assertions below would pass vacuously.
    idTokenProvider: async () => 'test.id.token',
    runner: (host) => { calls.push(host); return Promise.resolve({ code: 0, stdout: 'aios-op\n', stderr: '' }); },
  });
  try {
    await post(s, '/redeem', {
      link: inviteLink('crads-solo', 'test-org-4', 'test-org-4.crads-ai.com|203.0.113.5|aios-op|tok'),
    });
    const t = await (await post(s, '/test', { slug: 'test-org-4', kind: 'member' })).json();
    assert.equal(t.ok, true);
    assert.deepEqual([...new Set(calls)], ['test-org-4-rock'], 'no Host block for -box, so the -rock that exists is tested');
    assert.deepEqual(connected, [{ kind: 'operator', alias: 'test-org-4-rock' }], 'kind follows the alias, not the form');
    assert.ok(readFileSync(join(sshDir, 'known_hosts'), 'utf8').includes('AAAAC3rockhostkey'), 'still pinned');
  } finally { s.close(); }
});

test('member-connect.html carries the redeemed kind on every /test call', async () => {
  const html = readFileSync(new URL('./member-connect.html', import.meta.url), 'utf8');
  const calls = html.match(/post\('\/test',[^)]*\)/g) || [];
  assert.equal(calls.length, 2, `expected the poll + the button /test calls, found ${calls.length}`);
  for (const c of calls) {
    assert.match(c, /kind:\s*redeemedKind/, `a hardcoded kind is the test-org-4 bug: ${c}`);
  }
});

// ---------------------------------------------------------------------------
// 2026-08-14: a block that EXISTS is not a block that WORKS.
//
// installAccess skipped out whenever the `Host <alias>` line was already there,
// so a block carrying a wrong address could never be repaired by re-running the
// flow. That is what every device enrolled against a pebble was left holding
// when the registered address turned out to be the Cloudflare-proxied name,
// which carries no port 22: the machine kept dialling the edge, the door kept
// saying "not answering yet", and the only escape was Forget-then-reconnect.
// ---------------------------------------------------------------------------

test('installAccess repairs a stale HostName rather than skipping the block', () => {
  const sshDir = tmp();
  installMemberAccess({ slug: 'jane01', host: 'jane01.crads-ai.com', user: 'member' }, sshDir);
  assert.match(readFileSync(join(sshDir, 'config'), 'utf8'), /HostName jane01\.crads-ai\.com/);

  const again = installMemberAccess({ slug: 'jane01', host: '203.0.113.5', user: 'member' }, sshDir);
  const cfg = readFileSync(join(sshDir, 'config'), 'utf8');
  assert.equal(again.configUpdated, false, 'the block was already there');
  assert.equal(again.configRepaired, true, 'and its address was wrong, so it was corrected');
  assert.match(cfg, /HostName 203\.0\.113\.5/, 'the dialable address won');
  assert.doesNotMatch(cfg, /HostName jane01\.crads-ai\.com/, 'the dead one is gone');
  assert.equal(cfg.match(/Host jane01-box/g).length, 1, 'repaired in place, never duplicated');
});

test('installAccess repairs a stale User the same way', () => {
  const sshDir = tmp();
  installMemberAccess({ slug: 'jane01', host: '203.0.113.5', user: 'node' }, sshDir);
  const again = installMemberAccess({ slug: 'jane01', host: '203.0.113.5', user: 'member' }, sshDir);
  assert.equal(again.configRepaired, true);
  assert.match(readFileSync(join(sshDir, 'config'), 'utf8'), /User member/);
});

test('a correct block is left completely alone', () => {
  const sshDir = tmp();
  installMemberAccess({ slug: 'jane01', host: '203.0.113.5', user: 'member' }, sshDir);
  const before = readFileSync(join(sshDir, 'config'), 'utf8');
  const again = installMemberAccess({ slug: 'jane01', host: '203.0.113.5', user: 'member' }, sshDir);
  assert.equal(again.configRepaired, false, 'nothing to repair means nothing is written');
  assert.equal(readFileSync(join(sshDir, 'config'), 'utf8'), before);
});

test('the repair touches only this alias, and only the two lines it owns', () => {
  const sshDir = tmp();
  installMemberAccess({ slug: 'jane01', host: 'jane01.crads-ai.com', user: 'member' }, sshDir);
  // a directive the person added, and a neighbouring identity that must not move
  appendFileSync(join(sshDir, 'config'), '  ServerAliveInterval 30\n\nHost other-box\n  HostName jane01.crads-ai.com\n  User member\n');
  installMemberAccess({ slug: 'jane01', host: '203.0.113.5', user: 'member' }, sshDir);
  const cfg = readFileSync(join(sshDir, 'config'), 'utf8');
  assert.match(cfg, /ServerAliveInterval 30/, 'what the person added is theirs and survives');
  const other = cfg.slice(cfg.indexOf('Host other-box'));
  assert.match(other, /HostName jane01\.crads-ai\.com/, 'a different alias is none of our business');
});

test('removeHostBlock drops the block and nothing else', () => {
  const sshDir = tmp();
  const a = installMemberAccess({ slug: 'jane01', host: '203.0.113.5', user: 'member' }, sshDir);
  const r = removeHostBlock('jane01-box', sshDir);
  assert.equal(r.configUpdated, true);
  assert.equal(r.hostName, '203.0.113.5', 'it reports what the block was dialling');
  assert.doesNotMatch(readFileSync(join(sshDir, 'config'), 'utf8'), /Host jane01-box/);
  // the whole point of the narrow version: the key a staged enrol request is
  // bound to must survive, or the request strands against a key that is gone
  assert.ok(existsSync(a.keyPath), 'the keypair stays');
  assert.ok(existsSync(join(sshDir, 'jane01-box.vault.key')), 'and so does the vault key');
});

test('removeHostBlock refuses an alias that is not a wizard identity', () => {
  assert.throws(() => removeHostBlock('github.com', tmp()));
});
