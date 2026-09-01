// device-enrol.test.mjs — the asking device's leg of T9. Under test: the key
// is minted BEFORE the token so the nonce can bind them, the mineral's verdict
// is reported in its own words, and a silent mineral leaves the request staged
// rather than pretending an outcome.
// Run: node --test wizard/panel/device-enrol.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { enrolThisDevice, listEnrollable, machineName, machineSlug } from './device-enrol.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const TOKEN = { ok: true, idToken: 'x.' + Buffer.from('{}').toString('base64url') + '.y' };

function fakeDirectory({ outcome = 'added', reason = '', answers = true, boxes } = {}) {
  const calls = [];
  let stagedId = '';
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const p = new URL(String(url)).pathname;
    const respond = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (p === '/my-boxes') {
      return respond({ ok: true, boxes: boxes || [
        { host: 'keith', label: 'Keith', ssh: { hostname: 'keith.crads-ai.com', user: 'member', port: 22 } },
      ] });
    }
    if (p === '/enrol-request') {
      const b = JSON.parse(init.body);
      stagedId = sha(b.pubkey);
      return respond({ ok: true, id: stagedId });
    }
    if (p === '/enrol-status') {
      if (!answers) return respond({ ok: true, state: 'staged' });
      return respond({ ok: true, state: 'done', outcome, reason });
    }
    return respond({ error: 'unexpected ' + p }, 500);
  };
  return { fetcher, calls, stagedId: () => stagedId };
}

test('the happy path: key minted first, token bound to it, Host block installed, verdict relayed', async () => {
  const sshDir = tmpDir('ssh-');
  const dir = fakeDirectory({ outcome: 'added' });
  const minted = [];
  const getToken = async (o) => { minted.push(o); return TOKEN; };

  const r = await enrolThisDevice({
    host: 'keith', deviceName: 'Sam laptop', getToken, fetcher: dir.fetcher,
    sshDir, pollMs: 1, deadlineMs: 5000, sleep: async () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'added');
  assert.equal(r.alias, 'keith-box', 'the same alias every other install path writes');
  assert.ok(existsSync(r.keyPath), 'the private key exists on this machine');

  // the binding: the enrol token's nonce IS the staged pubkey's hash
  const enrolMint = minted.find((m) => m.scope === 'enrol');
  const stagedBody = JSON.parse(dir.calls.find((c) => c.url.endsWith('/enrol-request')).init.body);
  assert.equal(enrolMint.nonce, sha(stagedBody.pubkey), 'a stolen token cannot enrol a different key');
  assert.equal(stagedBody.device_name, 'Sam laptop');

  // the Host block landed, so the app recognises the face afterwards
  const cfg = readFileSync(join(sshDir, 'config'), 'utf8');
  assert.match(cfg, /Host keith-box/);
  assert.match(cfg, /HostName keith\.crads-ai\.com/, 'the SSH facts came from the box\'s own registration');
});

test('a refusal arrives in the mineral\'s own words', async () => {
  const sshDir = tmpDir('ssh-');
  const dir = fakeDirectory({ outcome: 'refused', reason: 'that account does not own this mineral' });
  const r = await enrolThisDevice({
    host: 'keith', getToken: async () => TOKEN, fetcher: dir.fetcher,
    sshDir, pollMs: 1, deadlineMs: 5000, sleep: async () => {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'refused');
  assert.match(r.reason, /does not own/, 'the box\'s reason, not a generic failure');
});

test('a silent mineral leaves the request STAGED, and says so honestly', async () => {
  const sshDir = tmpDir('ssh-');
  const dir = fakeDirectory({ answers: false });
  const r = await enrolThisDevice({
    host: 'keith', getToken: async () => TOKEN, fetcher: dir.fetcher,
    sshDir, pollMs: 1, deadlineMs: 5, sleep: async () => {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'pending', 'no invented verdict');
  assert.match(r.reason, /stays staged/, 'the week-long stage is stated, not silent');
});

test('an unknown mineral is refused BEFORE any key is minted for it', async () => {
  const sshDir = tmpDir('ssh-');
  const dir = fakeDirectory({ boxes: [] });
  const r = await enrolThisDevice({
    host: 'stranger', getToken: async () => TOKEN, fetcher: dir.fetcher,
    sshDir, pollMs: 1, deadlineMs: 5000, sleep: async () => {},
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no mineral of yours answers/);
  assert.ok(!existsSync(join(sshDir, 'config')), 'no Host block for a mineral that is not yours');
});

test('signed out means signed out: no key, no request', async () => {
  const dir = fakeDirectory({});
  const r = await enrolThisDevice({
    host: 'keith', getToken: async () => ({ ok: false, reason: 'sign in first' }), fetcher: dir.fetcher,
    sshDir: tmpDir('ssh-'), sleep: async () => {},
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /sign in/);
  assert.ok(!dir.calls.some((c) => c.url.endsWith('/enrol-request')), 'nothing was staged');
});

// ------------------------------------------------- what this machine is called
//
// The bug these pin (2026-08-12): Sam's rock listed "This computer" and "Win32"
// and nothing could say whether that was one machine or two. "Win32" is
// `navigator.platform`, which member.html and door.html both sent, and which
// returns the same string for every Windows user on earth. App builds already
// shipped keep sending it, so the junk filter is the migration and has to hold
// until those builds are gone.

test('a platform family is not a machine name: navigator.platform is refused', () => {
  const own = machineName();
  for (const junk of ['Win32', 'MacIntel', 'Linux x86_64', 'iPhone', 'computer', 'This computer']) {
    assert.equal(machineName(junk), own, `${junk} must not become a machine name`);
  }
});

test('a real name a human chose still rides', () => {
  assert.equal(machineName('Sam laptop'), 'Sam laptop');
  assert.equal(machineSlug('Sam laptop'), 'sam-laptop');
});

test('the machine name falls back to this machine, never to empty', () => {
  const n = machineName('');
  assert.ok(n && n.length, 'always something');
  assert.ok(n.length <= 60, 'and it fits a roster label');
  assert.ok(!n.includes('.'), 'first hostname label only, no FQDN tail');
  assert.match(machineSlug(''), /^[a-z0-9][a-z0-9-]{0,23}$/, 'a slug the roster will accept');
});

test('the staged request carries the machine name when the caller sends junk', async () => {
  const dir = fakeDirectory({});
  await enrolThisDevice({
    host: 'keith', deviceName: 'Win32', getToken: async () => TOKEN, fetcher: dir.fetcher,
    sshDir: tmpDir('ssh-'), sleep: async () => {}, deadlineMs: 0,
  });
  const staged = dir.calls.find((c) => c.url.endsWith('/enrol-request'));
  assert.equal(JSON.parse(staged.init.body).device_name, machineName(), 'the box is told the real name');
});

test('listEnrollable relays the directory\'s rows and its refusals', async () => {
  const dir = fakeDirectory({});
  const ok = await listEnrollable({ getToken: async () => TOKEN, fetcher: dir.fetcher });
  assert.equal(ok.ok, true);
  assert.equal(ok.boxes[0].host, 'keith');
  const out = await listEnrollable({ getToken: async () => ({ ok: false, reason: 'sign in first' }) });
  assert.equal(out.ok, false);
});

// ---- 2026-08-12: enrolled, and invisible to Claude Code ----
//
// Sam: "the ssh key is not listed as an option in the claude code app." It was on
// disk and the Host block was right; nothing had told the app it existed.
// registerClaudeSshConfig was wired only to the OLDER member-connect flow, so the
// T9 enrol path the door and app actually use inherited the key-writing and not
// the part that makes the key reachable.
test('a successful enrolment registers the connection with Claude Code', () => {
  const src = readFileSync(new URL('./device-enrol.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ registerClaudeSshConfig, claudeSettingsPath, startDirectoryFor, OPEN_FOLDER_PROBE \}/,
    'the enrol path must know how to register a connection, and which folder to open');
  const i = src.indexOf("if (body.outcome === 'added')");
  assert.ok(i > -1, 'the success branch must still exist');
  // Window widened twice on 2026-08-16: first for the host-key pin (finding
  // 151), then again when review found that pin was a no-op and the fix grew a
  // probe-then-pin plus the paragraph explaining why. The assertions below are
  // about what the branch DOES, not how long it is, so the window tracks it.
  const branch = src.slice(i, i + 5200);
  assert.match(branch, /registerClaudeSshConfig\(/, 'and must do it on success');
  // R18 (2026-08-23): the start directory is /state/<name> on BOTH tiers, read
  // off the box (/state/open-folder) by the probe, never derived from the tier.
  assert.match(branch, /startDirectory: startDirectoryFor\(openFolder\)/,
    'start directory comes from what the box wrote to /state/open-folder');
  assert.doesNotMatch(branch, /\/state\/brain/, 'no tier-derived landing dir');
  assert.match(branch, /claude/, 'and the outcome is reported rather than swallowed');
});

test('registering with Claude Code never fails the enrolment', () => {
  const src = readFileSync(new URL('./device-enrol.mjs', import.meta.url), 'utf8');
  const i = src.indexOf("if (body.outcome === 'added')");
  // Anchored on the registration itself rather than on the branch start
  // (2026-08-16): a second try/catch now precedes it, and a window that opened
  // at the branch would have matched THAT one's `try {` and gone on passing even
  // if this call lost its guard.
  const j = src.indexOf('let claude = { ok: false', i);
  assert.ok(j > i, 'the registration must still live in the success branch');
  assert.match(src.slice(j, j + 700), /try \{[\s\S]*registerClaudeSshConfig[\s\S]*\} catch/,
    'the machine IS on the roster by this point; a settings write must not undo that');
});

// ---------------------------------------------------------------------------
// 2026-08-14: the phantom on-device row.
//
// The Host block is written BEFORE the mineral has said anything, and the door's
// on-device list is nothing but a parse of Host blocks (listPanelTargets). So
// every failure path promoted the mineral from "not on this computer" to "on
// this computer, not answering yet", permanently, and the only escape was the
// Forget link. Found live: Sam pressed Connect on two pebbles whose boxes had
// been destroyed an hour earlier, and both moved into the connected list dead.
// ---------------------------------------------------------------------------

test('a pending verdict leaves no phantom Host block, but keeps the key', async () => {
  const sshDir = tmpDir('ssh-');
  const dir = fakeDirectory({ answers: false });
  const r = await enrolThisDevice({
    host: 'keith', getToken: async () => TOKEN, fetcher: dir.fetcher,
    sshDir, pollMs: 1, deadlineMs: 5, sleep: async () => {},
  });
  assert.equal(r.outcome, 'pending');
  const cfg = existsSync(join(sshDir, 'config')) ? readFileSync(join(sshDir, 'config'), 'utf8') : '';
  assert.doesNotMatch(cfg, /Host keith-box/,
    'a mineral that never admitted this machine must not appear as on-device');
  // the staged request is bound to sha256(pubkey), so the key has to survive or
  // a retry starts a second request and the first one strands
  assert.ok(existsSync(join(sshDir, 'keith-box.key')), 'the key the staged request names stays');
});

test('a refusal leaves no phantom Host block either', async () => {
  const sshDir = tmpDir('ssh-');
  const dir = fakeDirectory({ outcome: 'refused', reason: 'not your mineral' });
  const r = await enrolThisDevice({
    host: 'keith', getToken: async () => TOKEN, fetcher: dir.fetcher,
    sshDir, pollMs: 1, deadlineMs: 5000, sleep: async () => {},
  });
  assert.equal(r.outcome, 'refused');
  const cfg = existsSync(join(sshDir, 'config')) ? readFileSync(join(sshDir, 'config'), 'utf8') : '';
  assert.doesNotMatch(cfg, /Host keith-box/, 'a refused key is not an installed identity');
});

test('a directory that cannot be reached undoes its own half-install', async () => {
  const sshDir = tmpDir('ssh-');
  const base = fakeDirectory({});
  const fetcher = async (url, init) => {
    if (new URL(String(url)).pathname === '/enrol-request') throw new Error('ENOTFOUND');
    return base.fetcher(url, init);
  };
  const r = await enrolThisDevice({
    host: 'keith', getToken: async () => TOKEN, fetcher,
    sshDir, pollMs: 1, deadlineMs: 5, sleep: async () => {},
  });
  assert.equal(r.ok, false);
  const cfg = existsSync(join(sshDir, 'config')) ? readFileSync(join(sshDir, 'config'), 'utf8') : '';
  assert.doesNotMatch(cfg, /Host keith-box/, 'nothing was asked, so nothing is installed');
});

test('the rollback never tears down a block this run did not create', async () => {
  const sshDir = tmpDir('ssh-');
  // first run succeeds and installs the identity
  const ok = await enrolThisDevice({
    host: 'keith', getToken: async () => TOKEN, fetcher: fakeDirectory({ outcome: 'added' }).fetcher,
    sshDir, pollMs: 1, deadlineMs: 5000, sleep: async () => {},
  });
  assert.equal(ok.outcome, 'added');
  // a later re-run against a box that has gone quiet must not evict a WORKING
  // identity: undoing a re-run is a worse bug than the one being fixed
  const again = await enrolThisDevice({
    host: 'keith', getToken: async () => TOKEN, fetcher: fakeDirectory({ answers: false }).fetcher,
    sshDir, pollMs: 1, deadlineMs: 5, sleep: async () => {},
  });
  assert.equal(again.outcome, 'pending');
  assert.match(readFileSync(join(sshDir, 'config'), 'utf8'), /Host keith-box/,
    'the identity that was already there survives');
});

// ---------------------------------------------------------------------------
// 2026-08-14: the address that carries SSH.
//
// enrol-sync registers ssh.hostname as <slug>.crads-ai.com, which Cloudflare
// proxies and which therefore has no port 22. /my-boxes now overrides that field
// with something dialable (a rock's rock_ssh_host, or the source address the
// worker observed at /box-register). This leg's job is simply to believe it.
// ---------------------------------------------------------------------------

test('the Host block dials the address /my-boxes decided, not the proxied name', async () => {
  const sshDir = tmpDir('ssh-');
  const dir = fakeDirectory({ outcome: 'added', boxes: [
    { host: 'keith.crads-ai.com', label: 'Keith', tier: 'pebble',
      ssh: { hostname: '178.104.168.45', user: 'member', port: 22 } },
  ] });
  const r = await enrolThisDevice({
    host: 'keith.crads-ai.com', getToken: async () => TOKEN, fetcher: dir.fetcher,
    sshDir, pollMs: 1, deadlineMs: 5000, sleep: async () => {},
  });
  assert.equal(r.outcome, 'added');
  const cfg = readFileSync(join(sshDir, 'config'), 'utf8');
  assert.match(cfg, /HostName 178\.104\.168\.45/, 'the dialable endpoint, not the edge');
  assert.doesNotMatch(cfg, /HostName keith\.crads-ai\.com/, 'the proxied name carries no ssh');
});

// ---------------------------------------------------------------------------
// 2026-08-16 (QA finding 151): enrolled, and the app still would not open it.
//
// After a successful "Connect this computer", ~/.ssh/known_hosts was not even
// created. installAccess clears this address from BOTH known_hosts on every
// install and leaves the re-pin "after the verified connection test", which is
// member-connect's /test, on the INVITE path. The door's Connect button comes
// through this leg instead, and pinHostForUser had exactly one non-test caller,
// so the key our bridge learned under accept-new stayed in the app-private
// ~/.crads-ai/known_hosts and plain ssh answered "No ED25519 host key is known
// ... Host key verification failed". The Claude Code app is that same client
// (bundled ssh2, reads ONLY ~/.ssh/known_hosts, never accept-news), and the
// app's own Claude Code tab tells the member to pick this connection.
//
// Same shape as the 2026-08-12 defect twenty lines up: this path inherited the
// key-writing and not the part that makes the key reachable.
// ---------------------------------------------------------------------------

const PINNED = { host: 'keith', label: 'Keith', tier: 'pebble',
  ssh: { hostname: '203.0.113.7', user: 'member', port: 22 } };

test('an admitted machine pins the verified host key into ~/.ssh/known_hosts', async () => {
  const sshDir = tmpDir('ssh-');
  const appKH = join(sshDir, 'app-known-hosts');
  // what our bridge learned under accept-new while the mineral was deciding
  writeFileSync(appKH, '203.0.113.7 ssh-ed25519 AAAAC3keithhostkey\n');
  const dir = fakeDirectory({ outcome: 'added', boxes: [PINNED] });

  const r = await enrolThisDevice({
    host: 'keith', getToken: async () => TOKEN, fetcher: dir.fetcher,
    sshDir, appKnownHosts: appKH, probeSsh: async () => ({ code: 0 }), claudeSettings: join(sshDir, 'settings.json'),
    pollMs: 1, deadlineMs: 5000, sleep: async () => {},
  });
  assert.equal(r.outcome, 'added');
  const userKH = join(sshDir, 'known_hosts');
  assert.ok(existsSync(userKH), 'the file the app reads must exist after a successful connect');
  assert.match(readFileSync(userKH, 'utf8'), /AAAAC3keithhostkey/,
    'the key is pinned for the address the Host block actually dials');
});

test('the pin follows the dialable address, not the proxied name', async () => {
  // /my-boxes overrides ssh.hostname with something that carries port 22; the
  // registered <slug>.crads-ai.com name is Cloudflare-proxied. A pin against the
  // wrong one of those two looks like a pass and fixes nothing.
  const sshDir = tmpDir('ssh-');
  const appKH = join(sshDir, 'app-known-hosts');
  writeFileSync(appKH, ['203.0.113.7 ssh-ed25519 AAAAC3dialablekey',
    'keith.crads-ai.com ssh-ed25519 AAAAC3proxiedkey', ''].join('\n'));
  const dir = fakeDirectory({ outcome: 'added', boxes: [
    { ...PINNED, host: 'keith.crads-ai.com' },
  ] });

  await enrolThisDevice({
    host: 'keith.crads-ai.com', getToken: async () => TOKEN, fetcher: dir.fetcher,
    sshDir, appKnownHosts: appKH, probeSsh: async () => ({ code: 0 }), claudeSettings: join(sshDir, 'settings.json'),
    pollMs: 1, deadlineMs: 5000, sleep: async () => {},
  });
  const user = readFileSync(join(sshDir, 'known_hosts'), 'utf8');
  assert.match(user, /AAAAC3dialablekey/, 'the endpoint ssh will actually reach');
  assert.doesNotMatch(user, /AAAAC3proxiedkey/, 'the edge name carries no ssh, so its key is not this box');
});

test('a mineral that refused or never answered pins nothing', async () => {
  // Trusting a host key is a claim that this machine belongs on that box. The
  // Host block is torn down on both of these paths for exactly that reason, and
  // a pin left behind would outlive it.
  for (const [name, opts] of [['refused', { outcome: 'refused', reason: 'not your mineral' }], ['pending', { answers: false }]]) {
    const sshDir = tmpDir('ssh-');
    const appKH = join(sshDir, 'app-known-hosts');
    writeFileSync(appKH, '203.0.113.7 ssh-ed25519 AAAAC3keithhostkey\n');
    const dir = fakeDirectory({ ...opts, boxes: [PINNED] });
    const r = await enrolThisDevice({
      host: 'keith', getToken: async () => TOKEN, fetcher: dir.fetcher,
      sshDir, appKnownHosts: appKH, probeSsh: async () => ({ code: 0 }), claudeSettings: join(sshDir, 'settings.json'),
      pollMs: 1, deadlineMs: 5, sleep: async () => {},
    });
    assert.notEqual(r.outcome, 'added', name);
    const user = existsSync(join(sshDir, 'known_hosts')) ? readFileSync(join(sshDir, 'known_hosts'), 'utf8') : '';
    assert.doesNotMatch(user, /AAAAC3keithhostkey/, `${name}: no verdict, no trust`);
  }
});

test('a pin that cannot be written never fails the enrolment', () => {
  const src = readFileSync(new URL('./device-enrol.mjs', import.meta.url), 'utf8');
  const i = src.indexOf('pinHostForUser(');
  assert.ok(i > -1, 'the pin must exist on the success path');
  // window widened 2026-08-16: the probe that makes the pin non-empty sits
  // between the try and the pin now, with the reason written above it
  assert.match(src.slice(i - 1600, i + 400), /try \{[\s\S]*pinHostForUser\([\s\S]*\} catch/,
    'the machine IS on the roster by this point; a known_hosts write must not undo that');
});

// ---------------------------------------------------------------------------
// The test the four above could not be (review, 2026-08-16).
//
// They all pass `appKnownHosts: appKH` pointing somewhere in the temp ssh dir,
// and `forgetHost` is hardcoded to appKnownHostsPath(). So the injection point
// was the one path the CLEAR cannot reach, and the pin looked like it worked
// while in production installAccess had already emptied the file forty lines
// earlier and pinHostForUser copied zero lines. Green, and a guaranteed no-op.
//
// This one lets the clear and the pin see the SAME file, which is the wiring
// that shipped, and asserts on behaviour rather than on the pin being called.
test('151: the pin has something to copy because the probe learned it first', async () => {
  const sshDir = tmpDir('ssh-');
  const appKH = join(sshDir, 'app-known-hosts');
  // the address is UNKNOWN when enrolment starts: nothing has dialled it
  writeFileSync(appKH, '');
  let probedAlias = '';
  const dir = fakeDirectory({ outcome: 'added', boxes: [PINNED] });
  const r = await enrolThisDevice({
    host: 'keith', getToken: async () => TOKEN, fetcher: dir.fetcher,
    sshDir, appKnownHosts: appKH, claudeSettings: join(sshDir, 'settings.json'),
    pollMs: 1, deadlineMs: 50, sleep: async () => {},
    // stand in for the real ssh: a successful dial under accept-new is what
    // writes the host key into the app-private file, so the stub does that
    probeSsh: async (alias) => {
      probedAlias = alias;
      writeFileSync(appKH, '203.0.113.7 ssh-ed25519 AAAAC3keithhostkey\n');
      return { code: 0 };
    },
  });
  assert.equal(r.outcome, 'added');
  assert.equal(probedAlias, 'keith-box', 'the probe dials the Host block this enrolment just wrote');
  const user = readFileSync(join(sshDir, 'known_hosts'), 'utf8');
  assert.match(user, /AAAAC3keithhostkey/,
    'the key the probe learned must reach the file the Claude Code app reads');
});

test('R18: the admission probe reads /state/open-folder and Claude Code opens that folder', async () => {
  const sshDir = tmpDir('ssh-');
  const appKH = join(sshDir, 'app-known-hosts');
  writeFileSync(appKH, '');
  const settings = join(sshDir, 'settings.json');
  let probedCmd = '';
  const dir = fakeDirectory({ outcome: 'added', boxes: [PINNED] });
  const r = await enrolThisDevice({
    host: 'keith', getToken: async () => TOKEN, fetcher: dir.fetcher,
    sshDir, appKnownHosts: appKH, claudeSettings: settings,
    pollMs: 1, deadlineMs: 50, sleep: async () => {},
    probeSsh: async (alias, cmd) => { probedCmd = cmd; return { code: 0, stdout: 'keith\n' }; },
  });
  assert.equal(r.outcome, 'added');
  assert.match(probedCmd, /cat \/state\/open-folder/, 'the probe asks the box which folder to open');
  const entry = JSON.parse(readFileSync(settings, 'utf8')).sshConfigs.find((c) => c.id === 'keith-box');
  assert.equal(entry.startDirectory, '/state/keith', 'Claude Code opens the mineral-named folder');

  // a box born before the link existed answers "state": plain /state, which always opens
  const sshDir2 = tmpDir('ssh-');
  const settings2 = join(sshDir2, 'settings.json');
  const dir2 = fakeDirectory({ outcome: 'added', boxes: [PINNED] });
  await enrolThisDevice({
    host: 'keith', getToken: async () => TOKEN, fetcher: dir2.fetcher,
    sshDir: sshDir2, appKnownHosts: join(sshDir2, 'akh'), claudeSettings: settings2,
    pollMs: 1, deadlineMs: 50, sleep: async () => {},
    probeSsh: async () => ({ code: 0, stdout: 'state\n' }),
  });
  const e2 = JSON.parse(readFileSync(settings2, 'utf8')).sshConfigs.find((c) => c.id === 'keith-box');
  assert.equal(e2.startDirectory, '/state');
});

test('151: a probe that cannot connect pins nothing, and still admits the machine', async () => {
  const sshDir = tmpDir('ssh-');
  const appKH = join(sshDir, 'app-known-hosts');
  writeFileSync(appKH, '');
  const dir = fakeDirectory({ outcome: 'added', boxes: [PINNED] });
  const r = await enrolThisDevice({
    host: 'keith', getToken: async () => TOKEN, fetcher: dir.fetcher,
    sshDir, appKnownHosts: appKH, claudeSettings: join(sshDir, 'settings.json'),
    pollMs: 1, deadlineMs: 50, sleep: async () => {},
    probeSsh: async () => ({ code: 255, stderr: 'Connection refused\n' }),
  });
  // the mineral admitted this machine; a failed probe says nothing about that
  assert.equal(r.outcome, 'added', 'a probe is not a gate on admission');
  const user = existsSync(join(sshDir, 'known_hosts')) ? readFileSync(join(sshDir, 'known_hosts'), 'utf8') : '';
  assert.doesNotMatch(user, /AAAAC3/, 'nothing was learned, so nothing is trusted');
});
