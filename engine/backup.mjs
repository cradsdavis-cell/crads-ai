// engine/backup.mjs — nightly encrypted snapshot of a client box's NON-GIT state (2026-07-14,
// propagated from the operator's second-brain hardening; closes the known-issues "no offsite
// recovery for box state" gap for everything the brain repo's .gitignore excludes).
//
// What dies with a client VM today: .claude-auth/ (the client's Claude OAuth), secrets/
// (telegram bot token + chat id, code-server password), .kernel/gh (GitHub auth), the box
// crontab, .mcp.json. All gitignored by design — so connect-github's brain-repo push never
// carries them. This script tars those targets, encrypts (AES-256-CBC, pbkdf2, per-box
// passphrase), and writes the blob to <state>/backups/ — which IS tracked, so it rides the
// normal brain-repo commit+push to the CLIENT'S OWN GitHub (encrypted: the repo only ever
// sees ciphertext). No remote connected -> the blob stays local and the heartbeat says so.
//
// Passphrase: <state>/secrets/backup_passphrase, auto-generated on first run and PRINTED BY
// VALUE on the run that mints it. Its only other copy is inside the backup it encrypts, so
// the operator must store it off-box or a dead VM cannot decrypt its own snapshot. Touching
// secrets/backup_passphrase.escrowed records that they did; until then the heartbeat reports
// recoverable:false, because an offsite blob nobody can decrypt is not a backup.
//
// Run: node engine/backup.mjs <state-dir>     (cadence: gen-crontab emits a 03:40 line)
// Restore: docs/box-restore-runbook.md
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, statSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const stateDir = path.resolve(process.argv[2] || process.env.STATE_DIR || '.');
if (!existsSync(path.join(stateDir, 'profile.yaml'))) {
  console.error(`backup: ${stateDir} does not look like a state dir (no profile.yaml)`);
  process.exit(2);
}
const ENGINE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(stateDir, 'backups');
const OUT = path.join(OUT_DIR, 'state-snapshot.tar.gz.enc');
const HEARTBEAT = path.join(OUT_DIR, 'heartbeat.json');

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
const policy = (() => {
  try { return JSON.parse(readFileSync(path.join(ENGINE, 'policy.json'), 'utf8')).backup || {}; }
  catch { return {}; }
})();
const TARGETS = policy.targets || ['secrets', '.claude-auth', '.claude', '.mcp.json', '.kernel/gh', '.kernel/crontab', '.kernel/telegram-offset', 'profile.yaml'];
const SENTINELS = policy.sentinel_files || ['profile.yaml'];

// The escrow marker. The passphrase is minted ON the box and its only copy is
// inside the backup it encrypts, so a snapshot is recoverable ONLY if a human
// has taken the value off the box. Nothing here can verify that they did, so we
// record the one thing we can: whether anybody ever said so. Until they have,
// the heartbeat refuses to call the backup recoverable (2026-08-20 audit).
const ESCROW = path.join(stateDir, 'secrets', 'backup_passphrase.escrowed');

function passphrase() {
  const p = path.join(stateDir, 'secrets', 'backup_passphrase');
  if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  const fresh = randomBytes(32).toString('hex');
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, fresh + '\n', { mode: 0o600 });
  // PRINT THE VALUE (2026-08-20 audit). This used to name the file and then say
  // "copy it to the password manager NOW", without ever showing what to copy,
  // into a cron log going to /dev/null. So no operator ever held the key, and
  // every nightly blob pushed to the member's own GitHub was undecryptable the
  // moment the VM died: an offsite backup that could never be restored, while
  // the run reported ok and offsite true and the sentinel test pinned it green.
  console.log('backup: GENERATED a new backup passphrase.');
  console.log(`backup: PASSPHRASE ${fresh}`);
  console.log('backup: >>> OPERATOR ACTION: store that value off this box NOW. Its only other copy is inside the backup it encrypts, so a dead VM cannot decrypt its own snapshot without it. <<<');
  console.log(`backup: then run: touch ${ESCROW}   (until that exists the heartbeat reports the snapshot as NOT recoverable)`);
  return fresh;
}

const staging = mkdtempSync(path.join(tmpdir(), 'aios-backup-'));
try {
  const present = TARGETS.filter((t) => existsSync(path.join(stateDir, t)));
  if (!present.length) throw new Error('no backup targets present in state dir');
  const tarPath = path.join(staging, 'state.tar.gz');
  sh('tar', ['czf', tarPath, '-C', stateDir, ...present]);

  mkdirSync(OUT_DIR, { recursive: true });
  const env = { ...process.env, AIOS_BACKUP_PASSPHRASE: passphrase() };
  // WRITE BESIDE, VERIFY, THEN REPLACE (2026-08-20 audit). This encrypted
  // straight over OUT, the single canonical snapshot path, and only decrypted it
  // afterwards to check the round trip. So a failed or truncated run destroyed
  // last night's good blob before anything had proven tonight's could restore,
  // and the catch below then recorded ok:false over a file that was already
  // gone. On a box with no remote that is the only copy. Staging next to it
  // costs one rename and means the previous snapshot survives every failure mode
  // between here and the assertions.
  const staged = OUT + '.tmp';
  sh('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt',
    '-in', tarPath, '-out', staged, '-pass', 'env:AIOS_BACKUP_PASSPHRASE'], { env });

  // decrypt-verify + sentinel extraction: a backup that can't restore is theatre
  const verifyTar = path.join(staging, 'verify.tar.gz');
  sh('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000',
    '-in', staged, '-out', verifyTar, '-pass', 'env:AIOS_BACKUP_PASSPHRASE'], { env });
  const drill = path.join(staging, 'drill');
  mkdirSync(drill);
  sh('tar', ['xzf', verifyTar, '-C', drill]);
  // WHAT THE VERIFY ACTUALLY ASSERTS (fixed 2026-08-09): everything that went
  // into the blob comes back out of it. It used to assert that every name in
  // policy.json's sentinel_files was in the archive, unconditionally — and that
  // list carries `secrets/telegram_bot_token`, which exists only once a member
  // runs connect-telegram. So every box that never connected Telegram wrote a
  // perfectly good, decryptable snapshot and then failed itself on a file it
  // was never supposed to have, nightly, silently, since 2026-07-14. The
  // harness could not see it: provision-box.mjs seeds a fake bot token into
  // every persona box, so the sentinel was always satisfied in test.
  //
  // A sentinel for a file the box does not have proves nothing. So sentinels
  // are now conditional on the source existing, and the unconditional half of
  // the assertion is the round-trip over the targets that were actually tarred
  // (`present` is non-empty by the guard above, so this is never vacuous).
  const onBox = (p) => { try { const st = statSync(path.join(stateDir, p)); return st.isDirectory() || st.size > 0; } catch { return false; } };
  const applicable = SENTINELS.filter(onBox);
  for (const s of applicable) {
    const sp = path.join(drill, s);
    if (!existsSync(sp) || statSync(sp).size === 0) throw new Error(`verify: sentinel missing/empty: ${s}`);
  }
  for (const t of present) {
    if (!existsSync(path.join(drill, t))) throw new Error(`verify: target missing from archive: ${t}`);
  }

  // Verified. Only now does last night's snapshot get replaced.
  renameSync(staged, OUT);

  // ride the brain repo offsite (client-owned remote, per connect-github). Best-effort:
  // box-up's commit-on-exit also sweeps backups/; no remote => local-only, heartbeat says so.
  let offsite = false;
  try {
    sh('git', ['-C', stateDir, 'add', '--', 'backups/']);
    try { sh('git', ['-C', stateDir, 'commit', '-q', '-m', `backup: nightly state snapshot ${new Date().toISOString().slice(0, 10)}`]); } catch { /* nothing new staged */ }
    const remotes = sh('git', ['-C', stateDir, 'remote']).trim();
    if (remotes) { sh('git', ['-C', stateDir, 'push', '-q']); offsite = true; }
  } catch { /* commit/push best-effort — heartbeat carries the truth */ }

  // `offsite` says the ciphertext left the box. `recoverable` says somebody can
  // actually decrypt it, which needs the passphrase to be off the box too. They
  // are different facts and conflating them is what made an unrestorable backup
  // read as a healthy one.
  const escrowed = existsSync(ESCROW);
  writeFileSync(HEARTBEAT, JSON.stringify({
    asOf: new Date().toISOString(), ok: true, bytes: statSync(OUT).size, offsite,
    escrowed, recoverable: offsite && escrowed,
    ...(escrowed ? {} : { warning: 'the backup passphrase has not been recorded off this box, so this snapshot cannot be decrypted once the VM is gone' }),
  }, null, 2) + '\n');
  console.log(`backup: ok ${(statSync(OUT).size / 1024).toFixed(0)}KB, ${present.length} targets + ${applicable.length}/${SENTINELS.length} sentinels verified, offsite=${offsite}, recoverable=${offsite && escrowed}`);
  if (!escrowed) console.warn(`backup: WARNING the passphrase is not escrowed, so this snapshot is not recoverable off-box. See ${ESCROW}`);
} catch (e) {
  // A staged blob that never passed the verify is not a backup; leaving it beside
  // the real one only invites a restore from it.
  try { rmSync(OUT + '.tmp', { force: true }); } catch { /* nothing staged */ }
  const msg = String(e?.message || e).slice(0, 200);
  try { mkdirSync(OUT_DIR, { recursive: true }); writeFileSync(HEARTBEAT, JSON.stringify({ asOf: new Date().toISOString(), ok: false, error: msg }, null, 2) + '\n'); } catch { /* */ }
  console.error(`backup: FAILED — ${msg}`);
  process.exitCode = 1;
} finally {
  rmSync(staging, { recursive: true, force: true });
}
