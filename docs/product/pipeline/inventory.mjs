#!/usr/bin/env node
// inventory.mjs - the surface inventory: what the product HAS.
//
//   node docs/product/pipeline/inventory.mjs [--json]
//
// Phase 1 of the v2 documentation plan. This is the coverage DENOMINATOR:
// "more depth" is unmeasurable without knowing what one hundred percent is, and
// v1 was written from whatever came to mind, which is how it ended up covering 8
// of 18 nav sections and 1 of 62 connectors while feeling finished.
//
// Everything here is EXTRACTED, never listed by hand, so the inventory cannot
// drift from the product the way a hand-kept list would. When the extraction
// finds nothing it throws rather than reporting an empty surface: a silently
// empty inventory would report 100% coverage of nothing.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOGUE } from '../../../wizard/panel/mcp-catalogue.mjs';
import { skills, machinery } from './generate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const MEMBER = path.join(REPO, 'wizard', 'panel', 'member.html');

// --- nav sections -----------------------------------------------------------
// A nav button carries: data-sec, a face class, an icon, and its label text.
// The face class is the thing v1's probe missed entirely, which is why it
// recorded "/panel and /member show identical sections". They do not: the
// member face hides .orgonly and the rock face hides .memonly.
export function navSections() {
  const html = readFileSync(MEMBER, 'utf8');
  const out = [];
  const re = /<button([^>]*?)data-sec="([a-z0-9-]+)"([^>]*)>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = `${m[1]} ${m[3]}`;
    if (/data-group-toggle/.test(attrs)) continue;
    const sec = m[2];
    // label is the text after the icon, plus any <span> text
    const label = m[4].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
    const face = /\borgonly\b/.test(attrs) ? 'rock' : /\bmemonly\b/.test(attrs) ? 'pebble' : 'both';
    if (!label) continue;
    if (out.some((o) => o.sec === sec)) continue;
    out.push({ sec, label, face });
  }
  if (!out.length) throw new Error('inventory: no nav buttons found; the nav markup changed');
  return out;
}

// Nav GROUPS: the collapsible headings a member actually clicks through. A doc
// that says "open Skills" without saying it lives under "Your assistant" is
// telling someone to find a button that is hidden behind a closed group.
export function navGroups() {
  const html = readFileSync(MEMBER, 'utf8');
  // Split on group boundaries rather than trying to match nested divs. The
  // regex version of this was greedy and attributed every section to the first
  // group, reporting "Network > Terminal" for a top-level button.
  const parts = html.split(/<div class="navgroup"/);
  const out = [];
  for (let i = 1; i < parts.length; i += 1) {
    const chunk = parts[i].split('</nav>')[0];
    const id = /data-group="([a-z]+)"/.exec(chunk);
    const head = /class="ghead"[^>]*>([\s\S]*?)<\/(?:button|div|span)>/.exec(chunk);
    if (!id || !head) continue;
    const label = head[1].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').trim();
    // Sections belong to a group only if they are inside its OWN gitems div,
    // which ends at the first </div> after it. Running to the next group (or to
    // the end of the chunk, for the last group) swallowed the top-level Terminal
    // button and reported it as "Privacy & access > Terminal", which would have
    // sent a reader looking inside a group it is not in.
    const items = /class="gitems"[^>]*>([\s\S]*?)<\/div>/.exec(chunk);
    const secs = [...(items ? items[1] : '').matchAll(/data-sec="([a-z0-9-]+)"/g)].map((x) => x[1]);
    if (label) out.push({ group: id[1], label, sections: secs });
  }
  return out;
}

// Sections that EXIST but no nav button reaches. v1 found `cadence` this way and
// then wrote a page telling members to visit a page they cannot click to.
export function unreachableSections() {
  const html = readFileSync(MEMBER, 'utf8');
  const declared = new Set([...html.matchAll(/<section[^>]*data-sec="([a-z0-9-]+)"/g)].map((m) => m[1]));
  const reachable = new Set(navSections().map((n) => n.sec));
  return [...declared].filter((s) => !reachable.has(s)).sort();
}

// --- member actions ---------------------------------------------------------
// MEMBER_VERBS is what a member may do to their own mineral: the one served
// table since the face collapse (SELF_VERBS, the old wall-crossing list, went
// with it on 2026-09-01). It is the action denominator.
export function memberVerbs() {
  const src = readFileSync(path.join(REPO, 'wizard', 'panel', 'panel-server.mjs'), 'utf8');
  const start = src.indexOf('export const MEMBER_VERBS = {');
  if (start < 0) throw new Error('inventory: MEMBER_VERBS not found; panel-server changed');
  const block = [src.slice(start, src.indexOf('\n};\n', start))];
  const verbs = [...block[0].matchAll(/^  '([a-z][a-z0-9_-]+)': \{/gm)].map((m) => m[1]);
  if (!verbs.length) throw new Error('inventory: MEMBER_VERBS parsed empty');
  // mutating verbs change the member's mineral and are the ones a doc must be
  // most careful about, so mark them
  const mutating = new Set();
  for (const v of verbs) {
    const def = new RegExp(`'${v}':\\s*\\{[\\s\\S]{0,200}?mutating:\\s*true`).test(src);
    if (def) mutating.add(v);
  }
  return verbs.sort().map((v) => ({ verb: v, mutating: mutating.has(v) }));
}

// --- connectors -------------------------------------------------------------
export function connectors() {
  return CATALOGUE.map((c) => ({
    key: c.key, label: c.label, category: c.category,
    auth: c.auth, featured: Boolean(c.boxKey),
  }));
}

// --- the harness worlds a shot can be taken in ------------------------------
export const WORLDS = ['rich', 'empty', 'error'];

export function inventory() {
  const nav = navSections();
  const conns = connectors();
  const groups = navGroups();
  const grouped = new Map();
  for (const g of groups) for (const sec of g.sections) grouped.set(sec, g.label);
  return {
    navSections: nav.map((n) => ({ ...n, group: grouped.get(n.sec) || null })),
    navGroups: groups,
    unreachableSections: unreachableSections(),
    memberVerbs: memberVerbs(),
    connectors: conns,
    connectorCategories: [...new Set(conns.map((c) => c.category))].sort(),
    engineSkills: skills().map((s) => ({ name: s.name, title: s.title, category: s.category })),
    machineryJobs: machinery().map((j) => j.id),
    worlds: WORLDS,
    totals: {
      navSections: nav.length,
      navByFace: nav.reduce((a, n) => ({ ...a, [n.face]: (a[n.face] || 0) + 1 }), {}),
      memberVerbs: memberVerbs().length,
      mutatingVerbs: memberVerbs().filter((v) => v.mutating).length,
      connectors: conns.length,
      featuredConnectors: conns.filter((c) => c.featured).length,
      engineSkills: skills().length,
      machineryJobs: machinery().length,
      surfaceStates: nav.length * WORLDS.length,
    },
  };
}

if (process.argv[1] && process.argv[1].endsWith('inventory.mjs')) {
  const inv = inventory();
  if (process.argv.includes('--json')) { console.log(JSON.stringify(inv, null, 2)); process.exit(0); }
  const t = inv.totals;
  console.log('SURFACE INVENTORY\n');
  console.log(`nav sections        ${t.navSections}  (both ${t.navByFace.both || 0} · pebble ${t.navByFace.pebble || 0} · rock ${t.navByFace.rock || 0})`);
  console.log(`  x 3 worlds        ${t.surfaceStates} surface states`);
  console.log(`member actions      ${t.memberVerbs}  (${t.mutatingVerbs} mutating)`);
  console.log(`connectors          ${t.connectors}  (${t.featuredConnectors} featured, ${inv.connectorCategories.length} categories)`);
  console.log(`engine skills       ${t.engineSkills}`);
  console.log(`machinery jobs      ${t.machineryJobs}`);
  if (inv.unreachableSections.length) {
    console.log(`\nsections with NO nav button: ${inv.unreachableSections.join(', ')}`);
  }
  console.log('\nnav sections by face:');
  for (const n of inv.navSections) {
    const where = n.group ? `${n.group} > ${n.label}` : n.label;
    console.log(`  ${n.face.padEnd(7)} ${n.sec.padEnd(14)} "${where}"`);
  }
}
