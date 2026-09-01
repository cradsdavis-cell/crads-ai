// sharing-iter2.test.mjs — panel iteration 2 (2026-08-23), Sharing page:
// R10 (rock face: no toggles, no Save), R9/R2 copy (who receives the update,
// one model, no self-contradiction), and the run_ledger chip matching its
// mechanism. Run: node --test wizard/panel/sharing-iter2.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');
// the rendered page, not its source comments (those narrate the old copy)
const sec = html.slice(html.indexOf('<section data-sec="sharing">'), html.indexOf('<section data-sec="secrets">'))
  .replace(/<!--[\s\S]*?-->/g, '');

function attrs(id) {
  const m = sec.match(new RegExp(`<[a-z]+[^>]*id="${id}"[^>]*>`));
  assert.ok(m, `#${id} exists on the Sharing page`);
  return m[0];
}

test('R10: the rock face hides the consent toggles and Save; the member face keeps them', () => {
  assert.match(attrs('sharingRows'), /class="[^"]*\bmemberonly\b/, 'the toggle rows are member-only');
  assert.match(attrs('sharingSave'), /class="[^"]*\bmemberonly\b/, 'Save sharing choices is member-only');
  // the face rule that makes memberonly mean something on a rock
  assert.match(html, /body\[data-edition="org"\] \.memberonly\{display:none !important\}/);
  // and the rock face is not left with nothing: Public brain, the three
  // always-on rows and Support access are all face-visible there
  assert.match(attrs('pubBrainCard'), /orgonly/, 'Public brain is the rock face\'s one switch');
  const floor = sec.slice(sec.indexOf('<h3 class="gtitle">What Crads AI receives from this rock'), sec.indexOf('id="sharingWhoCard"'));
  assert.equal((floor.match(/class="lockchip">always on</g) || []).length, 2, 'the two always-on rows keep their lock chips (billing events left with the self-host strip)');
  assert.doesNotMatch(floor, /toggles below/, 'the floor card no longer promises toggles a rock does not have');
  const support = sec.slice(sec.indexOf('Support access'));
  assert.doesNotMatch(support.slice(0, 400), /orgonly|memberonly/, 'Support access shows on both faces');
});

test('the rock floor rows each name where the fact is produced', () => {
  const floor = sec.slice(sec.indexOf('<h3 class="gtitle">What Crads AI receives from this rock'), sec.indexOf('id="sharingWhoCard"'));
  assert.match(floor, /Hosting health<\/b>[\s\S]{0,200}directory registry snapshot/, 'hosting health: the registry snapshot');
  assert.match(floor, /Seat counts<\/b>[\s\S]{0,120}Produced by the directory/, 'seat counts: the directory');
  assert.doesNotMatch(floor, /Billing events/, 'the billing-events row stays dead (self-host strip, 2026-09-01)');
  assert.match(floor, /<h3 class="gtitle">What Crads AI receives from this rock<button class="info"/, 'and a bubble on the card title');
});

test('one model of who receives the update: the same filtered record to the anchor and every joined rock', () => {
  assert.match(sec, /Your anchor rock receives a small status update from your mineral, and each rock you have joined receives the same update once that tie is wired; the wiring happens by itself in the minutes after a join completes\./);
  assert.doesNotMatch(sec, /community floor/i, 'the self-contradicting community-floor paragraph is gone');
  assert.doesNotMatch(sec, /fixed while joined/, 'no promise of a joined minimum that does not flow');
  // R9's box side landed 2026-08-23 (engine/box/heartbeat-push.sh pushes the
  // filtered heartbeat to every /state/heartbeat.d/<rock>.conf), so the page
  // must no longer under-disclose what leaves the box
  assert.doesNotMatch(sec, /receive nothing|Not yet for joined rocks|rock-side half/, 'the retired "not yet" caveat does not survive anywhere on the page');
  const who = sec.slice(sec.indexOf('id="sharingWhoCard"') - 80, sec.indexOf('id="sharingWho"'));
  assert.match(who, /button class="info"[^>]*data-tip="Yes\. Every rock you are tied to receives the same filtered status update/, 'the bubble says joined rocks receive the same filtered update');
  assert.match(who, /shares nothing beyond this status record/, 'and still says joining adds nothing beyond the record');
  assert.doesNotMatch(sec, /Not flowing yet/, 'the old bold caveat is retired');
});

test('the heading has a bubble and the sub-copy is one line, both faces', () => {
  const head = sec.slice(0, sec.indexOf('</div>'));
  assert.match(head, /<h2>Sharing<button class="info" type="button"[^>]*data-tip="[^"]{40,}"/);
  assert.match(head, /<p>What leaves your mineral, and who receives it\.<\/p>/);
  const override = html.match(/setHead\('sharing', '([^']*)', '([^']*)'\)/);
  assert.ok(override, 'the rock face overrides through setHead');
  assert.ok(override[1].length <= 120 && !/[.!?] [A-Z]/.test(override[1]), 'one short line on the rock face too');
  assert.doesNotMatch(override[2], /toggles are your recorded consent/, 'the rock bubble no longer describes toggles');
  assert.doesNotMatch(html, /shead\.textContent = 'Sharing'/, 'nothing wipes the h2 (and its bubble) after setHead');
});

test('the run_ledger chip matches its mechanism: partly shared, inside the floor group', () => {
  const row = html.match(/\{ k: 'run_ledger'[^\n]*/)[0];
  assert.match(row, /cat: '__floor__'/, 'it stays in the floor group: the box\'s own jobs always ride');
  assert.match(row, /part: true/, 'and is marked partial');
  assert.match(row, /only while Skill engagement is on/, 'with the gate named in the meaning');
  const render = html.slice(html.indexOf('function renderPreview()'), html.indexOf('function renderPreview()') + 4000);
  assert.match(render, /f\.part \? 'partly shared' : 'always shared'/, 'the chip reads the flag');
  assert.equal((html.match(/part: true/g) || []).length, 1, 'run_ledger is the only partial floor key');
});

test('no em dashes in anything the Sharing page renders', () => {
  assert.doesNotMatch(sec, /\u2014/);
  const js = html.slice(html.indexOf('var SHARE_CATS = ['), html.indexOf("$('sharingSave').onclick"));
  assert.doesNotMatch(js.replace(/^\s*\/\/.*$/gm, ''), /\u2014/, 'nor in the strings the rows are built from');
});
