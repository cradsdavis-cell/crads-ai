#!/usr/bin/env node
// transfer-reconcile.mjs · E6.3 residual (wired 2026-08-03): apply ACCEPTED
// org-to-org ownership transfers (requests engine, kind 'transfer', subject =
// the box slug). Until this existed, transfer-row.mjs was an executor wired to
// nothing: consent transported fine and then nobody moved the pointer.
//
// Direction is symmetric on purpose. Both consent chains are legitimate:
//   - the OWNER offers ("take this box"), the other org accepts;
//   - the non-owner asks ("give us this box"), the OWNER accepts.
// Either way both parties have said yes by the time a request reads
// 'accepted', so the pointer flips to whichever party does NOT currently own
// the box. A request whose parties do not include the current owner is
// refused: consent from bystanders moves nothing.
//
// Only the org holding the registry row (the box's anchor) applies the flip;
// a party org without the row is notified and ledgered, nothing more. The
// guards (edge required pre-flip, no-op refused, D60 managed_by) live in
// registry/transfer-row.mjs and are not re-implemented here.
// Applied-ledger keyed like every sibling: re-runs never re-apply or re-ping.
// Registry commit/push rides the caller's cadence (git-sync).
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transferRowOwner } from '../registry/transfer-row.mjs';
import { extractRow } from '../registry/normalize-row.mjs';
import { setScalar } from '../registry/set-field.mjs';

// A row write is not visible until the INDEX is rebuilt: the panel's Fleet
// health reads registry/index.json, not the yaml files. Every panel verb that
// touches a row runs build-index; these appliers did not, so a member who had
// LEFT still showed as ACTIVE on Fleet health, with Pause/Transfer/Leave
// offered against a box whose door key was already detached (seen live
// 2026-08-03). Fail-soft: a missing builder must never strand an applied row.
const rebuildIndex = async (root) => {
  const b = path.join(root, 'registry', 'build-index.mjs');
  if (!existsSync(b)) return;
  await new Promise((res) => execFile('node', [b], { cwd: root }, () => res())).catch(() => {});
};

/* Decide the flip for one accepted request against the row we hold.
   Returns the flipped, validated row; throws with the refusal reason.
   Pure: guards + direction only, no fs. Exported for tests. */
export function decideTransferApply(row = {}, q = {}, opts = {}) {
  const from = String(q.from || ''), to = String(q.to || '');
  if (!from || !to) throw new Error('a transfer request names both orgs');
  const current = String(row.owner || 'member');
  if (current !== from && current !== to) {
    throw new Error(`the current owner '${current}' is not a party to this request (${from} -> ${to}); consent from bystanders moves nothing`);
  }
  const newOwner = current === from ? to : from;
  return transferRowOwner(row, newOwner, opts);
}

/* Serialize a normalized row back to member-yaml, preserving EVERY field
   extractRow reads (consent grants and delivery_pause included: a transfer
   must not silently strip a member's recorded answers). Exported for tests. */
export function transferRowYaml(r = {}) {
  const lines = [
    `slug: "${r.slug}"`, `status: "${r.status}"`, `owner: "${r.owner}"`,
    `managed_by: "${r.managed_by}"`, `anchor: ${r.anchor}`, 'memberships:',
    ...(r.memberships || []).map((m) => `  - ${m}`),
    `tier: "${r.tier}"`,
  ];
  if (r.legacy_level) lines.push(`legacy_level: "${r.legacy_level}"`);
  if (r.infra_push_consent) lines.push(`infra_push_consent: "${r.infra_push_consent}"`);
  if (r.read_consent) lines.push(`read_consent: "${r.read_consent}"`);
  if (r.delivery_pause) lines.push(`delivery_pause: "${r.delivery_pause}"`);
  return lines.join('\n') + '\n';
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const policy = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
  const ORG = (policy.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim();
  if (!ORG) { console.log('transfer-reconcile: dormant (no org handle in org-policy).'); process.exit(0); }

  const inbox = JSON.parse(await readFile(path.join(repoRoot, 'control', 'org-requests.json'), 'utf8').catch(() => '{}'));
  const requests = (inbox.requests || []).filter((q) => q.kind === 'transfer' && q.status === 'accepted');
  const ledgerPath = path.join(repoRoot, 'control', 'transfer-applied.json');
  const applied = JSON.parse(await readFile(ledgerPath, 'utf8').catch(() => '[]'));

  const notify = async (msg) => {
    const script = path.join(repoRoot, 'control', 'notify.mjs');
    if (!existsSync(script)) return;
    await new Promise((res) => execFile('node', [script, msg], { cwd: repoRoot }, () => res())).catch(() => {});
  };

  let flipped = 0, noted = 0;
  for (const q of requests) {
    if (applied.includes(q.id)) continue;
    if (q.from !== ORG && q.to !== ORG) continue;   // not our request at all
    try {
      const p = path.join(repoRoot, 'registry', 'members', `${q.subject}.yaml`);
      const y = await readFile(p, 'utf8').catch(() => '');
      if (y) {
        const row = decideTransferApply(extractRow(y), q, { anchorSlug: ORG });
        // the guards ran on the normalized view; the WRITE touches one line of
        // the real row, so nothing outside normalizeRow's model is lost
        await writeFile(p, setScalar(y, 'owner', row.owner));
        await notify(`transfer: ${q.subject} is now owned by ${row.owner} (${q.from} -> ${q.to}, both consented). The row stays anchored here.`);
        flipped++;
      } else {
        // a party without the row: the anchor's reconcile moves the pointer
        await notify(`transfer: ownership of ${q.subject} moved between ${q.from} and ${q.to} (accepted). The registry row lives with its anchor.`);
        noted++;
      }
      applied.push(q.id);
    } catch (e) {
      console.log(`transfer-reconcile: ${q.subject || q.id} refused: ${e.message}`);
    }
  }
  await rebuildIndex(repoRoot);
  await writeFile(ledgerPath, JSON.stringify(applied.slice(-500)) + '\n');
  console.log(`transfer-reconcile: ${flipped} flipped, ${noted} noted (${requests.length} accepted seen).`);
}
