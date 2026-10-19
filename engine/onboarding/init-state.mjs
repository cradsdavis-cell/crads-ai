#!/usr/bin/env node
// init-state.mjs — scaffold /state/onboarding-state.json for /onboard.
// The state file is what makes the deep interview RESUMABLE (decisions D10): every
// /onboard turn reads + writes it, so a client can stop and pick up days later.
//
// Seeds the 8 layers (layers.mjs), the shape onboard.md reads and writes. Until
// 2026-09-18 this line-scanned interview-spec.yaml and wrote the pre-rewrite 11
// modules, so every fresh brain reported "0 of 11 steps" beside "The 8 layers".
// interview-spec.yaml stays as the coverage reference the docs pin; it no
// longer decides the seed.
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { LAYERS, initialLayersState, doneLayersState } from './layers.mjs';

const stateDir = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || process.env.STATE_DIR || '.');
// onboard.md: a rock brain is detected by org-policy.yaml in the brain root.
const scope = existsSync(path.join(stateDir, 'org-policy.yaml')) ? 'org' : 'person';
// --done: an ADOPTED brain (spec 2026-10-17) arrives already set up, so its
// onboarding state is written finished (every layer too, not just the phase:
// layers.mjs doneLayersState) and the app never routes a working brain back
// into the first-run interview. box-up.sh passes it only when adopted.
const state = process.argv.includes('--done') ? doneLayersState({ scope }) : initialLayersState({ scope });

await mkdir(stateDir, { recursive: true });
const out = path.join(stateDir, 'onboarding-state.json');
await writeFile(out, JSON.stringify(state, null, 2) + '\n');
console.log(`initialised ${LAYERS.length} layers (${scope} scope) -> ${out}`);
console.log(`layers: ${LAYERS.join(', ')}`);
