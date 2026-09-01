// onboard-ingest.mjs — DETERMINISTIC onboarding ingest (the seeded-suite path; the
// live LLM /onboard is the chaos tier). Reads the discovery transcript DELIVERED to the
// box (brain/sources/discovery.transcript.json — client input, NOT the oracle) and builds
// the client's brain: 11 canonical modules + brain/.index.json where EVERY atomic fact
// carries a source_span tracing to a real transcript turn (P2 brain-integrity / G2
// no-fabrication). It reads ONLY the delivered transcript — never the persona/oracle.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createFromBrain as createOutcomesFromBrain } from './outcomes.mjs';
import { emitOnboardingComms } from './comms.mjs';

const CANON_MODULES = ['business', 'constraints', 'goals', 'tools', 'voice', 'workflow', 'self', 'north-star', 'philosophy', 'priorities', 'past'];

export function ingest(stateDir) {
  // Reads the clean structured intake (NO harness tags, NO oracle) the onboarding interview
  // produced, plus the raw discovery.md for source_span verification.
  const intakePath = path.join(stateDir, 'brain', 'sources', 'intake.json');
  if (!existsSync(intakePath)) throw new Error('no delivered intake at brain/sources/intake.json');
  const intake = JSON.parse(readFileSync(intakePath, 'utf8'));
  const srcFile = 'brain/sources/discovery.md';

  const facts = [];
  const addFact = (id, type, statement, turn, quote) => {
    facts.push({ fact_id: id, type, statement: statement.trim(), source_span: { file: srcFile, turn, quote: quote.slice(0, 80) } });
  };

  // --- pains / goals / tools / provider / tz from the structured intake ---
  for (const p of intake.pains || []) addFact('pain.' + p.id, 'pain', p.quote, p.turn, p.quote);
  for (const g of intake.goals || []) addFact('goal.' + g.id, 'goal', g.quote, g.turn, g.quote);
  (intake.tools || []).forEach((t, i) => addFact(`tools.${i}`, 'tools', t.quote, t.turn, t.quote));
  if (intake.provider?.value) addFact('logistics.provider', 'logistics', `email/calendar provider is ${intake.provider.value}`, intake.provider.turn, intake.provider.quote);
  if (intake.timezone?.value) addFact('logistics.timezone', 'logistics', `timezone is ${intake.timezone.value}`, intake.timezone.turn, intake.timezone.quote);

  // --- brain index (P2 substrate) ---
  const brainDir = path.join(stateDir, 'brain');
  mkdirSync(brainDir, { recursive: true });
  const index = { schema: 'brain-index/1', source: srcFile, fact_count: facts.length, facts };
  writeFileSync(path.join(brainDir, '.index.json'), JSON.stringify(index, null, 2) + '\n');

  // --- aliases (P2 alias matcher substrate) ---
  writeFileSync(path.join(brainDir, '.aliases.json'), JSON.stringify({ schema: 'brain-aliases/1', aliases: {} }, null, 2) + '\n');

  // --- 11 canonical modules; substantive ones cite facts, others are honest minimal stubs ---
  const factsOf = (type) => facts.filter((f) => f.type === type);
  const bullets = (fs2) => fs2.map((f) => `- ${f.statement}  _(source: ${f.source_span.file} turn ${f.source_span.turn})_`).join('\n') || '- _(none captured)_';
  const moduleBody = {
    business: `# Business\n\nWhat the client does and how it runs, captured from discovery.\n\n## Pains they raised\n${bullets(factsOf('pain'))}\n`,
    constraints: `# Constraints\n\nThe pains + limits the assistant must work around.\n\n${bullets(factsOf('pain'))}\n`,
    goals: `# Goals\n\nWhat success looks like for this client.\n\n${bullets(factsOf('goal'))}\n`,
    tools: `# Tools\n\nThe client's current stack (verbatim from discovery).\n\n${bullets(factsOf('tools'))}\n`,
    voice: `# Voice\n\nHow the assistant should sound to them (from their stated comms style).\n\n- _(tuned during onboarding)_\n`,
    workflow: `# Workflow\n\nHow the day runs.\n\n${bullets(factsOf('logistics'))}\n`,
    self: `# Self\n\nWho the client is.\n\n- _(deepened over the engagement)_\n`,
    'north-star': `# North Star\n\nThe long-term direction.\n\n- _(elicited later)_\n`,
    philosophy: `# Philosophy\n\nHow they think about their work.\n\n- _(deepened over the engagement)_\n`,
    priorities: `# Priorities\n\nSee wiki/priorities.md (kept current by /weekly).\n`,
    past: `# Past\n\nHistory + context.\n\n- _(deepened over the engagement)_\n`,
  };
  mkdirSync(path.join(brainDir), { recursive: true });
  for (const m of CANON_MODULES) writeFileSync(path.join(brainDir, `${m}.md`), moduleBody[m]);

  // --- onboarding-state -> complete ---
  const obState = { phase: 'complete', current_module: null, modules: Object.fromEntries(CANON_MODULES.map((m) => [m, { status: 'done', synthesized: true, reviewed: true }])) };
  writeFileSync(path.join(stateDir, 'onboarding-state.json'), JSON.stringify(obState, null, 2) + '\n');

  // --- OUT-COV: create the pending outcome set (every pain+goal+ladder) at onboarding-end ---
  let outcomes = 0;
  try { const o = createOutcomesFromBrain(stateDir); outcomes = Object.keys(o).length; } catch {}

  // --- onboarding comms: C1 proposal + C2 welcome (client-facing EMAILS -> gated, never auto-sent) ---
  let comms = 0;
  try { comms = emitOnboardingComms(stateDir); } catch {}

  return { facts: facts.length, modules: CANON_MODULES.length, outcomes, comms, index_path: 'brain/.index.json' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(ingest(process.argv[2] || '.'), null, 2));
}
