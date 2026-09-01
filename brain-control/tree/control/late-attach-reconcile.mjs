#!/usr/bin/env node
// late-attach-reconcile.mjs · apply ACCEPTED late-attach requests to the
// registry (live cert, 2026-08-03).
//
// The gap this closes: late-attach had a model, a console send menu, a panel
// verb, a directory route, cycle guards at create AND answer, and an orgedge
// written on acceptance. What it did not have was anyone to write the box's own
// row. So two rocks could agree that a box had joined a second community and
// the registry never recorded it. Downstream, `rel: 'community'` and the
// community branch of access.mjs were unreachable, and cross-org transfer was
// impossible: transfer-row refuses an owner holding no edge, and late-attach is
// the only way to gain one.
//
// Role decides WHO joins WHOM (the same convention console-request validates):
//   role 'applicant' — WE asked THEM: our box (subject) joins their rock (to)
//   role 'inviter'   — WE invited THEM: their box joins OUR rock (from)
// Only the org holding the row writes it; the other side is notified and
// ledgered. Idempotent by request id. The membership write is textual
// (registry/membership.mjs), so nothing else on the row is disturbed.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addMembership, readMemberships } from '../registry/membership.mjs';

const rebuildIndex = async (root) => {
  const b = path.join(root, 'registry', 'build-index.mjs');
  if (!existsSync(b)) return;
  await new Promise((res) => execFile('node', [b], { cwd: root }, () => res())).catch(() => {});
};

/* Which org gains a tie on which box, for one accepted request. Pure; exported
   for tests. Returns null when this request does not concern a row we hold. */
export function decideLateAttach(q = {}, ourOrg = '') {
  const from = String(q.from || ''), to = String(q.to || ''), subject = String(q.subject || '');
  if (!from || !to || !subject) return null;
  const role = q.role === 'inviter' ? 'inviter' : 'applicant';
  // the rock being joined, and the org that holds the joining box's row
  const rock = role === 'inviter' ? from : to;
  const holder = role === 'inviter' ? to : from;
  if (holder !== ourOrg) return null;          // the other side has the row
  if (rock === ourOrg) return null;            // joining ourselves is not a tie
  return { slug: subject, gains: rock };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const policy = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
  const ORG = (policy.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim();
  if (!ORG) { console.log('late-attach-reconcile: dormant (no org handle).'); process.exit(0); }

  const inbox = JSON.parse(await readFile(path.join(repoRoot, 'control', 'org-requests.json'), 'utf8').catch(() => '{}'));
  const accepted = (inbox.requests || []).filter((q) => q.kind === 'late-attach' && q.status === 'accepted');
  const ledgerPath = path.join(repoRoot, 'control', 'late-attach-applied.json');
  const applied = JSON.parse(await readFile(ledgerPath, 'utf8').catch(() => '[]'));
  const notify = async (msg) => {
    const s = path.join(repoRoot, 'control', 'notify.mjs');
    if (!existsSync(s)) return;
    await new Promise((res) => execFile('node', [s, msg], { cwd: repoRoot }, () => res())).catch(() => {});
  };

  let joined = 0, noted = 0;
  for (const q of accepted) {
    if (applied.includes(q.id)) continue;
    const plan = decideLateAttach(q, ORG);
    if (!plan) {
      if (q.from === ORG || q.to === ORG) {
        await notify(`late-attach: ${q.subject} and ${q.from === ORG ? q.to : q.from} agreed a community tie. The row lives with the other rock.`);
        applied.push(q.id); noted += 1;
      }
      continue;
    }
    const p = path.join(repoRoot, 'registry', 'members', `${plan.slug}.yaml`);
    const text = await readFile(p, 'utf8').catch(() => '');
    if (!text) { console.log(`late-attach-reconcile: no local row for '${plan.slug}'; skipping.`); continue; }
    try {
      const before = readMemberships(text);
      await writeFile(p, addMembership(text, plan.gains));
      const after = readMemberships(await readFile(p, 'utf8'));
      await notify(`late-attach: ${plan.slug} now also belongs to ${plan.gains} (community tie; its home rock is unchanged).`);
      console.log(`late-attach-reconcile: ${plan.slug} memberships ${before.join(',')} -> ${after.join(',')}`);
      applied.push(q.id); joined += 1;
    } catch (e) {
      console.log(`late-attach-reconcile: ${plan.slug} refused: ${e.message}`);
    }
  }
  await rebuildIndex(repoRoot);
  await writeFile(ledgerPath, JSON.stringify(applied.slice(-500)) + '\n');
  console.log(`late-attach-reconcile: ${joined} tie(s) recorded, ${noted} noted.`);
}
