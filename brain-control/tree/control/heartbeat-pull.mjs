#!/usr/bin/env node
// heartbeat-pull.mjs — the rock pulls each ACTIVE member's heartbeat-<slug>
// repo into heartbeats/<slug>.json (D49). The rock READS repos it owns; it
// never touches a member box. Membership-gated: a non-active member is skipped
// (the off-switch — nothing deleted, the tap just closes). The stall board reads
// heartbeats/<slug>.json. Run on a rock cron (every ~30 min is plenty).
//
// Auth: ORG_GH_OWNER + ORG_GH_TOKEN (repo .env), same as push-down.
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRow, extractRow } from '../registry/normalize-row.mjs';
import { resolveOrgGitHub, refusal, plainRemote, runGit } from '../factory/org-github.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { owner: OWNER, token: TOKEN } = resolveOrgGitHub({ brainRoot: repoRoot });
if (!OWNER || !TOKEN) { console.error(refusal({ what: 'read the heartbeats of its member boxes' })); process.exit(2); }

const membersDir = path.join(repoRoot, 'registry', 'members');
const outDir = path.join(repoRoot, 'heartbeats');
await mkdir(outDir, { recursive: true });

// T1.4 (metadata split): heartbeats belong to the ANCHOR. This org's slug comes
// from org-policy; a row anchored to another org is not ours to pull, however
// it got here — its heartbeat repo lives under its anchor's GitHub.
let anchorSlug = '';
try {
  const pol = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8');
  const m = pol.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m);
  anchorSlug = m ? m[1].trim() : '';
} catch { /* no policy: anchoredHere stays permissive below */ }

let pulled = 0, skipped = 0, foreign = 0;
for (const f of (await readdir(membersDir).catch(() => []))) {
  if (!f.endsWith('.yaml') || f.startsWith('_')) continue;
  const slug = f.replace(/\.yaml$/, '');
  const row = await readFile(path.join(membersDir, f), 'utf8');
  const n = normalizeRow(extractRow(row), { anchorSlug });
  if (n.status !== 'active') { skipped++; continue; }   // membership gate
  if (anchorSlug && n.anchor !== anchorSlug) {          // anchor gate (T1.4)
    foreign++;
    console.log(`heartbeat-pull: ${slug} is anchored to '${n.anchor}': its heartbeat is not ours to hold; skipping.`);
    continue;
  }

  const clone = path.join(repoRoot, 'state', 'heartbeats-in', slug);
  const remote = plainRemote(OWNER, `heartbeat-${slug}`);
  try {
    let has = false; try { await stat(path.join(clone, '.git')); has = true; } catch {}
    if (!has) { await mkdir(path.dirname(clone), { recursive: true }); runGit(['clone', '--depth', '1', remote, clone], { token: TOKEN }); }
    else { runGit(['-C', clone, 'pull', '--ff-only', 'origin', 'main'], { token: TOKEN }); }
    const hb = await readFile(path.join(clone, 'heartbeat.json'), 'utf8');
    JSON.parse(hb);   // validate; a corrupt heartbeat never lands
    await writeFile(path.join(outDir, `${slug}.json`), hb);
    pulled++;
  } catch (e) {
    // No heartbeat repo yet, or the box has never pushed — not an error, just no data.
    skipped++;
  }
}
console.log(`heartbeat-pull: ${pulled} pulled, ${skipped} skipped (inactive or no data yet)${foreign ? `, ${foreign} anchored elsewhere` : ''}.`);
