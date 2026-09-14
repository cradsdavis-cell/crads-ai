// The hard gates (build step 5). What ships is refused here, not reviewed by
// hope. Zero-dep, so it runs in the clean-checkout suite on every push and PR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTree } from './source.mjs';
import { extractShotRefs } from './shots.mjs';
import { BANNED_TERMS, PINNED_CLAIMS, checkVocab, checkClaims, checkBilling } from './claims.mjs';
import { bodyHash, readLock, auditLock } from './legal.mjs';
import { ledger } from './drift.mjs';
import { RECIPES, recipeIds, auditRecipes } from './recipes.mjs';
import { caseProblems } from './case.mjs';
import { DIAGRAM_LINE, DIAGRAM_ANY, renderMarkdown, calloutKind } from './render.mjs';
import { diagramIds, renderDiagram } from './diagrams.mjs';
import { coverage } from './coverage.mjs';
import { audit } from './links.mjs';
import { journeyProblems } from './nav.mjs';
import { skills } from './generate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGES = path.join(HERE, '..', 'pages');
// The gates run on SHIPPED pages. Fixtures are unit-test material for the
// source, render and shots contracts: gating test data would mean a fixture
// written to exercise a refusal fails the build for exercising it. Each gate
// is instead pinned on synthetic pages below, so the mechanism is proven
// before the real page it guards exists.
const realPages = () => (existsSync(PAGES) ? loadTree(PAGES) : []);
const synth = (slug, body, extra = {}) => ({ slug, title: '', summary: '', body, pins: [], reviewed: null, ...extra });

// --- vocabulary -------------------------------------------------------------
test('internal wire vocabulary never reaches a reader', () => {
  assert.deepEqual(checkVocab(realPages()), [],
    'internal vocabulary in a shipped page (see claims.mjs BANNED_TERMS)');
});

test('the vocabulary gate catches internal phrases and spares ordinary English', () => {
  // The token version of this gate fired three times in one afternoon and was
  // wrong all three: `mark-read` (an inbox bucket) in the generated skills
  // page, "if you wire it to your business email" in the terms, and "or mark
  // anything done" in a recipe. Zero real leaks. So it matches phrases now.
  for (const bad of [
    'we stamp the metal for you',
    'stamping a pebble takes a minute',
    'the box claims its anchor wire',
    'it claims the wire bundle',
    'a connector that lost its marks',
    'the marks a connector wears',
  ]) {
    assert.equal(checkVocab([synth('x', bad)]).length >= 1, true, `should fire: ${bad}`);
  }
  for (const fine of [
    'buckets: mark-read, archive',
    'or mark anything done',
    'wire it up yourself',
    'already stamped and sent',
    'the software is wireless',
    'a bench-mark of speed',
    'open the connector page and sign in again',
  ]) {
    assert.deepEqual(checkVocab([synth('y', fine)]), [], `should be silent: ${fine}`);
  }
});

test('mineral is explicitly allowed: it is brand, not jargon', () => {
  // A regression guard on the gate itself. Sam ruled this 2026-08-24; if someone
  // re-bans `mineral`, three generated pages break at once and the reason will
  // not be obvious from the failure.
  // Behaviour, not regex source: `stamp-the-metal` legitimately contains the
  // word `mineral` because "stamp the mineral" IS the provisioning sense and
  // should fire. What must never fire is ordinary member-facing use.
  for (const fine of [
    'your mineral runs these jobs on its own',
    'every mineral ships with these skills',
    'a mineral belongs to exactly one account',
    'open the app and pick a mineral',
    'Mineral is the word for either kind, when it does not matter which',
  ]) {
    assert.deepEqual(checkVocab([synth('m', fine)]), [],
      `mineral is brand and stays member-facing (Sam, 2026-08-24): ${fine}`);
  }
  // and the provisioning sense still does fire
  assert.equal(checkVocab([synth('m', 'we stamp the mineral for you')]).length, 1);
});

// --- pinned claims ----------------------------------------------------------
test('every pinned claim survives on the page that owes it', () => {
  const { broken, pending } = checkClaims(realPages());
  if (pending.length) console.log(`  note: ${pending.length} claim(s) awaiting their page: ${pending.join(', ')}`);
  assert.deepEqual(broken, [], 'a pinned claim was edited out of a page that must carry it');
});

test('the claims gate fails a page that loses its claim, and only then', () => {
  // More than one claim can land on the same page (privacy-policy owes two), so
  // a page that satisfies one and drops the other is still broken. Build the
  // satisfying body from every claim for that slug rather than assuming one.
  const slug = 'privacy-policy';
  const owed = PINNED_CLAIMS.filter((c) => c.slug === slug);
  assert.ok(owed.length > 1, 'this test is about a page owing several claims');

  const satisfies = synth(slug, owed.map((c) => `We commit: ${c.must}.`).join(' '));
  assert.deepEqual(checkClaims([satisfies]).broken, []);

  const dropsOne = synth(slug, owed.slice(1).map((c) => `We commit: ${c.must}.`).join(' '));
  assert.equal(checkClaims([dropsOne]).broken.length, 1, 'dropping one of several is caught');

  assert.equal(checkClaims([synth(slug, 'We collect some things.')]).broken.length, owed.length);

  // A claim must survive re-wrapping and emphasis: those are formatting, not
  // broken promises. The privacy policy hit this on its first draft.
  const wrapped = synth(slug, owed.map((c) => {
    const w = c.must.split(' ');
    const half = Math.ceil(w.length / 2);
    return `**${w.slice(0, half).join(' ')}\n${w.slice(half).join(' ')}**.`;
  }).join('\n\n'));
  assert.deepEqual(checkClaims([wrapped]).broken, [], 'a re-wrapped, bolded claim is still the claim');

  // a claim whose page is unwritten is PENDING, never a failure
  const none = checkClaims([]);
  assert.deepEqual(none.broken, []);
  assert.equal(none.pending.length, PINNED_CLAIMS.length);
});

// --- the billing caveat -----------------------------------------------------
test('a page showing a price says the price is indicative', () => {
  assert.deepEqual(checkBilling(realPages(), extractShotRefs), [],
    'pricing is display-only until the 26 Sep read-date: a screenshot of a number reads as a commitment');
});

test('the billing gate fires on a priced shot and not on any other', () => {
  const priced = '![the home](shot:member-overview)';
  assert.equal(checkBilling([synth('a', priced)], extractShotRefs).length, 1);
  assert.equal(checkBilling([synth('b', `${priced}\n\nPrices shown are indicative.`)], extractShotRefs).length, 0);
  assert.equal(checkBilling([synth('c', '![the brain](shot:member-brain)')], extractShotRefs).length, 0);
});

// --- legal ------------------------------------------------------------------
test('a legal page cannot change its text without moving its version', () => {
  const { problems } = auditLock();
  assert.deepEqual(problems, []);
});

test('every legal page in pages/ is in the lock', () => {
  const lock = readLock();
  const missing = realPages().filter((p) => p.mode === 'legal' && !lock.pages[p.slug]).map((p) => p.slug);
  assert.deepEqual(missing, [],
    'a legal page is unlocked. Run: node docs/product/pipeline/legal.mjs --update');
});

test('the lock refuses the one combination that matters', () => {
  // Unit-tested on synthetic content so it is pinned before the first real
  // legal page exists, rather than after.
  const page = (body, version) => ({ slug: 'p', body, version, mode: 'legal' });
  const lock = { pages: { p: { version: '1.0', hash: bodyHash('original text') } } };
  assert.equal(auditLock([page('original text', '1.0')], lock).problems.length, 0, 'unchanged: fine');
  assert.equal(auditLock([page('original text', '1.1')], lock).problems.length, 0, 're-stamp with no text change: fine');
  assert.equal(auditLock([page('EDITED text', '1.1')], lock).problems.length, 0, 'changed with a bump: fine');
  assert.equal(auditLock([page('EDITED text', '1.0')], lock).problems.length, 1, 'changed WITHOUT a bump: refused');
});

// --- soft drift -------------------------------------------------------------
test('the drift ledger reads pins and reports, without blocking', () => {
  const rows = ledger(realPages());
  assert.ok(Array.isArray(rows), 'the ledger always answers');
  if (rows.length) console.log(`  note: ${rows.length} page/pin pair(s) want a re-read (node docs/product/pipeline/drift.mjs)`);
});

test('a page that pins code must carry a review date', () => {
  // Enforced in source.mjs; asserted here so the reason is visible in the gates.
  const orphans = realPages().filter((p) => p.pins.length && !p.reviewed).map((p) => p.slug);
  assert.deepEqual(orphans, []);
});

// --- recipes ----------------------------------------------------------------
test('every recipe would actually fire on a real mineral', () => {
  // Validated by the ENGINE's scheduleProblem(), the same function the box runs.
  // A recipe that could not be scheduled must not ship inside a page that says
  // it installs in one click.
  assert.deepEqual(auditRecipes(skills().map((s) => s.name)), []);
});

test('every how-to installs a declared recipe', () => {
  const declared = new Set(recipeIds());
  const bad = realPages()
    .filter((p) => p.mode === 'how-to' && p.installs)
    .filter((p) => !declared.has(p.installs))
    .map((p) => `${p.slug} -> installs: ${p.installs}`);
  assert.deepEqual(bad, [], 'a how-to points at a recipe that does not exist');
});

test('recipes not yet documented are reported, not failed', () => {
  const used = new Set(realPages().filter((p) => p.mode === 'how-to').map((p) => p.installs));
  const undocumented = recipeIds().filter((id) => !used.has(id));
  if (undocumented.length) console.log(`  note: ${undocumented.length} recipe(s) without a how-to yet: ${undocumented.join(', ')}`);
  assert.ok(true);
});

// --- sentence case -----------------------------------------------------------
// --- the line under the title -------------------------------------------------
test('every public tutorial and how-to says what you will be able to do', () => {
  // `outcome:` (2026-09-10) is the one line a practical page owes its reader.
  // Explanations and reference pages are exempt: they explain or list, they
  // do not promise a capability.
  const missing = realPages()
    .filter((p) => p.audience === 'public' && ['tutorial', 'how-to'].includes(p.mode) && !p.outcome)
    .map((p) => p.slug);
  assert.deepEqual(missing, [], 'a practical page with no outcome: line');
});

test('a callout is a Note, a Tip or a Careful, and nothing else', () => {
  const bad = [];
  for (const pg of realPages()) {
    const lines = String(pg.body).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/^>\s?/.test(lines[i])) continue;
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      const k = calloutKind(buf.join(' '));
      if (k.error) bad.push(`${pg.slug}: ${k.error}`);
    }
  }
  assert.deepEqual(bad, [], 'a quote asks for a callout flavour that does not exist');
});

test('docs copy is sentence case, both directions', () => {
  assert.deepEqual(caseProblems(realPages()), []);
});

test('the case gate knows a sentence start from a Title Case word', () => {
  const p = (body, title = 'A page') => synth('c', body, { title, summary: 'One line.' });
  // real violations
  assert.equal(caseProblems([p('## Connect Your Own Key')]).length, 1);
  assert.equal(caseProblems([p('## box')]).length, 1, 'a raw slug as a heading');
  // NOT violations: numbered headings, sentence continuations, proper nouns,
  // acronyms. All four of these were reported by the first version of this
  // check, and all four were wrong.
  assert.deepEqual(caseProblems([p('## 7. Ending it')]), []);
  assert.deepEqual(caseProblems([p('## Layer 1: the machinery. We maintain it.')]), []);
  assert.deepEqual(caseProblems([p('## Connect Google, with your own key')]), []);
  assert.deepEqual(caseProblems([p('## What the OAIC expects')]), []);
});

// --- diagrams ----------------------------------------------------------------
test('every diagram a page references exists', () => {
  const bad = [];
  for (const pg of realPages()) {
    for (const m of pg.body.matchAll(/!\[[^\]]*\]\(diagram:([a-z0-9-]+)\)/g)) {
      if (!diagramIds().includes(m[1])) bad.push(`${pg.slug} -> diagram:${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], 'a page points at a diagram that does not exist');
});

test('every diagram is shown by some page', () => {
  // The reverse of the test above. Three diagrams sat unreferenced for two
  // weeks (2026-08-25 to 2026-09-10) and two of them rotted into the hosted
  // era, which nothing caught because nothing rendered them. An orphan
  // diagram is one nobody proofreads, so it is a failed build.
  const used = new Set(realPages().flatMap((pg) => [...pg.body.matchAll(/!\[[^\]]*\]\(diagram:([a-z0-9-]+)\)/g)].map((m) => m[1])));
  const orphans = diagramIds().filter((id) => !used.has(id));
  assert.deepEqual(orphans, [], 'a diagram no page shows');
});

test('a diagram carries no hex colour, so it inherits the page', () => {
  for (const id of diagramIds()) {
    const svg = renderDiagram(id);
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(svg),
      `${id} hardcodes a colour; use a site token so it cannot drift from the palette`);
  }
});

test('every diagram is described for someone who cannot see it', () => {
  for (const id of diagramIds()) {
    const svg = renderDiagram(id);
    assert.match(svg, /<title id="[^"]+">[^<]{10,}<\/title>/, `${id} has no title`);
    const desc = /<desc id="[^"]+">([^<]+)<\/desc>/.exec(svg);
    assert.ok(desc, `${id} has no desc`);
    assert.ok(desc[1].length > 80,
      `${id}'s description is too thin to replace the picture (${desc[1].length} chars)`);
    assert.match(svg, /aria-labelledby=/, `${id} does not point at its own title`);
  }
});

test('a diagram is always its own block', () => {
  const bad = [];
  for (const pg of realPages()) {
    pg.body.split('\n').forEach((line, n) => {
      if (DIAGRAM_ANY.test(line) && !DIAGRAM_LINE.test(line)) bad.push(`${pg.slug}:${n + 1}`);
    });
  }
  assert.deepEqual(bad, [], 'an inline diagram cannot render as valid HTML: give it its own line');
});

// --- coverage ----------------------------------------------------------------
test('no page claims a surface the product does not have', () => {
  const { phantom } = coverage();
  assert.deepEqual(phantom, [],
    'a page documents a nav section that is not in the extracted inventory');
});

test('one page per surface, never two', () => {
  const seen = new Map();
  const dupes = [];
  for (const p of realPages()) {
    if (!p.surface) continue;
    if (seen.has(p.surface)) dupes.push(`${p.surface}: ${seen.get(p.surface)} and ${p.slug}`);
    seen.set(p.surface, p.slug);
  }
  assert.deepEqual(dupes, [], 'two pages claim the same screen, so a reader has two answers');
});

test('coverage is reported, and does not silently go backwards', () => {
  const { covered, total, rows } = coverage();
  // Re-pinned 2026-09-01 (final sweep): the Organisations tab (`rocks`) left
  // the nav with the hosted-era board, and the `library` page was written, so
  // every nav section a reader can reach now has its page. A change that
  // drops a surface page should have to say so out loud here.
  // Re-pinned 2026-09-09 (simple assistant): commons, publish, library and
  // network left the nav with their surfaces; seven sections remain and each
  // has its page.
  assert.equal(total, 7, 'the nav grew or shrank; re-read the inventory before adjusting this');
  assert.ok(covered >= 7, `surface coverage fell to ${covered}/${total}: ${rows.filter((r) => !r.page).map((r) => r.sec).join(', ')}`);
});

// --- how the pages know about each other -------------------------------------
test('every internal link resolves', () => {
  const { broken } = audit();
  assert.deepEqual(broken, [], 'a page links to a page that does not exist');
});

test('every public page has exactly one place in the journey', () => {
  // nav.mjs is where the story's shape lives (Sam's ruling 2026-08-25). A new
  // public page fails the build until someone decides where it sits in the
  // reader's journey; a page in two groups would give a reader two nexts.
  assert.deepEqual(journeyProblems(realPages().filter((p) => p.audience === 'public')), []);
});

test('a figure never splits a list in two', () => {
  // A block figure between two list items closes the list, so the resumed
  // items renumber from 1. Three pages walked into this in one day
  // (2026-08-25) before it became a gate; the fix is always the same: put the
  // figure above or below the whole list.
  const split = /<\/(ol|ul)>\s*(?:<figure[\s\S]*?<\/figure>|<svg[\s\S]*?<\/svg>)\s*<\1>/;
  for (const p of realPages()) {
    assert.ok(!split.test(renderMarkdown(p.body)),
      `${p.slug}: a figure sits between two list items; move it above or below the list`);
  }
});

test('no page links above its own tier', () => {
  const { crossTier } = audit();
  // Tiers are cumulative downward, so a public page linking a pebble or rock
  // page hands every public reader a 404: the corpus has the page, the
  // reader's surface does not. Found live on 2026-08-24 (13 dead links on 4
  // public pages); this gate is why it cannot happen again.
  assert.deepEqual(crossTier, [],
    'a page links a page its own readers cannot see');
});

test('no page is reachable only from the sidebar', () => {
  const { orphans } = audit();
  // The sidebar makes everything reachable, which is not the same as connected.
  // A reader on the backup page should be TOLD where ownership is explained,
  // not left to go looking for it in a list.
  assert.deepEqual(orphans, [],
    'nothing links to these pages, so they read as a pile rather than a manual');
});

test('another page named in prose is a link, not plain text', () => {
  const { unlinked } = audit();
  assert.deepEqual(unlinked.map((u) => `${u.from} -> ${u.to}`), [],
    'a page names another page\'s subject without linking it');
});

test('the legal lock protects words, and ignores link markup', () => {
  // Adding a link to an existing sentence must not demand a version bump: a bump
  // tells every reader the document CHANGED, and linking "privacy policy" to the
  // privacy policy is navigation. Changing a word must still move the hash, and
  // so must re-wrapping a line, because a re-wrapped paragraph in a legal
  // document is something a person should look at.
  const plain = 'See the privacy policy for detail.';
  assert.equal(bodyHash(plain), bodyHash('See the [privacy policy](/docs/privacy-policy) for detail.'),
    'a link is not a wording change');
  assert.notEqual(bodyHash(plain), bodyHash('See the privacy notice for detail.'),
    'a changed word still moves the hash');
  assert.notEqual(bodyHash(plain), bodyHash('See the\nprivacy policy for detail.'),
    'a re-wrap still moves the hash');
});
