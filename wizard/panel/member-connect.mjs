// member-connect.mjs: the member's first-run flow (D44 companion to D40).
// Runs on the MEMBER's machine, loopback only. It does for a member what the
// wizard's installAccessKey does for an operator: mint an ed25519 keypair
// locally (the private key never leaves this machine), install it plus a
// `Host <slug>-box` block into ~/.ssh, and hand back the PUBLIC key for the
// org to install on the member's box. Once the block exists, the app opens as
// the member companion (app.mjs mode selection) and the Claude Code app can
// use the same alias.
//
// Endpoints (same shapes as the panel server, JSON not SSE: these are quick):
//   GET  /           the member-connect page
//   POST /generate   { slug, host, user } -> { publicKey, keyPath, reused, configUpdated }
//   POST /test       { slug } -> { ok, output }
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync, renameSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDeployKeypair, derivePublicKey } from '../engine.mjs';
import { deviceFingerprint } from './fingerprint.mjs';   // D51: the 6-char device safety code
import { machineName } from './machine-name.mjs';       // finding 116: name the claim path's device too

// SELF-HOST STRIP (2026-09-01): the thin central broker (D51 Phase 2,
// directory.crads-ai.com) is deleted along with the account system, so the
// default here is now OFF — '' — permanently. stageWithDirectory returns false
// on '' and every caller already treats that as "fall back to the Phase-1
// manual paste-back", which is a designed, honest path, not an error. The
// join-org / my-orgs surfaces below gate on the same emptiness and say plainly
// that community membership is moving to the commons model. Tests keep
// injecting joinDirectoryUrl/directoryUrl to exercise the machinery.
const DIRECTORY_URL = '';
const MAX_ID_TOKEN_BYTES = 16384;   // matches idtoken-verify.mjs; oversized proofs are dropped, not sent
// The directory route standalone pebbles stage their redeems under. Kept in step
// with cockpit/tools/invite-link.mjs, which mints the links, and
// cockpit/jobs/enrol-arrivals.mjs, which drains this lane.
export const SOLO_ORG = 'crads-solo';

// THIS READS THE LANE ON PURPOSE, and it is not the 136 bug wearing a new hat.
//
// The one thing it gates is whether the redeem runs the browser sign-in
// handshake, and that handshake exists to produce an id_token FOR A ROCK TO
// VERIFY. The rock that verifies is the one that MINTED the invite and stored
// its token_hash: brain-template control/auto-approve.mjs gate 5 is
// `!tokenHash || sha256(entry.token) !== tokenHash` and it fails closed. A
// pebble the MOUNTAIN builds for a rock is minted by the Mountain, so the rock
// holds no token_hash for it and could only refuse; that claim is drained by
// cockpit/jobs/enrol-arrivals.mjs on this lane, and enrol-arrivals never reads
// an id_token at all. Pointing this at parseInviteLink's `anchor` would open a
// browser window the member has to finish, to mint a proof nothing reads.
//
// So: the LANE names the approver, the ANCHOR names the owner. 136 was answering
// the owner question with the lane; answering the approver question with the
// anchor would be the same mistake pointing the other way. member-connect.html
// already carries the scar of getting this one wrong in the other direction
// (2026-08-14: `!!r.org` told every self-serve member to read a six-character
// code to a rock that did not exist).
export const isSoloInvite = (inv) => String(inv?.org || '') === SOLO_ORG;

// DOES THIS CLAIM HAVE TO BE ACCOUNT-BOUND? (finding 159, 2026-08-16.)
//
// The twin of isSolo() in wizard/join-page/join-parse.mjs, and deliberately the
// SECOND predicate on this page rather than a change to the first. isSoloInvite
// answers "who approves this device" and its answer is the lane; this answers
// "who owns this mineral" and its answer is the anchor. The comment above and
// invite-anchor-lockstep.test.mjs both exist to stop the next reader collapsing
// them, so this does not.
//
// WHY THE ARGUMENT ABOVE NO LONGER FORBIDS THE HANDSHAKE HERE. It said, truly at
// the time, that asking an anchored member to sign in would "open a browser
// window the member has to finish, to mint a proof nothing reads": the Mountain
// mints these invites, so the rock holds no token_hash and could only refuse,
// and enrol-arrivals reads no id_token. What changed is that the proof now HAS a
// reader. directory/worker.js POST /redeem verifies the token, binds it to this
// exact device key by its nonce, checks the address against boxreg:<host>.owner_e
// and refuses a mismatch, and records the verified address on the staged record
// for the drainer. The window is no longer opened for nothing.
//
// WHY IT DOES NOT REACH THE SOLO PATH. A standalone pebble has no anchor field at
// all (cockpit/tools/invite-link.mjs mints `...|token|||` with the seventh field
// empty), so it answers false here and keeps exactly the redeem it has today:
// no handshake, no browser window, no 180s freeze for a stranger who closed one
// (QA 2026-07-30). Same rule the /join page uses to decide whether to PRINT the
// sign-in step, which is the point: the page promised an address lock and the
// flow performed none, and one predicate cannot promise what the other skips.
// SOLO JOINED THE LIST (Harriet's audit 2026-08-21, point 5). The paragraph above
// argued the handshake "does not reach the solo path", on two grounds that have
// both since expired: that a standalone pebble has no rock for a token to prove
// anything to, and that asking anyway cost a stranger 180s of frozen UI. The
// first stopped being true when directory/worker.js POST /redeem became the
// token's own reader (it verifies, binds by nonce, records the address, and needs
// no rock to do any of it). The second was fixed on its own terms below: a
// provider that does not complete now returns a 401 with one-click recovery
// instead of stalling. What was left was the plain hole: possession of a
// standalone invite link was the entire proof, so a forwarded one claimed the
// box, and cohort one arrives mostly through that lane (docs/beta-runbook.md).
//
// THE ROCK-MINTED LANE IS DELIBERATELY UNTOUCHED. An invite with no anchor whose
// lane names a real rock keeps returning false here, because Sam ruled on
// 2026-08-09 that on that lane the link IS the proof, and because that lane has a
// second approver anyway (the rock's own auto-approve). Solo has neither, which
// is the whole distinction. redeem-signin-required.test.mjs names this case
// explicitly so nobody "finishes" the change by collapsing the two.
export const signInRequired = (inv) => !!String(inv?.anchor || '').trim() || isSoloInvite(inv);

// A SIGN-IN THE MEMBER NEVER FINISHES MUST NOT BECOME A FROZEN BUTTON.
//
// The solo path used to be protected from this by not asking at all, and the test that
// pinned it ("it must not hang waiting for one") was written against the live incident
// that produced the rule: QA 2026-07-30 watched a stranger close the sign-in window and
// sit on a disabled button through "up to 180s of a frozen 'Setting up your device…'".
// Now that solo asks too (see signInRequired), the protection has to come from a bound
// rather than from silence, or arming this reintroduces the exact failure by a new route.
//
// The anchored path carried the same unbounded await all along and simply never had a test
// catch it, so this fixes both rather than special-casing the newcomer. A lapsed wait
// resolves to '' and falls into the `mustBind && !idToken` refusal below, which is the
// contract that already exists for a window the member closed: loud, and one click from
// recovery, because the device key is minted once and reused on the retry.
const SIGN_IN_TIMEOUT_MS = 120000;
const withSignInTimeout = (p, ms) => new Promise((resolve) => {
  ms = Number(ms) > 0 ? Number(ms) : SIGN_IN_TIMEOUT_MS;
  let settled = false;
  const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
  // unref so a provider that never settles cannot hold the app's event loop open on exit.
  const timer = setTimeout(() => finish(''), ms);
  timer.unref?.();
  Promise.resolve(p).then(finish, () => finish(''));
});

export async function stageWithDirectory(inv, publicKey, fingerprint, { idToken = '', fetcher = fetch, directoryUrl = DIRECTORY_URL } = {}) {
  if (!directoryUrl) return false;
  let refusal = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    // THE MACHINE'S NAME (finding 116, 2026-08-13). /enrol-request has always
    // carried device_name, and enrol-sync names the roster row from it. This,
    // the ADMIN-FIRST claim path, did not — so a member who arrived by invite
    // got a row labelled with the status phrase device-sync stamps when it has
    // nothing better ('Approved by your rock') and a slug made of their
    // fingerprint. That is the list you revoke a lost laptop from, and with two
    // devices both rows read identically. Same field, same shape, same 60-char
    // cap as the path that already worked.
    // host + anchor ride along, and NEITHER decides anything (finding 159 and its omission
    // fix, 2026-08-16). The first version of the account gate looked the mineral up by the
    // `host` sent from here, which meant a caller that simply left the field out skipped the
    // lookup and with it the gate. The broker now rebuilds the address from `slug`, which is
    // mandatory and is the thing being claimed, so `host` is sent for compatibility and is
    // read by nothing. `anchor` survives as an honesty signal that can only ADD a demand:
    // an invite that says it is rock-owned asks for the sign-in even in the seconds before
    // the new box has registered itself. See the account gate in directory/worker.js POST
    // /redeem.
    const body = { org: inv.org, slug: inv.slug, token: inv.token, pubkey: String(publicKey).trim(), fingerprint,
      device_name: machineName(), host: String(inv.host || ''), ...(inv.anchor ? { anchor: String(inv.anchor) } : {}) };
    // P1.2 (spec 2026-07-24 § 1): the OAuth ID token rides the envelope as a sealed
    // proof for the ROCK to verify. The worker relays it to the rock untouched, and since
    // 2026-08-16 also verifies it itself before staging, because on the crads-solo lane the
    // rock never sees it and nothing else was checking.
    const idt = String(idToken || '');
    if (idt && idt.length <= MAX_ID_TOKEN_BYTES) body.id_token = idt;
    const r = await fetcher(directoryUrl + '/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify(body),
    });
    clearTimeout(timer);
    // A REFUSAL IS NOT AN OUTAGE (finding 159, 2026-08-16). This returned r.ok, so a 403
    // "that mineral belongs to a different account" arrived at the page as staged:false,
    // which reads as "the broker is down, carry on with the manual path": the silent
    // downgrade the whole finding is about, wearing the one shape nobody would look at.
    //
    // 401 and 403 ONLY, deliberately narrow: those two are the account gate saying no about
    // WHO this is, and there is no honest fallback for that. Everything else keeps the
    // fail-silent contract this function has always had, including 400. A malformed envelope
    // is our bug, not the member's, and turning it into a dead end would strand a claim the
    // Phase-1 manual path can still complete.
    if (r.status === 401 || r.status === 403) {
      let why = '';
      try { why = String(((await r.json()) || {}).error || ''); } catch { /* no body to read */ }
      refusal = new Error(why || 'the invite could not be claimed from this machine');
      refusal.status = 400;
      throw refusal;
    }
    return !!r.ok;
  } catch (e) { if (refusal && e === refusal) throw e; return false; }   // fail-silent: nothing central is required
}
import { forgetHost, runSsh, listPanelTargets, pinHostForUser, hostNameFor, userKnownHostsPath } from './ssh-bridge.mjs';
import { registerClaudeSshConfig, unregisterClaudeSshConfig, claudeSettingsPath, syncClaudeStartDir, OPEN_FOLDER_PROBE } from './claude-settings.mjs';
import { createOwnBrainRoutes } from './own-brain-routes.mjs';
import { ensureVaultKeypair } from './vault-crypto.mjs';
import { crossOriginBlocked, refuseCrossOrigin } from './same-origin.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

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

// D51: parse a self-describing invite link into its parts. Accepts a full URL
// (https://crads-ai.com/join#v1.<org>.<slug>.<payload>) or a bare fragment. The payload is
// base64url("host|sip|user|token"). No network + no Sam-run service needed to redeem.
// factory#2: the payload MAY carry two extra pipe-separated fields after the token
// ("...|token|tier_name|tier_description") so the member sees their assigned level
// during onboarding. Legacy links omit them and the fields come back as empty strings.
//
// FIELD 7 IS THE ANCHOR, and this parser used to drop it (finding 136 follow-up,
// 2026-08-16). The /join page's twin (wizard/join-page/join-parse.mjs, f[6])
// learned it when 136 landed and this one did not, so one format had two parsers
// that disagreed about what the format was: the app could not distinguish an
// anchored invite from a solo one however carefully the minter filled it in.
// That is the same shape as 136 itself, which is why the two are now pinned to
// each other by invite-anchor-lockstep.test.mjs.
//
// The anchor is WHO OWNS the box. It is not the same question as the dotted
// `org` segment, which is the staging lane, i.e. WHO APPROVES the device. See
// isSoloInvite above before reaching for it.
export function parseInviteLink(link) {
  const s = String(link || '').trim();
  const frag = s.includes('#') ? s.slice(s.indexOf('#') + 1) : s;
  const parts = frag.split('.');
  if (parts[0] !== 'v1' || parts.length < 4) bad('that does not look like an invite link (expected v1.<org>.<slug>.<code>)');
  const org = parts[1], slug = parts[2], b64 = parts.slice(3).join('.');
  let decoded = '';
  try {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    decoded = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
  } catch { bad('the invite link is corrupt; ask your admin to re-send it'); }
  const [host, sip, user, token, tierName, tierDescription, anchor] = decoded.split('|');
  if (!slug || !host) bad('the invite link is missing the mineral address; ask your admin to re-send it');
  return {
    org, slug, host, sip: sip || host, user: user || 'member', token: token || '',
    tierName: tierName || '', tierDescription: tierDescription || '',
    // '' and never undefined: the page's twin returns '' for an absent anchor,
    // and a reader testing truthiness must get the same answer from both.
    anchor: anchor || '',
  };
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

// createMemberConnectServer({ port, host, htmlText|htmlPath, sshDir, runner })
// -> the listening http.Server. runner is injectable (tests): (host, cmd) ->
// Promise<{ code, stdout, stderr }>; defaults to the real ssh bridge.

// ---- D58 P4 join-flow helpers ------------------------------------------------------
// The resumable dotfile holds ONLY {id, secret, org, orgDisplay, at}: enough for a
// restarted app to keep polling for its outcome, never the id_token.
// Org-binding nonce: deterministic from the handle so the ROCK can recompute and
// verify the signed token commits to ITS org (keep in lockstep with join-reconcile.mjs).
export function joinNonce(org) { return createHash('sha256').update('crads-join:' + String(org).toLowerCase()).digest('hex'); }
const JOIN_MAX_AGE_MS = 8 * 24 * 3600 * 1000;   // just past the worker's 7-day request TTL
const joinStatePathOf = (opts) => opts.joinStatePath || join(homedir(), '.crads-ai-join.json');
function loadJoinState(opts) {
  try {
    const st = JSON.parse(readFileSync(joinStatePathOf(opts), 'utf8'));
    if (st && /^[0-9a-f]{8,40}$/.test(String(st.id || '')) && st.secret) return { stage: 'requested', ...st };
  } catch { /* none pending */ }
  return null;
}
function saveJoinState(opts, st) {
  try { writeFileSync(joinStatePathOf(opts), JSON.stringify({ id: st.id, secret: st.secret, org: st.org, orgDisplay: st.orgDisplay, at: st.at || Date.now() }), { mode: 0o600 }); } catch { /* best-effort */ }
}
function clearJoinState(opts) { try { unlinkSync(joinStatePathOf(opts)); } catch { /* already gone */ } }
function startJoinPolling(server, st, opts) {
  if (st._polling) return;
  st._polling = true;
  const jf = opts.joinFetcher || fetch;
  const dir = opts.joinDirectoryUrl || DIRECTORY_URL;
  const ms = opts.joinPollMs || 15000;
  // A join request resumed from an older dotfile has nowhere left to poll: the
  // central directory is gone (self-host strip). Settle it honestly rather
  // than fetching a dead host every 15 seconds. An injected fetcher (tests, or
  // a future commons endpoint) counts as a live far end.
  if (!dir && !opts.joinFetcher) { st.stage = 'failed'; st.reason = 'community membership is moving to the commons model; the central join service has been retired'; clearJoinState(opts); return; }
  const tick = async () => {
    if (server._joinOrg !== st) return;
    // Give up once the request has outlived the worker's TTL (2026-07-24 review minor: an
    // unactioned request would otherwise poll forever after the record expired to 'unknown').
    if (st.at && Date.now() - st.at > JOIN_MAX_AGE_MS) { st.stage = 'expired'; clearJoinState(opts); return; }
    try {
      const r = await jf(`${dir}/join-status?id=${encodeURIComponent(st.id)}&secret=${encodeURIComponent(st.secret)}`);
      const b = await r.json().catch(() => ({}));
      if (server._joinOrg !== st) return;
      if (b.status === 'approved' && b.invite) { st.stage = 'approved'; st.invite = b.invite; clearJoinState(opts); return; }
      if (b.status === 'declined') { st.stage = 'declined'; st.note = b.note || ''; clearJoinState(opts); return; }
      // pending / unknown / transient: keep listening (requests live days, not minutes)
    } catch { /* transient */ }
    const t = setTimeout(tick, ms);
    if (t.unref) t.unref();
  };
  tick();
}

export function createMemberConnectServer(opts = {}) {
  const runner = opts.runner || ((host, cmd) => runSsh(host, cmd));
  const html = () => (opts.htmlText ?? readFileSync(opts.htmlPath || join(HERE, 'member-connect.html')));
  // D56: after installing a key, also register the connection (with the right
  // start folder) in the Claude Code app's settings, so the Environment
  // dropdown shows it ready-made. Best-effort: a refusal never fails the flow.
  // R18 (2026-08-23): /state for BOTH kinds at install time. Every face lands in
  // /state now, and the mineral-named folder inside it (/state/<name>, what the
  // box wrote to /state/open-folder) is registered by the /test leg below, the
  // first moment this machine can actually ask the box. Registering a folder
  // nobody has confirmed exists would be a session Claude Code cannot open.
  const settingsPath = opts.claudeSettingsPath || claudeSettingsPath();
  const registerInClaude = (alias, kind, label) => {
    try {
      return registerClaudeSshConfig({
        id: alias, name: label || alias, sshHost: alias,
        startDirectory: '/state',
      }, settingsPath);
    } catch { return { ok: false, reason: 'could not write Claude Code settings' }; }
  };
  const syncOpenFolder = (alias) => runner(alias, OPEN_FOLDER_PROBE)
    .then((r) => (r && r.code === 0 ? syncClaudeStartDir(alias, r.stdout, settingsPath) : null))
    .catch(() => null);

  // D52 cross-surface nav: getters because the sibling servers bind after us.
  const surfaceUrl = (name) => { const u = (opts.urls || {})[name]; return typeof u === 'function' ? u() : u; };

  // The own-brain flow (shared with the member's seat; see own-brain-routes.mjs).
  // This surface's box is whichever member box the machine is connected to, exactly
  // as the inline handlers resolved it before the extraction.
  const connectMemberTargets = () => (opts.listTargets || (() => listPanelTargets()))().filter((t) => t && t.kind === 'member');
  const ownBrainRoute = createOwnBrainRoutes({
    opts,
    defaultHost: () => { const t = connectMemberTargets(); return t.length ? t[0].host : null; },
    resolveHost: (want) => { const t = connectMemberTargets().find((x) => x.host === want); return t ? t.host : null; },
  });

  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];

    // One gate for every state-changing verb on this server (2026-08-20 audit).
    if (crossOriginBlocked(req)) return refuseCrossOrigin(res);

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html());
      return;
    }

    // Vendored frontend assets (tokens.css, inter/) — same contract as the panel
    // server; without this route the connect page's font link 404s silently.
    // Packaged exe: opts.vendor carries the SEA-embedded bytes (disk read would
    // miss inside the exe); the disk fallback keeps dev checkouts working.
    if (req.method === 'GET' && path.startsWith('/vendor/')) {
      const name = path.slice(8);
      if (!/^[a-z0-9._-]+(\/[a-z0-9._-]+)?$/i.test(name) || name.includes('..')) { res.writeHead(404); res.end(); return; }
      let body = (opts.vendor || {})[name] || null;
      if (!body) { try { body = readFileSync(join(HERE, 'vendor', name)); } catch { /* 404 below */ } }
      if (!body) { res.writeHead(404); res.end(); return; }
      const ct = name.endsWith('.css') ? 'text/css' : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript';
      res.writeHead(200, { 'content-type': ct });
      res.end(body);
      return;
    }

    // ---- D58 P5: "Your rocks" picker. Local boxes always; central edges after
    // the member confirms their email by signing in. Token + email stay server-side.
    if (req.method === 'GET' && path === '/my-orgs') {
      const st = server._myOrgs || {};
      const localTargets = (opts.listTargets || (() => listPanelTargets()))().filter((t) => t && t.kind === 'member');
      const localSlugs = new Set(localTargets.map((t) => t.org));   // org field = slug for a member box alias
      const byOrg = new Map();
      for (const e of (st.edges || [])) {
        byOrg.set(e.org, { org: e.org, role: e.role, status: e.status, slug: e.slug, box: e.box, ...(e.owner ? { owner: e.owner } : {}),
          // pause honesty (2026-08-03): who shut the door, when, and their words
          ...(e.paused_reason ? { paused_reason: e.paused_reason } : {}), ...(e.paused ? { paused: e.paused } : {}),
          connected: localSlugs.has(e.slug) });
      }
      // local boxes whose org we do not yet know (no matching edge) still surface
      for (const t of localTargets) {
        if (![...byOrg.values()].some((o) => o.slug === t.org)) byOrg.set(`local:${t.org}`, { org: null, slug: t.org, role: null, status: 'active', connected: true });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ signedIn: !!st.edges, reason: st.reason, orgs: [...byOrg.values()] }));
      return;
    }
    if (req.method === 'POST' && path === '/my-orgs/refresh') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      (async () => {
        const st = {}; server._myOrgs = st;
        try {
          // Self-host strip: no directory means no /edges to read and no reason
          // to open a sign-in window. Say so before asking anyone to sign in.
          // An injected fetcher (tests, or a future commons endpoint) counts
          // as a live far end.
          if (!(opts.joinDirectoryUrl || DIRECTORY_URL) && !opts.myOrgsFetcher && !opts.myOrgsSignIn) {
            st.reason = 'community membership is moving to the commons model; the central organisation listing has been retired';
            return;
          }
          const signIn = opts.myOrgsSignIn || (await import('./crads-account.mjs')).signInWithCrads;
          const signed = await signIn({ nonce: randomBytes(12).toString('hex') });
          if (server._myOrgs !== st) return;
          if (!signed.ok) { st.reason = signed.reason || 'sign-in did not complete'; return; }
          const email = (() => { try { return String(JSON.parse(Buffer.from(String(signed.idToken).split('.')[1], 'base64url').toString()).email || ''); } catch { return ''; } })();
          if (!email) { st.reason = 'sign-in did not prove an email'; return; }
          const eh = createHash('sha256').update(email.toLowerCase()).digest('hex');
          const jf = opts.myOrgsFetcher || fetch;
          const dir = opts.joinDirectoryUrl || DIRECTORY_URL;
          // 2026-08-03 fix: /edges now requires the caller to PROVE the email the hash was
          // derived from. The Google sign-in above already produced that proof (signed.idToken);
          // it was being decoded locally for the email but never sent. Send it as a bearer
          // token, never in the query string (query strings land in logs/proxies).
          const r = await jf(`${dir}/edges?e=${eh}`, { headers: { authorization: `Bearer ${signed.idToken}` } });
          const body = await r.json().catch(() => ({ edges: [] }));
          if (server._myOrgs !== st) return;
          st.edges = Array.isArray(body.edges) ? body.edges : [];
        } catch (e) { st.reason = String(e.message || e); }
      })();
      return;
    }

    // ---- D58 P4: member-driven request-to-join. -------------------------------------
    // The poll secret + id_token live in this closure (+ a resumable dotfile holding
    // only {id, secret, org}; never the token). Nothing sensitive leaves in responses.
    if (req.method === 'GET' && path === '/join-org/status') {
      const st = server._joinOrg || loadJoinState(opts) || { stage: 'idle' };
      server._joinOrg = st;
      if (st.stage === 'requested' && !st._polling) startJoinPolling(server, st, opts);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ stage: st.stage, orgDisplay: st.orgDisplay, invite: st.invite, note: st.note, reason: st.reason }));
      return;
    }
    if (req.method === 'POST' && (path === '/join-org/lookup' || path === '/join-org/submit')) {
      if (!/application\/json/i.test(String(req.headers['content-type'] || ''))) {
        res.writeHead(415, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'json only' })); return;
      }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        let form;
        try { form = JSON.parse(body); } catch { json(400, { error: 'bad json' }); return; }
        const handle = String(form.handle || '').trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,62}$/.test(handle)) { json(400, { error: 'that handle does not look right' }); return; }
        const jf = opts.joinFetcher || fetch;
        const dir = opts.joinDirectoryUrl || DIRECTORY_URL;
        // Self-host strip: there is no central route registry to look a handle
        // up in and no request queue to stage a join into. Honest and final,
        // not an error a member should retry. An injected fetcher (tests, or a
        // future commons endpoint) counts as a live far end.
        if (!dir && !opts.joinFetcher) { json(503, { error: 'community membership is moving to the commons model; joining through the central directory has been retired' }); return; }
        (async () => {
          try {
            const route = await jf(`${dir}/route?org=${encodeURIComponent(handle)}`);
            if (!route.ok) { json(404, { error: `no rock answers to "${handle}"; check the handle with whoever gave it to you` }); return; }
            const info = await route.json();
            if (path === '/join-org/lookup') { json(200, { orgDisplay: info.org_display || handle }); return; }

            const name = String(form.name || '').trim().slice(0, 80);
            if (!name) { json(400, { error: 'tell them who you are: your name is required' }); return; }
            const st = { stage: 'signin', orgDisplay: info.org_display || handle };
            server._joinOrg = st;
            json(200, { ok: true });
            const signIn = opts.joinSignIn || (await import('./crads-account.mjs')).signInWithCrads;
            // Bind the sign-in to THIS org (2026-07-24 review): the OIDC nonce commits the
            // signed token to the org handle, so a token captured for org A cannot be
            // re-staged as a verified request at org B (the rock recomputes + checks it).
            // scope 'join' so this token cannot act as the applicant anywhere
            // else: the directory stores it raw for 7 days and serves it to the
            // rock, so it must be purpose-bound (2026-08-20 audit).
            const signed = await signIn({ nonce: joinNonce(handle), scope: 'join' });
            if (server._joinOrg !== st) return;
            if (!signed.ok) { st.stage = 'failed'; st.reason = signed.reason || 'sign-in did not complete'; return; }
            const email = (() => {
              try { return String(JSON.parse(Buffer.from(String(signed.idToken).split('.')[1], 'base64url').toString()).email || ''); } catch { return ''; }
            })();
            if (!email) { st.stage = 'failed'; st.reason = 'the sign-in did not prove an email address'; return; }
            const secret = randomBytes(24).toString('hex');
            const secretHash = createHash('sha256').update(secret).digest('hex');
            const rq = await jf(`${dir}/join-request`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ org: handle, name, email, id_token: signed.idToken, secret_hash: secretHash }),
            });
            const rqBody = await rq.json().catch(() => ({}));
            if (server._joinOrg !== st) return;
            if (!rq.ok || !rqBody.id) { st.stage = 'failed'; st.reason = rqBody.error || `the request could not be staged (HTTP ${rq.status})`; return; }
            st.stage = 'requested'; st.id = rqBody.id; st.secret = secret; st.org = handle; st.at = Date.now();
            saveJoinState(opts, st);
            startJoinPolling(server, st, opts);
          } catch (e) {
            if (!res.writableEnded) json(500, { error: String(e.message || e) });
            server._joinOrg = { stage: 'failed', reason: String(e.message || e) };
          }
        })();
      });
      return;
    }

    // ---- D58 P3: the own-brain flow (member-owned brain repo). ----------------------
    // The handlers moved to own-brain-routes.mjs on 2026-08-05 so the member's own seat
    // can mount the SAME three routes and run the flow without leaving the app. This
    // wizard keeps serving them unchanged for the member who really is mid-claim.
    if (ownBrainRoute(req, res, path)) return;

    if (req.method === 'GET' && (path === '/door' || path === '/dashboard' || path === '/panel')) {
      const u = surfaceUrl(path === '/door' ? 'door' : path === '/dashboard' ? 'member' : 'panel');
      if (u) { res.writeHead(302, { location: u }); res.end(); }
      else { res.writeHead(404); res.end('that screen is not up yet; give it a second and try again, or reopen the app'); }
      return;
    }

    if (req.method === 'POST' && (path === '/generate' || path === '/test' || path === '/redeem')) {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        let form;
        try { form = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
        const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

        // D51 admin-first redeem: parse the invite link, mint the device key locally, and
        // return the 6-char code the member reads to their admin (+ the public line to send).
        // The SSH Host block points at the raw VM IP (sip), never the Cloudflare-proxied host.
        if (path === '/redeem') {
          (async () => {
            try {
              const inv = parseInviteLink(form.link);
              if (!SLUG_RE.test(inv.slug)) { json(400, { error: 'invite slug is invalid' }); return; }
              // An aios-op invite is a ROCK's owner claiming their org box
              // (self-serve rocks, 2026-08-09): same claim chain as a pebble,
              // but the identity that lands must be the operator one —
              // <slug>-rock + aios-op — or the app never opens the org panel
              // and the box's only remembered face is the browser door the
              // 2026-08-05 ruling shut. Routed off the invite's own user field,
              // which fulfil-arrivals mints; a hand-built link claiming aios-op
              // buys the sender nothing (the key still has to be approved into
              // the box's people registry by the enrol job's token check).
              const isOp = inv.user === 'aios-op';
              const acc = isOp
                ? installOperatorAccess({ org: inv.slug, host: inv.sip, role: 'admin' }, opts.sshDir)
                : installMemberAccess({ slug: inv.slug, host: inv.sip, user: inv.user }, opts.sshDir);
              registerInClaude(acc.alias, isOp ? 'operator' : 'member',
                isOp ? `${inv.slug} (rock)` : `My assistant (${inv.slug})`);
              const fingerprint = deviceFingerprint(acc.publicKey);
              // Try to stage the PUBLIC key centrally (removes the paste-back); falls back silently.
              // P1.2: an OAuth ID token (from the form, or an injected provider once the app's
              // sign-in ships) rides along so the rock can auto-approve the device.
              // CONTRACT (security-review 2026-07-24): the sign-in flow MUST request the OIDC
              // nonce = this device's fingerprint, so the signed token commits to the key being
              // enrolled and a hostile broker cannot swap the staged pubkey. The provider gets
              // the key material for exactly that purpose; the rock enforces the match.
              // ...but a STANDALONE pebble has no rock rock, so there is
              // nobody for a signed token to prove anything to: the invite token is
              // the whole proof. Asking anyway blocked the redeem behind a surprise
              // browser window, and a stranger who closed it got up to 180s of a
              // frozen "Setting up your device…" with the button stuck disabled
              // (QA 2026-07-30, hit by curl in 30s flat). Solo skips the handshake.
              //
              // ...but an ANCHORED pebble is neither of those cases, and this is where finding
              // 159 lived: the invite says a rock owns it, /join tells the member "the invite
              // only works for that address", and the lane still said crads-solo, so this
              // skipped the handshake and the claim completed with no identity anywhere in it.
              // signInRequired reads the anchor for exactly that; isSoloInvite still reads the
              // lane for its own question, and both are needed.
              let idToken = String(form.id_token || '');
              const mustBind = signInRequired(inv);
              if (isSoloInvite(inv) && !mustBind) idToken = '';
              else if (!idToken && opts.idTokenProvider) {
                try { idToken = String((await withSignInTimeout(opts.idTokenProvider(inv, { publicKey: acc.publicKey, fingerprint }), opts.signInTimeoutMs)) || ''); } catch { idToken = ''; }
              }
              // REFUSED, NOT DOWNGRADED. A swallowed provider (window closed, popup blocked,
              // offline for that one call) used to stage tokenless, and nothing downstream
              // said so: docs/archive/invite-door-gap-2026-08-14.md § 1. On an anchored invite that
              // silently voids the address lock the member was just shown, so it stops here
              // instead. Loud and one click from recovery, not stranding: the key is already
              // minted and reused, so pressing the button again re-runs only the sign-in.
              if (mustBind && !idToken) {
                json(401, { error: 'This invite is locked to the email address it was sent to. The sign-in did not finish, so nothing was claimed. Press "Set up my device" again and complete the sign-in window in your browser.' });
                return;
              }
              const stage = opts.stageWithDirectory || stageWithDirectory;
              const staged = await stage(inv, acc.publicKey, fingerprint, { idToken });
              // The KIND rides back with the alias. The page has to hand it to /test
              // on every poll, and it cannot infer it: the invite is a hash the page
              // deliberately drops from the address bar. Hardcoding 'member' there
              // (live on test-org-4, 2026-08-10) tested a `<slug>-box` no rock claim
              // ever installed, so the whoami failed forever and the pin below it
              // never ran. See the /test resolver.
              json(200, { slug: inv.slug, org: inv.org, host: inv.host, sip: inv.sip,
                kind: isOp ? 'operator' : 'member',
                alias: acc.alias, reused: acc.reused, publicKey: acc.publicKey, fingerprint, staged,
                tierName: inv.tierName, tierDescription: inv.tierDescription,   // factory#2
                id_token_sent: !!idToken });
            } catch (e) { json(e.status === 400 ? 400 : 500, { error: String(e.message || e) }); }
          })();
          return;
        }

        if (path === '/generate') {
          try {
            const acc = form.kind === 'operator'
              ? installOperatorAccess({ org: form.slug, host: form.host, role: form.role }, opts.sshDir)
              : installMemberAccess(form, opts.sshDir);
            registerInClaude(acc.alias, form.kind === 'operator' ? 'operator' : 'member',
              form.kind === 'operator' ? `${form.slug} (rock)` : `My assistant (${form.slug})`);
            json(200, acc);
          } catch (e) { json(e.status === 400 ? 400 : 500, { error: String(e.message || e) }); }
          return;
        }

        // /test: one whoami over the just-installed alias
        const slug = String(form.slug ?? '');
        if (!SLUG_RE.test(slug)) { json(400, { error: 'slug must match [a-z0-9-]{2,32}' }); return; }
        const testSshDir = opts.sshDir || join(homedir(), '.ssh');
        const testCfg = join(testSshDir, 'config');
        // Which identity is this? The caller says so, but a caller that says it
        // WRONG used to fail silently and expensively, so the config gets the last
        // word. member-connect.html hardcoded kind:'member' on both of its /test
        // calls, so a self-serve ROCK claim (which installs `<slug>-rock`) went
        // on whoami-ing a `<slug>-box` that has no Host block at all: the test
        // could never pass, the page polled "your rock hasn't approved this
        // device" forever, and, the real damage, the pin below never ran, so the
        // connection /redeem had already registered in Claude Code sat un-pinned
        // and the app answered "Host denied (verification failed)" (test-org-4,
        // 2026-08-10). If the asked-for alias has no Host block and its sibling
        // does, the sibling is the only identity this machine actually has for the
        // slug; take the KIND from the alias that wins, never from the form, or a
        // mislabelled call would spin up the wrong dashboard on the way past.
        const asked = form.kind === 'operator' ? `${slug}-rock` : `${slug}-box`;
        const alias = hostNameFor(asked, testCfg)
          ? asked
          : [`${slug}-rock`, `${slug}-box`].find((a) => hostNameFor(a, testCfg)) || asked;
        const kind = alias.endsWith('-rock') ? 'operator' : 'member';
        runner(alias, 'whoami').then(async (r) => {
          // D52: a passing test means the identity is live NOW — let the app spin
          // up the matching dashboard surface so "close and reopen" isn't needed.
          if (r.code === 0 && opts.onConnected) {
            try { opts.onConnected({ kind, alias }); } catch { /* observer only */ }
          }
          if (r.code === 0) {
            // R18: the box is reachable, so ask it which folder Claude Code
            // should open and point the registered connection at it.
            await syncOpenFolder(alias);
            // owed item (g), closed: the connect test just VERIFIED this box, so
            // its key (learned by our bridge under accept-new) now also lands in
            // the user's known_hosts — the only file the Claude Code app's
            // bundled ssh reads. Best-effort: a pin hiccup never fails the test.
            try {
              const addr = hostNameFor(alias, testCfg);
              if (addr) pinHostForUser(addr, { sshDir: testSshDir, ...(opts.appKnownHosts ? { appPath: opts.appKnownHosts } : {}) });
            } catch { /* the next passing test re-pins */ }
          }
          json(200, { ok: r.code === 0, output: (r.code === 0 ? r.stdout : r.stdout + r.stderr).trim().slice(0, 500) });
        });
      });
      return;
    }

    res.writeHead(404); res.end();
  });

  server.listen(opts.port ?? 0, opts.host || '127.0.0.1');
  return server;
}
