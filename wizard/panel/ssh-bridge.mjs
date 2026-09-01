// ssh-bridge.mjs: the panel's transport (D43). Pure Node, zero dependencies:
// every panel verb runs on the rock box by spawning the SYSTEM ssh client
// against the Host alias the wizard installed (`<org>-rock` in ~/.ssh/config,
// see server-lib.mjs installAccessKey). Windows-compatible: ssh.exe ships with
// Windows 10+ (the OpenSSH client feature), and `spawn('ssh', ...)` resolves it
// from PATH exactly like on linux/darwin.
//
// The rock's sshd force-lands every remote command INSIDE the ai-os container
// at /state (ForceCommand enter-aios, provisioning/host/enter-aios, embedded in
// cloud-init.rock.template.yaml; it landed at /state/brain until R18,
// 2026-08-23), so commands built against this bridge use container paths and
// resolve the brain explicitly (BRAIN_ROOT_SH, /state/brain by default), never
// the cwd: the provisioning checkout at /app, factory tokens at
// /state/secrets/provisioning.env.local, provision state at /state/.factory.
//
// Flags, and why:
//   -F <config>                     always the default user config, resolved from
//                                   the home dir explicitly so tests can point
//                                   HOME at a fixture and get deterministic runs
//   -o BatchMode=yes                never hang on a password/passphrase prompt
//   -o ConnectTimeout=8             a dead box fails in seconds, not minutes
//   -o StrictHostKeyChecking=accept-new
//                                   first contact with a box the operator just
//                                   created is accepted; a CHANGED key still
//                                   refuses loudly (OpenSSH >= 7.6; Win10 ships 7.7+)
//   -o ServerAliveInterval/CountMax long-running streams (stamp: minutes) survive
//                                   NAT idle timeouts
import { spawn } from 'node:child_process';
import { poolFor } from './ssh-channel.mjs';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export function sshConfigPath() {
  return join(homedir(), '.ssh', 'config');
}

// The app owns its OWN known_hosts (2026-07-20 UI-loop finding): boxes are
// created and destroyed and cloud IPs recycle, so a stale fingerprint in the
// user's global file turns into a cryptic hard failure inside the product.
// accept-new records fresh boxes here; forgetHost() clears an entry when an
// identity is (re)installed (a new stamp legitimately has a new key). A key
// that changes MID-LIFE still refuses loudly: that is the MITM protection.
// ---------------------------------------------------------------- box kinds
// WHICH FACE A BOX GETS IS THE BOX'S ANSWER, NOT ITS NAME (Sam's ruling
// 2026-08-04). The ratified mechanism is the face probe + PROMOTED registry
// below (promote ruling § 3); the alias suffix stays the default, so nothing
// changes for a box that was never promoted and a cold start with every box
// offline looks exactly like today.

// Does a target serve the face the caller wants? A promoted box serves both
// faces, surfaced as a SECOND rock-kind target row under the same alias by
// the PROMOTED overlay in listPanelTargets. There are seven comparison sites
// across app.mjs and panel-server.mjs; editing seven of them by hand is how
// one gets missed and a promoted box silently loses a face, so every consumer
// asks this instead of comparing to a single value. ('both' is tolerated for
// safety; the two-row model never actually produces it.)
export function matchesKind(target, want) {
  const k = (target && target.kind) || 'rock';
  return k === want || k === 'both';
}

export function appKnownHostsPath() {
  const dir = join(homedir(), '.crads-ai');
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  return join(dir, 'known_hosts');
}
// The address an alias actually dials, read from the user's ssh config.
// known_hosts keys on the ADDRESS, so forgetting a rebuilt box's stale key needs
// this, not the alias (2026-07-30).
// The USER's known_hosts: what plain ssh and the Claude Code app read. The app
// keeps its own file (above) for its own connections, so a rebuilt box that
// recycled an address leaves a stale key in BOTH, and a re-trust that clears
// only one leaves the other app still refusing (2026-07-30).
export const userKnownHostsPath = (sshDir = join(homedir(), '.ssh')) => join(sshDir, 'known_hosts');

export function hostNameFor(alias, cfgPath = join(homedir(), '.ssh', 'config')) {
  try {
    const lines = readFileSync(cfgPath, 'utf8').split('\n');
    let inBlock = false;
    for (const line of lines) {
      const h = line.match(/^\s*Host\s+(.+?)\s*$/i);
      if (h) { inBlock = h[1].trim() === alias; continue; }
      if (!inBlock) continue;
      const n = line.match(/^\s*HostName\s+(\S+)/i);
      if (n) return n[1];
    }
  } catch { /* no config */ }
  return '';
}

// Does one known_hosts line name this host? Two shapes exist and BOTH matter:
//   plaintext   "host1,host2 ssh-ed25519 AAAA..."
//   hashed      "|1|<b64 salt>|<b64 HMAC-SHA1(salt, host)> ecdsa-... AAAA..."
// OpenSSH defaults to HashKnownHosts yes on Debian/Ubuntu, so anything ssh
// itself learned is hashed. Matching only the plaintext shape meant a stale
// entry written by ssh survived every clear — the recycled-IP lockout, still
// live after the clear was built to stop it (reproduced 2026-08-04: a deleted
// box's IP was reissued to a new box within minutes and two hashed entries
// outlived the install). A malformed line simply does not match.
export function knownHostsLineMatches(line, hostOrIp) {
  const field = String(line ?? '').trim().split(/\s+/)[0] || '';
  if (!field) return false;
  if (field.startsWith('|1|')) {
    const [, salt, hash] = field.split('|').filter((x, i) => i !== 0 || true).slice(1);
    if (!salt || !hash) return false;
    try {
      return createHmac('sha1', Buffer.from(salt, 'base64')).update(String(hostOrIp)).digest('base64') === hash;
    } catch { return false; }
  }
  return field.split(',').includes(String(hostOrIp));
}

// Pin a VERIFIED box host key where the Claude Code app can see it (owed item
// (g), closed 2026-08-04; found live on Sam's own pebble 2026-08-03). The app
// bundles its own ssh (ssh2): it reads ONLY ~/.ssh/known_hosts and never
// accept-news, so a key learned by OUR bridge (accept-new into the app-private
// file) must be COPIED into the user's file after a verified connect, or every
// fresh member's first open dies on "Host denied (verification failed)".
// Stale user entries for the same address clear first (the recycled-IP case);
// lines for other hosts are untouched, hashed or not.
export function pinHostForUser(hostOrIp, { sshDir = join(homedir(), '.ssh'), appPath = appKnownHostsPath() } = {}) {
  let appLines = [];
  try {
    appLines = readFileSync(appPath, 'utf8').split('\n')
      .filter((l) => l.trim() && knownHostsLineMatches(l, hostOrIp));
  } catch { /* nothing learned yet */ }
  if (!appLines.length) return { pinned: 0, cleared: 0 };
  const userPath = userKnownHostsPath(sshDir);
  let userLines = [];
  try { userLines = readFileSync(userPath, 'utf8').split('\n').filter((l) => l.trim()); } catch { /* no file yet */ }
  const before = userLines.length;
  userLines = userLines.filter((l) => !knownHostsLineMatches(l, hostOrIp));
  const cleared = before - userLines.length;
  mkdirSync(sshDir, { recursive: true });
  writeFileSync(userPath, userLines.concat(appLines).join('\n') + '\n');
  return { pinned: appLines.length, cleared };
}

export function forgetHost(hostOrIp, path = appKnownHostsPath()) {
  try {
    const keep = readFileSync(path, 'utf8').split('\n')
      .filter((l) => l.trim() && !knownHostsLineMatches(l, hostOrIp));
    writeFileSync(path, keep.length ? keep.join('\n') + '\n' : '');
  } catch { /* no file yet */ }
}

// Scan the user ssh config for aliases the wizard (or the coached member
// session) installed. Two kinds (D44):
//   `<org>-rock`  an operator's org control-plane box  -> kind 'rock'
//   `<slug>-box`    a member's OWN box                   -> kind 'member'
// Returns [{ host, org, kind }] (org = the slug for members too, so callers
// have one field to label with). Wildcard patterns (Host *-rock) never
// match: a slug is strictly [a-z0-9-], so only real installed aliases surface.
// Promoted-host registry (promote ruling § 3, 2026-08-04): fed ONLY by the
// face probe's box-side answer (see face-probe.mjs), never by request input,
// so the panel's host gate stays a server-side decision. A registered host
// keeps its member target AND gains a rock-kind target under the SAME alias:
// a promoted rock keeps its owner's personal seat (ruling § 1) and its address.
// (Merge note 2026-08-04: fix/live-cert built the same "the box says what it
// is" answer as a persisted ~/.crads-ai/box-kinds.json; this registry + the
// face probe is the ratified form, so the kinds file was not carried over —
// one source of truth for a box's kind, never two writers.)
// PERSISTED since 2026-08-17 (ingrid). The merge note above records that the
// fix/live-cert build kept this registry in ~/.crads-ai/box-kinds.json and the
// ratified form dropped the file for "one source of truth". Reality voted the
// other way: in memory only, the app forgot ingrid was a rock at every
// restart and had to re-learn it from ONE un-retried ssh probe at launch — a
// probe proven flaky from Sam's laptop (a one-shot ssh to her box timed out
// while the same port answered another machine instantly). One lost race per
// launch meant a whole session rendered pebble-only, which is exactly what
// Sam saw. A promoted rock is just a normal rock (Sam's ruling), and a normal
// rock's face comes from durable local knowledge (its config alias) — so the
// promoted face persists too.
//
// One source of truth SURVIVES this: the box's ownership record is still the
// only authority. The file is a cache of the box's last answer, written only
// by the probe/flip (never by request input), refreshed on every probe, and
// deleted by demote. Corrupt or unreadable cache = empty cache, never a crash.
// AIOS_BOX_KINDS_PATH overrides for tests, resolved at call time so a test can
// point it at a temp file without fighting ESM import hoisting. The load is
// lazy for the same reason.
const boxKindsPath = () => process.env.AIOS_BOX_KINDS_PATH || join(homedir(), '.crads-ai', 'box-kinds.json');
let PROMOTED = null; // host -> org, loaded on first touch
const promotedMap = () => {
  if (PROMOTED) return PROMOTED;
  try {
    const j = JSON.parse(readFileSync(boxKindsPath(), 'utf8'));
    PROMOTED = new Map(Object.entries(j && typeof j === 'object' ? j : {})
      .filter(([h, o]) => typeof h === 'string' && typeof o === 'string'));
  } catch { PROMOTED = new Map(); }
  return PROMOTED;
};
const savePromoted = () => {
  try {
    mkdirSync(dirname(boxKindsPath()), { recursive: true });
    writeFileSync(boxKindsPath(), JSON.stringify(Object.fromEntries(promotedMap()), null, 2) + '\n');
  } catch { /* cache only: the probe re-teaches on a machine that cannot write */ }
};
export function registerPromotedHost(host, org = '') {
  if (!host) return;
  promotedMap().set(String(host), String(org || ''));
  savePromoted();
}
export function promotedHosts() { return [...promotedMap().keys()]; }
export function unregisterPromotedHost(host) {
  promotedMap().delete(String(host));
  savePromoted();
}

export function listPanelTargets(configPath = sshConfigPath()) {
  if (!existsSync(configPath)) return [];
  const targets = [];
  let text = '';
  try { text = readFileSync(configPath, 'utf8'); } catch { return []; }
  for (const raw of text.split('\n')) {
    const m = raw.match(/^\s*Host\s+(.+?)\s*$/i);
    if (!m) continue;
    for (const alias of m[1].split(/\s+/)) {
      const pm = alias.match(/^([a-z0-9][a-z0-9-]*)-rock$/);
      const mm = alias.match(/^([a-z0-9][a-z0-9-]*)-box$/);
      if (pm && !targets.some((t) => t.host === alias)) targets.push({ host: alias, org: pm[1], kind: 'rock' });
      else if (mm && !targets.some((t) => t.host === alias)) targets.push({ host: alias, org: mm[1], kind: 'member' });
    }
  }
  // A promoted rock keeps its -box alias: surface the SECOND face for any
  // registered host that is a live member target (registry entries for hosts
  // no longer in the config are simply inert — nothing to surface).
  for (const [host, org] of promotedMap()) {
    const m = targets.find((t) => t.host === host && t.kind === 'member');
    if (m && !targets.some((t) => t.host === host && t.kind === 'rock')) {
      targets.push({ host, org: org || m.org, kind: 'rock', promoted: true });
    }
  }
  return targets;
}

function sshArgs(configPath) {
  const args = [
    '-F', configPath,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${appKnownHostsPath()}`,
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=6',
  ];
  // Connection sharing (2026-07-24 finding: the panel's pollers + a running stamp can
  // burst past sshd MaxStartups, which drops connections with a reset and kills verbs
  // mid-flight). On mux-capable platforms every panel call rides ONE authenticated
  // connection. Windows OpenSSH has no ControlMaster support, so there the concurrency
  // queue below is the whole defence.
  if (process.platform !== 'win32') {
    args.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${join(homedir(), '.ssh', 'crads-mux-%C')}`, '-o', 'ControlPersist=300s');
  }
  return args;
}

// Portable half of the same defence: at most MAX_CONC ssh processes in flight; the
// rest queue FIFO. Interactive TTY sessions are exempt (they are long-lived by
// design and a human is watching them). A queued caller gets a pebble-shaped proxy
// immediately; events wire through when the real spawn starts.
// 6, up from 3 (2026-08-09 lag audit): ControlMaster multiplexes them over one
// TCP connection where it runs, and sshd's MaxSessions default is 10, so six
// concurrent execs are safe while halving worst-case queue wait.
const MAX_CONC = Number(process.env.AIOS_SSH_MAX_CONC || 6);
let inFlight = 0;
const waiting = [];
function acquireSlot(run) {
  if (inFlight < MAX_CONC) { inFlight += 1; run(); }
  else waiting.push(run);
}
function releaseSlot() {
  inFlight -= 1;
  const next = waiting.shift();
  if (next) { inFlight += 1; next(); }
}

// Attach a line-splitter to a readable stream: CRLF-safe, flushes the tail.
function lineWire(stream, cb) {
  let buf = '';
  stream.on('data', (d) => {
    buf += d.toString('utf8');
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const l of parts) cb(l.replace(/\r$/, ''));
  });
  stream.on('end', () => { if (buf) cb(buf.replace(/\r$/, '')); });
}

// PERSISTENT CHANNEL (2026-08-14 lag audit, stage S2). Opt-in via
// AIOS_SSH_CHANNEL=1. Default OFF, so nothing below changes until it is set.
//
// The discrete path pays a full SSH handshake per verb, and sshArgs() cannot
// hand Windows a ControlMaster to amortise it. ssh-channel.mjs holds a small
// pool of sessions open instead. Measured against a QA rock at 249ms RTT:
// 596ms/verb discrete-and-parallel vs 92ms/verb pooled, a 6.5x improvement,
// on every platform rather than only the ones that can multiplex.
//
// Eligibility is deliberately narrow. A pty runs in canonical mode with a ~4KB
// line limit, so a large opts.stdin payload (file uploads arrive base64'd)
// would be silently truncated; and binary output cannot be line-framed. Those
// keep the discrete path, which is also why this is a dispatcher rather than a
// replacement.
export function isChannelEligible(command, opts = {}) {
  if (process.env.AIOS_SSH_CHANNEL !== '1') return false;
  if (opts.noChannel) return false;
  if (opts.stdin !== undefined) return false;
  return typeof command === 'string' && command.length <= 2000;
}

function streamViaChannel(host, command, opts, cfg) {
  const closeCbs = [];
  let killed = false;
  const proxy = {
    on(ev, cb) { if (ev === 'close') closeCbs.push(cb); return proxy; },
    kill() { killed = true; },
  };
  const pool = poolFor(host, {
    sshArgs: sshArgs(cfg),
    sshExe: opts.sshExe,
    size: Number(process.env.AIOS_SSH_CHANNEL_POOL || 3),
  });
  pool.run(command, {
    onStdout: opts.onStdout,
    onStderr: opts.onStderr,
    hardTimeoutMs: opts.hardTimeoutMs,
  }).then(
    (r) => { for (const cb of closeCbs) cb(killed ? -1 : r.code); },
    () => {
      // ANY channel failure falls back to the discrete path once. The channel
      // has no host-key-changed retry and no queue, so turning the flag on must
      // never be able to fail a verb that would otherwise have worked.
      if (killed) { for (const cb of closeCbs) cb(-1); return; }
      const real = streamSshDiscrete(host, command, { ...opts, noChannel: true });
      real.on('close', (code) => { for (const cb of closeCbs) cb(code); });
      proxy.kill = (sig) => { killed = true; real.kill(sig); };
    },
  );
  return proxy;
}

// Streamed variant: returns the ChildProcess. opts:
//   onStdout(line) / onStderr(line)   per-line callbacks (ANSI left as-is)
//   stdin                             string written to the remote command's stdin
//   configPath / sshExe               overrides (tests, exotic installs)
export function streamSsh(host, command, opts = {}) {
  if (isChannelEligible(command, opts)) return streamViaChannel(host, command, opts, opts.configPath || sshConfigPath());
  return streamSshDiscrete(host, command, opts);
}

function streamSshDiscrete(host, command, opts = {}) {
  const cfg = opts.configPath || sshConfigPath();
  // Queued spawn: callers get a pebble-shaped proxy at once; the real ssh starts when a
  // slot frees. Events/kill wire through. See the MaxStartups note above sshArgs().
  const listeners = [];
  // CLOSE IS ALWAYS OURS. A caller registers `.on('close')` AFTER this function
  // returns, and the proxy used to forward straight to the live child once one
  // existed, which bypassed the host-key retry below for every real caller. Close
  // callbacks are therefore collected here and fanned out by the retry decision.
  const closeCbs = [];
  let real = null, killed = false;
  const proxy = {
    on(ev, cb) {
      if (ev === 'close') { closeCbs.push(cb); return proxy; }
      if (real) real.on(ev, cb); else listeners.push([ev, cb]);
      return proxy;
    },
    kill(sig) { killed = true; if (real) try { real.kill(sig); } catch { /* gone */ } },
  };
  // A RECYCLED ADDRESS IS OUR OWN DOING, NOT AN ATTACK (finding 82, second site).
  //
  // forgetHost runs when a box is STAMPED or re-identified, which covers a box we
  // just built. It does not cover the opposite case: a box pinned days ago whose
  // provider has since handed that address to a different new box. Then every verb
  // dies on a changed host key, and because the failure never reaches the UI the
  // panel simply renders nothing.
  //
  // Not theoretical. qa-baseline-gmail landed on an address recycled from a box
  // destroyed the day before; org-backup-status returned NO output; and the Custody
  // card went on showing the PREVIOUS rock's repository, telling an owner their
  // brain was backed up to a repository belonging to another organisation
  // (finding 89). One silent ssh failure became a cross-mineral lie on the one card
  // that answers "is my brain safe".
  //
  // Same treatment as the broker's sshRun: purge the stale pin and retry ONCE, only
  // on this specific failure. Host checking is never disabled, so a genuine
  // man-in-the-middle against a box we did not just build still fails the retry.
  const HOSTKEY_CHANGED = /REMOTE HOST IDENTIFICATION HAS CHANGED|WARNING: POSSIBLE DNS SPOOFING/i;
  // Accumulate stderr as raw text rather than relying on the line-wired callback.
  // `close` can beat a line-buffered handler, so a flag set from lineWire is not
  // reliably set by the time the retry decision is made: caught by this file's own
  // "keeps changing" test, which saw one attempt instead of two.
  let errText = '';
  let retriedHostKey = false;
  const launch = () => {
    real = spawn(opts.sshExe || 'ssh', [...sshArgs(cfg), host, command],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // Hard watchdog (2026-07-24 finding): ConnectTimeout only bounds the TCP connect, NOT the
    // SSH handshake, so a verb can hang for LoginGraceTime (~120s) if the box is momentarily
    // starved. A hung pebble holds its concurrency slot AND a box-side connection, so hangs
    // COMPOUND into the very MaxStartups saturation that caused the hang. Kill any non-tty verb
    // that overruns, which frees the slot and closes the box connection, letting the box drain.
    const HARD_MS = Number(opts.hardTimeoutMs ?? process.env.AIOS_SSH_HARD_TIMEOUT ?? 25000);
    const wd = HARD_MS > 0 ? setTimeout(() => { try { real.kill('SIGKILL'); } catch { /* gone */ }
      if (opts.onStderr) opts.onStderr(`ssh to ${host} exceeded ${HARD_MS}ms; killed (box busy?)`); }, HARD_MS) : null;
    let released = false;
    const release = () => { if (wd) clearTimeout(wd); if (!released) { released = true; releaseSlot(); } };
    real.on('close', release);
    real.on('error', release);
    if (opts.onStdout) lineWire(real.stdout, opts.onStdout);
    // Watch stderr for the changed-key signature whether or not the caller asked
    // for stderr: the whole problem is that this failure was invisible.
    real.stderr.on('data', (d) => { if (errText.length < 8192) errText += d; });
    if (opts.onStderr) lineWire(real.stderr, opts.onStderr);
    if (opts.stdin !== undefined) real.stdin.write(opts.stdin);
    real.stdin.end();
    for (const [ev, cb] of listeners) real.on(ev, cb);
    real.on('close', (code) => {
      if (HOSTKEY_CHANGED.test(errText) && !retriedHostKey && !killed) {
        retriedHostKey = true;
        errText = '';
        const addr = hostNameFor(host, cfg) || host;
        try { forgetHost(addr); forgetHost(addr, userKnownHostsPath()); } catch { /* best effort */ }
        if (opts.onStderr) opts.onStderr(`host key for ${addr} had changed (recycled address); stale pin dropped, retrying once`);
        // The failed attempt's slot was already released, so re-enter the queue
        // rather than spawning inline and running over the concurrency cap.
        acquireSlot(launch);
        return;
      }
      for (const cb of closeCbs) cb(code);
    });
  };
  acquireSlot(() => {
    if (killed) { releaseSlot(); for (const cb of closeCbs) cb(-1); return; }
    launch();
  });
  return proxy;
}

// Interactive variant (D53 terminal widget): `ssh -tt` forces a REMOTE pty, so
// the local side needs none — raw bytes stream both ways and the box's
// ForceCommand lands the session in an interactive shell inside the container.
// Deliberately NO remote command: enter-aios only grants a container tty on its
// interactive (no-command) branch, so sending a command would land the session
// in a tty-less pipe on boxes provisioned before the D53 template fix ("no job
// control", broken TUIs). Sizing instead rides in as the FIRST line of input:
// inside the real pty, stty resizes it directly (no local pty = no SIGWINCH
// path, so window resizes after open still don't propagate — v1 limitation).
// TERM is pinned so curses apps (claude's TUI) render on Windows spawns too.
// RAW byte stream. streamSsh line-wires stdout and kills the pebble after 25s, both
// correct for a verb and both fatal for a download: line-wiring mangles a tar, and a
// real brain takes longer than a verb. So this one hands the caller the pebble with
// untouched pipes and no watchdog, and the caller owns it. Added 2026-07-30 for the
// "download a copy" path, which exists so a member with no GitHub account can still
// get their data out. Still queued through the same concurrency slots, because
// saturating a box's MaxStartups is what caused the hangs the watchdog exists for.
export function rawSsh(host, command, opts = {}) {
  const cfg = opts.configPath || sshConfigPath();
  return new Promise((resolve) => {
    acquireSlot(() => {
      const pebble = spawn(opts.sshExe || 'ssh', [...sshArgs(cfg), host, command],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let released = false;
      const release = () => { if (!released) { released = true; releaseSlot(); } };
      pebble.on('close', release);
      pebble.on('error', release);
      resolve(pebble);
    });
  });
}

export function openSshTty(host, opts = {}) {
  const cfg = opts.configPath || sshConfigPath();
  const cols = Math.min(500, Math.max(20, parseInt(opts.cols, 10) || 120));
  const rows = Math.min(200, Math.max(5, parseInt(opts.rows, 10) || 32));
  const pebble = spawn(opts.sshExe || 'ssh', [...sshArgs(cfg), '-tt', host],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, TERM: 'xterm-256color' } });
  // POINT `claude` AT THE LOGIN THE BOX ALREADY HAS. Auth persists in
  // /state/.claude-auth (entrypoint.sh's own default, and what the cron runner
  // pins), but $HOME here is /home/node and holds nothing. So an owner who had
  // just signed in, opened this terminal, typed `claude` and was asked to sign in
  // AGAIN, which reads as "the sign-in did not work". Worse, completing it there
  // writes credentials to an ephemeral $HOME, so it never sticks and the loop
  // repeats. Proven on harbour-labs 2026-08-11: the same box answered a
  // `claude -p` probe immediately once CLAUDE_CONFIG_DIR was set, while the
  // terminal beside it kept asking for a login. Note the cron path had this
  // right all along; the human surface was the one that did not.
  // Rides the same first-line-of-input channel as the sizing, because this path
  // deliberately sends no remote command. Defaulted, not forced.
  try { pebble.stdin.write('export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/state/.claude-auth}"\n'); } catch { /* dying spawn */ }
  try { pebble.stdin.write(`stty cols ${cols} rows ${rows} 2>/dev/null; clear\n`); } catch { /* dying spawn */ }
  return pebble;
}

// Buffered variant: resolves { code, stdout, stderr }. Never rejects; a spawn
// failure (no ssh binary) resolves code -1 with the message in stderr.
export function runSsh(host, command, opts = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const pebble = streamSsh(host, command, {
      ...opts,
      onStdout: (l) => { out += l + '\n'; if (opts.onStdout) opts.onStdout(l); },
      onStderr: (l) => { err += l + '\n'; if (opts.onStderr) opts.onStderr(l); },
    });
    pebble.on('error', (e) => resolve({ code: -1, stdout: out, stderr: err + String(e && e.message ? e.message : e) + '\n' }));
    pebble.on('close', (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
  });
}

// The injectable transport the panel server consumes (opts.bridge in tests).
// Contract: targets() -> [{host, org}]; stream(host, command, { onStdout,
// onStderr, stdin }) -> pebble-like { on('error'|'close', cb), kill() };
// tty(host, { cols, rows }) -> raw ChildProcess with stdin/stdout/stderr pipes.
export function systemBridge(opts = {}) {
  return {
    targets: () => listPanelTargets(opts.configPath),
    stream: (host, command, o = {}) => streamSsh(host, command, { ...opts, ...o }),
    tty: (host, o = {}) => openSshTty(host, { ...opts, ...o }),
  };
}
