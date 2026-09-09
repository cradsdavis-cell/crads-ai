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
// the skills section runs to whatever section follows it in source order
const skillsStart = html.indexOf('<section data-sec="skills">');
const nextSec = html.indexOf('<section ', skillsStart + 1);
const skillsSec = html.slice(skillsStart, nextSec > -1 ? nextSec : html.indexOf('</main>', skillsStart));
const render = html.split('function renderSkills()')[1].split('function skillRow(')[0];
const row = html.split('function skillRow(s, st, gated)')[1].split('function sendToSignIn(')[0];

test('one group on one page, no tabs (the community group left 2026-09-09)', () => {
  assert.ok(!skillsSec.includes('class="tabs"'), 'no tab strip');
  assert.match(render, /skGroupHead\(box, 'On this mineral'\)/, 'the installed group');
  assert.ok(!render.includes("skGroupHead(box, 'From your communities')"), 'no offers group');
  assert.ok(!render.includes('libEntries('), 'nothing reads a catalogue');
});




test('every installed card carries its origin chip (built-in, starter, yours)', () => {
  assert.match(row, /<span class="chip origin">' \+ esc\(srcBadge\(s\)\)/, 'origin chip in the card head');
  const badge = html.split('function srcBadge(s)')[1].split('\n  function ')[0];
  assert.match(badge, /'built-in'/);
  assert.match(badge, /'starter'/);
  assert.match(badge, /'yours'/);
  assert.ok(!badge.includes('s.rock'), 'no from-<rock> badge: communities left 2026-09-09');
});

test('Remove: an x on every card except engine skills, with an are-you-sure that names the skill', () => {
  assert.match(row, /if \(!s\.missing && s\.source !== 'engine'\) \{[\s\S]*?className = 'skx'/, 'the x is gated on the source not being engine');
  assert.match(row, /setAttribute\('aria-label', 'Remove ' \+ skTitle\(s\)\)/, 'aria-label names the skill');
  assert.match(row, /if \(!confirm\(msg\)\) return;\s*removeSkill\(s\.id, x, 'skillsNotice'\)/, 'confirm, then the shared remover');
  assert.match(row, /This is the only copy\./, 'every removal says it is the only copy (nothing can offer one back since 2026-09-09)');
  const rem = html.split('function removeSkill(')[1].split('function skillRow(')[0];
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

