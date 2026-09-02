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
  assert.match(html, /Your access to this community’s shared library has ended\. What you installed stays yours/, 'the revoked state speaks plainly');
  assert.match(html, /larger than this mineral accepts/, 'the size-cap state speaks plainly');
});

test('an unreadable community says WHICH blocker, and every stuck state gets Check again', () => {
  // Ruling 3 (2026-09-02): the pending GitHub invitation and the missing
  // sign-in each get their own sentence, rendered off the record's
  // access_hint; the generic case stays honest; all of them carry the
  // Check again button wired to community-check.
  assert.match(html, /c\.access_hint === 'pending-invite'/);
  assert.match(html, /GitHub sent you an invitation email from ' \+ \(c\.invite_from \|\| 'the community owner'\)/);
  assert.match(html, /then press Check again/);
  assert.match(html, /c\.access_hint === 'needs-github'/);
  assert.match(html, /Connect GitHub on Your mineral \(the Backup card\)/);
  assert.match(html, /run\('community-check', \{ org: c\.org \}\)/, 'Check again runs the check verb');
});

test('each community card carries its shared library: new first, existing installer, look stamped', () => {
  // Ruling 4 (2026-09-02): the storefront. Items render fresh-first with
  // name + description; installs ride the EXISTING catalog-install verb with
  // the community named as the source (never a new install path); opening the
  // fold stamps the look via community-seen.
  const block = html.slice(html.indexOf('function loadCommunities'), html.indexOf('// Files tab'));
  assert.match(block, /items\.sort\(function\(a, b\)\{ return \(b\.fresh \? 1 : 0\) - \(a\.fresh \? 1 : 0\); \}\)/, 'new things lead');
  assert.match(block, /'Shared library \(' \+ items\.length/, 'the fold names itself in plain words');
  assert.match(block, /', ' \+ c\.fresh_count \+ ' new'/, 'the new count is on the summary');
  assert.match(block, /var args = \{ id: it\.id, rock: c\.org \};/, 'the community is the named source');
  assert.match(block, /run\('catalog-install', args\)/, 'installs ride the one existing installer');
  assert.match(block, /run\('community-seen', \{ org: c\.org \}\)/, 'opening the fold stamps the look');
  assert.match(block, /Read and copy it on the Library page\./, 'prompts point at their real surface');
  assert.ok(!/new RegExp/.test(block), 'nothing box-supplied is compiled');
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
  assert.match(html, /run\('commons-revoke', alsoGithub \? \{ id: g\.id, github: true \} : \{ id: g\.id \}\)/,
    'revoke carries the GitHub half exactly when the grant names a username');
  assert.match(html, /run\('commons-create', \{ payload_b64: /, 'Start a community drives the create verb');
  assert.match(html, /if \(name === 'publish'\) loadCommons\(\);/, 'loads with the Catalogue page');
});

test('Start a community is one field; the old form is the Advanced fold, unchanged', () => {
  assert.match(html, /<input id="commonsName" placeholder="Harbour Guild"/, 'one human-words field');
  assert.match(html, /<input type="checkbox" id="commonsOpenCk">/, 'the open-community checkbox');
  assert.match(html, /Open community: anyone with the link can pull the library/);
  assert.match(html, /Advanced: bring your own repository<span class="sum2">Any git host, your own URL and key<\/span>/);
  assert.match(html, /<input id="commonsUrl"/, 'the BYO form survives whole');
  assert.match(html, /start\.style\.display = s\.configured \? 'none' : 'block';/, 'the start block hides once configured');
});

test('no GitHub sign-in on the hub reveals the SAME device flow the Backup card runs, in place', () => {
  assert.match(html, /if \(\/no GitHub sign-in\/i\.test\(text\)\) \{ var gc = \$\('commonsGhConnect'\); if \(gc\) gc\.style\.display = 'block'; \}/,
    'the refusal opens the connect step instead of a dead end');
  const i = html.indexOf('function commonsObStart');
  assert.ok(i > 0);
  const flow = html.slice(i, i + 900);
  assert.match(flow, /fetch\('\/own-brain\/start'/, 'the own-brain precedent, exactly');
  assert.match(html, /commonsCreate\(\);\s*return;\s*\}/, 'a finished sign-in retries the create by itself');
});

test('the grant output leads with the join link and keeps the honest fallbacks', () => {
  assert.match(html, /'JOIN_LINK '/, 'the link is lifted off the verb output');
  assert.match(html, /copyBtn\('Copy join link', link\)/);
  assert.match(html, /copyBtn\('Copy invitation text', bundle\)/);
  assert.match(html, /invite their GitHub account as a read collaborator/i, 'the manual reminder survives for the paths that need it');
  assert.match(html, /remove their read access on your git host/i);
});

test('member-facing copy says shared library, never the jargon', () => {
  // Ruling 4's vocabulary half: "commons" stays the owner card's proper noun;
  // the member page speaks of a community's SHARED LIBRARY, and mint/grant/
  // roster/org id never reach member-visible copy. The protocol prefix
  // (cradscommons1:) is the one literal a member legitimately sees.
  const sec = html.slice(html.indexOf('<section data-sec="commons">'), html.indexOf('<section data-sec="publish">'))
    .replace(/cradscommons1/g, '');
  assert.match(sec, /shared library/i);
  for (const word of [/ commons/i, /\bmint\b/i, /\broster\b/i, /\borg id\b/i, /\bbundle\b/i, /\bgrant\b/i]) {
    assert.ok(!word.test(sec), `member section copy still carries ${word}`);
  }
});

test('sentence case and no em dashes in the new copy', () => {
  for (const anchor of ['data-sec="commons"', 'Commons<button', 'commJoinFold', 'commonsSetupFold']) {
    const i = html.indexOf(anchor);
    assert.ok(i >= 0, anchor);
    const slice = html.slice(i, i + 2500);
    assert.ok(!slice.includes('\u2014'), `no em dash near ${anchor}`);
  }
});
