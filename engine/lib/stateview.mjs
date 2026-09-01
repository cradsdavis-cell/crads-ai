// stateview.mjs — the per-client STATE-VIEW (spec §3.P5 + §7). The single operator-truth
// projection: Sam's 10 fields, each leaf carrying provenance (no provenance = fabricated).
// DERIVED, never hand-maintained — regenerated on job-completion. Projects ONLY from the
// box's own committed data (profile, priorities, action-ledger, onboarding-state); it must
// NEVER read the ground-truth oracle (that would be ORACLE_LEAK).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { nowISO } from './clock.mjs';

const rd = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
function headSha(stateDir) { try { return execFileSync('git', ['-C', stateDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } }

export function generate(stateDir) {
  const profile = rd(path.join(stateDir, 'profile.yaml'));
  const priorities = rd(path.join(stateDir, 'wiki', 'priorities.md'));
  const sha = headSha(stateDir);
  const prov = (file) => sha ? [`git:${sha}:${file}`] : [`file:${file}`];

  // --- profile-derived facts (what the box actually knows pre-onboarding) ---
  const tz = (profile.match(/timezone:\s*"?([^"\n]+)"?/) || [, ''])[1].trim();
  const provider = (profile.match(/provider:\s*"?(google|microsoft)"?/) || [, ''])[1];
  const bizType = (profile.match(/business:\s*[\s\S]*?type:\s*"?([^"\n]+)"?/) || [, ''])[1];
  const userShort = (profile.match(/user_short:\s*"([^"]+)"/) || [, ''])[1];

  // --- wants/goals from priorities.md (verbatim spans, ranked) ---
  const goalLines = priorities.split('\n').filter((l) => l.trim().startsWith('- '));
  const wants = goalLines.map((l, i) => ({ id: `want${i + 1}`, statement: l.replace(/^\s*-\s*/, '').replace(/\s*\(target:.*$/, '').trim(), priority_rank: i + 1, provenance: prov('wiki/priorities.md') }));

  // --- comms_sent from the action-ledger (only real, recorded actions) ---
  const ledger = rd(path.join(stateDir, 'state', 'action_ledger.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const lastSeq = ledger.length ? ledger[ledger.length - 1].seq : -1;
  const comms_sent = ledger.filter((a) => a.side_effect?.kind === 'message.send').map((a) => ({ id: a.action_id, trigger: a.actor_id, approved_by: a.approval?.decided_by || (a.actor_class === 'auto' ? 'auto_allowlist' : null), delivery_status: 'sent', provenance: [`ledger:action:${a.seq}`] }));

  // --- onboarding/block state ---
  // current_block stays 'onboarding' until a B1 session actually runs — completing the
  // onboarding INTERVIEW does not start B1 (block-progression tracking is a later component).
  // A pebble keeps onboarding-state.json at the box root; a rock keeps it at
  // brain/. Reading only the root meant a rock's state-view NEVER saw
  // onboarding finish, so the onboarding_incomplete blocker (and its amber
  // engagement_health) could not clear (finding 194).
  const ob = (() => {
    for (const p of [path.join(stateDir, 'onboarding-state.json'), path.join(stateDir, 'brain', 'onboarding-state.json')]) {
      try { return JSON.parse(rd(p)); } catch { /* try next */ }
    }
    return null;
  })();
  const current_block = 'onboarding';
  // Same layers/modules rename as the cockpit reads. Two traps live in the old one-liner:
  // `Object.values(undefined || {})` is [], and `[].every()` is TRUE, so a brain on the new
  // schema reported onboarding COMPLETE from the moment it was created. And the terminal
  // phase is 'done' (what /onboard writes and what the panel's stamp-gate tests), not
  // 'complete'. Require a non-empty step list before believing the every().
  const obSteps = Object.values(ob?.layers || ob?.modules || {});
  const obDone = !!ob && (ob.phase === 'done' || ob.phase === 'complete'
    || (obSteps.length > 0 && obSteps.every((m) => m?.status === 'done' || m?.status === 'covered')));

  // --- brain index: the facts the onboarding ingest extracted from the client's discovery.
  // When the brain exists, the OPERATOR genuinely KNOWS the client's pains + tools, so they
  // move from info_NEEDED into info_have (with provenance to the brain fact). Until then they
  // are info_needed. This is what makes the operator state-view ACCURATE post-onboarding (G3).
  const brain = (() => { try { return JSON.parse(rd(path.join(stateDir, 'brain', '.index.json'))); } catch { return null; } })();
  const brainFacts = (type) => brain ? brain.facts.filter((f) => f.type === type) : [];
  const brainProv = (f) => sha ? [`git:${sha}:brain/.index.json`, `brain-fact:${f.fact_id}`] : [`brain-fact:${f.fact_id}`];

  const info_have = [];
  if (provider) info_have.push({ id: 'provider', statement: `provider is ${provider}`, confidence: 'high', provenance: prov('profile.yaml') });
  if (tz) info_have.push({ id: 'timezone', statement: `timezone is ${tz}`, confidence: 'high', provenance: prov('profile.yaml') });
  if (bizType) info_have.push({ id: 'business_type', statement: `business type is ${bizType}`, confidence: 'high', provenance: prov('profile.yaml') });
  for (const w of wants) info_have.push({ id: `goal_${w.id}`, statement: w.statement, confidence: 'high', provenance: w.provenance });
  // pains + tools from the brain (post-onboarding)
  for (const f of brainFacts('pain')) info_have.push({ id: f.fact_id, statement: f.statement, confidence: 'high', provenance: brainProv(f) });
  for (const f of brainFacts('tools')) info_have.push({ id: f.fact_id, statement: f.statement, confidence: 'high', provenance: brainProv(f) });

  // info_needed: only what the box still lacks. Once the brain has pains/tools, those drop out.
  const info_needed = [];
  if (brainFacts('pain').length === 0) info_needed.push({ id: 'pains_from_discovery', statement: 'client pains (need /onboard to ingest discovery into the brain)', blocks: ['bespoke-skill'], requested_via: 'onboarding', provenance: prov('profile.yaml') });
  if (brainFacts('tools').length === 0) info_needed.push({ id: 'tools_from_discovery', statement: 'client current tools (need /onboard)', blocks: [], requested_via: 'onboarding', provenance: prov('profile.yaml') });
  info_needed.push({ id: 'oauth_consent', statement: `${provider} OAuth consent`, blocks: ['connect-email'], requested_via: 'onboarding', provenance: prov('profile.yaml') });

  // outcomes: read the OUTCOME LEDGER (machine-evaluable). achieved ONLY contains outcomes
  // with a logged verification — the operator can never be shown a false "achieved" (G3).
  const outcomeState = (() => { try { return JSON.parse(rd(path.join(stateDir, 'state', 'outcomes.state.json'))); } catch { return null; } })();
  let outcomes_achieved = [], outcomes_pending = [];
  if (outcomeState) {
    const oprov = (id) => sha ? [`git:${sha}:state/outcomes.state.json`, `outcome:${id}`] : [`outcome:${id}`];
    for (const o of Object.values(outcomeState)) {
      const row = { id: o.outcome_id, origin: o.origin, trace: o.trace, status: o.status, verification: o.verification || null, provenance: oprov(o.outcome_id) };
      (o.status === 'achieved' ? outcomes_achieved : outcomes_pending).push(row);
    }
  } else {
    // pre-ledger fallback (no outcomes yet)
    outcomes_pending = [
      ...wants.map((w) => ({ id: `o_${w.id}`, origin: 'goal', status: 'pending', statement: w.statement, provenance: w.provenance })),
      ...['b1', 'b2', 'b3', 'b4'].map((b) => ({ id: `o_ladder_${b}`, origin: 'ladder', status: 'pending', provenance: prov('profile.yaml') })),
    ];
  }

  const next_action = obDone
    ? { owner: 'operator', description: 'schedule B1 session', due: null, provenance: prov('profile.yaml') }
    : { owner: 'client', description: 'complete the onboarding interview + OAuth consent before B1', due: null, provenance: prov('profile.yaml') };
  const blockers = obDone ? [] : [{ id: 'onboarding_incomplete', owner: 'client', blocking: 'pains_from_discovery', age_days: 0, provenance: prov('profile.yaml') }];

  const view = {
    schema: 'state-view/1',
    client_id: path.basename(path.dirname(stateDir)),
    current_block: { value: current_block, provenance: ob ? [`git:${sha}:onboarding-state.json`] : prov('profile.yaml') },
    materials_held: [],
    comms_sent,
    info_have,
    info_needed,
    wants,
    outcomes_achieved,
    outcomes_pending,
    next_action,
    blockers,
    source_watermarks: { action_ledger_seq: lastSeq, generated_at: nowISO(stateDir), head: sha },
    last_operator_action_at: null,
    engagement_health: blockers.length ? 'amber' : 'green',
    projection_alive: true,
    integrity: { derived: true, reads_oracle: false, generator: 'engine/lib/stateview.mjs@v1' },
  };

  const dir = path.join(stateDir, 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'state-view.json'), JSON.stringify(view, null, 2) + '\n');
  return view;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sv = generate(process.argv[2] || '.');
  console.log(JSON.stringify(sv, null, 2));
}
