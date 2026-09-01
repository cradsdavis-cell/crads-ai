#!/usr/bin/env node
// re-anchor-reconcile.mjs · T2.4: apply ACCEPTED re-anchor requests on the
// registry plane. Reads control/org-requests.json (landed by
// requests-reconcile) and, for each accepted kind='re-anchor':
//   - this org is the ADDRESSEE (the receiving rock): land the row from the
//     request payload via importReAnchoredRow (anchor rewritten to us, old
//     anchor demoted to a community membership, validated pre-write);
//   - this org is the SENDER (the old anchor, relaying its box owner's ask):
//     stamp its own row left + anchor_moved_to (never deleted).
// Each application fires control/notify.mjs once (applied-ledger keyed, so
// re-runs never re-apply or re-ping). Registry commit/push is left to the
// caller's cadence (git-sync); heartbeat-repo swap + box conf re-point are the
// BLOCKED choreography (see the plan) and NOT attempted here.
// SELF-HOST STRIP (2026-09-01): the central directory this script spoke to
// (directory.crads-ai.com) is deleted, along with the account system. It exits
// here — silently, 0 — so a rock that syncs this machinery on boot stops
// phoning a dead service on its reconcile cadence. The body below is kept for
// reference until the commons model replaces this leg. Authored upstream in
// brain-template; keep the two copies identical.
// Unlike the other stubs, this one guards its exit on isMain: the module
// exports reAnchorRowYaml and is deliberately import-safe (imports are
// hoisted, so path/fileURLToPath below are live here). A bare process.exit(0)
// killed every importer, tests included; an EXECUTED run still exits before
// touching anything.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(0);

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importReAnchoredRow, markRowReAnchored } from '../registry/re-anchor.mjs';
import { extractRow } from '../registry/normalize-row.mjs';
import { setScalar } from '../registry/set-field.mjs';

/* Serialize a row back to member-yaml, preserving EVERY field extractRow
   reads (consent grants and delivery_pause included: a re-anchor mark or land
   must not silently strip a member's recorded answers), plus the moved-to
   stamp the mark path adds. Exported for tests. */
export function reAnchorRowYaml(r = {}) {
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
  if (r.anchor_moved_to) lines.push(`anchor_moved_to: ${r.anchor_moved_to}`, `anchor_moved: "${r.anchor_moved}"`);
  return lines.join('\n') + '\n';
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const policy = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
  const ORG = (policy.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim();
  if (!ORG) { console.log('re-anchor-reconcile: dormant (no org handle in org-policy).'); process.exit(0); }

  const FRAMEWORK = (policy.match(/^\s{2}framework:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim() || '';
  const env = Object.fromEntries((await readFile(path.join(repoRoot, '.env'), 'utf8').catch(() => ''))
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  const DIRECTORY_URL = process.env.CRADS_DIRECTORY_URL || env.CRADS_DIRECTORY_URL || 'https://directory.crads-ai.com';
  const PULL_TOKEN = process.env.ORG_PULL_TOKEN || env.ORG_PULL_TOKEN || '';

  // T4.2: re-anchoring RE-OFFERS the (new) anchor's framework, declined-before or
  // not (ruled 2026-07-27: re-homing re-offers declined grafts). Org-owned boxes
  // get the offer through the requests engine (their owner answers); member-owned
  // boxes get a pending marker until member seats hold directory auth (E6 note).
  const reOffer = async (row) => {
    if (!FRAMEWORK) return;
    if (row.owner !== 'member' && row.owner !== ORG && PULL_TOKEN) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        await fetch(`${DIRECTORY_URL}/requests`, {
          method: 'POST', signal: ctrl.signal,
          headers: { authorization: `Bearer ${PULL_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from_org: ORG, to_org: row.owner, kind: 'reframe', subject: row.slug, payload: { framework: FRAMEWORK, intensity: 'overlay' } }),
        });
        clearTimeout(t);
        console.log(`re-anchor-reconcile: re-offered '${FRAMEWORK}' to ${row.owner} for ${row.slug}.`);
      } catch { console.log('re-anchor-reconcile: re-offer could not reach the directory; next pass.'); }
    } else if (row.owner === 'member') {
      const pPath = path.join(repoRoot, 'control', 'reframe-offers-pending.json');
      const pend = JSON.parse(await readFile(pPath, 'utf8').catch(() => '[]'));
      if (!pend.some((x) => x.box === row.slug && x.framework === FRAMEWORK)) {
        pend.push({ box: row.slug, framework: FRAMEWORK, reason: 're-anchor re-offer; member seat answers via the console once member auth lands' });
        await writeFile(pPath, JSON.stringify(pend, null, 2) + '\n');
        console.log(`re-anchor-reconcile: re-offer for ${row.slug} pended (member-owned).`);
      }
    }
  };

  const inbox = JSON.parse(await readFile(path.join(repoRoot, 'control', 'org-requests.json'), 'utf8').catch(() => '{}'));
  const requests = (inbox.requests || []).filter((q) => q.kind === 're-anchor' && q.status === 'accepted');
  const ledgerPath = path.join(repoRoot, 'control', 're-anchor-applied.json');
  const applied = JSON.parse(await readFile(ledgerPath, 'utf8').catch(() => '[]'));

  const notify = async (msg) => {
    const script = path.join(repoRoot, 'control', 'notify.mjs');
    if (!existsSync(script)) return;
    await new Promise((res) => execFile('node', [script, msg], { cwd: repoRoot }, () => res())).catch(() => {});
  };

  let landed = 0, marked = 0;
  for (const q of requests) {
    if (applied.includes(q.id)) continue;
    try {
      if (q.to === ORG) {
        const fields = JSON.parse(q.payload || '{}');
        const row = importReAnchoredRow(fields, { anchorSlug: ORG });
        // Slugs are per-org, not globally unique, so two rocks can each
        // legitimately hold a member called jane01. The land path used to write
        // unconditionally, which meant accepting a re-anchor could silently
        // OVERWRITE our own unrelated member of the same name with a twelve-field
        // row describing someone else's box. Refuse instead: a colliding arrival
        // is a decision for a human, and every panel verb already opens with the
        // same shape ([ -f "$f" ] || refuse).
        const landPath = path.join(repoRoot, 'registry', 'members', `${row.slug}.yaml`);
        if (existsSync(landPath)) {
          console.log(`re-anchor-reconcile: REFUSED to land '${row.slug}' from ${q.from}: `
            + 'a member of that name already exists here. Rename one of them, then re-send. Nothing was written.');
          await notify(`re-anchor from ${q.from} could not land: we already have a member called ${row.slug}. Nothing was changed.`);
          continue;   // deliberately NOT marked applied: it can land once the clash is resolved
        }
        await writeFile(landPath, reAnchorRowYaml(row));
        await notify(`re-anchor: ${row.slug} is now anchored here (from ${q.from}). Heartbeat-channel swap still owes a runbook step.`);
        await reOffer(row);
        landed++;
      } else if (q.from === ORG) {
        const p = path.join(repoRoot, 'registry', 'members', `${q.subject}.yaml`);
        const y = await readFile(p, 'utf8').catch(() => '');
        if (!y) { console.log(`re-anchor-reconcile: no local row for '${q.subject}'; skipping mark.`); continue; }
        // TEXTUAL edit, like transfer-reconcile. This used to regenerate the row
        // from reAnchorRowYaml, whose own comment claims it preserves "EVERY field
        // extractRow reads" - true, and exactly the wrong bar, because extractRow
        // models eleven fields and a live row carries sixty. Marking a member as
        // moved therefore destroyed display_name, email, box.host/hetzner_id/
        // tunnel_id, inbox_repo, the invite record with its device fingerprint,
        // every key_date and the skills list. Same defect class as the 61-line row
        // cut to a 10-line stub on 3 Aug; this call site was missed then, and it
        // runs unattended from the console read and the 15-minute reconcile job.
        //
        // markRowReAnchored changes exactly three fields, so change exactly three.
        const row = markRowReAnchored(extractRow(y), q.to, new Date().toISOString().slice(0, 10));
        let out = y;
        out = setScalar(out, 'status', row.status);
        out = setScalar(out, 'anchor_moved_to', row.anchor_moved_to);
        out = setScalar(out, 'anchor_moved', row.anchor_moved);
        await writeFile(p, out);
        await notify(`re-anchor: ${q.subject} moved its anchor to ${q.to}. Our row is marked, nothing deleted.`);
        marked++;
      } else { continue; }
      applied.push(q.id);
    } catch (e) {
      console.log(`re-anchor-reconcile: ${q.subject || q.id} refused: ${e.message}`);
    }
  }
  await writeFile(ledgerPath, JSON.stringify(applied.slice(-500)) + '\n');
  console.log(`re-anchor-reconcile: ${landed} landed, ${marked} marked (${requests.length} accepted seen).`);
}
