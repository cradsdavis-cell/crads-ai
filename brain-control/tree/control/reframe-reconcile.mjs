#!/usr/bin/env node
// reframe-reconcile.mjs · T4.2: apply ANSWERED reframe offers (requests engine,
// kind 'reframe', subject = the box slug, payload {framework, intensity}).
// For offers THIS org sent (from === ORG):
//   accepted -> deliver factory/imprint/ via push-down, NAMESPACED to
//     frameworks/<ORG>/ on the box (attribution rides in the imprint dir from
//     T4.1's convention), plus a reframe-record the box appends to its own
//     frozen lineage; log the adoption.
//   declined -> record it in control/reframe-log.json. A decline is history,
//     not an absence: re-anchoring re-offers declined reframes (ruled
//     2026-07-27), which reads this log.
// Idempotent via the applied-ledger; delivery only where we ANCHOR the box
// (push-down is the anchor's transport; cross-community delivery undesigned).
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRow, normalizeRow } from '../registry/normalize-row.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
const ORG = (policy.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim();
if (!ORG) { console.log('reframe-reconcile: dormant (no org handle in org-policy).'); process.exit(0); }

const inbox = JSON.parse(await readFile(path.join(repoRoot, 'control', 'org-requests.json'), 'utf8').catch(() => '{}'));
const answered = (inbox.requests || []).filter((q) =>
  q.kind === 'reframe' && (q.status === 'accepted' || q.status === 'declined') && q.from === ORG);
const ledgerPath = path.join(repoRoot, 'control', 'reframe-applied.json');
const applied = JSON.parse(await readFile(ledgerPath, 'utf8').catch(() => '[]'));
const logPath = path.join(repoRoot, 'control', 'reframe-log.json');
const log = JSON.parse(await readFile(logPath, 'utf8').catch(() => '[]'));

const today = new Date().toISOString().slice(0, 10);
let delivered = 0, recorded = 0;
for (const q of answered) {
  if (applied.includes(q.id)) continue;
  let pay = {};
  try { pay = JSON.parse(q.payload || '{}'); } catch { /* shapeless offer */ }
  const entry = { id: q.id, box: q.subject, to: q.to, framework: pay.framework || '', intensity: pay.intensity || 'overlay', outcome: q.status, date: today };
  if (q.status === 'accepted') {
    const rowPath = path.join(repoRoot, 'registry', 'members', `${q.subject}.yaml`);
    const y = await readFile(rowPath, 'utf8').catch(() => '');
    const n = y ? normalizeRow(extractRow(y), { anchorSlug: ORG }) : null;
    if (!n || n.anchor !== ORG) {
      console.log(`reframe-reconcile: ${q.subject} accepted but we are not its anchor; delivery is the anchor's transport. Logged only.`);
    } else if (!existsSync(path.join(repoRoot, 'factory', 'imprint'))) {
      console.log(`reframe-reconcile: ${q.subject} accepted but factory/imprint/ is empty; nothing to deliver.`);
    } else {
      // The reframe-record travels WITH the framework so the box can append to
      // its own frozen lineage (the org never edits a box's lineage.json).
      const rec = { from: ORG, framework: pay.framework || '', intensity: pay.intensity || 'overlay', date: today, outcome: 'accepted' };
      await writeFile(path.join(repoRoot, 'factory', 'imprint', 'reframe-record.json'), JSON.stringify(rec) + '\n');
      const ok = await new Promise((res) => execFile('node',
        [path.join(repoRoot, 'orchestrator', 'push-down.mjs'), q.subject, path.join(repoRoot, 'factory', 'imprint'), `frameworks/${ORG}`],
        { cwd: repoRoot }, (e) => res(!e)));
      if (!ok) { console.log(`reframe-reconcile: delivery to ${q.subject} failed; will retry next pass.`); continue; }
      delivered++;
    }
  }
  log.push(entry);
  recorded++;
  applied.push(q.id);
}
await writeFile(logPath, JSON.stringify(log.slice(-500), null, 2) + '\n');
await writeFile(ledgerPath, JSON.stringify(applied.slice(-500)) + '\n');
console.log(`reframe-reconcile: ${delivered} delivered, ${recorded} recorded (${answered.length} answered seen).`);
