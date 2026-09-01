#!/usr/bin/env node
// auto-approve.mjs — the whole of device enrolment (D58 § 1; rewritten 2026-08-09).
// Given the staged redeems invite-reconcile pulled, enrol them. There is no
// second, human half any more: Sam's ruling that day killed the fingerprint
// readback ceremony after an audit showed it was inert — the panel sent the
// code and the pubkey from the SAME broker payload and the server re-derived
// the code from that same key, so the check was equal by construction, the
// admin's "Yes, let them in" was clickable without contacting anyone, and
// "No / not sure" merely re-showed the button. What always did the real work
// is gate 5 below, plus the IdP's signature when one is offered.
//
// Gate, in order, per staged entry:
//   1. slug is well-formed
//   2. pubkey is EXACTLY one well-formed ssh-ed25519 public line (anchored: a
//      prefix-only check allowed quote+newline YAML smuggling of extra keys)
//   3. slug exists in registry/members/ with status invited|active
//   4. the row carries an email
//   5. INVITE-TOKEN BINDING: sha256(staged token) equals the stored
//      invite.token_hash. This is "the link is the proof": a guessed slug or a
//      leaked directory record cannot pass it without being THE invite. It is
//      sufficient on its own, which is what lets a solo pebble — with no IdP to
//      prove anything to, and no token by design — complete without a human.
//   6. IF an id_token was offered: verifyIdToken — IdP signature + tenant pin
//      (Microsoft) + audience + email == registry email + email_verified
//      (Google) + freshness + NONCE == the device fingerprint DERIVED HERE from
//      the staged pubkey, so the signed token commits to the key being enrolled
//      and a hostile broker cannot swap it. A token that is PRESENT but does
//      not verify FAILS: an identity claim failing its own check must never
//      silently degrade to the tokenless path. The staged fingerprint field is
//      display-only and never trusted.
//   7. approve sequence (the acts the panel's approve-device used to perform):
//      append key, flip status active, stamp redeemed + fingerprint,
//      build-index, git commit+push, push-member-key, invite-consume, and
//      record to control/device-activity.json for the panel's Recent-device-
//      activity surface. `details[]` carries HOW each device was proven, so the
//      notice invite-reconcile sends can say so — with no approval step left,
//      that notice is the whole of an admin's awareness that someone joined.
//
// Testable by injection: runner (pebble processes), jwksSource, audience, now.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { verifyIdToken, ReplayGuard } from './idtoken-verify.mjs';
import { deviceFingerprint } from './fingerprint.mjs';
import { resolveOrgToken } from '../factory/org-github.mjs';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
// Anchored, same shape push-member-key enforces per line. Nothing else may be written.
const PUBKEY_RE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9@._ -]{1,64})?$/;
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const yq = (text, key) => (text.match(new RegExp(`^${key}:\\s*"?([^"\\n#]*)"?`, 'm')) || [])[1]?.trim() ?? '';

const sharedGuard = new ReplayGuard({});

export async function autoApprove({ repoRoot, pending, audience, jwksSource, runner, msTenants = [], replayGuard = sharedGuard, now = () => new Date(), log = () => {} }) {
  const approved = [], remaining = [], details = [];
  for (const entry of pending || []) {
    const fail = (reason) => { remaining.push({ ...entry, verify_failed: reason }); log(`auto-approve: ${entry.slug}: ${reason}`); };
    if (!entry) { remaining.push(entry); continue; }
    // NO id_token: still auto-approved (Sam's ruling 2026-08-09, "the link is
    // the proof"). This used to fall through to a human reading a 6-char code
    // back to an admin — a ceremony the 2026-08-09 audit showed was inert: the
    // panel sent the fingerprint and the pubkey from the SAME broker payload
    // and the server re-derived the code from that same key, so it compared
    // broker data with broker data, equal by construction. What actually binds
    // a device here is the invite-token check below (gate 6), which a leaked
    // link cannot pass without being THE invite. A solo pebble has no IdP to
    // prove to and deliberately sends no token at all, so this is also the only
    // way that lane ever completes without a human.
    //
    // A token that is PRESENT but does not verify is a different animal: that
    // is a claim of identity failing its own check, so it still fails hard
    // below rather than silently degrading to the tokenless path.
    const proven = entry.id_token ? 'id_token' : 'invite_token';
    if (!SLUG_RE.test(String(entry.slug || ''))) { fail('bad slug'); continue; }
    const pubkey = String(entry.pubkey || '').trim();
    if (!PUBKEY_RE.test(pubkey)) { fail('pubkey is not one well-formed ssh-ed25519 public line'); continue; }
    // The ONLY fingerprint that matters is derived from the staged key itself.
    const fp = deviceFingerprint(pubkey);

    const rowPath = path.join(repoRoot, 'registry', 'members', `${entry.slug}.yaml`);
    const row = await readFile(rowPath, 'utf8').catch(() => '');
    if (!row) { fail('not in the registry'); continue; }
    const status = yq(row, 'status');
    if (status !== 'invited' && status !== 'active') { fail(`status "${status}" cannot enrol a device`); continue; }
    const email = yq(row, 'email');
    if (!email) { fail('registry row has no email to verify against'); continue; }
    const tokenHash = (row.match(/^\s{2}token_hash:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim() ?? '';
    if (!tokenHash || sha256(entry.token) !== tokenHash) { fail('invite-token binding mismatch'); continue; }

    // The strongest proof when it is offered: the IdP's signature, the email
    // matching the registry row, and a nonce committing to THIS pubkey.
    if (proven === 'id_token') {
      const v = await verifyIdToken(entry.id_token, { email, audience, jwksSource, replayGuard, msTenants, expectedNonce: fp });
      if (!v.ok) { fail(v.reason); continue; }
    }

    try {
      // approve sequence — the same acts the panel's approve-device performs
      const keysDir = path.join(repoRoot, 'registry', 'members', 'keys');
      await mkdir(keysDir, { recursive: true });
      const keyPath = path.join(keysDir, `${entry.slug}.yaml`);
      let keys = await readFile(keyPath, 'utf8').catch(() => '');
      if (!keys) keys = `slug: "${entry.slug}"\npubkeys:\n`;
      if (!keys.includes(pubkey)) keys += `  - "${pubkey}"\n`;
      await writeFile(keyPath, keys);

      // WHAT THE MEMBER CALLS THIS MACHINE (finding 116, 2026-08-13). The
      // self-serve path has always carried device_name and enrol-sync names the
      // roster row from it; the admin-first path dropped it, so every device a
      // rock approved landed on the member's box labelled with device-sync's
      // fallback status phrase, "Approved by your rock", under a slug made of
      // its own fingerprint. Two devices, two identical rows, and that is the
      // list you revoke a lost laptop from.
      //
      // Keyed by FINGERPRINT, not by slug: a member may hold several devices,
      // and the fingerprint is the only thing that identifies one of them on
      // both sides. Written next to the keys, carried down by push-member-key.
      const dn = String(entry.device_name || '').replace(/[^\x20-\x7E]/g, '').replace(/"/g, '').trim().slice(0, 60);
      if (dn) {
        const namePath = path.join(keysDir, `${entry.slug}.names.yaml`);
        let names = await readFile(namePath, 'utf8').catch(() => '');
        if (!names) names = `slug: "${entry.slug}"\nnames:\n`;
        if (!names.includes(`${fp}:`)) names += `  ${fp}: "${dn}"\n`;
        await writeFile(namePath, names);
      }

      const today = now().toISOString().slice(0, 10);
      let updated = row
        .replace(/^status:.*$/m, 'status: "active"')
        .replace(/^(\s{2})redeemed:.*$/m, `$1redeemed: "${today}"`)
        .replace(/^(\s{2})device_fingerprint:.*$/m, `$1device_fingerprint: "${fp}"`);
      // WIRED IS TRUE THE MOMENT A DEVICE IS APPROVED (finding 102, 2026-08-13).
      // The stall board carries two grace windows, written after Sam's 2026-08-10
      // screenshot, so a member who has not checked in YET is shown as "just
      // wired: waiting for their first check-in" rather than accused of going
      // dark. Both are gated on `wired`, and `wired` was only ever set on the
      // ADOPT path: a member the rock stamped kept the empty string it was born
      // with, so both windows were unreachable and every fresh member dropped
      // straight to AT RISK · "never checked in" the moment they claimed.
      //
      // This is the point where the sentence becomes true: their key is on the
      // box and their inbox channel exists, so there is now something to check
      // in through. First write wins, so a re-approval never moves the date.
      if (/^wired:\s*["']?\s*["']?\s*$/m.test(updated)) {
        updated = updated.replace(/^wired:.*$/m, `wired: "${today}"`);
      } else if (!/^wired:/m.test(updated)) {
        updated += `wired: "${today}"\n`;
      }
      await writeFile(rowPath, updated);

      const opts = { cwd: repoRoot };
      await runner('node', [path.join('registry', 'build-index.mjs')], opts);
      await runner('git', ['add', 'registry/'], opts);
      // Commit tolerates "nothing to commit" (panel parity: `|| echo "(no change)"`) so an
      // idempotent RE-approval of an already-recorded device does not abort the sequence.
      try {
        await runner('git', ['-c', 'user.name=Rock-Brain', '-c', 'user.email=factory@rock.local',
          'commit', '-q', '-m', `auto-approve: ${entry.slug} device enrolled via ${proven} (fp ${fp}), box active`], opts);
      } catch { log(`auto-approve: ${entry.slug}: registry unchanged (no new commit)`); }
      // Push mirrors the panel's GIT_PUSH exactly (found on the 2026-07-24 VM cert): the
      // brain clone uses a READ-ONLY deploy key, so a bare push fails on a real box. Retry
      // with ORG_GH_TOKEN from the brain .env; if that too fails, WARN and continue — the
      // approval is complete locally and the commit rides the next successful sync, same
      // eventual-consistency posture as the panel path.
      try { await runner('git', ['push', '-q'], opts); }
      catch {
        try {
          // The shared resolver, not a regex over .env: on a door-born rock the
          // only token that exists is the one connect-github holds, and a
          // two-name regex could not see it, so this fallback was dead exactly
          // where it was needed most. Token only, because the remote below is
          // read from origin rather than composed from an owner.
          const gtok = resolveOrgToken({ brainRoot: repoRoot });
          const remote = (await runner('git', ['remote', 'get-url', 'origin'], opts))?.stdout?.trim() || '';
          const rp = remote.replace(/^git@github\.com:/, '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
          if (!gtok || !rp) throw new Error('no org token or remote');
          await runner('git', ['push', '-q', `https://x-access-token:${gtok}@github.com/${rp}.git`, 'HEAD'], opts);
        } catch {
          log(`auto-approve: WARN ${entry.slug}: registry commit is local-only (push failed; read-only deploy key and no working ORG_GH_TOKEN). Approval stands; the commit rides the next sync.`);
        }
      }
      await runner('node', [path.join('orchestrator', 'push-member-key.mjs'), entry.slug], opts);
      await runner('node', [path.join('control', 'invite-consume.mjs'), entry.slug], opts);

      // activity feed for the panel surface + notify hook (P1.5); newest first, bounded
      const actPath = path.join(repoRoot, 'control', 'device-activity.json');
      let act = [];
      try { act = JSON.parse(await readFile(actPath, 'utf8')); } catch { act = []; }
      if (!Array.isArray(act)) act = [];
      act.unshift({ slug: entry.slug, email, fingerprint: fp, at: now().toISOString(), mode: 'auto', proven });
      await writeFile(actPath, JSON.stringify(act.slice(0, 200), null, 2));

      approved.push(entry.slug);
      // Callers join approved[] into log lines and iterate it as slugs, so its
      // shape stays a string list; how each device was proven rides alongside,
      // for the notice that has to tell an admin what actually happened.
      details.push({ slug: entry.slug, proven, fingerprint: fp, email });
      log(`auto-approve: ${entry.slug} verified + activated (fp ${fp})`);
    } catch (e) {
      fail(`sequence failed: ${String(e.message || e)}`);
    }
  }
  return { approved, remaining, details };
}
