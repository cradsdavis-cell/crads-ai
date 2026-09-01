// outcomes.mjs — the Outcome Ledger (spec §7 + §3.P5 outcome model + §3.P1.e2e).
// Append-only, git-tracked. Every pain + goal + ladder block gets a machine-evaluable
// outcome at onboarding-end (OUT-COV), all status=pending. An outcome moves to 'achieved'
// ONLY via a logged 'verified' event with a verification record — never by assertion — so
// the operator can NEVER be shown a false "achieved" (P5.acc.false-achieved, G3 CRITICAL).
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { nowISO } from './clock.mjs';

const LEDGER = (s) => path.join(s, 'state', 'outcomes.jsonl');
const STATE = (s) => path.join(s, 'state', 'outcomes.state.json');

export function readEvents(stateDir) {
  const p = LEDGER(stateDir);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Fold the event log into current state (a derived projection — reproducible from the ledger).
export function fold(stateDir) {
  const out = {};
  for (const e of readEvents(stateDir)) {
    if (e.kind === 'created') out[e.outcome_id] = { outcome_id: e.outcome_id, origin: e.origin, trace: e.trace, completion_kind: e.completion_kind, acceptance: e.acceptance, status: 'pending', verification: null };
    else if (e.kind === 'verified' && out[e.outcome_id]) { out[e.outcome_id].status = 'achieved'; out[e.outcome_id].verification = e.verification; }
    else if (e.kind === 'regressed' && out[e.outcome_id]) { out[e.outcome_id].status = 'pending'; out[e.outcome_id].verification = null; out[e.outcome_id].regressed = true; }
  }
  return out;
}

export function readState(stateDir) {
  try { return JSON.parse(readFileSync(STATE(stateDir), 'utf8')); } catch { return null; }
}

function append(stateDir, ev) {
  const p = LEDGER(stateDir);
  mkdirSync(path.dirname(p), { recursive: true });
  const seq = readEvents(stateDir).length;
  appendFileSync(p, JSON.stringify({ seq, ts: nowISO(stateDir), ...ev }) + '\n');
}
function writeState(stateDir) { writeFileSync(STATE(stateDir), JSON.stringify(fold(stateDir), null, 2) + '\n'); }

// Create the pending outcome set from the brain (every pain + goal) + the ladder blocks.
// Idempotent: re-running does not duplicate (skips outcome_ids already 'created').
export function createFromBrain(stateDir) {
  const brain = (() => { try { return JSON.parse(readFileSync(path.join(stateDir, 'brain', '.index.json'), 'utf8')); } catch { return null; } })();
  if (!brain) throw new Error('no brain/.index.json — run onboard-ingest first');
  const existing = new Set(readEvents(stateDir).filter((e) => e.kind === 'created').map((e) => e.outcome_id));
  const add = (id, origin, trace, completion_kind, acceptance) => { if (!existing.has(id)) append(stateDir, { kind: 'created', outcome_id: id, origin, trace, completion_kind, acceptance, status: 'pending' }); };
  for (const f of brain.facts.filter((x) => x.type === 'pain')) add(`o_${f.fact_id}`, 'pain', f.fact_id, 'skill_runs_clean', `bespoke capability for ${f.fact_id} runs clean`);
  for (const f of brain.facts.filter((x) => x.type === 'goal')) add(`o_${f.fact_id}`, 'goal', f.fact_id, 'metric_threshold', `goal metric crosses threshold: ${f.fact_id}`);
  for (const b of ['b1', 'b2', 'b3', 'b4']) add(`o_ladder_${b}`, 'ladder', b, 'artifact_exists', `ladder block ${b} deliverable produced`);
  writeState(stateDir);
  return fold(stateDir);
}

// Verify an outcome (the ONLY way to 'achieved'). verification must carry an objective result.
export function verify(stateDir, outcomeId, verification) {
  append(stateDir, { kind: 'verified', outcome_id: outcomeId, verification });
  writeState(stateDir);
}
// Regress a reached outcome (achieved -> pending) with a reason (the outcome_regression friction).
export function regress(stateDir, outcomeId, reason) {
  append(stateDir, { kind: 'regressed', outcome_id: outcomeId, reason });
  writeState(stateDir);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(createFromBrain(process.argv[2] || '.'), null, 2));
}
