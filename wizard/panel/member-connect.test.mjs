// member-connect.test.mjs: the surviving identity-install machinery (D44).
//   node --test wizard/panel/member-connect.test.mjs
//
// The member-connect SURFACE (invite page + server + invite parsing + central
// staging + join-org/my-orgs) was deleted 2026-09-01 with the invitation
// system, and its tests went with it. What this file still pins is the
// machinery that provision-routes and device-routes run on this machine:
// install/repair/remove of the ~/.ssh identity and its vault keypair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { installMemberAccess, removeIdentityAccess, removeHostBlock } from './member-connect.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const tmp = () => tmpDir('pp-mc-');

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
