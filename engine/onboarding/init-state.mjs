#!/usr/bin/env node
// init-state.mjs — scaffold /state/onboarding-state.json from interview-spec.yaml.
// The state file is what makes the deep interview RESUMABLE (decisions D10): every
// /onboard turn reads + writes it, so a client can stop and pick up days later.
// Dependency-free: module ids are extracted by line-scan (the spec is well-structured).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.join(here, 'interview-spec.yaml');
const stateDir = path.resolve(process.argv[2] || process.env.STATE_DIR || '.');

const spec = await readFile(specPath, 'utf8');
const ids = [...spec.matchAll(/^\s*-\s+id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
if (!ids.length) {
  console.error('no modules found in interview-spec.yaml');
  process.exit(1);
}

const state = {
  phase: 'interview',
  current_module: ids[0],
  modules: Object.fromEntries(
    ids.map((id) => [id, { status: 'not-started', raw: [], synthesized: false, reviewed: false }]),
  ),
};
state.modules[ids[0]].status = 'in-progress';

await mkdir(stateDir, { recursive: true });
const out = path.join(stateDir, 'onboarding-state.json');
await writeFile(out, JSON.stringify(state, null, 2) + '\n');
console.log(`initialised ${ids.length} modules -> ${out}`);
console.log(`modules: ${ids.join(', ')}`);
