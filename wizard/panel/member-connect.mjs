// member-connect.mjs: the identity-install machinery (D44 survivor).
//
// SELF-HOST COLLAPSE (2026-09-01): the member-connect SURFACE is gone. The
// invite page (member-connect.html), createMemberConnectServer and everything
// only the server used — invite redeem (parseInviteLink, isSoloInvite,
// signInRequired), central staging (stageWithDirectory), the join-org flow
// (joinNonce, the poll + dotfile), the /my-orgs picker — were deleted with the
// invitation system. Nobody can be invited TO a box; a second device is let in
// by an already-connected one over SSH (device-routes.mjs), and communities
// work through commons repos.
//
// What REMAINS is the machinery other surfaces still run on this machine:
//   installMemberAccess / installOperatorAccess  mint (or reuse) an ed25519
//     keypair locally (the private key never leaves this machine) and install
//     it plus a `Host <alias>` block into ~/.ssh — used by provision-routes
//     (the door's "Set up my own") and device-routes (device-add).
//   removeHostBlock / removeIdentityAccess  the inverse, used by the door's
//     "Forget this assistant on this computer".
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync, renameSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generateDeployKeypair, derivePublicKey } from '../engine.mjs';
import { forgetHost, userKnownHostsPath } from './ssh-bridge.mjs';
import { unregisterClaudeSshConfig, claudeSettingsPath } from './claude-settings.mjs';
import { ensureVaultKeypair } from './vault-crypto.mjs';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;   // hostname or IP
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

function bad(msg) { const e = new Error(msg); e.status = 400; throw e; }

// Mint (or reuse) a keypair + Host block for an alias. Shared by the member
// flow (<slug>-box, user member) and the operator join flow (<org>-rock,
// user aios-op, D46). Exported for tests; sshDir is
// injectable so tests never touch the real ~/.ssh.
function installAccess({ slug, host, user, alias }, sshDir) {
  if (!SLUG_RE.test(String(slug ?? ''))) bad('slug must match [a-z0-9-]{2,32} (lowercase, no edge hyphens)');
  if (!HOSTNAME_RE.test(String(host ?? ''))) bad('host must be a plain hostname or IP');
  const u = String(user || 'member');
  if (!USER_RE.test(u)) bad('user must be a plain unix username');

  mkdirSync(sshDir, { recursive: true });
  const keyPath = join(sshDir, `${alias}.key`);
  const pubPath = keyPath + '.pub';
  let publicKey;
  let reused = false;

  const mintFresh = () => {
    const pair = generateDeployKeypair(alias);
    writeFileSync(keyPath, pair.privateKey, { mode: 0o600 });
    writeFileSync(pubPath, pair.publicKey, { mode: 0o644 });
    if (process.platform === 'win32') {
      const un = process.env.USERNAME || process.env.USER || '';
      spawnSync('icacls', [keyPath, '/inheritance:r', '/grant:r', `${un}:R`], { stdio: 'ignore' });
    }
    return pair.publicKey;
  };

  if (existsSync(keyPath)) {
    // never clobber a possibly-working key; reuse it
    if (existsSync(pubPath)) {
      publicKey = readFileSync(pubPath, 'utf8');
      reused = true;
    } else {
      // Self-heal a private key whose .pub went missing (an interrupted earlier setup). The
      // public half is recoverable from our own key blob, so restore it and reuse the key —
      // never make a member hand-move files inside .ssh. If the key is foreign/unreadable,
      // retire it aside (never delete) and mint fresh; still zero user action.
      const derived = derivePublicKey(readFileSync(keyPath, 'utf8'), alias);
      if (derived) {
        writeFileSync(pubPath, derived, { mode: 0o644 });
        publicKey = derived;
        reused = true;
      } else {
        renameSync(keyPath, `${keyPath}.orphan-${Date.now()}`);
        publicKey = mintFresh();
      }
    }
  } else {
    publicKey = mintFresh();
  }

  const cfgPath = join(sshDir, 'config');
  const hostLine = `Host ${alias}`;
  const cfg = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  forgetHost(String(host));   // (re)installed identity: stale fingerprints for this box are expected
  // ...and the USER's file too (owed item (g)): the Claude Code app's bundled
  // ssh reads only ~/.ssh/known_hosts, so a stale entry there (recycled IP)
  // would keep killing its connects even after ours heal. The fresh key is
  // pinned back after the verified connection test, never on blind install.
  forgetHost(String(host), userKnownHostsPath(sshDir));
  let configUpdated = false;
  let configRepaired = false;
  if (!cfg.split('\n').some((l) => l.trim() === hostLine)) {
    const block = [hostLine, `  HostName ${host}`, `  User ${u}`, `  IdentityFile ${keyPath.replace(/\\/g, '/')}`].join('\n');
    appendFileSync(cfgPath, (cfg && !cfg.endsWith('\n') ? '\n' : '') + block + '\n');
    configUpdated = true;
  } else {
    // A BLOCK THAT EXISTS IS NOT A BLOCK THAT WORKS (2026-08-14). This skipped
    // out whenever the Host line was already there, so a block carrying a wrong
    // address could never be repaired by re-running the flow: the machine kept
    // dialling the old value and the door kept saying "not answering yet", and
    // the only escape was Forget-then-reconnect. That is exactly what the
    // Cloudflare-proxied-hostname bug left behind on every device already
    // enrolled against a pebble, and a fix that cannot reach them is half a fix.
    //
    // Narrow on purpose: only HostName and User are rewritten, and only inside
    // the block whose Host line is EXACTLY this alias. Anything else a person
    // added (ProxyJump, IdentitiesOnly, ServerAliveInterval) is theirs and
    // survives untouched, on the same rule removeIdentityAccess already states.
    const lines = cfg.split('\n');
    const out = [];
    let inBlock = false;
    for (const line of lines) {
      const m = line.match(/^\s*Host\s+(.+?)\s*$/i);
      if (m) inBlock = (m[1].trim() === alias);
      if (inBlock) {
        const hn = line.match(/^(\s*)HostName(\s+)(\S+)\s*$/i);
        if (hn && hn[3] !== String(host)) { out.push(`${hn[1]}HostName${hn[2]}${host}`); configRepaired = true; continue; }
        const us = line.match(/^(\s*)User(\s+)(\S+)\s*$/i);
        if (us && us[3] !== u) { out.push(`${us[1]}User${us[2]}${u}`); configRepaired = true; continue; }
      }
      out.push(line);
    }
    if (configRepaired) writeFileSync(cfgPath, out.join('\n'));
  }
  return { publicKey, keyPath, alias, reused, configUpdated, configRepaired };
}

export function installMemberAccess({ slug, host, user }, sshDir = join(homedir(), '.ssh')) {
  const access = installAccess({ slug, host, user: user || 'member', alias: `${String(slug)}-box` }, sshDir);
  // Cold-tier vault keypair rides the same install (secret-store design,
  // 2026-07-28): member identities only, so operator/support machines never
  // become sealing targets. The panel's /vault/sync publishes the public half
  // once this device is on the box's roster.
  const vault = ensureVaultKeypair(`${String(slug)}-box`, sshDir);
  return { ...access, vaultPublicKey: vault.vaultPublicKey, vaultKeyPath: vault.vaultKeyPath };
}

// Inverse of installAccess: remove everything installAccess put on THIS machine
// for one identity — the `Host <alias>` block (only wizard-shaped aliases, and
// only a Host line that is exactly this one alias, so hand-written multi-alias
// blocks are never touched), the keypair files, the app known_hosts pin for the
// block's HostName, and the Claude Code Environment entry. Local-only by
// design: it never reaches at any box or repo. Idempotent; reports what it
// actually removed.
/**
 * Remove ONLY the `Host <alias>` block from ~/.ssh/config, leaving keys, vault
 * and Claude Code entry alone. Extracted from removeIdentityAccess (2026-08-14)
 * so the enrol path can undo the one thing it should not have left behind on a
 * failure, without destroying a keypair that a still-staged request is bound to.
 * Same care as its parent: wizard-shaped aliases only, and only a Host line that
 * is exactly this alias, so hand-written multi-alias blocks are never touched.
 * @returns {{configUpdated: boolean, hostName: string}}
 */
export function removeHostBlock(alias, sshDir = join(homedir(), '.ssh')) {
  if (!/^[a-z0-9][a-z0-9-]*-(rock|box)$/.test(String(alias ?? ''))) bad('alias must be a wizard-installed identity (<org>-rock or <slug>-box)');
  const cfgPath = join(sshDir, 'config');
  let configUpdated = false;
  let hostName = '';
  if (existsSync(cfgPath)) {
    const out = [];
    let skip = false;
    for (const line of readFileSync(cfgPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*Host\s+(.+?)\s*$/i);
      if (m) skip = (m[1].trim() === alias);
      if (skip) {
        configUpdated = true;
        const hn = line.match(/^\s*HostName\s+(\S+)/i);
        if (hn) hostName = hn[1];
        continue;
      }
      out.push(line);
    }
    if (configUpdated) writeFileSync(cfgPath, out.join('\n').replace(/\n{3,}/g, '\n\n'));
  }
  return { configUpdated, hostName };
}

export function removeIdentityAccess(alias, sshDir = join(homedir(), '.ssh'), settingsPath = claudeSettingsPath()) {
  const { configUpdated, hostName } = removeHostBlock(alias, sshDir);
  if (hostName) forgetHost(hostName);
  let keysRemoved = 0;
  let keysStuck = 0;
  // Unlock, the mirror of the install-time lock: installed keys are ACL-locked
  // read-only (icacls /inheritance:r /grant:r USER:R on Windows), which makes
  // unlinkSync (and renameSync, for the vault key below) throw EPERM there and
  // the key silently survive the removal (seen live 2026-07-23:
  // test-two-rock.key left on disk after deleting 'test-two').
  const unlock = (p) => {
    try { chmodSync(p, 0o600); } catch { /* the unlink/rename below is the verdict */ }
    if (process.platform === 'win32') {
      const un = process.env.USERNAME || process.env.USER || '';
      spawnSync('icacls', [p, '/grant', `${un}:F`], { stdio: 'ignore' });
    }
  };
  // The SSH keypair is ACCESS and is re-mintable: removing the identity should
  // remove it, and a fresh invite mints another. Keys that still cannot be
  // deleted are COUNTED (keysStuck), never swallowed as "already gone".
  for (const p of [join(sshDir, `${alias}.key`), join(sshDir, `${alias}.key.pub`),
    join(sshDir, `${alias}.vault.pub`)]) {
    if (!existsSync(p)) continue;
    unlock(p);
    try { unlinkSync(p); keysRemoved++; } catch { keysStuck++; }
  }
  // The VAULT PRIVATE KEY is not access, it is the only thing that can ever open
  // the cold envelopes already sealed to this device: vault.mjs has deliberately
  // no decrypt path without it. Unlinking it orphaned every cold secret
  // permanently, and this is reachable from the door's "Forget this assistant on
  // this computer" while the box is merely mid-restart, behind a dialog that says
  // nothing anywhere is destroyed. vault-crypto.mjs already states the rule for
  // this exact key ("Reuse-never-clobber ... must never orphan envelopes already
  // sealed to this device") and retires an unreadable one aside rather than
  // deleting it. Same treatment here: retire, never destroy, matching the
  // project's own never-delete-archive rule.
  const vaultKey = join(sshDir, `${alias}.vault.key`);
  if (existsSync(vaultKey)) {
    unlock(vaultKey);
    try {
      renameSync(vaultKey, `${vaultKey}.retired-${Date.now()}`);
      keysRemoved++;
    } catch { keysStuck++; }
  }
  let claude = { ok: false };
  try { claude = unregisterClaudeSshConfig(alias, settingsPath); } catch { /* best-effort */ }
  return { alias, configUpdated, keysRemoved, keysStuck, knownHostForgotten: !!hostName, claudeRemoved: !!claude.removed };
}

// D46 operator join: the alias is the org's <org>-rock. There is ONE operator
// login now: the Support role was deleted 2026-08-05 (it had a privilege-escalation
// bug and had never been granted to anyone). Refused rather than coerced, because
// silently installing an aios-op alias for someone who asked for Support would hand
// them more access than they requested, and installing an aios-support alias would
// write a config pointing at a login that no longer exists.
export function installOperatorAccess({ org, host, role }, sshDir = join(homedir(), '.ssh')) {
  const r = String(role ?? 'admin');
  if (r === 'support') bad('the Support role has been removed; operators are Admins');
  if (r !== 'admin') bad('role must be admin');
  return installAccess({ slug: org, host, user: 'aios-op', alias: `${String(org)}-rock` }, sshDir);
}
