#!/usr/bin/env node
// remote-control.mjs — the member's assistant from the Claude app on their phone.
//
//   node remote-control.mjs <state-dir> should-run  -> exit 0 = start-comms should launch it
//   node remote-control.mjs <state-dir> alive       -> exit 0 = a server is running (adopts one the pidfile lost)
//   node remote-control.mjs <state-dir> seed        -> pre-answer the two first-run questions
//   node remote-control.mjs <state-dir> name        -> the name the phone list shows
//   node remote-control.mjs <state-dir> folder      -> where sessions start (the brain root)
//   node remote-control.mjs <state-dir> status      -> {ok, state, enabled, name, detail}
//   node remote-control.mjs <state-dir> stop        -> stop it (no marker; start-comms decides)
//   node remote-control.mjs <state-dir> off         -> write the opt-out marker, stop it
//   node remote-control.mjs <state-dir> on          -> remove the marker (start-comms starts it)
//
// WHAT IT IS. Claude Code's Remote Control (`claude remote-control`) keeps an
// outbound connection to Anthropic so the Claude app (Code tab) or claude.ai/code
// can drive a session that runs HERE, with this mineral's brain, skills and
// connections. Telegram stays for scheduled output; conversation moves to the app.
// Spec: docs/superpowers/specs/2026-10-14-remote-control-design.md.
//
// ON BY DEFAULT (Sam, 2026-10-14), for new AND existing minerals. The only switch
// is the opt-out marker secrets/remote_control_disabled, written by the app's
// Phone card. No marker = on.
//
// THE FIRST RUN, WITHOUT A TERMINAL. `claude remote-control` asks three things the
// first time: trust the folder, enable Remote Control, and spawn mode. With no TTY
// the trust step does not ask, it exits "Workspace not trusted" (the `cannot_ask`
// path), and the enable step blocks on stdin. Read from the Claude Code 2.1.292
// binary on 2026-10-14, both answers are plain keys in the GLOBAL config,
// $CLAUDE_CONFIG_DIR/.claude.json:
//   remoteDialogSeen: true                              (enable)
//   projects["<folder>"].hasTrustDialogAccepted: true   (trust; also checked at the
//                                                        git root of the folder)
// and spawn mode is the --spawn flag. `seed` writes the two keys with a
// read-modify-write: that file also holds the OAuth account and onboarding state,
// so it is never replaced, only merged into. If a future Claude Code moves either
// answer, the launch log says "Workspace not trusted" or "Enable Remote Control?"
// and `status` reports it as an error instead of "starting" forever.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, realpathSync, renameSync, readdirSync, readlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { readClaudeCredential } from '../lib/claude-credential.mjs';
import { readAssistantState } from '../lib/assistant-state.mjs';
import { resolveBrainRoot } from '../lib/brain-root.mjs';

export const DISABLED_MARKER = ['secrets', 'remote_control_disabled'];
export const PID_FILE = ['.kernel', 'remote-control.pid'];
export const LOG_FILE = ['.kernel', 'remote-control.log'];
export const CAPACITY = 4;
const FALLBACK_NAME = 'Crads assistant';

// Always <state>/.claude-auth, never $CLAUDE_CONFIG_DIR: start-comms exports that
// same path, and reading the env here would let a stray value in a test (or a
// shell) seed somebody else's config.
const configDir = (stateDir) => path.join(stateDir, '.claude-auth');
const globalConfigPath = (stateDir) => path.join(configDir(stateDir), '.claude.json');

export function isEnabled(stateDir) {
  return !existsSync(path.join(stateDir, ...DISABLED_MARKER));
}

/** Where phone sessions start: the brain root, the same folder the Claude Code app opens. */
export function folder(stateDir) {
  const root = resolveBrainRoot(stateDir);
  try { return realpathSync(root); } catch { return root; }
}

/** The git root of a folder, or null. Trust is looked up there too. */
function gitRoot(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out ? realpathSync(out) : null;
  } catch { return null; }
}

/** The name the phone's session list shows: the assistant's own name. */
export function assistantName(stateDir) {
  const clean = (s) => String(s || '').replace(/[^\p{L}\p{N} '._-]/gu, '').trim().slice(0, 60);
  try { const n = clean(readFileSync(path.join(stateDir, 'box-name'), 'utf8')); if (n) return n; } catch { /* none */ }
  try {
    const m = readFileSync(path.join(stateDir, 'profile.yaml'), 'utf8').match(/assistant_name:\s*"?([^"\n]+)"?/);
    const n = clean(m && m[1]); if (n) return n;
  } catch { /* none */ }
  return FALLBACK_NAME;
}

/**
 * Should start-comms launch it? On by default; off only by the marker, on a
 * mineral that does not think with Claude Code, or with no Claude sign-in yet
 * (a launch then would just exit, every two minutes, forever).
 */
export function shouldRun(stateDir) {
  if (!isEnabled(stateDir)) return { run: false, reason: 'off' };
  const thinks = readAssistantState(stateDir);
  if (thinks.harness && thinks.harness !== 'claude-code') return { run: false, reason: 'unsupported' };
  if (!readClaudeCredential(stateDir).present) return { run: false, reason: 'signed_out' };
  return { run: true, reason: 'on' };
}

/** Pre-answer the trust + enable questions. Merge-only; returns what it changed. */
export function seed(stateDir) {
  const p = globalConfigPath(stateDir);
  let cfg = {};
  if (existsSync(p)) {
    try { cfg = JSON.parse(readFileSync(p, 'utf8')); }
    catch { return { ok: false, error: 'could not read the Claude config; left it alone' }; }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ok: false, error: 'unexpected Claude config shape; left it alone' };
  }
  const dir = folder(stateDir);
  const paths = [...new Set([dir, gitRoot(dir)].filter(Boolean))];
  const changed = [];
  if (cfg.remoteDialogSeen !== true) { cfg.remoteDialogSeen = true; changed.push('remoteDialogSeen'); }
  cfg.projects = cfg.projects && typeof cfg.projects === 'object' ? cfg.projects : {};
  for (const p2 of paths) {
    if (cfg.projects[p2]?.hasTrustDialogAccepted === true) continue;
    cfg.projects[p2] = { ...(cfg.projects[p2] || {}), hasTrustDialogAccepted: true };
    changed.push(`trust:${p2}`);
  }
  if (changed.length) {
    mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.rc-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, p);
  }
  return { ok: true, changed, folder: dir };
}

// Alive = the pid is live AND is a `claude remote-control`. The pidfile survives a
// container restart (it is on /state) while pid numbers start over, so a bare
// kill(pid, 0) can bless an unrelated process (2026-10-15 live cert). Where /proc
// cannot be read (not Linux), fall back to liveness alone.
const isServerCmd = (cmd) => /^(?:\S*\/)?claude\0remote-control\0/.test(cmd) || cmd.startsWith('claude remote-control');
const pidFileAlive = (stateDir) => {
  try {
    const pid = parseInt(readFileSync(path.join(stateDir, ...PID_FILE), 'utf8'), 10);
    if (!pid) return null;
    process.kill(pid, 0);
    let cmd = null;
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { /* no /proc */ }
    if (cmd !== null && !isServerCmd(cmd)) return null;
    return pid;
  } catch { return null; }
};
// The pidfile is wrong but a server IS running (the same live cert: Claude Code
// refuses a second one with "This folder is already served by a terminal
// `claude remote-control`", and the card would read "needs a look" while the
// first one kept working untracked). Find it in /proc and adopt it.
// Only a server whose working directory is THIS mineral's folder: one mineral per
// container makes that the only candidate on a box, and it keeps a test (or any
// shared machine) from adopting somebody else's process.
function findServer(stateDir) {
  const want = folder(stateDir);
  let entries = [];
  try { entries = readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return null; }
  for (const d of entries) {
    let cmd = '';
    try { cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8'); } catch { continue; }
    if (!isServerCmd(cmd)) continue;
    try { if (realpathSync(readlinkSync(`/proc/${d}/cwd`)) === want) return parseInt(d, 10); } catch { /* not ours to read */ }
  }
  return null;
}
/** The live server's pid (adopting a running one if the pidfile lost it), or null. */
export function serverPid(stateDir) {
  const pid = pidFileAlive(stateDir);
  if (pid) return pid;
  const found = findServer(stateDir);
  if (found) {
    try { mkdirSync(path.join(stateDir, '.kernel'), { recursive: true }); writeFileSync(path.join(stateDir, ...PID_FILE), String(found)); } catch { /* read-only: still report it */ }
  }
  return found;
}
const pidAlive = serverPid;

const stripAnsi = (s) => String(s).replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');

/** What the launch log says, read from the end. */
export function readLog(stateDir) {
  let text = '';
  try { text = stripAnsi(readFileSync(path.join(stateDir, ...LOG_FILE), 'utf8')); } catch { return { connected: false, error: null }; }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // The first-run questions coming back means the seeded keys stopped working
  // (a Claude Code release moved them). Say so, never "starting" forever.
  const prompt = lines.find((l) => /Workspace not trusted|Enable Remote Control\?|Trust .+\? \[y\/N\]/.test(l));
  // "already served by a terminal claude remote-control" is a refused DUPLICATE: a
  // server for this folder is running. Not an error of ours (status adopts it).
  const alreadyServed = lines.some((l) => /already served by a terminal `?claude remote-control/i.test(l));
  const err = [...lines].reverse().find((l) => !/already served/i.test(l)
    && /^Error:|did not start|not logged in|log in again|Couldn't verify Remote Control/i.test(l));
  const connected = lines.some((l) => /Connected/.test(l)) && !err;
  return { connected, error: prompt || err || null, alreadyServed };
}

/**
 * The card's status. off | connected | starting | down | signed_out | error | unsupported.
 * `down` = it should be running and is not (the two-minute supervisor will retry).
 */
export function status(stateDir) {
  const name = assistantName(stateDir);
  const enabled = isEnabled(stateDir);
  const gate = shouldRun(stateDir);
  if (gate.reason === 'unsupported') return { ok: true, state: 'unsupported', enabled, name };
  if (!enabled) return { ok: true, state: 'off', enabled, name };
  if (gate.reason === 'signed_out') return { ok: true, state: 'signed_out', enabled, name };
  const pid = pidAlive(stateDir);
  const log = readLog(stateDir);
  if (!pid) return { ok: true, state: log.error ? 'error' : 'down', enabled, name, detail: log.error || undefined };
  if (log.error) return { ok: true, state: 'error', enabled, name, detail: log.error };
  // A live server whose own log was overwritten by a refused duplicate: it is
  // running and it stays up only while it can reach Anthropic, so call it on.
  if (log.alreadyServed) return { ok: true, state: 'connected', enabled, name };
  return { ok: true, state: log.connected ? 'connected' : 'starting', enabled, name };
}

/** Stop the server process and the sessions it spawned (it leads its own process group). */
export function stop(stateDir) {
  const pid = pidAlive(stateDir);
  if (pid) {
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  }
  rmSync(path.join(stateDir, ...PID_FILE), { force: true });
  return { stopped: !!pid };
}

export function off(stateDir) {
  const m = path.join(stateDir, ...DISABLED_MARKER);
  mkdirSync(path.dirname(m), { recursive: true });
  writeFileSync(m, `switched off ${new Date().toISOString()}\n`);
  const s = stop(stateDir);
  return { ok: true, state: 'off', ...s };
}

export function on(stateDir) {
  rmSync(path.join(stateDir, ...DISABLED_MARKER), { force: true });
  return { ok: true, enabled: true };
}

// ---- CLI ------------------------------------------------------------------
const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname);
if (isMain) {
  const stateDir = path.resolve(process.argv[2] || '/state');
  const verb = process.argv[3];
  const print = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  switch (verb) {
    case 'should-run': { const g = shouldRun(stateDir); process.exit(g.run ? 0 : 1); break; }
    case 'alive': process.exit(serverPid(stateDir) ? 0 : 1); break;
    case 'seed': { const r = seed(stateDir); print(r); process.exit(r.ok ? 0 : 1); break; }
    case 'name': process.stdout.write(assistantName(stateDir) + '\n'); break;
    case 'folder': process.stdout.write(folder(stateDir) + '\n'); break;
    case 'status': print(status(stateDir)); break;
    case 'stop': print(stop(stateDir)); break;
    case 'off': print(off(stateDir)); break;
    case 'on': print(on(stateDir)); break;
    default:
      console.error('usage: remote-control.mjs <state-dir> should-run|alive|seed|name|folder|status|stop|on|off');
      process.exit(2);
  }
}
