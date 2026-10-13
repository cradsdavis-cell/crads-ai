// restore.test.mjs: a dead mineral's backup comes back onto a new one, and the
// restore never costs the member their way in. Run: node --test engine/restore.test.mjs
//
// The round trip is real on both ends: the OLD mineral's snapshot is written by
// the actual engine/backup.mjs (so the passphrase, cipher and archive layout are
// the ones members have in their repositories), and the actual engine/restore.mjs
// opens it on a NEW mineral. Two bare repositories stand in for the member's
// GitHub: the old brain's (read only, must not change) and the new one's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../tests/tmp-dir.mjs';
import { checkEntries, resolveSource } from './restore.mjs';
import { encryptArgs, PASS_ENV } from './lib/snapshot-cipher.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKUP = join(HERE, 'backup.mjs');
const RESTORE = join(HERE, 'restore.mjs');
const IGNORE = join(HERE, 'lib', 'brain-ignore.txt');
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const g = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...ID } }).trim();
const OLD_KEY = 'ssh-ed25519 AAAAOLDKEYOLDKEYOLDKEY old-laptop';
const NEW_KEY = 'ssh-ed25519 AAAANEWKEYNEWKEYNEWKEY new-laptop';
const device = (key) => `label: "This computer"\nstatus: "active"\nadded: "2026-10-13"\nrevoked: ""\nlast_seen: ""\nvaultkey: ""\npubkeys:\n  - ${key}\n`;

function bare(root, name) {
  const p = join(root, name);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', p]);
  return p;
}

function seedBox(dir, { name, key, user, extra = () => {} }) {
  mkdirSync(join(dir, 'wiki'), { recursive: true });
  mkdirSync(join(dir, 'devices'), { recursive: true });
  copyFileSync(IGNORE, join(dir, '.gitignore'));
  writeFileSync(join(dir, 'profile.yaml'), `identity:\n  assistant_name: "${name}"\n  user_short: "${user}"\n`);
  writeFileSync(join(dir, 'box-name'), name);
  writeFileSync(join(dir, 'open-folder'), name + '\n');
  symlinkSync('.', join(dir, name));
  writeFileSync(join(dir, 'devices', 'this-computer.yaml'), device(key));
  extra(dir);
  execFileSync('git', ['init', '-q', '-b', 'master', dir]);
}

// The old mineral, as it stood the night before it died, pushed to its repo.
function oldMineral(root) {
  const dir = join(root, 'old');
  const repo = bare(root, 'old-brain.git');
  seedBox(dir, { name: 'oldname', key: OLD_KEY, user: 'Ana', extra: (d) => {
    writeFileSync(join(d, 'wiki', 'clients.md'), '# Clients\nThe page the member cares about.\n');
    mkdirSync(join(d, 'secrets'), { recursive: true });
    writeFileSync(join(d, 'secrets', 'telegram_bot_token'), 'OLD-BOT-TOKEN\n', { mode: 0o644 });
    writeFileSync(join(d, 'secrets', 'telegram_chat_id'), '4242\n');
    mkdirSync(join(d, '.claude-auth'), { recursive: true });
    writeFileSync(join(d, '.claude-auth', '.credentials.json'), '{"old":"claude"}\n', { mode: 0o644 });
    mkdirSync(join(d, '.kernel', 'gh'), { recursive: true });
    writeFileSync(join(d, '.kernel', 'gh', 'hosts.yml'), 'github.com: old\n');
    writeFileSync(join(d, '.mcp.json'), '{"mcpServers":{"old":{}}}\n');
    // connections signed in through a browser keep their tokens here, not in .mcp.json
    writeFileSync(join(d, '.kernel', 'mcp-oauth.json'), '{"notion":{"refresh":"old"}}\n');
    mkdirSync(join(d, '.kernel', 'google-creds'), { recursive: true });
    writeFileSync(join(d, '.kernel', 'google-creds', 'ana@example.com.json'), '{"refresh_token":"old"}\n');
  } });
  g(dir, 'remote', 'add', 'origin', repo);
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'old life');
  g(dir, 'push', '-q', '-u', 'origin', 'master');
  // Two nights: the first mints the passphrase after tarring (so that snapshot
  // does not carry it), the second is a normal night that does.
  const first = spawnSync('node', [BACKUP, dir], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const pass = first.stdout.match(/PASSPHRASE ([0-9a-f]{64})/)[1];
  const second = spawnSync('node', [BACKUP, dir], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  return { dir, repo, pass };
}

// The new mineral, straight out of the wizard with "Connect my GitHub" done.
function newMineral(root) {
  const dir = join(root, 'new');
  const repo = bare(root, 'new-brain.git');
  seedBox(dir, { name: 'newname', key: NEW_KEY, user: '', extra: (d) => {
    writeFileSync(join(d, 'wiki', 'priorities.md'), '# Priorities\n_(populated by /onboard)_\n');
    mkdirSync(join(d, 'secrets'), { recursive: true });
    writeFileSync(join(d, 'secrets', 'backup_passphrase'), 'f'.repeat(64) + '\n', { mode: 0o600 });
    writeFileSync(join(d, 'secrets', 'code-server-password'), 'new-pw\n', { mode: 0o600 });
  } });
  g(dir, 'remote', 'add', 'origin', repo);
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'own-brain: snapshot');
  g(dir, 'push', '-q', '-u', 'origin', 'master');
  return { dir, repo };
}

const restore = (dir, args, pass) => spawnSync('node', [RESTORE, dir, ...args], {
  encoding: 'utf8', env: { ...process.env, ...(pass ? { [PASS_ENV]: pass } : {}) } });
const read = (...p) => readFileSync(join(...p), 'utf8');

test('the old brain and its settings come back onto a new mineral, and the door stays the new one', () => {
  const root = tmpDir('restore-');
  const old = oldMineral(root);
  const nu = newMineral(root);
  const oldTip = g(old.repo, 'rev-parse', 'master');
  const newBefore = g(nu.dir, 'rev-parse', 'HEAD');

  const r = restore(nu.dir, ['--from', old.repo], old.pass);
  assert.equal(r.status, 0, r.stderr + r.stdout);

  // the brain
  assert.match(read(nu.dir, 'wiki', 'clients.md'), /The page the member cares about/);
  // THE DOOR: the new computer's key, never the dead mineral's
  assert.match(read(nu.dir, 'devices', 'this-computer.yaml'), /NEWKEY/);
  assert.doesNotMatch(read(nu.dir, 'devices', 'this-computer.yaml'), /OLDKEY/);
  // this mineral's name, and the folder the app opens, are kept
  assert.equal(read(nu.dir, 'box-name').trim(), 'newname');
  assert.equal(read(nu.dir, 'open-folder').trim(), 'newname');
  assert.ok(existsSync(join(nu.dir, 'newname')), 'the named folder link the app opens is gone');
  const profile = read(nu.dir, 'profile.yaml');
  assert.match(profile, /assistant_name: "newname"/);
  assert.match(profile, /user_short: "Ana"/, 'the old profile did not come back');
  // the snapshot
  assert.equal(read(nu.dir, 'secrets', 'telegram_bot_token').trim(), 'OLD-BOT-TOKEN');
  assert.equal(read(nu.dir, '.claude-auth', '.credentials.json').trim(), '{"old":"claude"}');
  assert.equal(read(nu.dir, '.kernel', 'gh', 'hosts.yml').trim(), 'github.com: old');
  assert.match(read(nu.dir, '.mcp.json'), /"old"/);
  // without these the connections listed in .mcp.json come back signed out
  assert.match(read(nu.dir, '.kernel', 'mcp-oauth.json'), /notion/);
  assert.match(read(nu.dir, '.kernel', 'google-creds', 'ana@example.com.json'), /refresh_token/);
  assert.equal(read(nu.dir, 'secrets', 'code-server-password').trim(), 'new-pw', 'a secret only the new mineral had was lost');
  // permission fix: nothing restored is readable by anyone but the mineral's account
  assert.equal(statSync(join(nu.dir, 'secrets', 'telegram_bot_token')).mode & 0o077, 0);
  assert.equal(statSync(join(nu.dir, '.claude-auth', '.credentials.json')).mode & 0o077, 0);
  // the passphrase the member holds stays the one in use, and is recorded as held
  assert.equal(read(nu.dir, 'secrets', 'backup_passphrase').trim(), old.pass);
  assert.ok(existsSync(join(nu.dir, 'secrets', 'backup_passphrase.escrowed')));
  // both histories survive, nothing secret is tracked, and it went to the NEW repo
  assert.equal(spawnSync('git', ['-C', nu.dir, 'merge-base', '--is-ancestor', oldTip, 'HEAD']).status, 0);
  assert.equal(spawnSync('git', ['-C', nu.dir, 'merge-base', '--is-ancestor', newBefore, 'HEAD']).status, 0);
  assert.equal(g(nu.dir, 'ls-files', 'secrets', '.claude-auth', '.kernel', '.mcp.json'), '');
  assert.equal(g(nu.repo, 'rev-parse', 'master'), g(nu.dir, 'rev-parse', 'HEAD'));
  assert.equal(g(nu.dir, 'status', '--porcelain'), '');
  // the backup itself is read, never written
  assert.equal(g(old.repo, 'rev-parse', 'master'), oldTip);
});

test('a restored mineral backs itself up again with the passphrase the member already holds', () => {
  const root = tmpDir('restore-');
  const old = oldMineral(root);
  const nu = newMineral(root);
  assert.equal(restore(nu.dir, ['--from', old.repo], old.pass).status, 0);
  const b = spawnSync('node', [BACKUP, nu.dir], { encoding: 'utf8' });
  assert.equal(b.status, 0, b.stderr);
  assert.doesNotMatch(b.stdout, /GENERATED a new backup passphrase/);
  assert.match(b.stdout, /recoverable=true/);
  // and that new snapshot opens with the same passphrase
  const check = restore(nu.dir, ['--snapshot', join(nu.dir, 'backups', 'state-snapshot.tar.gz.enc'), '--dry-run'], old.pass);
  assert.equal(check.status, 0, check.stderr);
});

test('a wrong passphrase stops the restore before anything changes', () => {
  const root = tmpDir('restore-');
  const old = oldMineral(root);
  const nu = newMineral(root);
  const head = g(nu.dir, 'rev-parse', 'HEAD');
  const r = restore(nu.dir, ['--from', old.repo], 'a'.repeat(64));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /passphrase does not open this snapshot/);
  assert.equal(g(nu.dir, 'rev-parse', 'HEAD'), head);
  assert.ok(!existsSync(join(nu.dir, 'wiki', 'clients.md')));
  assert.ok(!existsSync(join(nu.dir, 'secrets', 'telegram_bot_token')));
});

test('a dry run checks the passphrase and changes nothing', () => {
  const root = tmpDir('restore-');
  const old = oldMineral(root);
  const nu = newMineral(root);
  const head = g(nu.dir, 'rev-parse', 'HEAD');
  const r = restore(nu.dir, ['--from', old.repo, '--dry-run'], old.pass);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /opens with that passphrase/);
  assert.equal(g(nu.dir, 'rev-parse', 'HEAD'), head);
  assert.ok(!existsSync(join(nu.dir, 'secrets', 'telegram_bot_token')));
});

test('--without-telegram leaves the old bot behind', () => {
  const root = tmpDir('restore-');
  const old = oldMineral(root);
  const nu = newMineral(root);
  const r = restore(nu.dir, ['--from', old.repo, '--without-telegram'], old.pass);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(nu.dir, 'secrets', 'telegram_bot_token')));
  assert.ok(!existsSync(join(nu.dir, 'secrets', 'telegram_chat_id')));
  assert.ok(existsSync(join(nu.dir, '.claude-auth', '.credentials.json')));
});

test('--list names the snapshots, --ref restores an earlier one', () => {
  const root = tmpDir('restore-');
  const old = oldMineral(root);
  const first = g(old.dir, 'log', '--format=%h', '-1', '--', 'backups/state-snapshot.tar.gz.enc');
  // a later night with a different bot token
  writeFileSync(join(old.dir, 'secrets', 'telegram_bot_token'), 'LATER-TOKEN\n');
  assert.equal(spawnSync('node', [BACKUP, old.dir]).status, 0);
  const nu = newMineral(root);
  const l = restore(nu.dir, ['--from', old.repo, '--list']);
  assert.equal(l.status, 0, l.stderr);
  assert.match(l.stdout, new RegExp(first));
  const r = restore(nu.dir, ['--from', old.repo, '--ref', first, '--no-push'], old.pass);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(nu.dir, 'secrets', 'telegram_bot_token').trim(), 'OLD-BOT-TOKEN');
});

test('no snapshot in the repository: the brain alone comes back with --no-snapshot', () => {
  const root = tmpDir('restore-');
  const dir = join(root, 'old');
  const repo = bare(root, 'old-brain.git');
  seedBox(dir, { name: 'oldname', key: OLD_KEY, user: 'Ana', extra: (d) => writeFileSync(join(d, 'wiki', 'clients.md'), '# Clients\n') });
  g(dir, 'remote', 'add', 'origin', repo); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'old'); g(dir, 'push', '-q', '-u', 'origin', 'master');
  const nu = newMineral(root);
  const refused = restore(nu.dir, ['--from', repo]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--no-snapshot/);
  const r = restore(nu.dir, ['--from', repo, '--no-snapshot']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(nu.dir, 'wiki', 'clients.md')));
  assert.match(read(nu.dir, 'devices', 'this-computer.yaml'), /NEWKEY/);
});

test('a snapshot that tries to write the door is refused, whatever it holds', () => {
  const root = tmpDir('restore-');
  const nu = newMineral(root);
  const src = join(root, 'evil'); mkdirSync(join(src, 'devices'), { recursive: true });
  writeFileSync(join(src, 'profile.yaml'), 'x: 1\n');
  writeFileSync(join(src, 'devices', 'this-computer.yaml'), device('ssh-ed25519 AAAAATTACKER x'));
  const tgz = join(root, 'evil.tar.gz'); const enc = join(root, 'evil.enc');
  execFileSync('tar', ['czf', tgz, '-C', src, 'profile.yaml', 'devices']);
  execFileSync('openssl', encryptArgs(tgz, enc), { env: { ...process.env, [PASS_ENV]: 'p' } });
  const r = restore(nu.dir, ['--snapshot', enc], 'p');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /must never overwrite/);
  assert.match(read(nu.dir, 'devices', 'this-computer.yaml'), /NEWKEY/);
});

test('checkEntries refuses paths that leave the mineral or touch the door', () => {
  assert.deepEqual(checkEntries(['secrets/', 'secrets/a', '.claude-auth/x', 'profile.yaml', '.kernel/gh/hosts.yml', '']),
    ['.claude-auth', '.kernel', 'profile.yaml', 'secrets']);
  for (const bad of ['/etc/passwd', '../x', 'secrets/../../x', 'devices/a.yaml', 'ssh/member/authorized_keys', 'support/access.json', '.git/config', 'backups/x']) {
    assert.throws(() => checkEntries([bad]), undefined, bad);
  }
  assert.throws(() => checkEntries([]));
});

test('resolveSource takes owner/name or a github address, nothing else remote', () => {
  assert.equal(resolveSource('ana/ana-brain'), 'https://github.com/ana/ana-brain.git');
  assert.equal(resolveSource('https://github.com/ana/ana-brain'), 'https://github.com/ana/ana-brain.git');
  assert.equal(resolveSource('/tmp/copy.git'), '/tmp/copy.git');
  for (const bad of ['', 'http://github.com/a/b', 'https://evil.example/a/b', 'git@github.com:a/b.git', 'a/b/c', '--upload-pack=x']) {
    assert.throws(() => resolveSource(bad), undefined, bad);
  }
});

test('backup.mjs and restore.mjs share one cipher definition', () => {
  // If either goes back to spelling its own openssl flags, a change to one of
  // them would make every member's snapshot unopenable by the tool meant to open it.
  for (const f of [BACKUP, RESTORE]) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /lib\/snapshot-cipher\.mjs/, `${f} no longer uses the shared cipher`);
    assert.doesNotMatch(src, /'-iter'/, `${f} spells its own cipher flags again`);
  }
});
