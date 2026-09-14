#!/usr/bin/env node
// links.mjs - do the pages know about each other?
//
//   node docs/product/pipeline/links.mjs
//
// A manual whose pages never reference each other is a pile of pages. The
// sidebar makes everything REACHABLE, which is not the same as connected: a
// reader on the backup page should be told where ownership is explained, not
// left to go looking.
//
// Three checks, and the third is the one that finds real work:
//   broken   a /docs/ link with no page behind it
//   orphans  a page nothing else links to
//   unlinked another page's subject named in prose, as plain text
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTree } from './source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGES = path.join(HERE, '..', 'pages');
const LINK_RE = /\]\(\/docs\/([a-z0-9-]+)\)/g;

// Phrases that mean "the page about X". Kept explicit rather than derived from
// titles: a title is a heading, and prose refers to a page by its subject.
export const SUBJECTS = [
  { slug: 'privacy-policy', re: /\bprivacy policy\b/i },
  { slug: 'terms', re: /\bterms of service\b/i },
  { slug: 'acceptable-use', re: /\bacceptable use\b/i },
  { slug: 'continuity', re: /\bcontinuity page\b/i },
  { slug: 'first-hour', re: /\byour first hour\b/i },
  { slug: 'the-three-layers', re: /\bwho edits what\b/i },
  { slug: 'connect-google', re: /\bconnect(?:ing)? Google\b/i },
  { slug: 'back-up-and-restore', re: /\bback ?up (?:your mineral|and restore)\b/i },
  { slug: 'machinery-jobs', re: /\bjobs your mineral runs by itself\b/i },
  { slug: 'skills', re: /\bevery skill your mineral ships with\b/i },
  { slug: 'connections', re: /\bwhat you can connect\b/i },
  { slug: 'fix-a-broken-connection', re: /\bfix a (?:broken )?connection\b/i },
  { slug: 'claude-code-on-your-mineral', re: /\bClaude Code on your mineral\b/i },
  // Working with your EA (2026-09-10)
  { slug: 'how-your-assistant-thinks', re: /\bhow your assistant thinks\b/i },
  { slug: 'a-day-with-your-assistant', re: /\ba day with your assistant\b/i },
  { slug: 'the-crit-method', re: /\bCRIT\b/ },
  { slug: 'prompting-habits', re: /\bprompting habits\b/i },
  { slug: 'grow-the-brain', re: /\bgrow(?:ing)? the brain\b/i },
  { slug: 'teach-it-your-voice', re: /\bteach it your voice\b/i },
  { slug: 'write-your-own-skill', re: /\bwrite your own skill\b/i },
  { slug: 'starter-recipes', re: /\bstarter recipes\b/i },
  { slug: 'what-it-will-not-do', re: /\bwhat it will not do\b/i },
  { slug: 'find-what-you-do-not-know', re: /\bfind what you do not know\b/i },
  { slug: 'glossary', re: /\bthe glossary\b/i },
  { slug: 'where-these-ideas-come-from', re: /\bwhere these ideas come from\b/i },
];

// A link is only a link for readers who can see both ends. Tiers are
// cumulative downward (a rock box carries pebble and public pages), so a page
// may link at its own tier or below. Upward is a 404 on the reader's surface:
// the live site proved it on 2026-08-24, when four PUBLIC pages linked five
// pebble recipes and every public reader who clicked got a 404. The link gate
// checked the corpus and publish shipped a subset; this check closes the gap
// between them.
const TIER = { public: 0, pebble: 1, rock: 2 };

export function audit() {
  const pages = loadTree(PAGES);
  const slugs = new Set(pages.map((p) => p.slug));
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const linkedTo = new Set();
  const broken = [];
  const crossTier = [];

  for (const p of pages) {
    for (const m of p.body.matchAll(LINK_RE)) {
      if (slugs.has(m[1])) linkedTo.add(m[1]);
      else broken.push(`${p.slug} -> /docs/${m[1]}`);
      const target = bySlug.get(m[1]);
      if (target && (TIER[target.audience] ?? 0) > (TIER[p.audience] ?? 0)) {
        crossTier.push(`${p.slug} (${p.audience}) -> /docs/${m[1]} (${target.audience})`);
      }
    }
  }

  const orphans = pages.filter((p) => !linkedTo.has(p.slug)).map((p) => p.slug);

  // A subject named in prose but not linked ANYWHERE on that page. Checked per
  // page rather than per mention: naming a page three times and linking it once
  // is good writing, not a defect.
  const unlinked = [];
  for (const p of pages) {
    const links = new Set([...p.body.matchAll(LINK_RE)].map((m) => m[1]));
    for (const s of SUBJECTS) {
      if (s.slug === p.slug) continue;
      if (!s.re.test(p.body)) continue;
      if (links.has(s.slug)) continue;
      unlinked.push({ from: p.slug, to: s.slug });
    }
  }
  return { pages, broken, orphans, unlinked, linkedTo, crossTier };
}

if (process.argv[1] && process.argv[1].endsWith('links.mjs')) {
  const { pages, broken, orphans, unlinked, crossTier } = audit();
  console.log(`${pages.length} pages\n`);
  console.log(`broken links:        ${broken.length}`);
  broken.forEach((b) => console.log(`  ${b}`));
  console.log(`\ncross-tier links:    ${crossTier.length}`);
  crossTier.forEach((c) => console.log(`  ${c}`));
  console.log(`\nlinked from nowhere: ${orphans.length}`);
  orphans.forEach((o) => console.log(`  ${o}`));
  console.log(`\nnamed but not linked: ${unlinked.length}`);
  unlinked.forEach((u) => console.log(`  ${u.from}  ->  ${u.to}`));
}
