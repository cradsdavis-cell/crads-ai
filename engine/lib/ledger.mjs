// ledger.mjs — the Action Ledger (spec §7 + §3.P3). Append-only, git-tracked record
// of EVERY action the kernel takes, so automation is reconcilable against expectations.
// Single-writer (the kernel) — same discipline as the git spine. Rows are ULID-keyed so
// lexical sort == time order (P3.ledger.wellformed: action_ids unique + ULID-sorted == ts-sorted).
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function b32(n, len) {
  let s = '';
  for (let i = 0; i < len; i++) { s = CROCKFORD[n % 32] + s; n = Math.floor(n / 32); }
  return s;
}
// Monotonic, deterministic ULID-like id from a virtual-time ms + a per-ledger sequence.
// time(10 chars, ms since epoch) + seq(6 chars) — time dominates the sort, seq breaks ties.
export function ulid(tsMs, seq) {
  return b32(tsMs, 10) + b32(seq, 6);
}

function ledgerPath(stateDir) { return path.join(stateDir, 'state', 'action_ledger.jsonl'); }

export function readActions(stateDir) {
  const p = ledgerPath(stateDir);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Append one action row. Fills action_id (ULID) and seq from the current ledger length,
// so it is restart-safe (the next seq is derived from what's on disk) and monotonic.
export function appendAction(stateDir, row) {
  const p = ledgerPath(stateDir);
  mkdirSync(path.dirname(p), { recursive: true });
  const existing = readActions(stateDir);
  const seq = existing.length;
  const tsMs = Date.parse(row.ts) || 0;
  const full = {
    action_id: ulid(tsMs, seq),
    seq,
    ...row,
  };
  // atomic-ish append (single-writer kernel; one line per row)
  appendFileSync(p, JSON.stringify(full) + '\n');
  return full;
}

// Classify a drained job into the action taxonomy (spec §3.P3 + §0.4 allowlist).
export function classifyJob(job) {
  const source = job.source || 'cli';
  const skill = job.skill;
  if (source === 'cron') return { actor_class: 'auto', actor_id: `cron:${skill}`, trigger_kind: 'cron' };
  if (source === 'telegram') {
    // inbound conversational turn — event-triggered, default-deny (drafts only, no send tools)
    if (skill === 'execute-proposal' || source === 'telegram-approve') return { actor_class: 'approval_gated', actor_id: 'telegram:approve', trigger_kind: 'approval' };
    return { actor_class: 'auto', actor_id: 'telegram:inbound', trigger_kind: 'inbound' };
  }
  if (source === 'telegram-approve') return { actor_class: 'approval_gated', actor_id: 'telegram:approve', trigger_kind: 'approval' };
  return { actor_class: 'manual', actor_id: `operator:${source}`, trigger_kind: null };
}
