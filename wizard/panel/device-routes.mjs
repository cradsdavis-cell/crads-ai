// device-routes.mjs — wizard-local device enrolment (self-host pivot,
// 2026-09-01). The last central dependency in the app was T9's account leg:
// adding a SECOND computer to an existing box went through the crads account
// sign-in and the directory worker. Ownership is the user's SSH key now, so
// the OLD (already-connected) machine authorises the NEW one, over SSH,
// straight to the user's own box. No account, no worker, no service of ours.
//
// The dance, in three legs across two machines:
//   NEW machine  POST /device/offer    {name}          -> { pubkey, alias }
//     mints (or reuses) the keypair for `<name>-box` the same way the
//     self-host wizard does: installMemberAccess with the placeholder address
//     '0.0.0.0', so the key shown here IS the key the completed install will
//     use. The name is asked FIRST because keys are per-alias and the slug is
//     not known until the bundle arrives; a wrong guess is refused at
//     /device/complete rather than installed under a mismatched name.
//   OLD machine  POST /device/approve  {host, pubkey}  -> { ok, bundle }
//     validates the pasted key line strictly (the cloud-init roster-seed
//     shape: one ssh-ed25519 line, bounded comment), appends it idempotently
//     to /state/ssh/member/authorized_keys ON THE BOX via the ssh bridge
//     (commands land inside the container via the enter-aios ForceCommand,
//     and /state there is the same mount sshd's AuthorizedKeysCommand reads).
//     The key rides STDIN, never the command string, so nothing pasted can
//     become shell. The answer is the connection bundle to carry back.
//   NEW machine  POST /device/complete {bundle}        -> { ok, alias } | { error }
//     parses the bundle, refuses a slug mismatch, repairs the Host block to
//     the real address (the same second-install-call pattern
//     provision-routes uses), pins the carried host key BEFORE first contact
//     when the bundle has one, then proves the whole chain with a short
//     probe-retry loop and says honestly whether it answered.
//
// The bundle is one copyable string: `crads1:` + base64(JSON {slug, host,
// hostkey}). hostkey is the box's known_hosts line as this app learned it;
// when the old machine has none on record the field is omitted and the
// answer says so (the new machine then trusts on first connect, exactly as
// a fresh wizard install does).
//
// Mounted by door-server the same way provisionRoutes is. Everything at an
// SSH or disk boundary is injectable for tests: sshDir, install, pin, probe,
// runSsh, targets, appKnownHostsPath, sleep.
import { existsSync, appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installMemberAccess } from './member-connect.mjs';
import {
  pinHostForUser, runSsh as realRunSsh, hostNameFor, listPanelTargets,
  appKnownHostsPath, knownHostsLineMatches, forgetHost,
} from './ssh-bridge.mjs';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;   // hostname or IP
// The one key shape the box's own roster seed accepts (provisioning/managed/
// cloud-init.template.yaml, the roster-seed grep): a single ssh-ed25519 line
// with real base64 and an optional bounded comment. Anything else — a second
// line, a quote, a stray shell character — is REFUSED, never escaped: the
// validation is the injection defence, and the stdin transport is the backstop.
const KEY_RE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9@._-]{1,64})?$/;

// The append, run inside the container. The key arrives on stdin ($(cat)), so
// the command string is a constant: nothing user-pasted is ever interpolated
// into shell. grep -qxF makes the append idempotent (whole-line, fixed-string
// match), and >> means the file is only ever added to, never rewritten — a
// failure here can never cost the owner the key that already works.
const APPEND_CMD = 'set -e; mkdir -p /state/ssh/member; '
  + 'touch /state/ssh/member/authorized_keys; K="$(cat)"; '
  + 'grep -qxF -- "$K" /state/ssh/member/authorized_keys '
  + '|| printf \'%s\\n\' "$K" >> /state/ssh/member/authorized_keys';

export function deviceRoutes(opts = {}) {
  const sshDir = opts.sshDir || join(homedir(), '.ssh');
  const install = opts.install || installMemberAccess;
  const pin = opts.pin || pinHostForUser;
  const probe = opts.probe || ((alias) => realRunSsh(alias, 'echo chain-ok'));
  const run = opts.runSsh || realRunSsh;
  const targets = opts.targets || (() => listPanelTargets());
  const appKh = () => opts.appKnownHostsPath || appKnownHostsPath();
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const probeTries = opts.probeTries ?? 5;
  const probePollMs = opts.probePollMs ?? 2000;

  // The offer made on THIS machine, so /device/complete can refuse a bundle
  // for a different mineral instead of installing under a mismatched name.
  // In-memory only: after an app restart the key file itself (reused, never
  // clobbered, by installMemberAccess) is the durable half of the offer.
  let offered = null;   // { slug, alias }

  function readBody(req, res, cb) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) { res.writeHead(413); res.end(); req.removeAllListeners('end'); } });
    req.on('end', () => cb(body));
  }
  const jsonOut = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  return function handle(req, res, path) {
    if (!path.startsWith('/device/')) return false;

    // NEW machine, step one: mint (or reuse) the key the install will use.
    if (req.method === 'POST' && path === '/device/offer') {
      readBody(req, res, (body) => {
        let form; try { form = JSON.parse(body); } catch { jsonOut(res, 400, { error: 'bad json' }); return; }
        const slug = String(form.name || '').trim().toLowerCase();
        if (!SLUG_RE.test(slug)) { jsonOut(res, 400, { error: 'the name must be 2-32 lowercase letters, digits or hyphens, the name the mineral was set up with' }); return; }
        try {
          // Key before address, exactly the self-host wizard's pattern: the
          // placeholder Host block is repaired by the second install call in
          // /device/complete once the bundle names the real address.
          const acc = install({ slug, host: '0.0.0.0', user: 'member' }, sshDir);
          const pubkey = String(acc.publicKey || '').trim().split('\n')[0];
          offered = { slug, alias: `${slug}-box` };
          jsonOut(res, 200, { ok: true, alias: offered.alias, pubkey });
        } catch (e) { jsonOut(res, e && e.status === 400 ? 400 : 500, { error: String((e && e.message) || e) }); }
      });
      return true;
    }

    // OLD machine: validate the pasted key, append it on the box, answer the
    // bundle. host must be an identity this machine actually has installed
    // (same rule as the door's /probe), and a member one: the append lands in
    // the member lane, so approving "onto" a rock alias would grant nothing.
    if (req.method === 'POST' && path === '/device/approve') {
      readBody(req, res, async (body) => {
        let form; try { form = JSON.parse(body); } catch { jsonOut(res, 400, { error: 'bad json' }); return; }
        const host = String(form.host || '');
        let known = [];
        try { known = targets() || []; } catch { known = []; }
        if (!known.some((t) => t && t.host === host && t.kind === 'member')) {
          jsonOut(res, 400, { error: 'host must be one of this computer\'s connected minerals' }); return;
        }
        // Strict single-line validation. Trailing newline from a paste is
        // tolerated; an embedded one is a second line and is refused.
        const key = String(form.pubkey || '').replace(/[\r\n]+$/, '');
        if (/[\r\n]/.test(key) || !KEY_RE.test(key)) {
          jsonOut(res, 400, { error: 'that does not look like a device key. It should be one line starting "ssh-ed25519", copied whole from the new computer.' }); return;
        }
        let r;
        try { r = await run(host, APPEND_CMD, { stdin: key + '\n' }); } catch (e) { r = { code: -1, stderr: String((e && e.message) || e) }; }
        if (!r || r.code !== 0) {
          jsonOut(res, 502, { error: 'the box did not accept the key: ' + String((r && (r.stderr || r.stdout)) || 'no answer').trim().slice(0, 300) }); return;
        }
        // Build the bundle: slug, the address this alias dials, and the box's
        // host key as this app learned it (so the new machine can pin before
        // first contact). No host key on record is survivable: say so and let
        // the new machine trust on first connect, as a fresh install does.
        const slug = host.replace(/-box$/, '');
        const addr = hostNameFor(host, join(sshDir, 'config'));
        if (!addr || !HOSTNAME_RE.test(addr)) { jsonOut(res, 500, { error: 'could not read the box\'s address from this computer\'s connection entry' }); return; }
        let hostkey = '';
        try {
          hostkey = readFileSync(appKh(), 'utf8').split('\n')
            .find((l) => l.trim() && knownHostsLineMatches(l, addr)) || '';
        } catch { hostkey = ''; }
        const payload = { slug, host: addr, ...(hostkey ? { hostkey: hostkey.trim() } : {}) };
        const bundle = 'crads1:' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
        jsonOut(res, 200, { ok: true, bundle, hostkeyIncluded: !!hostkey });
      });
      return true;
    }

    // NEW machine, step two: the bundle came back. Install, pin, probe.
    if (req.method === 'POST' && path === '/device/complete') {
      readBody(req, res, async (body) => {
        let form; try { form = JSON.parse(body); } catch { jsonOut(res, 400, { error: 'bad json' }); return; }
        const s = String(form.bundle || '').trim();
        if (!s.startsWith('crads1:')) { jsonOut(res, 400, { error: 'that does not look like a connection bundle (it should start with "crads1:"). Copy it whole from the other computer.' }); return; }
        let b;
        try { b = JSON.parse(Buffer.from(s.slice(7), 'base64').toString('utf8')); } catch { b = null; }
        if (!b || !SLUG_RE.test(String(b.slug || '')) || !HOSTNAME_RE.test(String(b.host || ''))) {
          jsonOut(res, 400, { error: 'the connection bundle is damaged or incomplete. Copy it again from the other computer.' }); return;
        }
        // Slug match: the key shown in step one was minted for a NAME, and
        // keys are per-alias. A bundle for a different mineral is refused
        // with the mismatch named, never installed under the wrong name.
        if (offered && offered.slug !== b.slug) {
          jsonOut(res, 400, { error: `this bundle is for "${b.slug}", but the key you showed was made for "${offered.slug}". Start again with the right name, or bring the bundle for "${offered.slug}".` }); return;
        }
        const alias = `${b.slug}-box`;
        if (!offered && !existsSync(join(sshDir, `${alias}.key`))) {
          jsonOut(res, 400, { error: 'this computer has not made a key for that mineral yet. Do the first step (show this computer\'s key) and approve it on the other computer before pasting the bundle.' }); return;
        }
        try {
          // Repair the Host block to the real address; reuses the offered key.
          install({ slug: b.slug, host: String(b.host), user: 'member' }, sshDir);
          // Pin BEFORE first contact when the bundle carried the host key:
          // record it where the bridge reads (the app file), then copy it into
          // the user's known_hosts the same way a verified connect would.
          const hostkey = String(b.hostkey || '').trim();
          if (hostkey && !/[\r\n]/.test(hostkey) && knownHostsLineMatches(hostkey, String(b.host))) {
            const appPath = appKh();
            forgetHost(String(b.host), appPath);
            appendFileSync(appPath, hostkey + '\n');
            pin(String(b.host), { sshDir, appPath });
          }
          // Prove the chain end to end, with a little patience: sshd's
          // AuthorizedKeysCommand reads the file live, but the paste on the
          // other machine may be seconds old.
          let ok = false; let lastErr = '';
          for (let i = 0; i < probeTries; i++) {
            let p; try { p = await probe(alias); } catch (e) { p = null; lastErr = String((e && e.message) || e); }
            if (p && p.code === 0 && String(p.stdout || '').includes('chain-ok')) { ok = true; break; }
            if (p) lastErr = String(p.stderr || p.stdout || '').trim().slice(0, 300);
            if (i < probeTries - 1) await sleep(probePollMs);
          }
          if (ok) { offered = null; jsonOut(res, 200, { ok: true, alias }); return; }
          jsonOut(res, 200, {
            ok: false, alias,
            error: 'the connection is set up on this computer, but the box did not answer yet'
              + (lastErr ? ' (' + lastErr + ')' : '')
              + '. Check the key was approved on the other computer, then try the bundle again.',
          });
        } catch (e) { jsonOut(res, e && e.status === 400 ? 400 : 500, { error: String((e && e.message) || e) }); }
      });
      return true;
    }

    res.writeHead(404); res.end();
    return true;
  };
}
