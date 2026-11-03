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
// What it never does (trap 80, 2026-10-22): commit a snapshot into an ADOPTED brain (that
// repo is the person's own, so the blob stays on the machine), commit one over CAP (GitHub
// refuses a file over 100 MB, and one such commit blocks every push after it), or archive
// what git already holds or a tool regenerates (.claude/worktrees, plugin and package
// caches). The adopted brain this first ran on tarred its 248 MB of worktrees into a
// 244 MB blob, committed it, and no push of that repo got through for nine hours.
//
// Run: node engine/backup.mjs <state-dir>     (cadence: gen-crontab emits a 03:40 line)
// Restore: node engine/restore.mjs (docs/mineral-restore-runbook.md)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, statSync, lstatSync, readdirSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASS_ENV, encryptArgs, decryptArgs } from './lib/snapshot-cipher.mjs';
import { isAdopted, isMovingIn } from './lib/mineral-identity.mjs';

const stateDir = path.resolve(process.argv[2] || process.env.STATE_DIR || '.');
if (!existsSync(path.join(stateDir, 'profile.yaml'))) {
  console.error(`backup: ${stateDir} does not look like a state dir (no profile.yaml)`);
  process.exit(2);
}
const ENGINE = path.dirname(fileURLToPath(import.meta.url));
// An ADOPTED brain (spec 2026-10-17) may already have a backups/ of its own (the
// first one tracks an encrypted snapshot there), so ours goes one level down and
// theirs is never touched. Pebbles keep backups/, where restore.mjs looks.
const ADOPTED = isAdopted(stateDir);
const OUT_REL = ADOPTED ? path.join('backups', 'crads') : 'backups';
const OUT_DIR = path.join(stateDir, OUT_REL);
const OUT = path.join(OUT_DIR, 'state-snapshot.tar.gz.enc');
const HEARTBEAT = path.join(OUT_DIR, 'heartbeat.json');
// Where a pebble's snapshot waits when it is too big to commit. backups/ is tracked and
// brain-push runs `git add -A` at 03:50, so the blob must never even be staged there;
// .kernel/ is on the never-commit floor of every brain (engine/lib/brain-ignore.txt).
const LOCAL_REL = path.join('.kernel', 'backups');
const LOCAL_OUT = path.join(stateDir, LOCAL_REL, 'state-snapshot.tar.gz.enc');

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
const policy = (() => {
  try { return JSON.parse(readFileSync(path.join(ENGINE, 'policy.json'), 'utf8')).backup || {}; }
  catch { return {}; }
})();
const TARGETS = policy.targets || ['secrets', '.claude-auth', '.claude', '.mcp.json', '.kernel/gh', '.kernel/crontab', '.kernel/telegram-offset', 'profile.yaml'];
const SENTINELS = policy.sentinel_files || ['profile.yaml'];
// Never archived, at any depth under a target: a path (stateDir-relative, it and all
// beneath it) or a bare name. Each is something git or a tool rebuilds.
const EXCLUDE = policy.exclude || ['.claude/worktrees', '.claude-auth/plugins/cache', '.claude-auth/plugins/marketplaces', '.claude-auth/plugins/plugin-directory-cache-v2.json', '.claude-auth/cache', '.opencode-auth/cache'];
const EXCLUDE_NAMES = policy.exclude_names || ['node_modules', '__pycache__'];
// Saved chats (*.jsonl) under these paths are not recovery state, and a chat the member's
// retention deleted (engine/box/chat-retention.mjs) must not live on in every snapshot.
const EXCLUDE_TRANSCRIPTS = policy.exclude_transcripts_under || ['.claude-auth/projects'];
// The most a committed snapshot may weigh. GitHub rejects any file over 100 MB (GH001);
// 90 leaves room for one night's growth. policy.json and the env (a test seam) can only
// lower it.
const HARD_CAP = 90 * 1000 * 1000;
const CAP = Math.min(HARD_CAP, Number(policy.max_commit_bytes) || HARD_CAP, Number(process.env.AIOS_BACKUP_CAP_BYTES) || HARD_CAP);
// openssl enc -salt adds "Salted__" + 8 salt bytes and up to 16 of padding.
const CIPHER_OVERHEAD = 64;
const size = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB` : `${Math.ceil(n / 1e3)} KB`);

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

// Files under a directory target that git already tracks. They are in the repo, which a
// restore clones before it lays the snapshot over it, so archiving them again only adds
// weight (on an adopted brain, the person's whole tracked .claude/). Not a repo, or no
// git: nothing is tracked, and every file is archived as before.
function trackedFiles(dirs) {
  if (!dirs.length) return new Set();
  try {
    return new Set(sh('git', ['-C', stateDir, 'ls-files', '-z', '--', ...dirs], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean));
  } catch { return new Set(); }
}

// The archive's member list. A target that is a file is always archived (they are named
// one by one in policy.json, and profile.yaml is the sentinel); a directory target is
// walked, leaving out EXCLUDE, EXCLUDE_NAMES and tracked files. Symlinks are archived as
// links, never followed, as tar did when it was handed the targets whole. A directory
// that cannot be read throws, so the run fails rather than archiving half of it.
function collect(present) {
  const dirs = present.filter((t) => lstatSync(path.join(stateDir, t)).isDirectory());
  const tracked = trackedFiles(dirs);
  const entries = []; const leftOut = []; let trackedCount = 0;
  const excluded = (rel) => EXCLUDE.some((x) => rel === x || rel.startsWith(x + '/')) || EXCLUDE_NAMES.includes(path.posix.basename(rel))
    || (rel.endsWith('.jsonl') && EXCLUDE_TRANSCRIPTS.some((x) => rel.startsWith(x + '/')));
  const walk = (dir) => {
    for (const name of readdirSync(path.join(stateDir, dir)).sort()) {
      const rel = `${dir}/${name}`;
      if (excluded(rel)) { leftOut.push(rel); continue; }
      const st = lstatSync(path.join(stateDir, rel));
      if (st.isDirectory()) { entries.push(rel); walk(rel); }
      else if (!st.isFile() && !st.isSymbolicLink()) continue;   // a socket or fifo is not state
      else if (tracked.has(rel)) trackedCount++;
      else entries.push(rel);
    }
  };
  for (const t of present) { entries.push(t); if (dirs.includes(t)) walk(t); }
  return { entries, leftOut, trackedCount };
}

const staging = mkdtempSync(path.join(tmpdir(), 'aios-backup-'));
try {
  const present = TARGETS.filter((t) => existsSync(path.join(stateDir, t)));
  if (!present.length) throw new Error('no backup targets present in state dir');
  const { entries, leftOut, trackedCount } = collect(present);
  const listPath = path.join(staging, 'members');
  writeFileSync(listPath, entries.join('\0') + '\0');
  const tarPath = path.join(staging, 'state.tar.gz');
  sh('tar', ['czf', tarPath, '-C', stateDir, '--no-recursion', '--null', '-T', listPath]);

  // Too big to commit? Decided from the tar BEFORE anything is written into the brain:
  // even a staged .tmp in a tracked backups/ can be swept into a commit by the kernel's
  // drain. An adopted brain never commits it, so its snapshot stays where it always was.
  const overCap = statSync(tarPath).size + CIPHER_OVERHEAD > CAP;
  const dest = overCap && !ADOPTED ? LOCAL_OUT : OUT;
  mkdirSync(path.dirname(dest), { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const env = { ...process.env, [PASS_ENV]: passphrase() };
  // WRITE BESIDE, VERIFY, THEN REPLACE (2026-08-20 audit). This encrypted
  // straight over OUT, the single canonical snapshot path, and only decrypted it
  // afterwards to check the round trip. So a failed or truncated run destroyed
  // last night's good blob before anything had proven tonight's could restore,
  // and the catch below then recorded ok:false over a file that was already
  // gone. On a box with no remote that is the only copy. Staging next to it
  // costs one rename and means the previous snapshot survives every failure mode
  // between here and the assertions.
  const staged = dest + '.tmp';
  sh('openssl', encryptArgs(tarPath, staged), { env });

  // decrypt-verify + sentinel extraction: a backup that can't restore is theatre
  const verifyTar = path.join(staging, 'verify.tar.gz');
  sh('openssl', decryptArgs(staged, verifyTar), { env });
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
  // and every member that went in came out (lstat: a link may point off the box)
  for (const e of entries) {
    try { lstatSync(path.join(drill, e)); } catch { throw new Error(`verify: missing from archive: ${e.slice(0, 120)}`); }
  }

  // Verified. Only now does last night's snapshot get replaced. Over the cap on a pebble,
  // last night's committed one (the last that fit) is left exactly as it is.
  renameSync(staged, dest);
  // A snapshot that fits again supersedes the one that had to wait on the machine.
  if (dest === OUT) rmSync(LOCAL_OUT, { force: true });
  const bytes = statSync(dest).size;

  // ride the brain repo offsite (client-owned remote, per connect-github). Best-effort:
  // box-up's commit-on-exit also sweeps backups/; no remote => local-only, heartbeat says so.
  // Never for an adopted brain or a snapshot over the cap (trap 80), and the reason is
  // written down: a commit that quietly does not happen reads as a healthy backup. Each
  // reason fits the 200 characters the run ledger keeps, with the line's prefix.
  let offsite = false;
  const notCommitted = ADOPTED
    ? `this brain is your own repository, so its snapshot is never committed into it; it stays on this machine in ${OUT_REL}/ until it has an offsite home`
    : overCap
      ? `the snapshot is ${size(bytes)}, over the ${size(CAP)} cap (GitHub refuses files over 100 MB); kept in ${LOCAL_REL}/ on this machine; ${OUT_REL}/ holds the last one that fit`
      // Move-in mode (and Move out, which sets it again before stopping anything):
      // the snapshot is written, nothing is committed or pushed.
      : isMovingIn(stateDir) ? 'moving in: nothing is committed until the move-in is finished' : null;
  if (!notCommitted) {
    try {
      sh('git', ['-C', stateDir, 'add', '--', OUT_REL + '/']);
      // An explicit identity, as every other engine commit carries: without one a box
      // (or a CI runner) with no global git identity fails this commit silently, and
      // the snapshot only reached GitHub with the 03:50 brain push (found 2026-10-13).
      try { sh('git', ['-C', stateDir, '-c', 'user.name=AI OS kernel', '-c', 'user.email=kernel@ai-os.local', 'commit', '-q', '-m', `backup: nightly state snapshot ${new Date().toISOString().slice(0, 10)}`]); } catch { /* nothing new staged */ }
      const remotes = sh('git', ['-C', stateDir, 'remote']).trim();
      if (remotes) { sh('git', ['-C', stateDir, 'push', '-q']); offsite = true; }
    } catch { /* commit/push best-effort: the heartbeat carries the truth */ }
  }

  // `offsite` says the ciphertext left the box. `recoverable` says somebody can
  // actually decrypt it, which needs the passphrase to be off the box too. They
  // are different facts and conflating them is what made an unrestorable backup
  // read as a healthy one.
  const escrowed = existsSync(ESCROW);
  // Over the cap on a pebble the backup is not doing its job (nothing new left the box),
  // so the run fails and the Health row shows why. Adopted is by design: ok, and says so.
  const ok = !(overCap && !ADOPTED);
  writeFileSync(HEARTBEAT, JSON.stringify({
    asOf: new Date().toISOString(), ok, bytes, capBytes: CAP, snapshot: path.relative(stateDir, dest), offsite,
    ...(notCommitted ? { notCommitted } : {}),
    escrowed, recoverable: offsite && escrowed,
    leftOut: leftOut.slice(0, 20), trackedLeftOut: trackedCount,
    ...(escrowed ? {} : { warning: 'the backup passphrase has not been recorded off this box, so this snapshot cannot be decrypted once the VM is gone' }),
  }, null, 2) + '\n');
  console.log(`backup: ${ok ? 'ok' : 'NOT OK'} ${(bytes / 1024).toFixed(0)}KB, ${present.length} targets + ${applicable.length}/${SENTINELS.length} sentinels verified, ${leftOut.length} regenerable paths and ${trackedCount} tracked files left out, offsite=${offsite}, recoverable=${offsite && escrowed}`);
  if (!escrowed) console.warn(`backup: WARNING the passphrase is not escrowed, so this snapshot is not recoverable off-box. See ${ESCROW}`);
  // Last, so it is the line the run ledger keeps as this run's summary.
  if (notCommitted) (ok ? console.warn : console.error)(`backup: NOT COMMITTED: ${notCommitted}`);
  if (!ok) process.exitCode = 1;
} catch (e) {
  // A staged blob that never passed the verify is not a backup; leaving it beside
  // the real one only invites a restore from it.
  for (const p of [OUT, LOCAL_OUT]) { try { rmSync(p + '.tmp', { force: true }); } catch { /* nothing staged */ } }
  const msg = String(e?.message || e).slice(0, 200);
  try { mkdirSync(OUT_DIR, { recursive: true }); writeFileSync(HEARTBEAT, JSON.stringify({ asOf: new Date().toISOString(), ok: false, error: msg }, null, 2) + '\n'); } catch { /* */ }
  console.error(`backup: FAILED — ${msg}`);
  process.exitCode = 1;
} finally {
  rmSync(staging, { recursive: true, force: true });
}
