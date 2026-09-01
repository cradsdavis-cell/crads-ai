// device-enrol.mjs — "account is the way in", the ASKING device's leg (T9's
// last piece, 2026-08-10).
//
// Before this file, adding a new laptop to a mineral you already own was a
// manual key dance: generate a key somehow, get it onto the box somehow. The
// other three legs already exist — the site mints enrol-scoped tokens
// (appHandoff SCOPES=['enrol']), the worker stages requests (/enrol-request →
// /enrol-status), and the mineral verifies EVERYTHING on its own disk before a
// key lands (enrol-sync: signature, scope, nonce=sha256(pubkey), owner). This
// module is the fourth leg: what the new device itself does.
//
//   1. ask the directory which minerals this account's boxes answer to
//      (/my-boxes with a plain token — the same registration enrol-sync
//      maintains, carrying the SSH facts a Host block needs)
//   2. mint or reuse the local keypair via the SAME install path every other
//      flow uses (installMemberAccess), so the app recognises the face
//      afterwards; the private key never leaves this machine
//   3. mint an enrol token BOUND to that key (nonce = sha256 of the pubkey —
//      a stolen token cannot enrol a different key)
//   4. stage the request and wait for the mineral's own verdict
//
// The mineral is the decider. This module never writes a roster row; it asks,
// then reports the box's answer in the box's words.
import { createHash } from 'node:crypto';
// (hostname moved with machineName -> machine-name.mjs, 2026-08-13)
import { installMemberAccess, removeHostBlock } from './member-connect.mjs';
import { pinHostForUser, runSsh } from './ssh-bridge.mjs';
import { registerClaudeSshConfig, claudeSettingsPath, startDirectoryFor, OPEN_FOLDER_PROBE } from './claude-settings.mjs';

const DIRECTORY_URL = process.env.CRADS_DIRECTORY_URL || 'https://directory.crads-ai.com';
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

// WHAT THIS MACHINE IS CALLED (2026-08-12). Every enrol path used to invent a
// name, and both inventions were bad: panel-server's deviceSelfEnrol hardcoded
// "This computer", and the two browser call sites (member.html, door.html) sent
// `navigator.platform`, which is a deprecated API returning a platform family,
// not a machine. Sam's own rock ended up with a row called "This computer" and
// a row called "Win32" and nothing could say whether that was one machine or
// two. Worse at cohort scale: navigator.platform returns the SAME string for
// every Windows user alive, so a room of members would enrol a row of "Win32"s.
//
// The servers that call this module (panel-server, door-server) are the app's
// own local servers, running in Node ON the machine being enrolled, so the real
// name is simply available here. The browser should not be asked for it.
//
// machineName/machineSlug moved to machine-name.mjs on 2026-08-13 so the CLAIM
// path (member-connect.mjs) can name a device too; re-exported so every existing
// importer of this module keeps working unchanged.
export { machineName, machineSlug } from './machine-name.mjs';
import { machineName } from './machine-name.mjs';

// enrol-sync runs on odd minutes, so the verdict usually lands inside two
// minutes; the deadline leaves room for a slow scheduler tick without letting
// a dead box hold the UI forever.
const POLL_MS = 5000;
const DEADLINE_MS = 4 * 60 * 1000;

/** The minerals this account can ask to join: registered boxes + their SSH facts. */
export async function listEnrollable({ getToken, fetcher = fetch, directoryUrl = DIRECTORY_URL } = {}) {
  const t = await getToken({});
  if (!t || !t.ok) return { ok: false, reason: (t && t.reason) || 'sign in first' };
  let r;
  try {
    r = await fetcher(`${directoryUrl}/my-boxes`, { headers: { authorization: `Bearer ${t.idToken}` } });
  } catch (e) {
    return { ok: false, reason: `the directory could not be reached (${String(e && e.message || e).slice(0, 80)})` };
  }
  const b = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, reason: b.error || `the directory answered ${r.status}` };
  return { ok: true, boxes: Array.isArray(b.boxes) ? b.boxes : [] };
}

/**
 * Enrol THIS machine with one mineral. Resolves when the mineral has spoken
 * (or the deadline passes with the request still staged).
 * @param {object} p
 *   host        the mineral's registered name (a /my-boxes row's host)
 *   deviceName  optional override for what the roster should call this machine;
 *               left empty (or carrying navigator.platform junk from an older
 *               app build) it resolves to this machine's own hostname
 *   getToken    ({nonce, scope}) => {ok, idToken} — crads-account's getAppToken
 *               (silent) or signInWithCrads (interactive); injected so tests
 *               and both call sites choose
 *   onStage     optional progress callback (words, for a UI to show)
 */
export async function enrolThisDevice({
  host, deviceName = '', getToken, fetcher = fetch, directoryUrl = DIRECTORY_URL,
  sshDir, appKnownHosts, claudeSettings = claudeSettingsPath(), pollMs = POLL_MS, deadlineMs = DEADLINE_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  // injectable so a test can exercise the real forgetHost/pinHostForUser pair
  // against ONE file, which is the wiring the shipped no-op hid behind
  probeSsh = runSsh,
  onStage = () => {},
} = {}) {
  const h = String(host || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(h)) return { ok: false, reason: 'that is not a mineral name' };

  // the box's SSH facts come from its own registration — the row also proves
  // the mineral EXISTS before we mint keys for it
  const listed = await listEnrollable({ getToken, fetcher, directoryUrl });
  if (!listed.ok) return listed;
  const box = listed.boxes.find((b) => String(b.host || '').toLowerCase() === h);
  if (!box) return { ok: false, reason: `no mineral of yours answers to "${h}"; it appears here once it has registered itself` };

  // key first (its hash IS the token's nonce). installMemberAccess reuses an
  // existing keypair and heals a missing .pub, so re-running is safe.
  const slug = h.split('.')[0].replace(/-box$/, '');
  const ssh = box.ssh || {};
  onStage(`preparing this machine's key for ${slug}`);
  // ssh.hostname is what /my-boxes decided is DIALABLE, not what the box called
  // itself: the worker overrides it with a rock's rock_ssh_host, or with the
  // source address it observed at /box-register, precisely because the
  // registered <slug>.crads-ai.com name is Cloudflare-proxied and carries no
  // port 22. `h` stays the last resort so an older worker still yields a block.
  const dialAddr = ssh.hostname || h;
  const access = installMemberAccess(
    { slug, host: dialAddr, user: ssh.user || 'member' },
    ...(sshDir ? [sshDir] : []),
  );
  // WHAT TO UNDO IF THIS DOES NOT END IN ADMISSION (2026-08-14).
  //
  // The Host block is written here, before the mineral has said anything, and
  // the door's on-device list is nothing but a parse of Host blocks
  // (ssh-bridge.mjs listPanelTargets). So every failure path used to PROMOTE the
  // mineral from "not on this computer" to "on this computer, red dot, forever",
  // and the only way out was the Forget link. Sam hit it live on 2026-08-14
  // against two pebbles whose boxes had been destroyed an hour earlier.
  //
  // The block, and ONLY the block. The keypair stays: the staged request is
  // bound to sha256(pubkey), so keeping it means a retry re-uses the same
  // fingerprint and the request already sitting at the directory stays valid,
  // and a box that comes back later still admits a key this machine holds.
  // Deleting it would strand that request against a key that no longer exists.
  //
  // Only what THIS call created, too: configUpdated is false when the block was
  // already there, and tearing down a working identity because a re-run timed
  // out would be a worse bug than the one this fixes.
  const undoBlock = () => {
    if (!access.configUpdated) return;
    try { removeHostBlock(access.alias, ...(sshDir ? [sshDir] : [])); } catch { /* best-effort: the report matters more */ }
  };
  const pubkey = String(access.publicKey || '').trim();
  const fp = sha256hex(pubkey);

  // the enrol token is minted FOR this key: nonce rides in the JWT, the worker
  // and the mineral both check it against the staged pubkey
  const t = await getToken({ nonce: fp, scope: 'enrol' });
  if (!t || !t.ok) { undoBlock(); return { ok: false, reason: (t && t.reason) || 'sign in first' }; }
  const auth = { authorization: `Bearer ${t.idToken}`, 'content-type': 'application/json' };

  onStage(`asking ${slug} to admit this machine`);
  let r;
  try {
    r = await fetcher(`${directoryUrl}/enrol-request`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ host: h, pubkey, device_name: machineName(deviceName) }),
    });
  } catch (e) {
    undoBlock();
    return { ok: false, reason: `the directory could not be reached (${String(e && e.message || e).slice(0, 80)})` };
  }
  const staged = await r.json().catch(() => ({}));
  if (!r.ok) { undoBlock(); return { ok: false, reason: staged.error || `the directory answered ${r.status}` }; }

  // the mineral decides on its own schedule; wait for its words
  onStage(`waiting for ${slug} to decide (it checks about every two minutes)`);
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let s;
    try {
      s = await fetcher(`${directoryUrl}/enrol-status?host=${encodeURIComponent(h)}&id=${fp}`, { headers: auth });
    } catch { continue; }   // a network blip is not a verdict
    const body = await s.json().catch(() => ({}));
    if (!s.ok) continue;
    if (body.state === 'done') {
      if (body.outcome === 'added') {
        // PIN THE HOST KEY WHERE THE APP READS IT (QA finding 151, 2026-08-16).
        //
        // installAccess clears this address from BOTH known_hosts on every
        // install and leaves the re-pin "after the verified connection test",
        // which is member-connect's /test on the INVITE path. The door's Connect
        // button comes through HERE, and this leg never pinned, so after a
        // successful enrolment ~/.ssh/known_hosts was not even created and a
        // strict-checking ssh died on "No ED25519 host key is known ... Host key
        // verification failed". The Claude Code app is exactly that client: it
        // bundles ssh2, reads ONLY ~/.ssh/known_hosts and never accept-news
        // (ssh-bridge.mjs pinHostForUser states the rule). So the app's own
        // Claude Code tab was telling the member to pick a connection this leg
        // had guaranteed would be refused.
        //
        // The same lesson as the Claude Code registration directly below: this
        // path inherited the key-writing and not the part that makes the key
        // reachable. Copies only what OUR bridge learned under accept-new while
        // the mineral was deciding, so it is a silent no-op until a real key
        // exists, and it runs on admission only: a refused or still-pending
        // mineral is not a box this machine should be trusting.
        // AND IT HAS TO LEARN THE KEY FIRST (review of this very patch,
        // 2026-08-16). The paragraph above was written, shipped, and was a
        // guaranteed no-op: installAccess -> forgetHost() DELETES every line for
        // this address from the app-private file forty lines earlier, and
        // nothing between there and here ever SSHes to the box (the wait is HTTP
        // to the directory; the door's 25s probe only walks rows already
        // onDevice, which this one is not). So pinHostForUser always found zero
        // lines and returned {pinned:0} while the tests passed, because they
        // injected an appKnownHosts path that forgetHost is hardcoded not to
        // reach. Green, and broken.
        //
        // The invite path works because it pins AFTER member-connect's /test,
        // i.e. after a real connection learned the key. So do the same thing
        // here: one cheap round trip through OUR bridge, which dials with
        // StrictHostKeyChecking=accept-new and UserKnownHostsFile pointed at the
        // app-private file, and THEN copy what it learned into the user's file.
        // The same round trip reads /state/open-folder (R18): the name of the
        // mineral-named folder Claude Code should open, so the registration
        // below can point at it. A box that does not have it yet says "state".
        let openFolder = '';
        try {
          // Dial the Host block installAccess just wrote, so the probe uses the
          // identity this enrolment installed rather than whatever the agent holds.
          const probe = await probeSsh(access.alias, OPEN_FOLDER_PROBE, { ...(sshDir ? { sshDir } : {}) });
          // A failed probe is not a failed enrolment: the machine IS on the
          // roster either way. It only means there is nothing to pin yet, and
          // the next connect re-pins. Never let this leg fail the admission.
          if (probe && probe.code === 0) {
            openFolder = String(probe.stdout || '');
            pinHostForUser(dialAddr, {
              ...(sshDir ? { sshDir } : {}),
              ...(appKnownHosts ? { appPath: appKnownHosts } : {}),
            });
          }
        } catch { /* best-effort: the machine IS on the roster; the next connect re-pins */ }

        // TELL CLAUDE CODE TOO (2026-08-12). installMemberAccess writes the key
        // and the ~/.ssh Host block, and that is where this path stopped, so an
        // enrolled machine had a working ssh identity and NOTHING in the Claude
        // Code app's Environment dropdown. Sam: "the ssh key is not listed as an
        // option in the claude code app."
        //
        // The registration already existed and was only wired to the OLDER
        // member-connect flow (createMemberConnectServer). The T9 enrol path is
        // the one the door and the app actually use now, so it inherited the
        // key-writing and not the part that makes the key reachable.
        //
        // Start directory (R18, 2026-08-23): /state/<name> on BOTH tiers, <name>
        // being what the box itself wrote to /state/open-folder (read by the
        // probe above), and plain /state when the box did not say. The tier no
        // longer decides: every face lands in /state, and inside it the
        // mineral-named link points at the brain wherever that is.
        let claude = { ok: false, reason: 'not attempted' };
        try {
          claude = registerClaudeSshConfig({
            id: access.alias, name: box.label || slug, sshHost: access.alias,
            startDirectory: startDirectoryFor(openFolder),
          }, claudeSettings);
        } catch (e) { claude = { ok: false, reason: String(e && e.message || e) }; }
        return { ok: true, outcome: 'added', alias: access.alias, keyPath: access.keyPath, claude,
          detail: `this machine is on ${slug}'s roster; open it from the app` };
      }
      undoBlock();
      return { ok: false, outcome: 'refused', reason: body.reason || 'the mineral refused this key' };
    }
  }
  // Pending is the common case for a box that is slow, asleep or gone, and it is
  // the one that produced the phantom row. The block goes; the key and the staged
  // request stay, so pressing Connect again re-installs the same fingerprint and
  // picks the same request back up rather than starting a second one.
  undoBlock();
  return { ok: false, outcome: 'pending',
    reason: `the mineral has not answered yet; the request stays staged for a week, so press Connect again once ${slug} is back and it will be admitted` };
}
