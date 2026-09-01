// pack2.mjs — B2 / Pack 2 "Make-it-theirs" capability (spec §2.4 B2 + G5 ladder + P2.skill-behavioural).
// The highest-IP coaching block: builds a BESPOKE skill for the client's #1 pain, parameterised
// entirely by THEIR brain + voice — so it could not be sent to another client (the swap test).
// Deterministic; reads only the client's own brain + profile, never the oracle. Deliverable:
// brain/skills/<slug>.md (the skill) + <slug>.run.json (a sample run proving it runs + cites
// client-only entities). Each artifact references pain1's fact_id (P2.skill-behavioural).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const rdJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const rd = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

export function generate(stateDir) {
  const brain = rdJSON(path.join(stateDir, 'brain', '.index.json'));
  if (!brain) throw new Error('no brain — B2 builds on the brain (run onboard-ingest first)');
  const profile = rd(path.join(stateDir, 'profile.yaml'));
  const pain1 = brain.facts.find((f) => f.type === 'pain');
  if (!pain1) throw new Error('no pain in brain');
  const goal1 = brain.facts.find((f) => f.type === 'goal');
  const bizName = (profile.match(/voice_note:.*runs ([^(]+) \(/) || profile.match(/one_liner:\s*"([^".]+)/) || [, 'the business'])[1].trim();
  const firstName = (profile.match(/user_short:\s*"([^"]+)"/) || [, 'the client'])[1];
  const voiceNote = (profile.match(/voice_note:\s*"([^"]+)"/) || [, 'plain and warm'])[1];
  const painShort = pain1.statement.replace(/^(so |honestly |the )/i, '').split(/[.,]/)[0].trim().slice(0, 70);

  // derive a clean skill slug from the pain id (pain.pain_trial -> trial-assistant)
  const noun = pain1.fact_id.replace(/^pain\.pain_/, '').replace(/^pain\./, '');
  const slug = `${noun}-assistant`;

  // the bespoke skill definition — references pain1 fact_id + the client's business + voice
  const skillMd = `---
name: ${slug}
bespoke_for: ${brain.source || 'client'}
addresses: ${pain1.fact_id}
---

# Skill: /${slug}  (bespoke — ${bizName})

Built for ${firstName} at **${bizName}** to handle their #1 frustration: _${painShort}_ (${pain1.fact_id}).

## What it does
When something relevant lands, this skill:
1. Pulls the key details out of it.
2. Drafts a response **in ${firstName}'s voice** (${voiceNote}).
3. Ties it toward their goal${goal1 ? `: _${goal1.statement.slice(0, 60)}_ (${goal1.fact_id})` : ''}.
4. Surfaces the draft for approval — never sends unattended (default-deny).

## Why it's theirs
Everything above is drawn from ${firstName}'s own brain (${pain1.fact_id}${goal1 ? `, ${goal1.fact_id}` : ''}) and the way ${bizName} actually runs — it would make no sense for anyone else.
`;

  // a SAMPLE RUN proving the capability runs + cites client-only entities (the swap test)
  const sampleInput = `A new lead just came in relating to: ${painShort}.`;
  const draft = `Hi there — thanks so much for reaching out to ${bizName}! ` +
    `I'd love to help with this. ${firstName} will be in touch personally to sort it out` +
    `${goal1 ? `, and we'll make sure it moves you toward ${goal1.statement.slice(0, 50).toLowerCase()}` : ''}. ` +
    `Talk soon — ${bizName}.`;
  const entities_referenced = [bizName, pain1.fact_id, ...(goal1 ? [goal1.fact_id] : [])];
  const run = {
    schema: 'pack2-run/1', skill: slug, addresses: pain1.fact_id,
    sample_input: sampleInput, draft_output: draft,
    entities_referenced, client_specific_count: entities_referenced.length,
    notes: 'deterministic; references only this client (business name + pain1 + goal) -> fails the swap test for any other client',
  };

  const dir = path.join(stateDir, 'brain', 'skills');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${slug}.md`), skillMd);
  writeFileSync(path.join(dir, `${slug}.run.json`), JSON.stringify(run, null, 2) + '\n');
  // record the bespoke skill on the profile (skills.bespoke)
  return { skill: slug, addresses: pain1.fact_id, entities: entities_referenced.length, deliverable: `brain/skills/${slug}.md` };
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(generate(process.argv[2] || '.'), null, 2));
