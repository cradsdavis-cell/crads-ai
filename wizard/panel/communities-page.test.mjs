// communities-page.test.mjs: the Communities page (member face) and the
// Commons card (org face) in member.html, source-pinned the way
// library-page.test.mjs pins its page (self-host pivot, 2026-09-01).
//   node --test wizard/panel/communities-page.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

test('the Communities nav entry is on the one nav and the old aliases land here', () => {
  // The face collapse (2026-09-01) deleted the edition wall: there is no
  // memonly class and no MEM_SECS allowlist any more, and the #communities
  // hash now aliases to THIS page (it used to point at the retired Rocks
  // page, which itself now lands on commons).
  assert.match(html, /<button data-sec="commons">/, 'nav entry, no face class');
  assert.match(html, /<section data-sec="commons">/, 'the section exists');
  assert.ok(!html.includes('MEM_SECS'), 'the member-section allowlist is gone');
  assert.match(html, /if \(name === 'communities'\) name = 'commons';/, 'the communities alias lands here');
  assert.match(html, /if \(name === 'rocks' \|\| name\.indexOf\('rocks\/'\) === 0 \|\| name === 'rockbrain'\) name = 'commons';/,
    'old rock deep links land here too');
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
  // Two innerHTML writes are legitimate: the list-clearing assignment and the
  // Share back fold's static <option> markup (a fixed single-quoted literal
  // with no concatenation, so nothing box-supplied can ride it). Anything
  // else, in particular any assignment that builds its string, is the bug.
  const scrubbed = commBlock.replace(/innerHTML = '[^']*';/g, '');
  assert.ok(!/innerHTML\s*=/.test(scrubbed), 'only clearing and static-literal assignments');
  assert.match(commBlock, /textContent/);
});

test('day zero opens the join fold, and each card carries the Share back fold', () => {
  // Two additions from the face collapse pass (2026-09-01): an empty list
  // opens #commJoinFold so the one thing to do leads the page, and every
  // community card grows a Share back fold that stages a contribution via the
  // community-share verb. The hint must keep saying nothing is sent by
  // itself: staging is local, the pull request is the member's own act.
  assert.match(html, /if \(jf && !items\.length\) jf\.open = true;/, 'the join fold opens itself on an empty list');
  assert.match(html, /shBtn\.textContent = 'Share back\\u2026'/, 'the fold is reached from a Share back button');
  assert.match(html, /run\('community-share', \{ org: c\.org, kind: shKind\.value, id: id \}\)/, 'the verb and its contract');
  assert.match(html, /nothing is sent anywhere by itself/, 'the hint keeps the no-send promise');
  assert.match(html, /shGo\.textContent = 'Stage it'/, 'staging is the verb the button speaks');
});

test('the Catalogue page Commons card wires the owner verbs', () => {
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
