// skills-page-iter2.test.mjs: the Skills page after panel iteration 2 (R11,
// R12, R26 display; docs/superpowers/specs/2026-08-23-panel-iteration-2.md).
//
// Structural pins, never copied prose (trap 6): two groups on one page, one
// subsection per rock, an origin chip on every installed card, an x on every
// card except engine skills, "Read the skill" on every card, an Update button
// only when a rock's offer is newer than what is installed. The second half
// drives the real page against the dev-harness fixtures, which carry exactly
// one of each case (see wizard/dev-harness/fixtures.mjs, SKILLS + catalog-list).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');
const skillsSec = html.slice(html.indexOf('<section data-sec="skills">'), html.indexOf('<section data-sec="pebbles"'));
const render = html.split('function renderSkills()')[1].split('function skillRow(')[0];
const row = html.split('function skillRow(s, st, gated)')[1].split('function sendToSignIn(')[0];

test('two groups on one page, no tabs', () => {
  assert.ok(!skillsSec.includes('id="skillsTabs"'), 'the tab strip is gone');
  assert.ok(!/data-tab=/.test(skillsSec), 'no tab buttons');
  assert.doesNotMatch(html, /var skillsTab\b/, 'and no tab state variable left behind');
  assert.match(render, /skGroupHead\(box, 'On this mineral'\)/, 'group 1');
  assert.match(render, /skGroupHead\(box, 'From your rocks'\)/, 'group 2');
  assert.ok(render.indexOf("'On this mineral'") < render.indexOf("'From your rocks'"), 'installed first, offers second');
});

test('From your rocks has one subsection per rock, listing only offers not installed', () => {
  assert.match(render, /byRock\[l\.rock\]/, 'grouped by the offer’s rock');
  assert.match(render, /if \(!offerInstalled\(l\.it, installedIds\)\) byRock\[l\.rock\]\.push\(l\)/, 'installed ids are filtered out of the offers');
  assert.match(render, /className = 'skillcat skrock'; sub\.setAttribute\('data-rock', rock\)/, 'the subsection is addressable by rock');
  assert.match(render, /Nothing new from ' \+ rock/, 'an empty subsection says so, naming the rock');
  const ents = html.split('function libEntries()')[1].split('function offerInstalled(')[0];
  assert.match(ents, /rockLocalAnchor && rockLocalAnchor\.name/, 'the anchor’s name is the last fallback for an unnamed rock');
});

// The offers list is skills only, by ALLOW-list. The deny-list this replaced
// (kind !== 'pack') let kind: 'page' through the moment step 5b gave a
// standalone page its own top-level catalogue item, and rendered it as an
// installable skill card whose Install button took the skill path. Pinned so
// the next kind cannot repeat it; the driven test below is the end-to-end half.
test('only skills reach the offers list, and the test is an allow-list not a deny-list', () => {
  assert.match(render, /if \(!isSkillOffer\(l\.it\)\) return;/, 'the group-2 loop skips anything that is not a skill');
  // comments stripped: the prose above the skip explains the pack kind it grew
  // out of, and this pin is about the CODE not naming a kind of its own.
  const renderCode = render.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(renderCode, /l\.it\.kind/, 'and does not test a kind by name');
  const pred = html.split('function isSkillOffer(it)')[1].split('function offerInstalled(')[0];
  assert.match(pred, /k === 'skill'/, "kind: 'skill' is a skill");
  assert.match(pred, /k === undefined/, 'and so is a catalogue row written before kind existed');
  const of = html.split('function offerFor(id)')[1].split('function offerNewer(')[0];
  assert.match(of, /isSkillOffer\(l\.it\)/, 'the update check uses the same rule, so a page cannot claim a skill’s id');
});

// Functional, not string-matched: the previous test pins the CODE SHAPE (an
// allow-list, no kind named), which a careful mutation could satisfy while
// still being wrong in practice. This one runs the REAL extracted group-2
// loop against a catalogue carrying one of every kind delivery-model has
// introduced so far, plus a kind nobody has invented yet ('sausage'), which
// is the actual property an allow-list buys: the next kind is excluded by
// default, not because someone remembered to add it to a list.
test('a mixed-kind catalogue: only the skill (and a bare pre-kind row) reach the offers list', () => {
  const isSkillOfferSrc = html.match(/function isSkillOffer\(it\)\{[\s\S]*?\n {2}\}/);
  const offerInstalledSrc = html.match(/function offerInstalled\(it, installedIds\)\{[\s\S]*?\n {2}\}/);
  assert.ok(isSkillOfferSrc, 'isSkillOffer moved or changed shape');
  assert.ok(offerInstalledSrc, 'offerInstalled moved or changed shape');
  const start = html.indexOf('// ---- group 2: From your rocks');
  const end = html.indexOf('// E7 (2026-08-10 tie audit)', start);
  assert.ok(start > -1 && end > start, 'the group-2 loop lives where the other tests in this file expect it');
  const loopSrc = html.slice(start, end);
  const runLoop = new Function('libs', 'installedIds', `
    ${isSkillOfferSrc[0]}
    ${offerInstalledSrc[0]}
    ${loopSrc}
    return byRock;
  `);
  const libs = [
    { it: { id: 'a-skill', kind: 'skill' }, rock: 'R' },
    { it: { id: 'a-legacy' }, rock: 'R' },   // no kind at all: a catalogue row written before kind existed
    { it: { id: 'a-prompt', kind: 'prompt' }, rock: 'R' },
    { it: { id: 'a-page', kind: 'page' }, rock: 'R' },
    { it: { id: 'a-dir', kind: 'dir' }, rock: 'R' },
    { it: { id: 'a-pack', kind: 'pack' }, rock: 'R' },
    { it: { id: 'a-sausage', kind: 'sausage' }, rock: 'R' },   // a kind nobody has invented yet
  ];
  const byRock = runLoop(libs, {});
  const ids = (byRock.R || []).map((l) => l.it.id).sort();
  assert.deepEqual(ids, ['a-legacy', 'a-skill'],
    'the skill and the bare pre-kind row reach the offers list; prompt, page, dir, pack and the invented kind do not');
});

test('every installed card carries its origin chip, with the version when a rock gave it', () => {
  assert.match(row, /<span class="chip origin">' \+ esc\(srcBadge\(s\)\)/, 'origin chip in the card head');
  const badge = html.split('function srcBadge(s)')[1].split('function offerFor(')[0];
  assert.match(badge, /'built-in'/);
  assert.match(badge, /'starter'/);
  assert.match(badge, /'yours'/);
  assert.match(badge, /' · v' \+ Number\(s\.version\)/, 'from <rock> · vN when skills-list carries the .origin.json version');
  assert.match(badge, /Number\(s\.version\) > 0 \?/, 'and no version when there is none');
});

test('Remove: an x on every card except engine skills, with an are-you-sure that names the skill', () => {
  assert.match(row, /if \(!s\.missing && s\.source !== 'engine'\) \{[\s\S]*?className = 'skx'/, 'the x is gated on the source not being engine');
  assert.match(row, /setAttribute\('aria-label', 'Remove ' \+ skTitle\(s\)\)/, 'aria-label names the skill');
  assert.match(row, /if \(!confirm\(msg\)\) return;\s*rockRemove\(s\.id, x, 'skillsNotice'\)/, 'confirm, then the shared remover');
  assert.match(row, /This is the only copy\./, 'self-authored removal says it is the only copy');
  const rem = html.split('function rockRemove(')[1].split('function rockRenderBoard(')[0];
  assert.match(rem, /run\('skill-remove', \{ id: id \}\)/, 'calls the verb');
  assert.match(rem, /notice\(noticeId, outLines\(rr\)\.slice\(-2\)\.join\('\\n'\)\);\s*loadSkills\(true\);/, 'prints the OK line, then reloads without eating it');
});

test('Read the skill on every card, rendering SKILL.md through mdRender with the origin block above', () => {
  assert.match(row, /className = 'act mini skread'/, 'the button');
  assert.match(row, /openSkillReader\(s\)/, 'opens the reader');
  const reader = html.split('function openSkillReader(s)')[1].split('function closeSkillReader()')[0];
  assert.match(reader, /run\('skill-read', \{ id: s\.id \}\)/, 'one verb');
  assert.match(reader, /mdRender\(stripFrontmatter\(p\.md\)\)/, 'the existing renderer, frontmatter stripped');
  const parse = html.split('function parseSkillRead(lines)')[1].split('function stripFrontmatter(')[0];
  for (const m of ['__SKILL__ ', '__META__ ', '__ORIGIN__ ']) assert.ok(parse.includes(m), `parses ${m.trim()}`);
  assert.ok(skillsSec.includes('id="skReader"') && skillsSec.includes('id="skReaderOrigin"') && skillsSec.includes('id="skReaderBody"'), 'the panel markup');
  assert.ok(row.indexOf("'Read the skill'") > row.indexOf('if (!s.missing)'), 'read sits with Run now, on installed cards');
  assert.ok(!/s\.source !== 'engine'[\s\S]{0,200}skread/.test(row), 'never gated on source: engine skills are readable too');
});

test('Update only when a rock offers a newer version, through the one installer, with a backup warning', () => {
  assert.match(row, /var newer = s\.missing \? null : offerNewer\(s\)/);
  const cmp = html.split('function offerNewer(s)')[1].split('function cadChip(')[0];
  assert.match(cmp, /\(Number\(o\.it\.version\) \|\| 0\) > \(Number\(s\.version\) \|\| 0\)/, 'strictly newer');
  assert.match(row, /newer \? ' <span class="chip configured upd">v' \+ esc\(String\(newerV\)\) \+ ' available<\/span>' : ''/, 'the chip only with an offer');
  assert.match(row, /if \(newer\) \{[\s\S]*?textContent = 'Update to v' \+ newerV/, 'the button only with an offer');
  assert.match(row, /kept under skill backups/, 'the are-you-sure says the old copy is kept');
  assert.match(row, /rockInstall\(newer, updBtn, 'skillsNotice'\)/, 'calls the shared installer');
});

test('the page head is one line with the explainer in a bubble (R28)', () => {
  const head = skillsSec.slice(0, skillsSec.indexOf('</div>'));
  assert.match(head, /<h2>Skills<button class="info"/, 'bubble on the heading');
  const p = (head.match(/<p>([^<]*)<\/p>/) || [])[1] || '';
  assert.ok(p.length > 0 && p.length < 80, 'one short line under the heading: ' + p);
  assert.ok(!/—/.test(skillsSec), 'zero em dashes in the section');
});

// ---- driven: the real page against the fixtures -----------------------------
// Needs the dev-harness playwright (cd wizard/dev-harness && npm i); skips
// cleanly when it is not there, like the other driven pins in this directory.
let chromium = null;
try { ({ chromium } = await import(join(HERE, '..', 'dev-harness', 'node_modules', 'playwright', 'index.mjs'))); } catch { /* no local playwright */ }

test('driven: groups per rock, origin chips, x off engine cards, read on all, update only where newer', { skip: !chromium && 'playwright not installed under wizard/dev-harness' }, async () => {
  const PORT = 4000 + Math.floor(Math.random() * 2000);
  const harness = spawn(process.execPath, [join(HERE, '..', 'dev-harness', 'harness.mjs'), '--port', String(PORT)], { stdio: 'pipe' });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('harness did not start')), 8000);
    harness.stdout.on('data', (d) => { if (String(d).includes('dev-harness up')) { clearTimeout(t); res(); } });
    harness.on('exit', (c) => rej(new Error('harness exited early ' + c)));
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://localhost:${PORT}/member`, { waitUntil: 'load' });
    await page.waitForTimeout(2000);
    await page.evaluate(() => { location.hash = '#skills'; });
    await page.waitForTimeout(1800);
    assert.deepEqual(await page.locator('#skillsGroups .skgroup').allTextContents(), ['On this mineral', 'From your rocks']);
    const rocks = await page.locator('#skillsGroups .skrock').evaluateAll((els) => els.map((e) => e.getAttribute('data-rock')));
    assert.deepEqual(rocks, ['Harbour Guild', 'Tide Collective'], 'one subsection per rock, in inbox order');
    const libs = await page.locator('#skillsGroups [data-lib]').evaluateAll((els) => els.map((e) => e.getAttribute('data-lib')));
    assert.deepEqual(libs, ['client-onboarding', 'tide-tables'], 'only offers not installed; inbox-triage (installed, newer offer) is NOT listed as an offer');
    const cards = await page.locator('#skillsGroups [data-skill]').count();
    assert.equal(await page.locator('#skillsGroups [data-skill] .chip.origin').count(), cards, 'every installed card has an origin chip');
    assert.equal(await page.locator('[data-skill="inbox-triage"] .chip.origin').innerText(), 'from Harbour Guild · v1');
    assert.equal(await page.locator('[data-skill="trip-planner"] .chip.origin').innerText(), 'yours');
    assert.equal(await page.locator('[data-skill][data-source="engine"] .skx').count(), 0, 'no x on engine cards');
    assert.equal(await page.locator('[data-skill]:not([data-source="engine"]) .skx').count(), 4, 'an x on every rock-published and self-authored card (Driftwood x2, Harbour Guild, yours), never on engine ones');
    assert.equal(await page.locator('[data-skill] .skread').count(), cards, 'Read the skill on every installed card');
    assert.equal(await page.locator('[data-skill] .skupdate').count(), 1, 'Update only on the one card whose offer is newer');
    assert.equal(await page.locator('[data-skill="inbox-triage"] .chip.upd').innerText(), 'v2 available');
    // the reader opens and renders the origin block above the markdown
    await page.locator('[data-skill="inbox-triage"] .info').click();
    await page.locator('[data-skill="inbox-triage"] .skread').click();
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('#skReader.open').count(), 1, 'reader open');
    assert.ok((await page.locator('#skReaderOrigin').innerText()).includes('Harbour Guild'), 'origin block names the rock');
    assert.equal(await page.locator('#skReaderBody h1').count(), 1, 'SKILL.md rendered, frontmatter stripped');
    assert.ok(!(await page.locator('#skReaderBody').innerText()).includes('origin-rock'), 'the R26 header is not shown as text');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#skReader.open').count(), 0, 'Escape closes it');
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
    harness.kill();
  }
});
