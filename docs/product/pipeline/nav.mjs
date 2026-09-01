// nav.mjs - the reading journey. Sam's ruling (2026-08-25): the docs tell the
// reader's story, not the documentation theory's. Groups follow where the
// reader IS (deciding -> setting up -> using -> hosting), not what mode a page
// was authored in. Diataxis still governs how each page is WRITTEN and
// updated; this file only governs how they are found.
//
// Every public page must appear in exactly one group: the coverage gate in
// gates.test.mjs refuses a page this file forgot, so a new page fails the
// build until someone decides where it lives in the story. That is a feature:
// "where does this fit in the journey" is exactly the question that keeps the
// docs a story rather than a pile.
export const JOURNEY = [
  {
    id: 'start', title: 'Start here',
    blurb: 'What this is, whether it is for you, and the two words everything else uses.',
    slugs: ['what-an-ai-ea-is', 'faq', 'rocks-and-pebbles'],
  },
  {
    id: 'setup', title: 'Getting set up',
    blurb: 'From nothing to an assistant that is awake, knows you, and reaches your phone.',
    slugs: ['get-a-hetzner-api-token', 'first-hour', 'the-interview', 'your-first-week', 'connect-google', 'connect-telegram'],
  },
  {
    id: 'app', title: 'Every page of the app',
    blurb: "Each screen, opening with the app's own words for it.",
    slugs: ['overview-page', 'your-pebble-page', 'map-page', 'join-a-community', 'brain-page',
      'skills-page', 'connections-page', 'secrets-page', 'what-your-community-can-see', 'terminal-page'],
  },
  {
    id: 'living', title: 'Living with it',
    blurb: 'The habits and honest mechanics of running a mineral of your own.',
    slugs: ['back-up-and-restore', 'fix-a-broken-connection', 'devices-and-access',
      'add-another-computer', 'when-something-looks-wrong', 'how-updates-reach-you',
      'grant-support-access', 'claude-code-on-your-mineral', 'the-three-layers', 'continuity'],
  },
  {
    id: 'hosting', title: 'Hosting a community',
    blurb: 'Turning your mineral into a rock, and looking after the people who pull from it.',
    slugs: ['become-a-rock', 'share-with-your-community', 'manage-members', 'run-your-rock',
      'run-a-cohort-session', 'curate-for-your-community', 'host-a-community-well', 'decisions-page'],
  },
  {
    id: 'reference', title: 'Reference',
    blurb: 'Generated from the software itself, so it cannot drift.',
    slugs: ['skills', 'connections', 'machinery-jobs'],
  },
  {
    id: 'legal', title: 'Legal',
    blurb: 'The written detail. Version-stamped, and it changes only with the version.',
    slugs: ['privacy-policy', 'terms', 'hosting-a-rock', 'acceptable-use'],
  },
];

// The two doors on the index (Sam: "split doors"). Each is a short ordered
// trail, not a group: the trails reuse pages the groups already carry.
export const DOORS = [
  {
    id: 'thinking', title: 'Thinking about it?',
    lead: 'Deciding whether an assistant of your own is worth having.',
    slugs: ['what-an-ai-ea-is', 'faq', 'rocks-and-pebbles'],
  },
  {
    id: 'invited', title: 'Making your own?',
    lead: 'From a blank screen to an assistant that knows you, on a server of your own.',
    slugs: ['first-hour', 'the-interview', 'your-first-week'],
  },
  {
    id: 'hosting', title: 'Hosting a community?',
    lead: 'Your members run their own assistants; you curate the commons they pull from.',
    slugs: ['become-a-rock', 'share-with-your-community', 'manage-members'],
  },
];

export function journeyGroups(publicEntries) {
  const bySlug = new Map(publicEntries.map((p) => [p.slug, p]));
  return JOURNEY.map((g) => ({ ...g, items: g.slugs.map((s) => bySlug.get(s)).filter(Boolean) }));
}

// The audit the gate runs: every public page in exactly one group, and no
// group naming a page that does not exist.
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
  for (const d of DOORS) for (const s of d.slugs) if (!real.has(s)) problems.push(`door "${d.title}" names ${s}, which is not a public page`);
  return problems;
}
