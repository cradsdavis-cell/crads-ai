// run-ledger.mjs — the box's job run history (spec 2026-08-04 § 5).
// cockpit/run-ledger.jsonl, one JSON line per run:
//   { ts, ended, job, skill|null, source, status: "ok"|"fail", summary, error }
//
// Why this exists NEXT TO the git-committed action ledger (engine/lib/ledger.mjs):
// the action ledger is the operator audit trail, written only by the kernel
// (single-writer, D9) and committed to the state repo. Machinery jobs (backup,
// brain-push, auto-update...) run OUTSIDE the kernel and must never commit to
// the member's repo, and the app needs a cheap uncommitted read. cockpit/ is
// gitignored, so both writers (kernel for skill runs, scheduler for machinery)
// can append here without touching the write door. Summaries are ONE line and
// stay on the box; the heartbeat carries status + timestamps only, never text.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const FILE = (stateDir) => path.join(stateDir, 'cockpit', 'run-ledger.jsonl');
// One row per skill, immune to the ledger's rotation (see appendRun).
const LASTFILE = (stateDir) => FILE(stateDir).replace(/run-ledger\.jsonl$/, 'last-skill-runs.json');
export const LEDGER_KEEP = 500;      // newest entries kept after rotation
const ROTATE_AT = LEDGER_KEEP + 100; // rotate lazily, not on every append

export function appendRun(stateDir, entry) {
  try {
    const f = FILE(stateDir);
    mkdirSync(path.dirname(f), { recursive: true });
    const row = {
      ts: entry.ts || new Date().toISOString(),
      ended: entry.ended || new Date().toISOString(),
      job: String(entry.job || entry.skill || 'unknown'),
      skill: entry.skill || null,
      source: entry.source || 'cron',
      status: entry.status === 'fail' ? 'fail' : 'ok',
      summary: oneLine(entry.summary, 200),
      error: entry.status === 'fail' ? oneLine(entry.error, 200) : null,
    };
    appendFileSync(f, JSON.stringify(row) + '\n');
    // A SKILL OUTCOME OUTLIVES ROTATION. The ledger keeps the newest 500 rows,
    // and machinery alone appends ~867 a day on a member box (org-sync fires
    // every even minute), so the visible window is under 14 hours. A skill's
    // outcome was therefore evicted long before the member next looked, while
    // the fire stamp in skill-runs.json lives forever — so a run that completed
    // on Sunday read as "started, no result recorded yet" all week. The flood
    // that proves the ledger is alive is the same flood that destroys the
    // evidence. This side map is one row per skill, a dozen or so, and rotation
    // cannot touch it.
    if (row.skill) {
      const lf = LASTFILE(stateDir);
      let last = {};
      try { last = JSON.parse(readFileSync(lf, 'utf8')) || {}; } catch { last = {}; }
      last[row.skill] = row;
      writeFileSync(lf, JSON.stringify(last, null, 2) + '\n');
    }
    // Lazy rotation: newest LEDGER_KEEP survive. Count cheaply, rewrite rarely.
    const text = readFileSync(f, 'utf8');
    let lines = 0; for (let i = 0; i < text.length; i++) if (text[i] === '\n') lines++;
    if (lines > ROTATE_AT) {
      const keep = text.trimEnd().split('\n').slice(-LEDGER_KEEP);
      writeFileSync(f, keep.join('\n') + '\n');
    }
    return row;
  } catch { return null; }   // the ledger is observability, never a reason a run fails
}

export function readRuns(stateDir, n = LEDGER_KEEP) {
  try {
    return readFileSync(FILE(stateDir), 'utf8').trimEnd().split('\n').slice(-n)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// Newest entry per skill id (the Skills/Cadence pages' health join).
// Reads the rotation-proof side map FIRST, then lets anything still visible in
// the ledger win if it is newer — so a box whose engine predates the side map
// keeps working, and a fresh row is never masked by a stale one.
export function lastRunBySkill(stateDir) {
  const out = {};
  try {
    const last = JSON.parse(readFileSync(LASTFILE(stateDir), 'utf8'));
    if (last && typeof last === 'object') for (const [k, v] of Object.entries(last)) if (v && v.skill) out[k] = v;
  } catch { /* no side map yet: the ledger scan below is the whole answer */ }
  for (const r of readRuns(stateDir)) {
    if (!r.skill) continue;
    const seen = out[r.skill];
    if (!seen || String(r.ts || '') >= String(seen.ts || '')) out[r.skill] = r;
  }
  return out;
}

// Newest SUCCESSFUL entry per skill id (2026-08-20 audit).
//
// lastRunBySkill above answers "what happened most recently", which is the
// Skills page's question. This answers "when did this last WORK", which is the
// stall board's, and they are not the same row: a skill that succeeded on
// Tuesday and has failed hourly since has a newest row of fail and a newest
// success of Tuesday. Reading the first as the second is half of how a mineral
// with a dead Claude sign-in rendered as "active, N skills running" (the other
// half was reading the scheduler's fire stamp as an outcome at all).
//
// Same two sources as lastRunBySkill, for the same reason: the rotation-proof
// side map first, which holds one row per skill and so may itself be a failure,
// then the ledger scan, newest ok winning.
//
// THE HONEST LIMIT, because a caller has to know it. The ledger keeps 500 rows
// and machinery alone writes hundreds a day, so a success old enough to have
// been rotated out leaves no trace here and its skill is simply absent from the
// result. Absent means "no evidence this has finished recently", which is true
// and is what a reader may say. It does not mean "never ran", and nothing may
// render it as never.
export function lastOkRunBySkill(stateDir) {
  const out = {};
  const take = (r) => {
    if (!r || !r.skill || r.status !== 'ok' || !r.ts) return;
    const seen = out[r.skill];
    if (!seen || String(r.ts) >= String(seen.ts || '')) out[r.skill] = r;
  };
  try {
    const last = JSON.parse(readFileSync(LASTFILE(stateDir), 'utf8'));
    if (last && typeof last === 'object') for (const v of Object.values(last)) take(v);
  } catch { /* no side map yet: the ledger scan below is the whole answer */ }
  for (const r of readRuns(stateDir)) take(r);
  return out;
}

// Newest entry per machinery job name (skill-less rows).
export function lastRunByJob(stateDir) {
  const out = {};
  for (const r of readRuns(stateDir)) if (!r.skill) out[r.job] = r;
  return out;
}

// The one-line summary of a skill run's output: the first line under a
// "## Summary" heading when the skill provides one, else the last non-empty
// line. Never more than `max` chars, never a newline.
export function summarize(output, max = 200) {
  const text = String(output || '').trim();
  if (!text) return '';
  const m = text.match(/^##\s*Summary\s*\n+([^\n]+)/im);
  const line = m ? m[1] : (text.split('\n').filter((l) => l.trim()).pop() || '');
  return oneLine(line, max);
}

// Heartbeat view (spec § 5): status + timestamps only — the summary TEXT never
// leaves the box. Machinery rows are part of the box-health floor; skill rows
// ride only when the member shares skill engagement.
export function tailForHeartbeat(runs, { shareEngagement = true, n = 20 } = {}) {
  return runs
    .filter((r) => !r.skill || shareEngagement)
    .slice(-n)
    .map((r) => ({ ts: r.ts, job: r.job, skill: r.skill, status: r.status }));
}

function oneLine(s, max) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
