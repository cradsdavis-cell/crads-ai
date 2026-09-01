// backup-sentinel.test.mjs — a box must not fail its backup over a file it was
// never supposed to have. Run: node --test engine/backup-sentinel.test.mjs
//
// Why this file exists. engine/policy.json lists `secrets/telegram_bot_token`
// in sentinel_files, and the verify step asserted every sentinel was in the
// archive unconditionally. That file appears only when a member runs
// connect-telegram, which box-up prints as an OPTIONAL pending step. So every
// Telegram-less box wrote a good, decryptable snapshot at 03:40, threw
// `verify: sentinel missing/empty: secrets/telegram_bot_token`, recorded
// status=fail in the run ledger, and — because the throw lands BEFORE the
// commit+push block — never sent the blob to the owner's own repo. Nightly,
// since 2026-07-14, showing on the Health card as a red FAILED row.
//
// The harness could not catch it: harness/provision-box.mjs seeds a fake bot
// token into every persona box, so the sentinel was always satisfied in test
// and only real self-serve boxes were affected. That is what the first test
// here pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'backup.mjs');
const POLICY = JSON.parse(readFileSync(join(HERE, 'policy.json'), 'utf8')).backup || {};

const run = (state) => {
  const r = spawnSync('node', [SCRIPT, state], { encoding: 'utf8' });
  const hb = join(state, 'backups', 'heartbeat.json');
  r.heartbeat = existsSync(hb) ? JSON.parse(readFileSync(hb, 'utf8')) : null;
  return r;
};

// A box as self-serve provisioning actually leaves it: a profile, a secrets dir
// with the credentials the box makes for itself, and no optional connections.
function stateDir({ telegram = false, claude = false } = {}) {
  const d = tmpDir('aios-backup-test-');
  writeFileSync(join(d, 'profile.yaml'), 'slug: test-box\n');
  mkdirSync(join(d, 'secrets'), { recursive: true });
  writeFileSync(join(d, 'secrets', 'code_server_password'), 'pw\n');
  if (telegram) writeFileSync(join(d, 'secrets', 'telegram_bot_token'), 'TEST-BOT-TOKEN\n');
  if (claude) { mkdirSync(join(d, '.claude-auth'), { recursive: true }); writeFileSync(join(d, '.claude-auth', 'creds.json'), '{}\n'); }
  return d;
}

test('policy still names an optional connection as a sentinel (the trap this guards)', () => {
  // If someone prunes the telegram sentinel from policy.json, the tests below
  // stop proving anything and this line says so out loud rather than passing
  // silently. Delete this test only together with the conditional logic.
  assert.ok((POLICY.sentinel_files || []).includes('secrets/telegram_bot_token'),
    'policy.json no longer lists the optional telegram sentinel: re-point this suite at whatever optional sentinel replaced it');
});

test('a box with no Telegram connected backs up green', () => {
  const d = stateDir({ telegram: false });
  const r = run(d);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.equal(r.heartbeat.ok, true);
  assert.ok(existsSync(join(d, 'backups', 'state-snapshot.tar.gz.enc')), 'no snapshot written');
});

test('a box WITH Telegram still verifies that sentinel', () => {
  const d = stateDir({ telegram: true, claude: true });
  const r = run(d);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.equal(r.heartbeat.ok, true);
  // present targets + the sentinels that apply on THIS box, both reported
  assert.match(r.stdout, /2\/2 sentinels verified/);
});

test('a target that goes missing from the archive still fails the run', () => {
  // The round-trip half of the assertion, which is what carries the verify now
  // that sentinels are conditional. tar is handed the target list, so the way
  // to break the round trip without breaking tar is to make a target
  // unreadable: tar then exits non-zero and the run must not report ok.
  const d = stateDir({ telegram: false });
  const secret = join(d, 'secrets');
  spawnSync('chmod', ['000', secret]);
  const r = run(d);
  spawnSync('chmod', ['700', secret]);   // leave the tmpdir removable
  if (process.getuid && process.getuid() === 0) return;   // root reads anything
  assert.notEqual(r.status, 0, 'unreadable target must not report success');
  assert.equal(r.heartbeat.ok, false);
});

test('heartbeat carries the reason on failure, not just a red flag', () => {
  const d = tmpDir('aios-backup-test-');   // no profile.yaml
  const r = run(d);
  assert.equal(r.status, 2, 'a non-state dir should be rejected before any work');
  assert.match(r.stderr, /does not look like a state dir/);
});

// 2026-08-20 audit: an offsite blob nobody can decrypt is not a backup.
// The passphrase is minted on the box and its only other copy is inside the
// archive it encrypts, so unless a human took the value off the box, a dead VM
// cannot restore itself. The run used to announce the FILE and tell the operator
// to "copy it" without ever printing the value, into a cron log going nowhere,
// while reporting ok:true and offsite:true.
test('the passphrase is printed by value when it is minted, and the run says so loudly', () => {
  const src = readFileSync(new URL('./backup.mjs', import.meta.url), 'utf8');
  assert.match(src, /backup: PASSPHRASE \$\{fresh\}/, 'the operator is shown the value they are told to store');
  assert.match(src, /backup_passphrase\.escrowed/, 'there is a marker recording that it was taken off the box');
});

test('the heartbeat separates "it left the box" from "somebody can decrypt it"', () => {
  const src = readFileSync(new URL('./backup.mjs', import.meta.url), 'utf8');
  assert.match(src, /recoverable: offsite && escrowed/,
    'recoverable requires BOTH the ciphertext offsite and the key escrowed');
  assert.match(src, /warning: 'the backup passphrase has not been recorded off this box/,
    'an un-escrowed snapshot carries the reason it is not recoverable, not a bare flag');
});

// 2026-08-20 audit: a failed run must not take last night's backup with it.
test('the snapshot is staged beside the real one and only replaces it once verified', () => {
  const src = readFileSync(new URL('./backup.mjs', import.meta.url), 'utf8');
  const staged = src.indexOf("const staged = OUT + '.tmp'");
  const rename = src.indexOf('renameSync(staged, OUT)');
  const verify = src.indexOf("'-in', staged, '-out', verifyTar");
  assert.ok(staged > -1 && rename > -1 && verify > -1, 'staging, verify and promote all present');
  assert.ok(staged < verify, 'the blob is written to the staging path first');
  assert.ok(verify < rename,
    'the decrypt-verify runs BEFORE the promote: encrypting straight over OUT destroyed the last good snapshot before anything proved the new one could restore');
  assert.match(src, /rmSync\(OUT \+ '\.tmp', \{ force: true \}\)/,
    'and a blob that failed the verify is cleaned up, not left beside the real one');
});
