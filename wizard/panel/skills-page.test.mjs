// skills-page.test.mjs — P1 of the skills/cadence/library spec (2026-08-04):
// the skills-list + skill-run member verbs, the Skills system page wiring in
// member.html, and the category vocabulary on the engine's own skills.
//   node --test wizard/panel/skills-page.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { MEMBER_VERBS, VERBS } from './panel-server.mjs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const CATEGORIES = ['briefing', 'capture', 'comms', 'box', 'org', 'other'];

// ---- verbs -----------------------------------------------------------------

test('skills-list runs the engine-side enumerator and degrades honestly on old images', () => {
  const cmd = MEMBER_VERBS['skills-list'].build().command;
  assert.match(cmd, /node \/app\/engine\/appshell\/skills-list\.mjs \/state/,
    'the enumeration lives in the engine on the box, not in a shell quoting tower');
  assert.match(cmd, /SKILLS_STATE \{"skills":\[\]/,
    'a box whose image predates the script answers with an empty state, not a shell error');
  assert.ok(!MEMBER_VERBS['skills-list'].mutating, 'skills-list is read-only');
});

test('skill-run validates the id app-side, checks existence box-side, and goes through the kernel', () => {
  assert.equal(MEMBER_VERBS['skill-run'].mutating, true, 'running a skill mutates the box');
  for (const evil of ['../evil', 'UPPER', 'a b', 'x;rm -rf /', '', 'a'.repeat(64)]) {
    assert.throws(() => MEMBER_VERBS['skill-run'].build({ id: evil }), /kebab-case/,
      `id "${evil}" must be rejected app-side`);
  }
  const cmd = MEMBER_VERBS['skill-run'].build({ id: 'plan-week' }).command;
  assert.match(cmd, /\[ -f "\$BR\/\.claude\/skills\/plan-week\/SKILL\.md" \]/,
    'existence-checked on the box, under the brain root, before anything runs');
  assert.match(cmd, /enqueue\.mjs \/state plan-week --source=dashboard/,
    'submitted through the kernel queue (single-writer), tagged with the sanctioned dashboard source');
  assert.match(cmd, /kernel\.mjs \/state --once/, 'drained in the same round trip');
  assert.match(cmd, /skill-runs\.json/, 'the last-run stamp lands so the page reflects the run');
});

test('the org edition does not gain a member skill-runner', () => {
  // The rock's own-box Skills page is a later pass; nothing here may quietly
  // widen the org verb table (org-side verb narrowing is an open item in the
  // three-layer model).
  assert.ok(!VERBS['skill-run'], 'no skill-run in the org verb table');
});

// ---- member.html wiring ------------------------------------------------------

test('Skills is a native system page: nav button, section, activation, loader', () => {
  assert.match(html, /<button data-sec="skills">/, 'nav button present');
  assert.match(html, /<section data-sec="skills">/, 'section present');
  // Warmth-guarded since the 2026-08-09 lag audit: tab re-entry within 60s
  // serves what is on screen instead of re-firing the SSH verb.
  assert.match(html, /if \(name === 'skills' && Date\.now\(\) - skillsWarmAt > 60000\) \{ skillsWarmAt = Date\.now\(\); loadSkills\(\); \}/, 'activateSec branch present');
  // takes `keep` since trap 23: the flag is the loader's contract with the verbs
  // that reload after writing their own confirmation, not an optional extra.
  assert.match(html, /function loadSkills\(keep\)/, 'loader present, carrying the preserve flag');
});

// The merged page (2026-08-09 audit R6): one cadence-list round trip carries the
// inventory too, and everything parses through the shared seg/prefix helper.
test('loadSkills rides cadence-list and parses through the shared helper, never a raw lines join', () => {
  const fn = html.split('function loadSkills(')[1].split('function skTitle(')[0];
  assert.match(fn, /run\('cadence-list', \{\}\)/, 'one round trip for skills + schedules + machinery');
  assert.match(fn, /parseCadenceText\(outText\(r\)\)/, 'parses filtered text through the shared parser');
  assert.doesNotMatch(fn, /r\.lines[^)]*\.join/, 'no unfiltered r.lines join in the loader');
  const parser = html.split('function parseCadenceText(')[1].split('function loadSkills(')[0];
  assert.match(parser, /SKILLS_STATE \(\.\*\)/, 'the inventory still arrives as the prefixed JSON line');
});

// R6: human names lead, the slash id stays visible as the invocation chip.
test('rows lead with the human title and wear the /id as a chip', () => {
  assert.match(html, /function skTitle\(s\)/, 'title resolver exists');
  const t = html.split('function skTitle(s)')[1].split('function renderSkills()')[0];
  assert.match(t, /if \(s\.title\) return s\.title;/, 'frontmatter title wins');
  assert.match(t, /charAt\(0\)\.toUpperCase\(\)/, 'de-kebab + title-case fallback');
  const row = html.split('function skillRow(s, st, gated)')[1].split('function ago(')[0];
  assert.match(row, /esc\(skTitle\(s\)\)/, 'the heading is the human name');
  assert.match(row, /<span class="chip">\/' \+ esc\(s\.id\)/, 'the slash id rides as a chip');
});

// R6: the Cadence editor lives on every row now; the page saves as one file.
test('every row carries the schedule toggle + editor, and Save writes the v2 file', () => {
  const row = html.split('function skillRow(s, st, gated)')[1].split('function ago(')[0];
  assert.match(row, /schedControls\(entry\)/, 'the full editor is inline');
  assert.match(row, /role', 'switch'/, 'the toggle keeps its switch semantics');
  assert.match(row, /querySelector\('\.cadchip'\)/, 'commit updates the cadence chip, not the first chip (the /id chip renders first)');
  assert.match(html, /run\('cadence-write', \{ content_b64: b64utf8\(payload\) \}\)/, 'save still writes the whole v2 file');
});

test('every engine skill carries a human title', () => {
  const dir = new URL('../../engine/skills/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const fm = (readFileSync(new URL(f, dir), 'utf8').match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
    assert.ok(/^title:\s*\S/m.test(fm), `${f} carries a title: for the Skills page heading`);
  }
});

test('the renderer groups by the six spec categories and badges provenance', () => {
  for (const key of CATEGORIES) assert.match(html, new RegExp(`key: '${key}'`), `category '${key}' rendered`);
  assert.match(html, /'built-in'/, 'engine badge');
  // The org-source fallback stopped naming "your rock" with the face collapse
  // (2026-09-01): a rock is a role a community hub plays, so the badge speaks
  // of the community instead.
  assert.match(html, /'from your community'/, 'org badge (community unknown)');
  assert.match(html, /'starter'/, 'seed badge');
  assert.match(html, /'yours'/, 'member badge');
});

// ---- engine skill catalog carries the vocabulary ------------------------------

test('every engine skill declares a category from the spec vocabulary', () => {
  const dir = new URL('../../engine/skills/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const fm = (readFileSync(new URL(f, dir), 'utf8').match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
    const cat = ((fm.match(/^category:\s*(\S+)/m) || [])[1] || '');
    assert.ok(CATEGORIES.includes(cat), `${f} category "${cat}" must be one of ${CATEGORIES.join('|')}`);
  }
});
