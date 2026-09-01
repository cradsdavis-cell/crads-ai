#!/usr/bin/env node
// box-status.mjs · T2.7: guarded lifecycle status moves on a registry row.
//   node orchestrator/box-status.mjs <slug> pause|resume|dark
// pause  : active -> paused   (delivery + heartbeat-pull stop via the status
//                              gates; seat + row persist; reversible)
// resume : paused -> active
// dark   : active|paused -> left  ("go dark": the box goes quiet; row is
//                              marked, never deleted; rejoin is two-consent
//                              via the requests engine + rejoin-reconcile)
// Guarded transitions only: anything else is refused loudly so choreography
// bugs surface. Registry commit/push rides the caller's cadence.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [slug, move] = process.argv.slice(2);
const MOVES = { pause: { from: ['active'], to: 'paused' }, resume: { from: ['paused'], to: 'active' }, dark: { from: ['active', 'paused'], to: 'left' } };
if (!slug || !MOVES[move]) { console.error('usage: box-status.mjs <slug> pause|resume|dark'); process.exit(2); }

const p = path.join(repoRoot, 'registry', 'members', `${slug}.yaml`);
const y = await readFile(p, 'utf8').catch(() => { console.error(`REFUSED: no registry row for ${slug}`); process.exit(1); });
const cur = (y.match(/^status:\s*"?(\w+)"?/m) || [, ''])[1];
const { from, to } = MOVES[move];
if (!from.includes(cur)) { console.error(`REFUSED: ${slug} is '${cur}'; ${move} moves ${from.join('|')} -> ${to} only.`); process.exit(1); }
await writeFile(p, y.replace(/^status:.*$/m, `status: "${to}"`));
console.log(`box-status: ${slug} ${cur} -> ${to}.`);
