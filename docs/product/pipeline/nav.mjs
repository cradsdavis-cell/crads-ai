// nav.mjs - the reading journey. Sam's ruling (2026-08-25): the docs tell the
// reader's story, not the documentation theory's. Groups follow where the
// reader IS (deciding -> setting up -> working with it -> using the app ->
// keeping it running -> understanding it), not what mode a page was authored
// in. Diataxis still governs how each page is WRITTEN and updated; this file
// only governs how they are found.
//
// Every public page must appear in exactly one group: the coverage gate in
// gates.test.mjs refuses a page this file forgot, so a new page fails the
// build until someone decides where it lives in the story. That is a feature:
// "where does this fit in the journey" is exactly the question that keeps the
// docs a story rather than a pile.
//
// Regrouped 2026-09-10 (Sam: "no path by goal", "groups too long"). Living
// with it was ten pages of mixed purpose; it is now Keep it running (how-tos)
// and Understand it (explanations). Working with your EA is the new home for
// everything about asking, teaching and building on the assistant; it sits
// right after Getting set up because Your first week ends by telling the
// reader to correct it and talk to it, and that is where this group begins.
import { glyphIds } from './glyphs.mjs';

export const JOURNEY = [
  {
    id: 'start', title: 'Start here',
    blurb: 'What this is, whether it is for you, and the two words everything else uses.',
    slugs: ['what-an-ai-ea-is', 'what-a-mineral-is', 'faq'],
  },
  {
    id: 'setup', title: 'Getting set up',
    blurb: 'From nothing to an assistant that is awake, knows you, and reaches your phone.',
    slugs: ['get-a-hetzner-api-token', 'get-a-digitalocean-api-token', 'first-hour', 'the-interview', 'your-first-week', 'connect-google', 'connect-telegram'],
  },
  {
    id: 'ea', title: 'Working with your EA',
    blurb: 'How to talk to it, teach it, build on it, and get it to find what you are missing.',
    slugs: ['how-your-assistant-thinks', 'a-day-with-your-assistant', 'the-crit-method',
      'prompting-habits', 'grow-the-brain', 'teach-it-your-voice', 'write-your-own-skill',
      'starter-recipes', 'what-it-will-not-do', 'find-what-you-do-not-know',
      'claude-code-on-your-mineral'],
  },
  {
    id: 'app', title: 'Every page of the app',
    blurb: "Each screen, opening with the app's own words for it.",
    slugs: ['overview-page', 'your-pebble-page', 'brain-page',
      'skills-page', 'connections-page', 'secrets-page', 'terminal-page'],
  },
  {
    id: 'running', title: 'Keep it running',
    blurb: 'Backups, connections, other machines, and what to do when something looks wrong.',
    slugs: ['back-up-and-restore', 'fix-a-broken-connection', 'when-something-looks-wrong',
      'devices-and-access', 'add-another-computer', 'grant-support-access'],
  },
  {
    id: 'understand', title: 'Understand it',
    blurb: 'The honest mechanics: who edits what, how updates arrive, and what happens if we go away.',
    slugs: ['the-three-layers', 'how-updates-reach-you', 'continuity'],
  },
  {
    id: 'reference', title: 'Reference',
    blurb: 'Generated from the software itself, so it cannot drift.',
    slugs: ['skills', 'connections', 'machinery-jobs', 'glossary', 'where-these-ideas-come-from'],
  },
  {
    id: 'legal', title: 'Legal',
    blurb: 'The written detail. Version-stamped, and it changes only with the version.',
    slugs: ['privacy-policy', 'terms', 'acceptable-use'],
  },
];

// The doors on the index, one per thing a reader came to do (Sam, 2026-09-10:
// "no path by goal"). Each is a short ordered trail, not a group: the trails
// reuse pages the groups already carry. Doors are DISJOINT (a page is on at
// most one) so the trail a page shows at its foot is never ambiguous, and each
// carries a glyph from glyphs.mjs.
export const DOORS = [
  {
    id: 'decide', title: 'I want to know if this is for me', glyph: 'compass',
    lead: 'What it actually is, the questions everyone asks, and the two words that follow.',
    slugs: ['what-an-ai-ea-is', 'faq', 'what-a-mineral-is'],
  },
  {
    id: 'build', title: 'I want to set one up', glyph: 'server',
    lead: 'A token, fifteen minutes of building, and an interview that makes it yours.',
    slugs: ['get-a-hetzner-api-token', 'first-hour', 'the-interview'],
  },
  {
    id: 'work', title: 'I want real work out of it', glyph: 'bolt',
    lead: 'Get it doing things, ask it well, tell it what it got wrong, and know where it stops.',
    slugs: ['your-first-week', 'the-crit-method', 'grow-the-brain', 'what-it-will-not-do'],
  },
  {
    id: 'reach', title: 'I want it in my inbox and my pocket', glyph: 'envelope',
    lead: 'Mail and calendar with your own key, a private Telegram bot, and every other plug.',
    slugs: ['connect-google', 'connect-telegram', 'connections-page'],
  },
  {
    id: 'safe', title: 'I want it safe and mine', glyph: 'shield',
    lead: 'The backup only you can do, the machines that can open it, and what outlives us.',
    slugs: ['back-up-and-restore', 'devices-and-access', 'continuity'],
  },
  {
    id: 'fix', title: 'I want to fix something', glyph: 'wrench',
    lead: 'The symptom list, the one page that tells the truth about a connection, and a hand.',
    slugs: ['when-something-looks-wrong', 'fix-a-broken-connection', 'grant-support-access'],
  },
];

export function journeyGroups(publicEntries) {
  const bySlug = new Map(publicEntries.map((p) => [p.slug, p]));
  return JOURNEY.map((g) => ({ ...g, items: g.slugs.map((s) => bySlug.get(s)).filter(Boolean) }))
    // a group with no pages yet is not rendered (it is allowed to exist ahead
    // of its pages, so the story can be shaped before it is written)
    .filter((g) => g.items.length);
}

// The door a page sits on, if any: { door, index } or null.
export function doorOf(slug) {
  for (const d of DOORS) {
    const i = d.slugs.indexOf(slug);
    if (i > -1) return { door: d, index: i };
  }
  return null;
}

// The audit the gate runs: every public page in exactly one group, no group
// naming a page that does not exist, doors disjoint with real pages and real
// glyphs, and at least two steps each (a one-page door is a link, not a trail).
export function journeyProblems(publicEntries) {
  const problems = [];
  const seen = new Map();
  for (const g of JOURNEY) {
    for (const s of g.slugs) {
      if (seen.has(s)) problems.push(`${s} appears in both "${seen.get(s)}" and "${g.title}"`);
      seen.set(s, g.title);
    }
  }
  const real = new Set(publicEntries.map((p) => p.slug));
  for (const s of seen.keys()) if (!real.has(s)) problems.push(`${s} is in the journey but is not a public page`);
  for (const p of publicEntries) if (!seen.has(p.slug)) problems.push(`${p.slug} is public but has no place in the journey`);
  const doored = new Map();
  const glyphs = new Set(glyphIds());
  for (const d of DOORS) {
    if (d.slugs.length < 2) problems.push(`door "${d.title}" has ${d.slugs.length} page(s); a door is a trail of at least two`);
    if (!glyphs.has(d.glyph)) problems.push(`door "${d.title}" names glyph "${d.glyph}", which glyphs.mjs does not draw`);
    for (const s of d.slugs) {
      if (!real.has(s)) problems.push(`door "${d.title}" names ${s}, which is not a public page`);
      if (doored.has(s)) problems.push(`${s} is on both door "${doored.get(s)}" and door "${d.title}"`);
      doored.set(s, d.title);
    }
  }
  return problems;
}
