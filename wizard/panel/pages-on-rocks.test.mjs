// pages-on-rocks.test.mjs — the client half of R15 (panel iteration 2,
// 2026-08-23), pinned structurally (hooks and wiring, never copied prose).
//   node --test wizard/panel/pages-on-rocks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MEMBER_VERBS } from './panel-server.mjs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const fn = (name) => {
  const i = html.indexOf('function ' + name + '(');
  assert.ok(i > 0, name + ' exists');
  return html.slice(i, html.indexOf('\n  }\n', i) + 4);   // the function body only
};

test('the edition wall is RETIRED (2026-09-01): page: routes open on the one face', () => {
  // R15's original pin held that the org face stopped blocking page: routes
  // while the member-section wall (IS_ORG && MEM_SECS) still stood. The face
  // collapse deleted the wall wholesale: there is no IS_ORG, no MEM_SECS, and
  // page: routes just open. The stronger truth is that the wall stays gone.
  const wall = html.slice(html.indexOf('function activateSec('), html.indexOf('function activateSec(') + 8000);
  assert.ok(!wall.includes('IS_ORG'), 'no edition check anywhere in activateSec');
  assert.ok(!html.includes('MEM_SECS'), 'the member-section allowlist is gone from the shell');
  assert.match(wall, /name\.indexOf\('page:'\) === 0\) openMemberPage/, 'page: routes still open the page');
});

test('the connect branch loads the page list on the rising edge', () => {
  // There is one connect branch now (no 'Connected as' org wording), and it
  // must still refresh the page nav when the connection comes up.
  const i = html.indexOf("$('connStat').textContent = 'Connected to your mineral'");
  assert.ok(i > 0, 'the one connected state exists');
  assert.ok(!html.includes("'Connected as '"), 'the org-face connected wording is gone');
  assert.match(html.slice(i, i + 800), /loadPagesList\(\)/, 'loadPagesList() runs on the rising edge');
});

test('seeded entries get a chip, rock-pushed entries get an origin chip, every page gets Delete', () => {
  const head = fn('pageHead');
  assert.match(head, /p\.seed === true/, 'keyed on the manifest seed flag');
  assert.match(head, /data-pagechip="seed"/, 'seed chip hook');
  assert.match(head, /p\.from/, 'rock origin read');
  assert.match(head, /data-pagechip="from"/, 'origin chip hook');
  assert.match(head, /data-pagedel="' \+ esc\(p\.id\)/, 'delete control carries the id, escaped');
  const nav = fn('renderMemberNav');
  assert.match(nav, /pageHead\(p\)/, 'the section is built with the header');
  assert.match(nav, /class="pagebody"/, 'and a body the fragment renders into');
  assert.match(nav, /\[data-pagedel\]/, 'delete controls are wired after render');
  const open = fn('openMemberPage');
  assert.match(open, /querySelector\('\.pagebody'\)/, 'the fragment lands in the body, not over the header');
});

test('delete asks first, names the page, runs page-delete, then refreshes the list', () => {
  const del = fn('deleteMemberPage');
  assert.match(del, /confirm\(/, 'an are-you-sure stands in front of it');
  assert.match(del, /p\.title \|\| id/, 'the confirm names the page');
  assert.match(del, /run\('page-delete', \{ id: id \}\)/, 'the verb and its contract');
  assert.match(del, /loadPagesList\(\)/, 'the nav is rebuilt from the manifest afterwards');
  assert.ok(MEMBER_VERBS['page-delete'] && MEMBER_VERBS['page-delete'].mutating === true, 'page-delete is a mutating member verb');
});

test('sentence case and no em dashes in the new page chrome', () => {
  for (const name of ['pageHead', 'deleteMemberPage']) {
    const src = fn(name);
    assert.ok(!src.includes('—'), name + ': no em dashes');
    assert.ok(!/Example Page|Delete Page/.test(src), name + ': sentence case');
  }
});
