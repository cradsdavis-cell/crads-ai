#!/usr/bin/env node
// build-index.mjs · derive registry/index.json + index.md from members/*.yaml.
// Metadata only. Never reads any pebble box.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRow, extractRow, validateRow } from './normalize-row.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const membersDir = path.join(here, 'members');

// the org this registry belongs to = the anchor default for every row here
let anchorSlug = '';
try {
  const pol = await readFile(path.join(here, '..', 'org-policy.yaml'), 'utf8');
  const m = pol.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m);
  anchorSlug = m ? m[1].trim() : '';
} catch {}

// Tiny flat-YAML reader for the fields we index (no YAML dependency).
function scalar(y, key) {
  const m = y.match(new RegExp(`^${key}:\\s*"?([^"\\n#]*)"?`, 'm'));
  return m ? m[1].trim() : '';
}
function nested(y, rock, key) {
  const block = (y.split(new RegExp(`^${rock}:\\s*$`, 'm'))[1] || '').split(/^\S/m)[0];
  const m = block.match(new RegExp(`^\\s+${key}:\\s*"?([^"\\n#]*)"?`, 'm'));
  return m ? m[1].trim() : '';
}
function countList(y, key) {
  // count '- ' items under a top-level list key (packs_installed)
  const block = (y.split(new RegExp(`^${key}:\\s*$`, 'm'))[1] || '').split(/^\S/m)[0];
  return (block.match(/^\s*-\s/gm) || []).length;
}

const rows = [];
let files = [];
try { files = (await readdir(membersDir)).filter((f) => f.endsWith('.yaml') && !f.startsWith('_')); }
catch { files = []; }
for (const f of files) {
  const y = await readFile(path.join(membersDir, f), 'utf8');
  // migration-on-read (T1.1): owner pointer, anchor-implies-membership,
  // tier=rock|pebble with old level slugs shifted to legacy_level
  const n = normalizeRow(extractRow(y), { anchorSlug });
  const problems = validateRow(n);
  if (problems.length)
    console.warn(`registry: ${f}: ${problems.join(' ; ')}`);
  rows.push({
    slug: scalar(y, 'slug') || f.replace(/\.yaml$/, ''),
    member_id: scalar(y, 'member_id'),
    display_name: scalar(y, 'display_name'),
    status: n.status,
    owner: n.owner,
    anchor: n.anchor,
    memberships: n.memberships,
    provider: scalar(y, 'provider'),
    cohort: scalar(y, 'cohort'),
    tier: n.tier,
    legacy_level: n.legacy_level,
    region: scalar(y, 'region'),
    packs: countList(y, 'packs_installed'),
    host: nested(y, 'box', 'host'),
    // Whether the BOX was torn down, as opposed to the member simply leaving.
    // deprovision-member, member-revoke and member-leave all write status
    // "left", so without this the fleet row cannot tell a destroyed box from a
    // departed member, and the panel offered "Bring back" on a VM that no
    // longer exists under copy saying it was never destroyed.
    decommissioned: scalar(y, 'decommissioned'),
    // the exit tombstone (run-6 audit, 2026-08-17): how a left row ended and
    // what the rock knows happened to the mineral; the Pebbles left-card reads
    // these instead of guessing
    left_how: scalar(y, 'left_how'),
    left_mineral: scalar(y, 'left_mineral'),
    // anchor adoption (T8): attached = the seat exists; wired = the channel
    // keys landed. Empty on every stamped row; the fleet card badges and the
    // Manage fold's shape (no teardown on metal the rock does not own) read
    // these two.
    attached: scalar(y, 'attached'),
    wired: scalar(y, 'wired'),
    problems,
  });
}
rows.sort((a, b) => a.slug.localeCompare(b.slug));

await writeFile(path.join(here, 'index.json'), JSON.stringify(rows, null, 2) + '\n');

const head = '| slug | name | status | owner | anchor | tier | cohort | region | packs | host |';
const sep = '|---|---|---|---|---|---|---|---|---|---|';
const body = rows.map((r) => `| ${r.slug} | ${r.display_name} | ${r.status} | ${r.owner} | ${r.anchor} | ${r.tier} | ${r.cohort} | ${r.region} | ${r.packs} | ${r.host} |`).join('\n');
await writeFile(path.join(here, 'index.md'), `# Registry index (derived)\n\n${head}\n${sep}\n${body}\n`);

console.log(`indexed ${rows.length} member(s) -> index.json + index.md`);
