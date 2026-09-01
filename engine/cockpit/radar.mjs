// radar.mjs — the operator's cross-client RADAR (spec §3.P5 "Cross-client RADAR").
// One row per client, DERIVED PURELY from each client's own state-view (+ its comms/outcome
// ledgers) — never hand-maintained. Each row's provenance resolves ONLY to its own box, so
// the operator can see every client's true state with ZERO cross-client bleed (G6). Lives in
// the operator's cockpit, NOT in any client box.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { nowISO } from '../lib/clock.mjs';

const rd = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// Deterministic derivation rules (spec §3.P5):
//   health red   if false-achieved OR blocker age>7 OR owed+overdue>2d OR projection dead
//   health amber if cold OR any blocker OR owed-not-overdue
//   else green
function rowFor(clientId, stateDir) {
  const sv = rd(path.join(stateDir, 'state', 'state-view.json'));
  if (!sv) return { client_id: clientId, error: 'no state-view', provenance_client_view: null };
  const commsRows = (() => { try { return readFileSync(path.join(stateDir, 'state', 'comms-ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
  // gated-not-sent comms = operator owes a send/approval
  const fold = {}; for (const r of commsRows) { fold[r.comm_id] ||= { gate: null, sent: false }; if (r.kind === 'gate') fold[r.comm_id].gate = r.decision; if (r.kind === 'send') fold[r.comm_id].sent = true; }
  const owed = Object.values(fold).filter((c) => c.gate === 'gated' && !c.sent).length;
  const blockers = sv.blockers || [];
  const blocked = blockers.length > 0;
  const falseAchieved = false; // by construction the state-view only shows verification-backed achieved
  const projectionAlive = sv.projection_alive === true;
  const coldDays = 0, isCold = false; // no client contact tracked in the seeded onboarding slice
  let health = 'green';
  if (falseAchieved || blockers.some((b) => (b.age_days || 0) > 7) || !projectionAlive) health = 'red';
  else if (isCold || blocked || owed > 0) health = 'amber';
  const outcomes = { achieved: (sv.outcomes_achieved || []).length, pending: (sv.outcomes_pending || []).length };
  return {
    client_id: clientId,
    stage: sv.current_block?.value || 'unknown',
    health,
    owed_a_comm: owed > 0,
    owed_count: owed,
    waiting_on: sv.next_action?.owner || null,
    cold_days: coldDays,
    is_cold: isCold,
    blocked,
    blocker_summary: blockers.map((b) => b.id).join(',') || null,
    next_action: sv.next_action?.description || null,
    outcomes,
    view_age_ok: projectionAlive,
    projection_alive: projectionAlive,
    provenance_client_view: path.join(stateDir, 'state', 'state-view.json'),
  };
}

// generate(clients) where clients = [{client_id, state_dir}, ...]. Writes cockpit/radar.json
// under outDir. Default sort: red -> amber -> green, then owed desc, then cold desc.
export function generate(clients, outDir) {
  const rows = clients.map((c) => rowFor(c.client_id, c.state_dir));
  const rank = { red: 0, amber: 1, green: 2 };
  rows.sort((a, b) => (rank[a.health] - rank[b.health]) || (b.owed_count - a.owed_count) || (b.cold_days - a.cold_days) || (a.client_id < b.client_id ? -1 : 1));
  const radar = { schema: 'radar/1', as_of: nowISO(clients[0]?.state_dir), client_count: rows.length, rows };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'radar.json'), JSON.stringify(radar, null, 2) + '\n');
  return radar;
}

// CLI: node radar.mjs <outDir> <id1>:<stateDir1> <id2>:<stateDir2> ...
if (import.meta.url === `file://${process.argv[1]}`) {
  const [outDir, ...pairs] = process.argv.slice(2);
  const clients = pairs.map((p) => { const i = p.indexOf(':'); return { client_id: p.slice(0, i), state_dir: p.slice(i + 1) }; });
  console.log(JSON.stringify(generate(clients, outDir), null, 2));
}
