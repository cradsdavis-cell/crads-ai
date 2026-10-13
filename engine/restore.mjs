#!/usr/bin/env node
// restore.mjs: bring a dead mineral's backup back onto a NEW mineral (2026-10-13).
//
// WHY THIS EXISTS. Every night a mineral writes two backups into the member's own
// private GitHub repository: the brain itself as readable files (brain-push.sh,
// 03:50) and an encrypted snapshot of what git must never carry (backup.mjs, 03:40:
// secrets/, the Claude sign-in, .mcp.json, the GitHub CLI login, the schedule,
// profile.yaml). The only restore procedure was the hosted-era runbook, which
// assumed an operator, provision-pebble.sh, a tunnel and DNS, and which told a
// person to `tar xzf` an archive straight over /state. On a self-hosted mineral
// that last step is dangerous as well as manual, so this does it properly.
//
// RUN IT ON THE NEW MINERAL, in a plain shell (`ssh <name>-box` from the computer
// that built it), after the wizard has made the mineral and "Connect my GitHub"
// has run on it:
//
//   node /app/engine/restore.mjs /state --from <owner>/<old-repo> --dry-run
//   node /app/engine/restore.mjs /state --from <owner>/<old-repo>
//
//   --from <repo>       the OLD mineral's brain repository: owner/name, a
//                       https://github.com/... address, or a local path to a copy
//   --ref <commit>      restore from an earlier commit (see --list) instead of the latest
//   --list              list the snapshots in that repository, newest first, and stop
//   --snapshot <file>   restore ONLY an encrypted snapshot file you already have
//   --no-snapshot       restore ONLY the brain (no passphrase needed)
//   --without-telegram  leave the old Telegram bot token and chat id behind
//   --no-push           do not send the restored brain to GitHub straight away
//   --dry-run           decrypt and check everything, change nothing
//
// The passphrase is read from AIOS_BACKUP_PASSPHRASE if set, otherwise asked for
// with nothing echoed. It is never put on a command line.
//
// WHAT IT WILL NOT TOUCH, and why each one matters:
//   devices/, support/, ssh/  The door. sshd on these servers reads ONLY the roster
//                             (cloud-init's 61-aios-roster-only.conf) and there is no
//                             root SSH, so taking the dead mineral's roster would
//                             re-derive authorized_keys from the OLD computer keys
//                             and lock the member out of a server nobody can get
//                             back into without the provider's rescue console.
//   box-name, open-folder,    THIS mineral's name and the folder the Claude Code
//   the named folder link,    app opens. The app's connection entry was made for the
//   ownership.json            new name; taking the old one breaks the start folder.
//   the old repository        Read, never written. It is the backup.
//
// ORDER IS THE SAFETY. The snapshot is decrypted and checked BEFORE anything on
// this mineral changes, so a wrong passphrase or a damaged file stops the run with
// nothing touched. The brain is then merged as a commit whose parents are this
// mineral's own history AND the old repository's, so nothing on either side is lost
// and the next push is an ordinary fast-forward.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, lstatSync,
  readdirSync, readlinkSync, cpSync, copyFileSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PASS_ENV, decryptArgs } from './lib/snapshot-cipher.mjs';
import { brainIgnores, brainRequired } from './lib/brain-ignore.mjs';
import { isMain } from './lib/is-main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_PATH = 'backups/state-snapshot.tar.gz.enc';
// Never restored from the old mineral: the door, and the backup itself.
export const NEVER_FROM_SNAPSHOT = new Set(['.git', 'ssh', '.ssh', 'devices', 'support', 'backups']);
// Tracked paths that stay exactly as THIS mineral has them (see header).
export const KEEP_TRACKED = ['devices', 'support', 'box-name', 'open-folder', 'ownership.json'];
export const TELEGRAM_FILES = ['secrets/telegram_bot_token', 'secrets/telegram_chat_id'];

class Refusal extends Error {}
const refuse = (msg) => { throw new Refusal(msg); };

// ---------------------------------------------------------------- pure helpers

/** owner/name, a github https address, or a local path -> something git can fetch. */
export function resolveSource(from) {
  const s = String(from || '').trim();
  if (!s) refuse('say which repository to restore from: --from <owner>/<repo>');
  if (path.isAbsolute(s)) return s;
  const short = s.match(/^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(\.git)?$/);
  if (short) return `https://github.com/${short[1]}/${short[2]}.git`;
  const url = s.match(/^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(\.git)?\/?$/);
  if (url) return `https://github.com/${url[1]}/${url[2]}.git`;
  return refuse(`"${s}" is not a repository this can read: use owner/name, a https://github.com/ address, or a full path to a local copy`);
}

/**
 * Check a snapshot's file list before anything is unpacked. Every entry must stay
 * inside the state directory and none may land on the door or the backup itself.
 * Returns the top-level names it would restore.
 */
export function checkEntries(entries) {
  const tops = new Set();
  for (const raw of entries) {
    const e = String(raw).replace(/^\.\//, '');
    if (!e) continue;
    if (e.startsWith('/') || /^[A-Za-z]:/.test(e)) refuse(`the snapshot holds an absolute path (${e}); not unpacking it`);
    const parts = e.split('/').filter(Boolean);
    if (parts.includes('..')) refuse(`the snapshot holds a path that climbs out of the mineral (${e}); not unpacking it`);
    if (NEVER_FROM_SNAPSHOT.has(parts[0])) refuse(`the snapshot holds ${parts[0]}/, which a restore must never overwrite; not unpacking it`);
    tops.add(parts[0]);
  }
  if (!tops.size) refuse('the snapshot is empty');
  return [...tops].sort();
}

// ---------------------------------------------------------------- shell helpers

const git = (stateDir, args, opts = {}) => execFileSync('git', ['-C', stateDir, ...args], {
  encoding: opts.buffer ? 'buffer' : 'utf8',
  // Never let git sit waiting for a username nobody is there to type.
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) },
  stdio: ['pipe', 'pipe', 'pipe'],
  input: opts.input,
  maxBuffer: 256 * 1024 * 1024,
});
const gitOk = (stateDir, args, opts) => { try { return git(stateDir, args, opts); } catch { return null; } };
const who = { GIT_AUTHOR_NAME: 'box', GIT_AUTHOR_EMAIL: 'box@local', GIT_COMMITTER_NAME: 'box', GIT_COMMITTER_EMAIL: 'box@local' };

function walk(dir, fn) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = lstatSync(p);
    fn(p, st);
    if (st.isDirectory()) walk(p, fn);
  }
}

// ---------------------------------------------------------------- the snapshot

/**
 * Decrypt and unpack the snapshot into a private staging directory, checking it as
 * it goes. Nothing in the state directory is touched here.
 */
export function openSnapshot(encBytes, passphrase, staging, stateDir) {
  const enc = path.join(staging, 'snapshot.enc');
  const tgz = path.join(staging, 'snapshot.tar.gz');
  writeFileSync(enc, encBytes, { mode: 0o600 });
  const dec = spawnSync('openssl', decryptArgs(enc, tgz), { env: { ...process.env, [PASS_ENV]: passphrase }, encoding: 'utf8' });
  if (dec.status !== 0) refuse('that passphrase does not open this snapshot (or the file is damaged). Check you copied the whole passphrase, with nothing added.');
  // A wrong passphrase gets past the padding check about one time in 256 and
  // yields noise, which tar then refuses: same message, same outcome.
  const list = spawnSync('tar', ['tzf', tgz], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (list.status !== 0) refuse('that passphrase does not open this snapshot (or the file is damaged). Check you copied the whole passphrase, with nothing added.');
  const tops = checkEntries(list.stdout.split('\n'));
  const out = path.join(staging, 'unpacked');
  mkdirSync(out, { mode: 0o700 });
  const x = spawnSync('tar', ['xzpf', tgz, '--no-same-owner', '-C', out], { encoding: 'utf8' });
  if (x.status !== 0) refuse(`the snapshot opened but would not unpack: ${(x.stderr || '').trim().split('\n').pop()}`);
  rmSync(tgz, { force: true });
  // A link inside the snapshot may point within the mineral, never outside it.
  walk(out, (p, st) => {
    if (!st.isSymbolicLink()) return;
    const rel = path.relative(out, p);
    const target = readlinkSync(p);
    const lands = path.isAbsolute(target) ? target : path.resolve(stateDir, path.dirname(rel), target);
    if (lands !== stateDir && !lands.startsWith(stateDir + path.sep)) refuse(`the snapshot holds a link that points outside the mineral (${rel}); not unpacking it`);
  });
  return { dir: out, tops };
}

/** Copy the unpacked snapshot over the state directory. Returns what it restored. */
export function applySnapshot(unpacked, stateDir, { withoutTelegram = false } = {}) {
  const skipped = [];
  if (withoutTelegram) {
    for (const f of TELEGRAM_FILES) {
      if (existsSync(path.join(unpacked, f))) { rmSync(path.join(unpacked, f), { force: true }); skipped.push(f); }
    }
  }
  const restored = [];
  for (const top of readdirSync(unpacked).sort()) {
    if (NEVER_FROM_SNAPSHOT.has(top)) continue;   // checkEntries already refused these; belt and braces
    const src = path.join(unpacked, top);
    const dst = path.join(stateDir, top);
    if (lstatSync(src).isDirectory()) {
      // Merge, the old mineral's files winning: anything this new mineral made for
      // itself that the old one never had (its own fresh secrets) stays.
      cpSync(src, dst, { recursive: true, force: true, verbatimSymlinks: true });
    } else {
      copyFileSync(src, dst);
    }
    restored.push(top);
    // Permission fix: nobody but the mineral's own account reads any of it. Owner
    // bits are kept as they were (Claude Code plugins carry executable hooks).
    const tighten = (p, st) => { if (!st.isSymbolicLink()) chmodSync(p, st.mode & 0o700); };
    tighten(dst, lstatSync(dst));
    if (lstatSync(dst).isDirectory()) walk(dst, tighten);
  }
  return { restored, skipped };
}

// ---------------------------------------------------------------- the brain

/**
 * The restored tree: the old repository's tree, except the paths THIS mineral keeps,
 * which come from its own HEAD (or are absent if it has none), and never anything on
 * the never-commit list. Committed with BOTH histories as parents.
 */
export function restoredCommit(stateDir, target, label) {
  const head = gitOk(stateDir, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() || null;
  const keep = [...KEEP_TRACKED];
  // The folder the Claude Code app opens is a link named after the mineral.
  const linkName = head ? (gitOk(stateDir, ['show', `${head}:open-folder`]) || '').trim() : '';
  if (/^[a-z0-9][a-z0-9-]{0,39}$/.test(linkName)) keep.push(linkName);
  const idx = path.join(mkdtempSync(path.join(tmpdir(), 'aios-restore-idx-')), 'index');
  const env = { GIT_INDEX_FILE: idx };
  try {
    git(stateDir, ['read-tree', target], { env });
    git(stateDir, ['rm', '-r', '-q', '-f', '--cached', '--ignore-unmatch', '--', ...keep], { env });
    if (head) {
      const ours = git(stateDir, ['ls-tree', '-r', '-z', head, '--', ...keep], { buffer: true });
      if (ours.length) git(stateDir, ['update-index', '-z', '--index-info'], { env, input: ours });
    }
    const never = brainIgnores().map((p) => p.replace(/\/$/, ''));
    git(stateDir, ['rm', '-r', '-q', '-f', '--cached', '--ignore-unmatch', '--', ...never], { env });
    const tree = git(stateDir, ['write-tree'], { env }).trim();
    const parents = head ? ['-p', head, '-p', target] : ['-p', target];
    return git(stateDir, ['commit-tree', tree, ...parents, '-m', label], { env: who }).trim();
  } finally {
    rmSync(path.dirname(idx), { recursive: true, force: true });
  }
}

function commitPending(stateDir, message) {
  git(stateDir, ['add', '-A']);
  if (gitOk(stateDir, ['diff', '--cached', '--quiet']) === null) {
    git(stateDir, ['commit', '-q', '-m', message], { env: who });
  }
}

// ---------------------------------------------------------------- passphrase

async function readPassphrase() {
  if (process.env[PASS_ENV]) return process.env[PASS_ENV].trim();
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    const chunks = [];
    for await (const c of stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').split('\n')[0].trim();
  }
  stdout.write('Backup passphrase (nothing will show as you type or paste; press Enter after): ');
  return new Promise((resolve) => {
    let s = '';
    stdin.setRawMode(true); stdin.setEncoding('utf8'); stdin.resume();
    const on = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); stdout.write('\n'); resolve(s.trim()); return; }
        if (c === '\u0003') { stdin.setRawMode(false); stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1); else s += c;
      }
    };
    stdin.on('data', on);
  });
}

// ---------------------------------------------------------------- main

export async function main(argv = process.argv.slice(2), log = console.log) {
  const { values: o, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      from: { type: 'string' }, ref: { type: 'string' }, snapshot: { type: 'string' },
      list: { type: 'boolean' }, 'no-snapshot': { type: 'boolean' }, 'without-telegram': { type: 'boolean' },
      'no-push': { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    },
  });
  const stateDir = path.resolve(positionals[0] || process.env.STATE_DIR || '/state');
  if (!existsSync(path.join(stateDir, 'profile.yaml'))) refuse(`${stateDir} does not look like a mineral (no profile.yaml)`);
  if (existsSync(path.join(stateDir, 'brain', '.git'))) refuse('this restores a personal mineral; this one keeps its brain in /state/brain');
  if (!o.from && !o.snapshot) refuse('say what to restore from: --from <owner>/<old-repo>, or --snapshot <file>');
  if (o.from && o.snapshot) refuse('use --from or --snapshot, not both');
  const dry = !!o['dry-run'];

  // ---- 1. find the old brain and its snapshot (reads only) ----
  let target = null; let source = null; let encBytes = null;
  if (o.from) {
    source = resolveSource(o.from);
    const notYet = 'this mineral is not connected to GitHub yet. Press "Connect my GitHub" on Your mineral first, then run this again.';
    if (!existsSync(path.join(stateDir, '.git'))) refuse(notYet);
    // The restored brain has to have somewhere to go, or it would live on this
    // server alone, which is the position the restore exists to get out of.
    if (!dry && !o.list && !o['no-push'] && !gitOk(stateDir, ['remote', 'get-url', 'origin'])) refuse(notYet);
    const fetched = spawnSync('git', ['-C', stateDir, 'fetch', '-q', '--no-tags', source], {
      encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (fetched.status !== 0) {
      refuse(`could not read ${o.from}: ${(fetched.stderr || '').trim().split('\n').pop()}\n`
        + 'Check the name, and that this mineral is connected to the same GitHub account that holds it ("Connect my GitHub" on Your mineral).');
    }
    const tip = git(stateDir, ['rev-parse', 'FETCH_HEAD']).trim();
    if (o.list) {
      const rows = (gitOk(stateDir, ['log', '--format=%h  %cs  %s', tip, '--', SNAPSHOT_PATH]) || '').trim();
      log(rows ? `Snapshots in ${o.from}, newest first (use --ref <code> for an earlier one):\n${rows}` : `No snapshots in ${o.from}: its mineral never sent one.`);
      return 0;
    }
    target = tip;
    if (o.ref) {
      const r = gitOk(stateDir, ['rev-parse', '--verify', '-q', `${o.ref}^{commit}`])?.trim();
      if (!r || gitOk(stateDir, ['merge-base', '--is-ancestor', r, tip]) === null) refuse(`${o.ref} is not a commit in ${o.from} (see --list)`);
      target = r;
    }
    if (!o['no-snapshot']) {
      encBytes = gitOk(stateDir, ['show', `${target}:${SNAPSHOT_PATH}`], { buffer: true });
      if (!encBytes || !encBytes.length) refuse(`there is no snapshot in ${o.from} at that point. Its mineral never sent one, so only the brain can come back: run again with --no-snapshot.`);
    }
  } else {
    if (!existsSync(o.snapshot)) refuse(`no such file: ${o.snapshot}`);
    encBytes = readFileSync(o.snapshot);
  }

  // ---- 2. open the snapshot BEFORE changing anything ----
  const staging = mkdtempSync(path.join(tmpdir(), 'aios-restore-'));
  try {
    let snap = null; let pass = null;
    if (encBytes) {
      pass = await readPassphrase();
      if (!pass) refuse('no passphrase given');
      snap = openSnapshot(encBytes, pass, staging, stateDir);
    }
    const when = target ? git(stateDir, ['show', '-s', '--format=%cs (%h)', target]).trim() : null;
    if (dry) {
      log('Dry run: nothing on this mineral has changed.');
      if (target) log(`  Brain: would come back from ${o.from} as of ${when}, keeping this mineral's name, devices and door.`);
      if (snap) log(`  Snapshot: opens with that passphrase. It holds: ${snap.tops.join(', ')}.`);
      if (snap && o['without-telegram']) log('  The old Telegram link would be left behind.');
      return 0;
    }

    // ---- 3. the brain ----
    if (target) {
      const missing = brainRequired().filter((p) => {
        const ig = (() => { try { return readFileSync(path.join(stateDir, '.gitignore'), 'utf8').split('\n').map((l) => l.trim()); } catch { return []; } })();
        return !ig.includes(p) && !ig.includes(`${p}/`) && !ig.includes(p.replace(/\/$/, ''));
      });
      if (missing.length) refuse(`this mineral's .gitignore is missing protective entries (${missing.join(' ')}). Press "Connect my GitHub" on Your mineral again to repair it, then run this again.`);
      commitPending(stateDir, 'restore: this mineral as it was before the restore');
      const c = restoredCommit(stateDir, target, `restore: brain from ${o.from} as of ${when}`);
      const head = gitOk(stateDir, ['rev-parse', '--verify', '-q', 'HEAD']);
      if (head) git(stateDir, ['merge', '--ff-only', '-q', c]);
      else git(stateDir, ['reset', '-q', '--hard', c]);
      log(`Brain restored from ${o.from} as of ${when}.`);
    }

    // ---- 4. the snapshot ----
    if (snap) {
      const { restored, skipped } = applySnapshot(snap.dir, stateDir, { withoutTelegram: !!o['without-telegram'] });
      // The passphrase that just opened this snapshot is the one the member holds.
      // A first-night snapshot predates the passphrase file, so it may not carry it.
      const pf = path.join(stateDir, 'secrets', 'backup_passphrase');
      mkdirSync(path.dirname(pf), { recursive: true, mode: 0o700 });
      const had = existsSync(pf) ? readFileSync(pf, 'utf8').trim() : '';
      if (had !== pass) writeFileSync(pf, pass + '\n', { mode: 0o600 });
      // They typed it from wherever they keep it, so it is demonstrably off the box.
      writeFileSync(path.join(stateDir, 'secrets', 'backup_passphrase.escrowed'), '', { mode: 0o600 });
      log(`Settings and sign-ins restored: ${restored.join(', ')}.`);
      if (skipped.length) log('The old Telegram link was left behind, as asked.');
    }

    // ---- 5. keep THIS mineral's name (the snapshot carried the old profile.yaml) ----
    const bn = path.join(stateDir, 'box-name');
    const name = existsSync(bn) ? readFileSync(bn, 'utf8').trim() : '';
    if (name) {
      const ns = path.join(HERE, 'box', 'name-set.mjs');
      if (existsSync(ns)) spawnSync('node', [ns, stateDir, name], { encoding: 'utf8' });
    }
    if (existsSync(path.join(stateDir, '.git'))) commitPending(stateDir, 'restore: keep this mineral\'s name');

    // ---- 6. send it off the box now rather than at 03:50 ----
    if (target && !o['no-push']) {
      const bp = path.join(HERE, 'brain-push.sh');
      const r = existsSync(bp) ? spawnSync('bash', [bp, stateDir], { encoding: 'utf8' }) : { status: 1 };
      log(r.status === 0 ? 'Restored brain sent to your GitHub.' : 'Could not send the restored brain to GitHub just now; the nightly backup will try again at 03:50.');
    }

    log('');
    log('Next: in the app, Help > Update and restart, so everything starts on the restored settings.');
    log('Then check: your pages are there, Claude answers in the Terminal (sign in again if it asks),');
    log('and your connections show as connected (reconnect any that do not).');
    return 0;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    if (e instanceof Refusal) { console.error(`restore: ${e.message}`); process.exitCode = 2; return; }
    console.error(`restore: FAILED: ${String(e?.stderr || e?.message || e).trim()}`);
    process.exitCode = 1;
  });
}
