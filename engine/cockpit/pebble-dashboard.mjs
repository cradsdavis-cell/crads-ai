#!/usr/bin/env node
// pebble-dashboard.mjs — the PEBBLE-facing dashboard (spec §3.P5.dash.pebble-*, gate G6).
//
// What ONE pebble sees about THEIR OWN engagement — derived PURELY from that pebble's own box
// (their state-view + comms/outcome ledgers). It contains ZERO operator-only fields, ZERO oracle
// content, and ZERO other-pebble data: a pebble viewing their dashboard can only ever see their
// own. Every field carries provenance that resolves to this pebble's box, so cross-pebble leakage
// is mechanically detectable. Plain-language (pebble-readable), not the operator's internal view.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const rd = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// generate(clientId, stateDir) -> the pebble's own dashboard object (derived from their box only).
export function generate(clientId, stateDir) {
  const sv = rd(path.join(stateDir, 'state', 'state-view.json'));
  if (!sv) return { client_id: clientId, error: 'no state-view', provenance: null };
  const owed = (() => {
    try {
      const rows = readFileSync(path.join(stateDir, 'state', 'comms-ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const fold = {}; for (const r of rows) { fold[r.comm_id] ||= { gate: null, sent: false }; if (r.kind === 'gate') fold[r.comm_id].gate = r.decision; if (r.kind === 'send') fold[r.comm_id].sent = true; }
      return Object.values(fold).filter((c) => c.gate === 'gated' && !c.sent).length;
    } catch { return 0; }
  })();
  // PEBBLE-facing fields only — no engagement_health / integrity / operator internals.
  return {
    client_id: clientId,
    your_stage: sv.current_block?.value || 'getting started',
    whats_set_up: (sv.outcomes_achieved || []).map((o) => o.outcome_id || o).slice(0, 20),
    in_progress: (sv.outcomes_pending || []).map((o) => o.outcome_id || o).slice(0, 20),
    waiting_on_you: sv.next_action?.owner === 'pebble' ? (sv.next_action?.description || 'a reply from you') : null,
    next_step: sv.next_action?.description || null,
    drafts_awaiting_your_ok: owed,
    // provenance: resolves ONLY to this pebble's own box (the leak check keys off '/<clientId>/').
    provenance: `pebble-view:${clientId}`,
    provenance_source: path.join(stateDir, 'state', 'state-view.json'),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [clientId, stateDir] = process.argv.slice(2);
  console.log(JSON.stringify(generate(clientId, stateDir), null, 2));
}
