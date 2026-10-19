#!/usr/bin/env node
// ms365-login.mjs: the box half of "connect Microsoft 365" (2026-10-19).
//
// Microsoft's device-code sign-in takes as long as the member takes (up to
// fifteen minutes), and a panel verb is one short SSH command. So the sign-in
// runs DETACHED and narrates into a file; the verbs only start it and read it.
//
//   node ms365-login.mjs <state-dir> start    start (or rejoin) a sign-in; prints the code
//   node ms365-login.mjs <state-dir> status   where the sign-in has got to
//   node ms365-login.mjs <state-dir> cancel   stop a sign-in in progress
//   node ms365-login.mjs <state-dir> run      (internal) the detached run itself
//
// The run spawns the baked server with --login and the SAME env as the saved
// definition in .mcp.json (engine/lib/ms365.mjs), so the token it caches is
// the one the server reads. The file is the whole record:
//   { stage: starting | code | done | failed | cancelled, pid, url?, code?,
//     expires_at?, user?, name?, reason?, at }
// Nothing secret is ever in it: a device code is useless once it expires, and
// the token stays in the package's own encrypted cache beside it.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { MS365_KEY, MS365_ARGS, isMs365, ms365Dir, ms365LoginFile, parseDeviceMessage, parseLoginResult } from '../lib/ms365.mjs';

const stateDir = path.resolve(process.argv[2] || '/state');
const cmd = process.argv[3] || 'status';
const FILE = ms365LoginFile(stateDir);
// Microsoft's device codes last 15 minutes; give the run a minute past that
const RUN_LIMIT_MS = Number(process.env.CRADS_MS365_RUN_LIMIT_MS) || 16 * 60e3;
const START_WAIT_MS = Number(process.env.CRADS_MS365_START_WAIT_MS) || 25e3;

const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(0); };
const read = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return null; } };
const write = (o) => {
  mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  // per-process temp name: cancel and the run it stops can both write at once
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...o, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  renameSync(tmp, FILE);
};
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const def = () => {
  try { return (JSON.parse(readFileSync(path.join(stateDir, '.mcp.json'), 'utf8')).mcpServers || {})[MS365_KEY]; }
  catch { return null; }
};

// What the page reads. A run that died without writing its end, or a code
// past its life, is reported as what it is rather than as "waiting" forever.
function view() {
  const s = read();
  if (!s) return { stage: 'idle' };
  if ((s.stage === 'starting' || s.stage === 'code') && !alive(s.pid)) {
    return { ...s, stage: 'failed', reason: 'the sign-in stopped before it finished: start it again' };
  }
  if (s.stage === 'code' && s.expires_at && Date.parse(s.expires_at) < Date.now()) {
    return { ...s, stage: 'failed', reason: 'the code expired before it was used: get a new one' };
  }
  return s;
}
const pub = (s) => {
  const o = { stage: s.stage };
  for (const k of ['url', 'code', 'expires_at', 'user', 'name', 'reason']) if (s[k]) o[k] = s[k];
  return o;
};

if (cmd === 'status') out({ ok: true, ...pub(view()) });

if (cmd === 'cancel') {
  const s = read();
  if (s && alive(s.pid) && (s.stage === 'starting' || s.stage === 'code')) {
    try { process.kill(s.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  if (s && s.stage !== 'done') write({ stage: 'cancelled' });
  out({ ok: true, stage: s && s.stage === 'done' ? 'done' : 'cancelled' });
}

if (cmd === 'start') {
  const d = def();
  if (!isMs365(d)) out({ ok: false, error: 'Microsoft 365 is not set up on this mineral yet' });
  // rejoin a live run rather than starting a second one beside it: two runs
  // would race to write one cache, and the page may simply have reloaded
  const cur = view();
  if (cur.stage === 'code' || (cur.stage === 'starting' && alive(read()?.pid))) {
    if (cur.stage === 'code') out({ ok: true, ...pub(cur) });
  } else {
    const child = spawn(process.execPath, [import.meta.filename, stateDir, 'run'], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    child.unref();
    // the run writes this too; writing it here first, with the run's pid, means
    // the first status read can never mistake a run still starting for a dead one
    write({ stage: 'starting', pid: child.pid });
  }
  const until = Date.now() + START_WAIT_MS;
  const tick = () => {
    const s = view();
    if (s.stage === 'code' || s.stage === 'failed' || s.stage === 'done') out({ ok: s.stage !== 'failed', ...pub(s), ...(s.stage === 'failed' ? { error: s.reason } : {}) });
    if (Date.now() > until) out({ ok: false, stage: 'failed', error: 'Microsoft did not send a sign-in code in time: try again in a minute' });
    setTimeout(tick, 400);
  };
  tick();
}

if (cmd === 'run') {
  const d = def();
  if (!isMs365(d)) { write({ stage: 'failed', reason: 'Microsoft 365 is not set up on this mineral' }); process.exit(0); }
  mkdirSync(ms365Dir(stateDir), { recursive: true, mode: 0o700 });
  write({ stage: 'starting', pid: process.pid });
  const child = spawn(d.command, [...(d.args || MS365_ARGS), '--login'], {
    env: { ...process.env, ...(d.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', shown = false, finished = false;
  const finish = (o) => { if (finished) return; finished = true; clearTimeout(timer); write({ ...o, pid: process.pid }); };
  const timer = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    finish({ stage: 'failed', reason: 'the code expired before it was used: get a new one' });
  }, RUN_LIMIT_MS);
  const onTerm = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } finish({ stage: 'cancelled' }); process.exit(0); };
  process.on('SIGTERM', onTerm);
  child.stdout.on('data', (b) => {
    stdout += b;
    if (!shown) {
      const m = parseDeviceMessage(stdout);
      if (m) {
        shown = true;
        write({ stage: 'code', pid: process.pid, url: m.url, code: m.code,
          expires_at: new Date(Date.now() + 15 * 60e3).toISOString() });
      }
    }
  });
  child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-4000); });
  child.on('error', () => finish({ stage: 'failed', reason: 'the Microsoft connection is missing from this mineral: press Update and restart' }));
  child.on('close', () => {
    const r = parseLoginResult(stdout);
    if (r && r.success) {
      finish({ stage: 'done', user: String(r.userData?.userPrincipalName || '').slice(0, 254),
        name: String(r.userData?.displayName || '').slice(0, 120) });
    } else {
      // the package's own sentence when it has one; the last stderr line otherwise
      const said = (r && r.message) || stderr.trim().split(/\r?\n/).pop() || 'the sign-in did not finish';
      finish({ stage: 'failed', reason: String(said).replace(/\s+/g, ' ').slice(0, 200) });
    }
    process.exit(0);
  });
}

if (!['status', 'cancel', 'start', 'run'].includes(cmd)) out({ ok: false, error: `unknown command: ${cmd}` });
