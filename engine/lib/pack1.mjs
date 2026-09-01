// pack1.mjs — B1 / Pack 1 "Starter" capability (spec §2.4 B1 + G5 ladder).
// Turns the client's brain into their STARTER PACK: a set of ready-to-use prompts tailored
// to THEIR pains/goals/tools, plus a brief-tune (lead with their #1 priority) and a
// foundation-modules confirmation. Deterministic — reads ONLY the client's own brain, never
// the oracle. Deliverable: brain/packs/pack1-starter.{md,json}. Each prompt traces to a brain
// fact (so it is provably about THEM, not a template — P2/G2 + the ladder "deliverable" check).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const CANON = ['business', 'constraints', 'goals', 'tools', 'voice', 'workflow', 'self', 'north-star', 'philosophy', 'priorities', 'past'];

export function generate(stateDir) {
  const brain = (() => { try { return JSON.parse(readFileSync(path.join(stateDir, 'brain', '.index.json'), 'utf8')); } catch { return null; } })();
  if (!brain) throw new Error('no brain/.index.json — run onboard-ingest first (B1 builds on the brain)');
  const pains = brain.facts.filter((f) => f.type === 'pain');
  const goals = brain.facts.filter((f) => f.type === 'goal');
  const toolFacts = brain.facts.filter((f) => f.type === 'tools');
  const short = (s) => s.replace(/^(so |honestly |the )/i, '').split(/[.,]/)[0].trim().slice(0, 70);

  // starter prompts, each derived from a real brain fact (so each is about THEM)
  const prompts = [];
  // the headline: a draft-reply prompt for their #1 pain (the must-build shape)
  if (pains[0]) prompts.push({ id: 'sp_headline', title: `Draft a reply for: ${short(pains[0].statement)}`, prompt_text: `When something lands about "${short(pains[0].statement)}", pull out the key details and draft me a reply in my voice so I can just glance and send.`, derived_from: pains[0].fact_id });
  // one per remaining pain
  pains.slice(1).forEach((p, i) => prompts.push({ id: `sp_pain_${i + 1}`, title: `Help me with: ${short(p.statement)}`, prompt_text: `Help me get on top of "${short(p.statement)}" — surface what needs doing and propose the next step.`, derived_from: p.fact_id }));
  // a goal-tracking prompt
  if (goals[0]) prompts.push({ id: 'sp_goal', title: `Track my goal: ${short(goals[0].statement)}`, prompt_text: `Each week, tell me if I'm on track for "${short(goals[0].statement)}" and what would move it.`, derived_from: goals[0].fact_id });
  // a tools-aware weekly-plan prompt
  if (toolFacts[0]) prompts.push({ id: 'sp_week', title: `Plan my week`, prompt_text: `Using what you know about how I work and the tools I use, set up my week: top 3, what's at risk, what to ignore.`, derived_from: toolFacts[0].fact_id });

  // foundation modules check (B1 confirms the onboarding foundation is in place)
  const modulesPresent = CANON.filter((m) => existsSync(path.join(stateDir, 'brain', `${m}.md`)));

  const pack = {
    schema: 'pack1-starter/1',
    block: 'b1',
    title: 'Pack 1 — Starter',
    foundation_modules: { expected: 11, present: modulesPresent.length, ok: modulesPresent.length === 11 },
    brief_tune: { lead_with: pains[0]?.fact_id || null, note: 'morning brief leads with the #1 priority' },
    starter_prompts: prompts,
  };

  const dir = path.join(stateDir, 'brain', 'packs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'pack1-starter.json'), JSON.stringify(pack, null, 2) + '\n');
  // human-readable deliverable
  const md = [`# Pack 1 — Starter\n`, `_Your starter prompts — tailored to your brain. Type any of these to the assistant._\n`,
    ...prompts.map((p) => `## ${p.title}\n> ${p.prompt_text}\n\n_(for: ${p.derived_from})_\n`),
    `\n---\nFoundation: ${modulesPresent.length}/11 brain modules in place. Your morning brief leads with your #1 priority.\n`].join('\n');
  writeFileSync(path.join(dir, 'pack1-starter.md'), md);
  return { prompts: prompts.length, foundation_ok: pack.foundation_modules.ok, deliverable: 'brain/packs/pack1-starter.md' };
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(generate(process.argv[2] || '.'), null, 2));
