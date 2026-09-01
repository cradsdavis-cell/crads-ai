#!/usr/bin/env node
// permission-reconcile.mjs · T2.5: apply ANSWERED permission asks to registry
// rows. The choreography (ruled 2026-07-28): a rock rock ASKS (requests
// engine, kind ask-install | ask-read, subject = the box slug), the box OWNER
// answers from their seat, and the answer lands here as the row's grant field
// (infra_push_consent / read_consent) via applyPermissionGrant. Declines land
// 'false' explicitly (a decline is a recorded no, not an absence). The owner's
// UNILATERAL flips remain theirs: this reconcile only ever writes rows for
// requests THIS org sent and only once per request id (applied-ledger).
// Registry commit/push rides the caller's cadence (git-sync).
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPermissionGrant } from '../registry/consent.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
const ORG = (policy.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim();
if (!ORG) { console.log('permission-reconcile: dormant (no org handle in org-policy).'); process.exit(0); }

const inbox = JSON.parse(await readFile(path.join(repoRoot, 'control', 'org-requests.json'), 'utf8').catch(() => '{}'));
const answered = (inbox.requests || []).filter((q) =>
  (q.kind === 'ask-install' || q.kind === 'ask-read')
  && (q.status === 'accepted' || q.status === 'declined')
  && q.from === ORG);
const ledgerPath = path.join(repoRoot, 'control', 'permission-applied.json');
const applied = JSON.parse(await readFile(ledgerPath, 'utf8').catch(() => '[]'));

const setField = (yaml, key, val) => {
  const line = `${key}: "${val}"`;
  if (new RegExp(`^${key}:`, 'm').test(yaml)) return yaml.replace(new RegExp(`^${key}:.*$`, 'm'), line);
  return yaml.replace(/\n*$/, '\n') + line + '\n';
};
const notify = async (msg) => {
  const script = path.join(repoRoot, 'control', 'notify.mjs');
  if (!existsSync(script)) return;
  await new Promise((res) => execFile('node', [script, msg], { cwd: repoRoot }, () => res())).catch(() => {});
};

let done = 0;
for (const q of answered) {
  // Key on the ANSWER, not the request id. The directory derives a request id
  // from sha256(kind|from|to|subject) and a re-POST reopens that same record, so
  // the id is REUSED across re-sends. Withdrawing a consent goes exactly that
  // way: /requests-answer refuses to re-answer a settled request, so the only
  // route is for the asker to send again, which reuses the id, which this ledger
  // had already recorded. The second, CONTRADICTING answer was therefore
  // swallowed and the row kept the first one: an org that accepted and later
  // declined stayed recorded as having granted. Same shape as the date-keyed
  // ask ledger fixed earlier today; `answered_at` is what distinguishes them.
  const key = `${q.id}|${q.answered_at || ''}|${q.status}`;
  if (applied.includes(key)) continue;
  // Back-compat, deliberately NARROW: entries recorded under the old bare-id
  // scheme stay settled ONLY when this answer carries no answered_at, i.e. when
  // there is genuinely nothing to tell them apart. Falling back on the bare id
  // unconditionally would re-create the defect for every record already on the
  // ledger. When answered_at IS present the composite key decides, so a real
  // second answer lands; re-applying an unchanged one just rewrites the same
  // grant value, which is idempotent.
  if (!q.answered_at && applied.includes(q.id)) continue;
  const p = path.join(repoRoot, 'registry', 'members', `${q.subject}.yaml`);
  const y = await readFile(p, 'utf8').catch(() => '');
  if (!y) { console.log(`permission-reconcile: no row for '${q.subject}'; skipping.`); continue; }
  // applyPermissionGrant is the single source of field semantics; mirror its
  // output onto the YAML so the pure layer and the file never disagree.
  const grant = applyPermissionGrant({}, q.kind, q.status);
  let out = y;
  for (const [k, v] of Object.entries(grant)) out = setField(out, k, v);
  await writeFile(p, out);
  await notify(`permission: ${q.kind} for ${q.subject} was ${q.status} by ${q.to}; the row now records it.`);
  applied.push(key);
  done++;
}
await writeFile(ledgerPath, JSON.stringify(applied.slice(-500)) + '\n');
console.log(`permission-reconcile: ${done} grant(s) applied (${answered.length} answered seen).`);
