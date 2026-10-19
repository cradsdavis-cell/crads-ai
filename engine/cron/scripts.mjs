#!/usr/bin/env node
// scripts.mjs — the box side of "Scripts on a schedule" (spec
// docs/superpowers/specs/2026-10-17-adopt-existing-server.md § Scripts on a schedule).
// scripts-lib.mjs says what a row means; this file looks inside the container
// (does the program exist, does the folder exist), runs a script, and is the
// CLI the app's verbs call.
//
//   node scripts.mjs <state-dir> list              # SCRIPTS_STATE {json} for the Skills page
//   node scripts.mjs <state-dir> save              # stdin: base64 JSON of page changes
//   node scripts.mjs <state-dir> run <id>          # Run now: start it, wait a little, report
//   node scripts.mjs <state-dir> exec <id> [--source=cron] [--token=T]   # run in the foreground
//
// scheduler.mjs imports runScript() and fires it in-process, so a scheduled run
// and a Run now share one path: the same lock, the same time limit, the same
// honest exit status into the run ledger.
import { readFileSync, writeFileSync, renameSync, existsSync, statSync, accessSync, constants, mkdirSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeScripts, scriptProblem, programPath, applyChanges, tailOf, failureReason, parseEnvFile, describeScriptSchedule } from './scripts-lib.mjs';
import { appendRun, summarize, lastRunByScript } from '../lib/run-ledger.mjs';
import { takeRunLock, releaseRunLock, runLockHeld } from './cadence-lock.mjs';
import { isMain } from '../lib/is-main.mjs';

const SELF = fileURLToPath(import.meta.url);
export const scriptsFile = (stateDir) => path.join(stateDir, 'cockpit', 'scripts.json');

export function readScriptsRaw(stateDir) {
  try { return JSON.parse(readFileSync(scriptsFile(stateDir), 'utf8')); } catch { return {}; }
}

// Env files the move-in recorded as the person's own (cockpit/move-in.json
// "env_files"), allowed beside anything under /state/secrets/.
export function recordedEnvFiles(stateDir) {
  try {
    const m = JSON.parse(readFileSync(path.join(stateDir, 'cockpit', 'move-in.json'), 'utf8'));
    return Array.isArray(m && m.env_files) ? m.env_files.filter((f) => typeof f === 'string').map((f) => path.posix.resolve(f)) : [];
  } catch { return []; }
}

function executable(p) {
  try { return statSync(p).isFile() && (accessSync(p, constants.X_OK), true); } catch { return false; }
}

export function programExists(entry, envPath = process.env.PATH || '') {
  const pp = programPath(entry);
  if (pp.path) return executable(pp.path);
  return envPath.split(':').filter(Boolean).some((d) => executable(path.join(d, pp.bare)));
}

export function factsFor(entry) {
  const f = { program: programExists(entry) };
  try { f.cwd = statSync(entry.cwd).isDirectory(); } catch { f.cwd = false; }
  if (entry.env_file != null) f.envFile = existsSync(entry.env_file);
  return f;
}

export function problemFor(stateDir, entry, recorded = recordedEnvFiles(stateDir)) {
  const ctx = { stateDir, recordedEnvFiles: recorded };
  const shape = scriptProblem(entry, ctx);   // shape first: never stat a path the file had no business naming
  if (shape) return shape;
  return scriptProblem(entry, ctx, factsFor(entry));
}

// ---- list ------------------------------------------------------------------
export function listScripts(stateDir) {
  const raw = readScriptsRaw(stateDir);
  const cfg = normalizeScripts(raw);
  const recorded = recordedEnvFiles(stateDir);
  const last = lastRunByScript(stateDir);
  const scripts = Object.entries(cfg.scripts).map(([id, e]) => ({
    id,
    name: e.name,
    description: e.description,
    enabled: e.enabled,
    schedule: e.schedule,
    when: e.schedule ? describeScriptSchedule(e.schedule) : 'no schedule',
    // Shown read-only on the row, so the person can see what runs. Never
    // editable from the page (scripts-lib.mjs validateChanges).
    argv: Array.isArray(e.argv) ? e.argv.map((a) => String(a)) : [],
    cwd: e.cwd,
    timeout_s: e.timeout_s,
    problem: problemFor(stateDir, e, recorded),
    running: runLockHeld(stateDir, id),
    last: last[id] || null,
  }));
  return { version: 1, scripts, removed: Object.keys(cfg.removed || {}).length };
}

// ---- save ----------------------------------------------------------------------
export function saveChanges(stateDir, changes, { nowIso = new Date().toISOString() } = {}) {
  const raw = readScriptsRaw(stateDir);
  const recorded = recordedEnvFiles(stateDir);
  const r = applyChanges(raw, changes, { problemOf: (id, e) => problemFor(stateDir, e, recorded), nowIso });
  if (!r.ok) return r;
  const f = scriptsFile(stateDir);
  mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(r.next, null, 2) + '\n');
  renameSync(tmp, f);   // atomic: the scheduler never reads half a file
  return r;
}

// ---- run -------------------------------------------------------------------------
// Resolves { status: 'ok'|'fail'|'skipped', reason?, row? }. Never rejects.
export function runScript(stateDir, id, { source = 'cron', token = '' } = {}) {
  return new Promise((resolve) => {
    const cfg = normalizeScripts(readScriptsRaw(stateDir));
    const entry = cfg.scripts[id];
    if (!entry) return resolve({ status: 'skipped', reason: `There is no script called ${id}.` });
    const p = problemFor(stateDir, entry);
    if (p) return resolve({ status: 'skipped', reason: p });
    if (!takeRunLock(stateDir, id, { timeout_s: entry.timeout_s })) {
      return resolve({ status: 'skipped', reason: 'It is still running from last time.' });
    }
    let env = { ...process.env };
    if (entry.env_file) {
      try { env = { ...env, ...parseEnvFile(readFileSync(entry.env_file, 'utf8')) }; } catch { /* checked above; a race just runs without it */ }
    }
    const started = new Date().toISOString();
    let child;
    try {
      child = execFile(entry.argv[0], entry.argv.slice(1), {
        cwd: entry.cwd, env, timeout: entry.timeout_s * 1000, killSignal: 'SIGTERM', maxBuffer: 8 * 1024 * 1024,
      }, (e, stdout, stderr) => {
        const out = `${String(stdout || '')}${String(stderr || '')}`;
        const reason = failureReason(e, entry.timeout_s);
        const row = appendRun(stateDir, {
          ts: started, job: `script:${id}`, script: id, skill: null, source,
          status: e ? 'fail' : 'ok', summary: summarize(out), error: reason, tail: tailOf(out), token,
        });
        releaseRunLock(stateDir, id);
        resolve({ status: e ? 'fail' : 'ok', reason, row, out });
      });
    } catch (e) {
      appendRun(stateDir, { ts: started, job: `script:${id}`, script: id, skill: null, source, status: 'fail', error: `could not start: ${e.message}`, tail: [], token });
      releaseRunLock(stateDir, id);
      return resolve({ status: 'fail', reason: `could not start: ${e.message}` });
    }
    child.stdin && child.stdin.end();
  });
}

// ---- CLI ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cli(argv) {
  const stateDir = path.resolve(argv[0] || '/state');
  const cmd = argv[1];
  const flag = (k) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ''; };
  if (cmd === 'list') {
    console.log('SCRIPTS_STATE ' + JSON.stringify(listScripts(stateDir)));
    return 0;
  }
  if (cmd === 'save') {
    let changes;
    try { changes = JSON.parse(Buffer.from(readFileSync(0, 'utf8').trim(), 'base64').toString('utf8')); }
    catch { console.log('ERROR: the changes were not readable, nothing saved'); return 1; }
    const r = saveChanges(stateDir, changes);
    if (!r.ok) { console.log(`ERROR: ${r.error}. Nothing saved.`); return 1; }
    for (const l of r.said) console.log(`OK: ${l}`);
    console.log('OK: scripts saved. Changes take effect within a minute.');
    return 0;
  }
  if (cmd === 'exec') {
    const r = await runScript(stateDir, argv[2], { source: flag('source') || 'cron', token: flag('token') });
    if (r.status === 'skipped') { console.log(r.reason); return 1; }
    if (r.out) process.stdout.write(r.out);
    return r.status === 'ok' ? 0 : 1;
  }
  if (cmd === 'run') {
    const id = argv[2] || '';
    const cfg = normalizeScripts(readScriptsRaw(stateDir));
    const entry = cfg.scripts[id];
    if (!entry) { console.log(`ERROR: there is no script called ${id} on this mineral.`); return 1; }
    const p = problemFor(stateDir, entry);
    if (p) { console.log(`ERROR: ${p}`); return 1; }
    if (runLockHeld(stateDir, id)) { console.log(`${id} is already running. Its result shows on this row when it finishes.`); return 0; }
    // Started detached, so a long script outlives this SSH call; we wait a
    // little and report the outcome if it lands in time.
    const token = randomBytes(6).toString('hex');
    const child = spawn(process.execPath, [SELF, stateDir, 'exec', id, '--source=dashboard', `--token=${token}`], { detached: true, stdio: 'ignore' });
    child.unref();
    console.log(`Running ${entry.name || id} now.`);
    const waitMs = Number(process.env.AIOS_SCRIPT_RUN_WAIT_S || 40) * 1000;
    for (let t = 0; t < waitMs; t += 500) {
      await sleep(500);
      const last = lastRunByScript(stateDir)[id];
      if (last && last.token === token) {
        for (const l of last.tail || []) console.log(`  ${l}`);
        if (last.status === 'ok') { console.log('It finished cleanly.'); return 0; }
        console.log(`It failed: ${last.error || 'no reason given'}.`);
        return 1;
      }
    }
    console.log('It is still running. Its result shows on this row when it finishes.');
    return 0;
  }
  console.log('usage: scripts.mjs <state-dir> list|save|run <id>|exec <id>');
  return 2;
}

// Exit only once stdout has drained: under docker exec stdout is a non-blocking
// pipe, and an immediate process.exit() cut long answers off at 64 KB (adopt
// rehearsal T4, 2026-10-18). The exit itself stays, so a stray handle cannot hang it.
if (isMain(import.meta.url)) cli(process.argv.slice(2)).then((code) => process.stdout.write('', () => process.exit(code)));
