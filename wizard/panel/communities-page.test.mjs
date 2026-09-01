// communities-page.test.mjs: the Communities page (member face) and the
// Commons card (org face) in member.html, source-pinned the way
// library-page.test.mjs pins its page (self-host pivot, 2026-09-01).
//   node --test wizard/panel/communities-page.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

test('the Communities nav entry is member-only and its section is edition-walled', () => {
  assert.match(html, /<button class="memonly" data-sec="commons">/, 'nav entry, member face only');
  assert.match(html, /<section data-sec="commons">/, 'the section exists');
  assert.match(html, /var MEM_SECS = \['seat', 'commons'\]/, 'a rock operator deep link can never land on it');
  // the sec id is NOT "communities" because that hash is a live alias to the
  // Rocks page (renamed 2026-08-09); pinned so nobody renames into the alias.
  assert.match(html, /if \(name === 'communities'\) name = 'rocks';/, 'the old alias is untouched');
});

test('the page loads on entry and wires the three member verbs', () => {
  assert.match(html, /if \(name === 'commons'\) loadCommunities\(\);/, 'activation loads the list');
  assert.match(html, /run\('community-list', \{\}\)/);
  assert.match(html, /run\('community-join', \{ bundle: bundle \}\)/);
  assert.match(html, /run\('community-leave', \{ org: c\.org \}\)/);
});

test('leaving asks first and says what stays', () => {
  const confirmCall = html.match(/window\.confirm\('Leave ' \+ [^)]+\)/);
  assert.ok(confirmCall, 'leave is confirmed, not instant');
  assert.match(html, /Everything you installed from it stays yours/, 'the standing ruling is in the copy');
});

test('access-ended renders as one honest sentence, not error noise', () => {
  assert.match(html, /Your access to this commons has ended\. What you installed stays yours/, 'the revoked state speaks plainly');
  assert.match(html, /larger than this mineral accepts/, 'the size-cap state speaks plainly');
});

test('every rendered community string goes through textContent, never innerHTML', () => {
  const commBlock = html.slice(html.indexOf('function loadCommunities'), html.indexOf('// Files tab'));
  assert.ok(commBlock.length > 500, 'found the communities block');
  assert.ok(!/innerHTML\s*=\s*[^'"]/.test(commBlock.replace(/innerHTML = '';/g, '')), 'only the clearing assignment');
  assert.match(commBlock, /textContent/);
});

test('the org face Commons card wires the owner verbs and never the member ones', () => {
  assert.match(html, /run\('commons-status', \{\}\)/);
  assert.match(html, /run\('commons-publish', \{\}\)/);
  assert.match(html, /run\('commons-init', \{ payload_b64: /);
  assert.match(html, /run\('commons-grant', \{ payload_b64: /);
  assert.match(html, /run\('commons-revoke', \{ id: g\.id \}\)/);
  assert.match(html, /if \(name === 'publish'\) loadCommons\(\);/, 'loads with the Catalogue page');
});

test('the grant copy carries the host-ACL reminder where the owner will read it', () => {
  assert.match(html, /invite their GitHub account as a read collaborator/i);
  assert.match(html, /remove their read access on your git host/i);
});

test('sentence case and no em dashes in the new copy', () => {
  for (const anchor of ['data-sec="commons"', 'Commons<button', 'commJoinFold', 'commonsSetupFold']) {
    const i = html.indexOf(anchor);
    assert.ok(i >= 0, anchor);
    const slice = html.slice(i, i + 2500);
    assert.ok(!slice.includes('\u2014'), `no em dash near ${anchor}`);
  }
});
