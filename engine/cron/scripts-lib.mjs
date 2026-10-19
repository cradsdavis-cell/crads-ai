// scripts-lib.mjs — pure logic for "Scripts on a schedule" (spec
// docs/superpowers/specs/2026-10-17-adopt-existing-server.md § Scripts on a schedule).
// No filesystem, no clock, no spawn: scripts.mjs and scheduler.mjs own IO, this
// owns meaning, and the app imports it to validate a page's edits before they
// leave the computer. Container paths are POSIX whatever the app runs on.
//
// cockpit/scripts.json v1 (sibling of cadence.json, same schedule shapes):
//   { "version": 1,
//     "scripts": {
//       "<id>": {
//         "enabled": false,
//         "name": "Money state",                    // optional, what the row is called
//         "description": "Rebuilds money.json",     // optional, one line
//         "argv": ["node", "cockpit/tools/money-state.mjs"],   // an ARRAY, never a shell string
//         "cwd": "/state",                          // must sit under /state
//         "schedule": { "kind": "every", "minutes": 15, "quiet": false },
//         "timeout_s": 600,
//         "env_file": "/state/secrets/vps.env"      // optional, under /state/secrets/
//       } },
//     "removed": { "<id>": { ...entry, "removed_at": "<iso>" } } }   // deleted rows, kept
//
// A script is a fixed program that runs the same way every time, without
// Claude. It costs nothing on the member's plan, so it gets a far lower
// "every N minutes" floor than a skill does. Where scripts come from: the
// move-in or the assistant writing this file. A PAGE can only switch a row on
// or off, change its schedule, or remove it (validateChanges below): the one
// field that says what runs, argv, is never page-writable.
import path from 'node:path';
import { scheduleProblem, scheduleMatches, describeSchedule } from './cadence-lib.mjs';

const P = path.posix;
export const SCRIPT_EVERY_FLOOR_MIN = 1;   // a script every minute is cheap; the overlap lock keeps it single
export const DEFAULT_TIMEOUT_S = 600;
export const MAX_TIMEOUT_S = 6 * 3600;
export const TAIL_LINES = 8;
const SCHED_OPTS = { everyFloor: SCRIPT_EVERY_FLOOR_MIN };
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_ARGV = 64;
const MAX_ARG_LEN = 4096;

const oneLine = (v, max) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

// ---- reading the file ------------------------------------------------------

// Junk ids and non-object entries are dropped; every kept entry has the full
// shape, so the readers never have to guard a field again. Normalising never
// repairs argv: an argv that is not a clean array stays as it is and
// scriptProblem names it, so a broken row is SEEN, not silently fixed.
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = Number(raw.timeout_s);
  const out = {
    enabled: raw.enabled === true,
    name: oneLine(raw.name, 80),
    description: oneLine(raw.description, 200),
    argv: raw.argv,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    schedule: raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : null,
    timeout_s: Number.isInteger(t) && t > 0 ? t : DEFAULT_TIMEOUT_S,
  };
  if (raw.env_file != null) out.env_file = raw.env_file;
  return out;
}

export function normalizeScripts(raw) {
  const out = { version: 1, scripts: {}, removed: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const src = raw.scripts && typeof raw.scripts === 'object' && !Array.isArray(raw.scripts) ? raw.scripts : {};
  for (const [id, entry] of Object.entries(src)) {
    if (!ID_RE.test(id)) continue;
    const n = normalizeEntry(entry);
    if (n) out.scripts[id] = n;
  }
  if (raw.removed && typeof raw.removed === 'object' && !Array.isArray(raw.removed)) out.removed = raw.removed;
  return out;
}

// ---- is this row runnable? ---------------------------------------------------

function under(dir, p) {
  const d = P.resolve(dir), q = P.resolve(p);
  return q === d || q.startsWith(d.endsWith('/') ? d : d + '/');
}

// The shape problems: everything that can be said from the file alone. Returns
// null when sound, else one sentence a member can read.
export function shapeProblem(entry, { stateDir = '/state', recordedEnvFiles = [] } = {}) {
  if (!entry) return 'This script has no settings.';
  const a = entry.argv;
  if (!Array.isArray(a) || !a.length) return 'This script has no program to run.';
  if (a.length > MAX_ARGV) return 'This script has too many arguments.';
  if (a.some((x) => typeof x !== 'string' || x.includes('\0') || x.length > MAX_ARG_LEN)) return 'Every part of the command must be plain text.';
  if (!a[0].trim()) return 'This script has no program to run.';
  if (!entry.cwd || !P.isAbsolute(entry.cwd) || !under(stateDir, entry.cwd)) return `Its folder must be inside ${stateDir}.`;
  if (entry.env_file != null) {
    const f = entry.env_file;
    const ok = typeof f === 'string' && P.isAbsolute(f)
      && (under(P.join(stateDir, 'secrets'), f) && P.resolve(f) !== P.resolve(P.join(stateDir, 'secrets'))
        || recordedEnvFiles.includes(P.resolve(f)));
    if (!ok) return `Its settings file must be inside ${P.join(stateDir, 'secrets')}/.`;
  }
  if (!Number.isInteger(entry.timeout_s) || entry.timeout_s < 1 || entry.timeout_s > MAX_TIMEOUT_S) return 'Its time limit must be between 1 second and 6 hours.';
  const sp = scheduleProblem(entry.schedule, SCHED_OPTS);
  if (sp) return `Its schedule is not valid (${sp}).`;
  return null;
}

// The full answer: shape, then the facts only the box can check. `facts` is
// what the IO layer found inside the container:
//   { program: true|false, cwd: true|false, envFile: true|false|undefined }
// A host-only binary (a Go bridge, a uvx tool) says so here, on the row,
// instead of failing at 3am.
export function scriptProblem(entry, ctx = {}, facts = {}) {
  const sp = shapeProblem(entry, ctx);
  if (sp) return sp;
  if (facts.program === false) return `${entry.argv[0]} is not installed inside your mineral, so this cannot run here yet.`;
  if (facts.cwd === false) return `Its folder ${entry.cwd} does not exist.`;
  if (entry.env_file != null && facts.envFile === false) return `Its settings file ${entry.env_file} does not exist.`;
  return null;
}

// The program to look for. Bare names are searched on PATH by the IO layer; a
// relative path with a slash is relative to the row's own folder.
export function programPath(entry) {
  const p = entry.argv[0];
  if (!p.includes('/')) return { bare: p };
  return { path: P.isAbsolute(p) ? p : P.resolve(entry.cwd, p) };
}

// ---- scheduling ----------------------------------------------------------------

export function scriptMatches(entry, now) {
  return scheduleMatches(entry.schedule, now, SCHED_OPTS);
}

export function describeScriptSchedule(s) {
  return describeSchedule(s, SCHED_OPTS);
}

// From the normalised file to fireable jobs. `problemOf(id, entry)` is the IO
// layer's full check; a row with any problem never fires.
export function buildScriptJobs(scripts, { quiet = '', problemOf = () => null } = {}) {
  const jobs = [];
  for (const [id, entry] of Object.entries((scripts && scripts.scripts) || {})) {
    if (!entry.enabled) continue;
    if (problemOf(id, entry)) continue;
    jobs.push({
      name: `script ${id} (${describeScriptSchedule(entry.schedule)})`,
      isScript: true,
      script: id,
      match: (hour, minute, dow, ymd) => scriptMatches(entry, { hour, minute, dow, ymd, quiet }),
    });
  }
  return jobs;
}

// ---- what a page may change ------------------------------------------------------
// The page sends { "<id>": { enabled?, schedule? } | { remove: true } }. Anything
// else is refused whole: no new ids, no argv, no cwd, no env_file, no timeout.
// Returns null when acceptable, else the reason. Run by the app before the verb
// leaves the computer AND by the box before the file is touched.
const PAGE_KEYS = new Set(['enabled', 'schedule', 'remove']);
export function validateChanges(changes, known) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return 'changes must be an object';
  const ids = Object.keys(changes);
  if (!ids.length) return 'nothing to change';
  if (ids.length > 200) return 'too many changes at once';
  for (const id of ids) {
    if (!ID_RE.test(id)) return `"${oneLine(id, 40)}" is not a script id`;
    if (known && !known.includes(id)) return `there is no script called ${id}; scripts are added by your assistant, not by this page`;
    const c = changes[id];
    if (!c || typeof c !== 'object' || Array.isArray(c)) return `the change for ${id} must be an object`;
    for (const k of Object.keys(c)) if (!PAGE_KEYS.has(k)) return `${k} cannot be changed from the app; ask your assistant`;
    if (c.remove != null && c.remove !== true) return 'remove must be true';
    if (c.remove === true && Object.keys(c).length > 1) return `removing ${id} cannot be combined with other changes`;
    if (c.enabled != null && typeof c.enabled !== 'boolean') return 'enabled must be true or false';
    if (c.schedule != null) {
      const sp = scheduleProblem(c.schedule, SCHED_OPTS);
      if (sp) return `the schedule for ${id} is not valid (${sp})`;
    }
  }
  return null;
}

// Apply page changes to the raw file object, preserving every field the page
// may not touch. `problemOf(id, nextEntry)` refuses switching on a row that
// cannot run. Returns { ok, next, error, said[] }; never mutates `raw`.
export function applyChanges(raw, changes, { problemOf = () => null, nowIso = '' } = {}) {
  const next = JSON.parse(JSON.stringify(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}));
  if (!next.scripts || typeof next.scripts !== 'object' || Array.isArray(next.scripts)) next.scripts = {};
  next.version = 1;
  const err = validateChanges(changes, Object.keys(normalizeScripts(next).scripts));
  if (err) return { ok: false, error: err };
  const said = [];
  for (const [id, c] of Object.entries(changes)) {
    if (c.remove === true) {
      if (!next.removed || typeof next.removed !== 'object' || Array.isArray(next.removed)) next.removed = {};
      next.removed[id] = { ...next.scripts[id], enabled: false, removed_at: nowIso };
      delete next.scripts[id];
      said.push(`${id} removed (kept under "removed" in cockpit/scripts.json, so your assistant can put it back)`);
      continue;
    }
    const e = next.scripts[id];
    if (c.schedule != null) e.schedule = c.schedule;
    if (c.enabled != null) e.enabled = c.enabled;
    if (e.enabled) {
      const p = problemOf(id, normalizeEntry(e));
      if (p) return { ok: false, error: `${id} cannot be switched on: ${p}` };
    }
    said.push(`${id} ${e.enabled ? 'on' : 'off'}, ${describeScriptSchedule(e.schedule)}`);
  }
  return { ok: true, next, said };
}

// ---- outcomes ------------------------------------------------------------------

// The last few non-empty lines of a run's output, each bounded, for the row's fold.
export function tailOf(out, n = TAIL_LINES) {
  return String(out || '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim())
    .slice(-n).map((l) => l.slice(0, 300));
}

// The honest one-line reason a run failed, from execFile's error.
export function failureReason(e, timeout_s) {
  if (!e) return null;
  if (e.killed) return `stopped after ${timeout_s} s (its time limit)`;
  if (e.code === 'ENOENT') return 'could not start: the program is not there';
  if (typeof e.code === 'number') return `exited with code ${e.code}`;
  if (e.signal) return `stopped by ${e.signal}`;
  return oneLine(e.message, 160) || 'failed';
}

// "KEY=value" lines; `export`, comments and quotes are understood, nothing is
// ever expanded or executed.
//
// Variables that change WHICH program runs, or make one run code at start-up,
// are dropped. An env file is a secret store, and secrets can be written from
// the app (secrets-put), so letting one set PATH or NODE_OPTIONS would be a way
// for a page to say what runs, the one thing this design forbids. Tokens and
// settings pass through untouched.
export const ENV_NEVER = /^(PATH|LD_[A-Z_]*|DYLD_[A-Z_]*|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|PS4|IFS|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|GIT_EXEC_PATH|GIT_SSH|GIT_SSH_COMMAND|HOME)$/;
export function parseEnvFile(text) {
  const env = {};
  for (const raw of String(text || '').split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const m = l.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (ENV_NEVER.test(m[1])) continue;
    env[m[1]] = v;
  }
  return env;
}
