#!/usr/bin/env node
// rejoin-reconcile.mjs · T2.7: apply ACCEPTED rejoin requests (two-consent:
// either side asked, the other answered in the requests engine). This org's
// row for the subject box, currently 'left', flips back to 'active'; anchor
// and everything else stay as marked. Idempotent (applied-ledger), notified.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
const ORG = (policy.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim();
if (!ORG) { console.log('rejoin-reconcile: dormant (no org handle in org-policy).'); process.exit(0); }

const inbox = JSON.parse(await readFile(path.join(repoRoot, 'control', 'org-requests.json'), 'utf8').catch(() => '{}'));
const accepted = (inbox.requests || []).filter((q) => q.kind === 'rejoin' && q.status === 'accepted' && (q.from === ORG || q.to === ORG));
const ledgerPath = path.join(repoRoot, 'control', 'rejoin-applied.json');
const applied = JSON.parse(await readFile(ledgerPath, 'utf8').catch(() => '[]'));
const notify = async (msg) => {
  const script = path.join(repoRoot, 'control', 'notify.mjs');
  if (!existsSync(script)) return;
  await new Promise((res) => execFile('node', [script, msg], { cwd: repoRoot }, () => res())).catch(() => {});
};

let done = 0;
for (const q of accepted) {
  if (applied.includes(q.id)) continue;
  const p = path.join(repoRoot, 'registry', 'members', `${q.subject}.yaml`);
  const y = await readFile(p, 'utf8').catch(() => '');
  if (!y) { console.log(`rejoin-reconcile: no row for '${q.subject}'; skipping.`); continue; }
  const cur = (y.match(/^status:\s*"?(\w+)"?/m) || [, ''])[1];
  if (cur !== 'left') { console.log(`rejoin-reconcile: ${q.subject} is '${cur}', not left; skipping (already back?).`); applied.push(q.id); continue; }
  await writeFile(p, y.replace(/^status:.*$/m, 'status: "active"'));
  // RE-PUSH THE DOOR KEY. leave-reconcile delivers the EMPTY key set on the way
  // out, and org-sync derives the box's door from that file, so flipping the row
  // back to active reopened nothing: the member read as active on Fleet health,
  // was told "delivery + heartbeats resume", and stayed locked out of their own
  // box forever, because no other schedule re-pushes it. Every sibling status
  // transition that touches the door already does this (leave-reconcile, and the
  // member-set-status / member-revoke / member-leave / approve-device verbs).
  // Fail-soft in the same shape as leave-reconcile: a rejoin that cannot reach
  // GitHub must not wedge the queue, but it must not claim the door is open.
  let doorOk = true;
  await new Promise((res) => execFile('node', [path.join(repoRoot, 'orchestrator', 'push-member-key.mjs'), q.subject],
    { cwd: repoRoot }, (err) => { doorOk = !err; res(); })).catch(() => { doorOk = false; });
  await notify(doorOk
    ? `rejoin: ${q.subject} is back (two-consent complete). Their door key is re-pushed; delivery + heartbeats resume on the next cadence.`
    : `rejoin: ${q.subject} is back on the registry, but the door key could NOT be re-pushed (the org GitHub credentials were unreachable). They cannot open their box until this is re-run.`);
  applied.push(q.id);
  done++;
}
await writeFile(ledgerPath, JSON.stringify(applied.slice(-500)) + '\n');
console.log(`rejoin-reconcile: ${done} rejoin(s) applied (${accepted.length} accepted seen).`);
