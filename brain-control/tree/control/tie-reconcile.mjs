#!/usr/bin/env node
// tie-reconcile.mjs — give every JOINED tie the same channel a seated member has.
// Spec: ai-os docs/superpowers/specs/2026-08-17-one-inbox.md § 3.
//
// Until one-inbox, a join was a directory edge and nothing else, so a joined
// member's box had no credential to this rock and their content had to travel a
// second transport (directory KV, fetched by the app behind a tie gate). Sam's
// ruling, 17 Aug: every tie is wired identically. This is the applier that makes
// that true for the joined half.
//
// RECONCILED FROM TRUTH, NOT FROM THE ACCEPT. The anchored path adopts inside
// the operator's click (rock-answer -> anchor-adopt), because an anchor has a
// metal-ceiling precheck and a billing consequence that must be synchronous with
// the decision. A join has neither, so this reads /rock-ties every round and
// provisions whatever is missing. Two things fall out of that and both matter:
// ties accepted BEFORE this shipped are picked up with no migration step, and a
// half-finished provision self-heals instead of needing the operator to
// re-answer an ask that is already gone.
//
// What this does NOT do:
//   - create the channel repos. anchor-reconcile.ensureChannelRepos already
//     creates missing repos when it registers the posted keys (it had to, for
//     adopted anchors, which never went through the factory either). Doing it
//     here as well would be a second copy of the same gh logic for no gain, and
//     would make this applier need a GitHub credential it otherwise does not.
//   - write a registry SEAT. A tie is not a seat. 32 files read
//     registry/members/ and most of them mean "somebody this rock hosts and
//     bills": eviction, transfer, backup, heartbeat-pull, the stall board. A
//     joined stranger appearing in those is a correctness and trust failure, so
//     ties live in their own directory and only the content path reads them.
//
// Idempotent, fail-soft, exit 0 always: it runs unattended on the reconcile
// cadence and one bad round must never stop the appliers after it.
// SELF-HOST STRIP (2026-09-01): the central directory this script spoke to
// (directory.crads-ai.com) is deleted, along with the account system. It exits
// here — silently, 0 — so a rock that syncs this machinery on boot stops
// phoning a dead service on its reconcile cadence. The body below is kept for
// reference until the commons model replaces this leg. Authored upstream in
// brain-template; keep the two copies identical.
process.exit(0);

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOrgGitHub } from '../factory/org-github.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = async (p) => readFile(path.join(repoRoot, p), 'utf8').catch(() => '');

const env = Object.fromEntries((await rd('.env'))
  .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

const DIR = process.env.CRADS_DIRECTORY_URL || env.CRADS_DIRECTORY_URL || 'https://directory.crads-ai.com';
const PULL = process.env.ORG_PULL_TOKEN || env.ORG_PULL_TOKEN;
const policy = await rd('org-policy.yaml');
const ORG = ((policy.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m) || [])[1] || '').trim();

if (!PULL || !ORG) {
  console.log('tie-reconcile: dormant (needs ORG_PULL_TOKEN + org handle).');
  process.exit(0);
}

// The bundle names the two repos, so this needs the org's GitHub owner and
// nothing else. No token is used here: staging a bundle is a directory call.
const ghId = resolveOrgGitHub({ brainRoot: repoRoot });
if (!ghId.ok || !ghId.owner) {
  console.log('tie-reconcile: no org GitHub identity resolves yet (run connect-github); waiting.');
  process.exit(0);
}
const GH_OWNER = ghId.owner;

const auth = { authorization: `Bearer ${PULL}`, 'content-type': 'application/json' };
const tiesDir = path.join(repoRoot, 'registry', 'ties');

const timed = async (url, init = {}, ms = 8000) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); } finally { clearTimeout(t); }
};

let ties = [];
try {
  const r = await timed(`${DIR}/rock-ties?org=${encodeURIComponent(ORG)}`, { headers: auth });
  const b = await r.json().catch(() => ({}));
  if (r.ok && Array.isArray(b.ties)) ties = b.ties;
  else { console.log(`tie-reconcile: the directory said ${r.status}; retrying next round.`); process.exit(0); }
} catch (e) {
  console.log(`tie-reconcile: directory unreachable (${String(e.message || e).slice(0, 60)}); retrying next round.`);
  process.exit(0);
}

// ANCHORED TIES ARE NOT THIS APPLIER'S. They are adopted at accept time and get
// a registry seat; touching them here would race anchor-adopt and could stage a
// bundle against a slug the seat is still renaming for a collision.
const joined = ties.filter((t) => t && t.tie === 'joined' && t.status !== 'left'
  && /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(String(t.slug || ''))
  && /^[0-9a-f]{64}$/.test(String(t.e || '')));

if (!joined.length) { console.log('tie-reconcile: no joined ties to provision.'); process.exit(0); }

await mkdir(tiesDir, { recursive: true });
const existing = new Set((await readdir(tiesDir).catch(() => [])).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')));

// A SEAT WINS. If this slug already holds a registry row, the person is hosted
// here and the anchored path owns their channel; a tie record beside it would
// have two appliers staging bundles for one mineral. Reads the directory of
// seats rather than a normalised row because all this needs is existence.
const seats = new Set((await readdir(path.join(repoRoot, 'registry', 'members')).catch(() => []))
  .filter((f) => f.endsWith('.yaml') && !f.startsWith('_')).map((f) => f.replace(/\.yaml$/, '')));

const today = new Date().toISOString().slice(0, 10);
const HOUR = 60 * 60 * 1000;
let created = 0, staged = 0, wired = 0, skipped = 0;

for (const t of joined) {
  const slug = String(t.slug);
  if (seats.has(slug)) { skipped++; continue; }

  const recFile = path.join(tiesDir, `${slug}.json`);
  let rec = null;
  if (existing.has(slug)) { try { rec = JSON.parse(await readFile(recFile, 'utf8')); } catch { rec = null; } }
  if (!rec) {
    rec = { slug, e: String(t.e), tie: 'joined', attached: today, wired: '',
      inbox_repo: `${GH_OWNER}/inbox-${slug}`, heartbeat_repo: `${GH_OWNER}/heartbeat-${slug}`, staged: 0 };
    created++;
  }

  // Wired means the member's box minted its keys and anchor-reconcile
  // registered them. Nothing left to stage.
  if (rec.wired) { wired++; await writeFile(recFile, JSON.stringify(rec, null, 2) + '\n'); continue; }

  // Re-stage only after an hour, the same grace anchor-reconcile uses for a
  // claim that never landed. The bundle carries a live pull token and is
  // one-time at the worker, so re-staging every few minutes would churn a
  // credential for a member who simply has not opened their app yet.
  if (rec.staged && Date.now() - rec.staged < HOUR) { await writeFile(recFile, JSON.stringify(rec, null, 2) + '\n'); continue; }

  const bundle = { inbox_repo: rec.inbox_repo, heartbeat_repo: rec.heartbeat_repo,
    pull_token: PULL, org_contact: { org: ORG, gh_owner: GH_OWNER } };
  try {
    const r = await timed(`${DIR}/anchor-wire`, { method: 'POST', headers: auth,
      body: JSON.stringify({ org: ORG, e: rec.e, slug, bundle }) });
    if (r.ok) { rec.staged = Date.now(); staged++; }
    else console.log(`tie-reconcile: ${slug}: the directory refused the wire (${r.status}); next round.`);
  } catch { /* next round */ }

  await writeFile(recFile, JSON.stringify(rec, null, 2) + '\n');
}

console.log(`tie-reconcile: ${joined.length} joined tie(s); ${created} new, ${staged} staged, ${wired} already wired, ${skipped} held by a seat.`);
