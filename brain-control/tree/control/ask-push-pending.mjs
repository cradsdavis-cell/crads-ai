#!/usr/bin/env node
// ask-push-pending.mjs · slice 2 (2026-08-03): drain reframe-offers-pending.json
// (offers to member-owned boxes that re-anchor-reconcile pended "until member
// seats hold directory auth") into the member lane that now exists: each entry
// becomes a push-ask reframe onto the box's inbox. Entries leave the pending
// file only when their push succeeds, so a failed push retries next pass.
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pPath = path.join(repoRoot, 'control', 'reframe-offers-pending.json');
const pend = JSON.parse(await readFile(pPath, 'utf8').catch(() => '[]'));
if (!pend.length) { console.log('ask-push-pending: nothing pending.'); process.exit(0); }

const still = [];
let pushed = 0;
for (const p of pend) {
  const ok = await new Promise((res) => execFile('node',
    [path.join(repoRoot, 'orchestrator', 'push-ask.mjs'), String(p.box || ''), 'reframe', '--framework', String(p.framework || '')],
    { cwd: repoRoot }, (e) => res(!e)));
  if (ok) pushed++; else still.push(p);
}
await writeFile(pPath, JSON.stringify(still, null, 2) + '\n');
console.log(`ask-push-pending: ${pushed} pushed to member inboxes, ${still.length} still pending.`);
