// join-page-html.test.mjs: the SHIPPED page, driven, not the module beside it.
//   node --test wizard/join-page/join-page-html.test.mjs
//
// Why this file exists (finding 141, live QA 2026-08-16). index.html carries an
// inline copy of join-parse.mjs because the page ships as one static file with no
// external fetches, and the header says KEEP IN LOCKSTEP. Nothing checked that it
// was. Commit d16110f landed the finding-136 anchor fix and its message said "both
// now carry the anchor field and the same solo test"; `--stat` shows it touched
// join-parse.mjs and its test, and nothing else. The deployed copy on
// samdavis-site got the fix. THIS one did not, and wizard/dev-harness/harness.mjs
// serves it at /join, so every design and QA pass since has been driving a page
// that is not the product: "Join your rock", a 14-day expiry, no anchor parsing.
//
// join-parse.test.mjs cannot catch that: it imports the module, which was right
// all along. So this evaluates the page's own <script> against a stub DOM and
// reads back what a member would actually have seen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJoinFragment, isSolo, orgLabel } from './join-parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(HERE, 'index.html'), 'utf8');
// Copy assertions run against the page WITHOUT its comments: the comments record
// what the wrong copy used to say, and a test that reads them would fail on its
// own explanation.
const VISIBLE = PAGE.replace(/<!--[\s\S]*?-->/g, '');

const el = (initial = {}) => ({
  style: {}, innerHTML: '', textContent: '', value: '', href: '', firstChild: null,
  addEventListener() {}, removeEventListener() {}, insertBefore() {}, appendChild() {},
  focus() {}, select() {}, ...initial,
});

// The two rows the script REWRITES rather than fills, so the stub has to start
// holding what the HTML ships or the test cannot tell "left alone" from "blank".
const shipped = (re) => (VISIBLE.match(re) || [])[1] || '';
const STEP3_HTML = shipped(/<li id="step3">([\s\S]*?)<\/li>/);
const EXPIRY_TEXT = shipped(/<p class="fine" id="expiry">([\s\S]*?)<\/p>/);

/** Run index.html's inline script for one invite link; return the elements it painted. */
function render(fragment, userAgent = 'Mozilla/5.0 (Windows NT 10.0)') {
  const src = (PAGE.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
  assert.ok(src, 'found the page\'s inline script');
  const ids = ['opening', 'fallback', 'badlink', 'orgline', 'orgline2', 'dlBtn', 'copyBtn',
    'retry', 'pasteLink', 'pasteMsg', 'badwhy', 'openAnyway', 'step3', 'expiry'];
  const dom = Object.fromEntries(ids.map((id) => [id, el()]));
  dom.step3 = el({ innerHTML: STEP3_HTML });
  dom.expiry = el({ textContent: EXPIRY_TEXT });
  const ctx = createContext({
    document: {
      getElementById: (id) => dom[id] || null,
      createElement: () => el(),
      addEventListener() {}, removeEventListener() {},
      hidden: false, body: { appendChild() {}, removeChild() {} },
    },
    // the page ends by handing the whole invite to the app; capture it instead
    location: { hash: '#' + fragment, href: '', pathname: '/join', replace() {}, reload() {} },
    navigator: { userAgent },
    // tryApp's 2s probe never has to fire: the assertions are about the paint
    setTimeout: () => 0,
    atob: (b) => Buffer.from(b, 'base64').toString('binary'),
  });
  runInContext(src, ctx);
  return { dom, handedToApp: ctx.location.href };
}

const mk = (lane, slug, fields) => 'v1.' + lane + '.' + slug + '.'
  + Buffer.from(fields.join('|'), 'utf8').toString('base64url');

// Exactly what fulfil-arrivals mints for a rock-stamped pebble: lane crads-solo,
// anchor qa-r2-gmail in payload field 7.
const ANCHORED = mk('crads-solo', 'qa-member-five',
  ['qa-member-five.crads-ai.com', '178.105.231.90', 'member', 'tok', '', '', 'qa-r2-gmail']);
const SOLO = mk('crads-solo', 'solo-one', ['solo-one.crads-ai.com', '1.2.3.4', 'member', 'tok', '', '', '']);
const ORG = mk('acme', 'jane01', ['jane01.crads-ai.com', '1.2.3.4', 'member', 'tok']);

test('141: a rock-anchored pebble keeps its sign-in step on the page that ships', () => {
  const { dom, handedToApp } = render(ANCHORED);
  assert.match(dom.step3.innerHTML, /Sign in with the email address/,
    'the anchored member must be told to sign in; the lane said crads-solo and this page used to believe it');
  assert.doesNotMatch(dom.step3.innerHTML, /no password, no sign-in/);
  assert.equal(handedToApp, 'crads-ai://join/' + ANCHORED, 'and the invite still reaches the app whole');
});

// REVERSED by Harriet's audit 2026-08-21, point 5. The page used to replace step 3 with
// "no password, no sign-in" for a standalone pebble, which was an accurate description of
// the flow until the flow changed: signInRequired() in member-connect.mjs now returns true
// for a solo invite, so the page has to stop promising the opposite. The org line is a
// SEPARATE question off the same field (finding 158) and is deliberately unchanged.
test('141: a standalone pebble now KEEPS the sign-in step, and still loses the org line', () => {
  const { dom } = render(SOLO);
  assert.match(dom.step3.innerHTML, /Sign in with the email address this invite was sent to/);
  assert.doesNotMatch(dom.step3.innerHTML, /no password, no sign-in/,
    'the old promise must not survive anywhere the member can read it');
  assert.equal(dom.orgline.innerHTML, '', 'nothing to name: crads-solo is a route handle, not a rock');
  assert.equal(dom.orgline2.innerHTML, '');
});

// THE NEW INVARIANT, and the reason the sign-in step is no longer a useful lockstep probe:
// every lane prints it now, so it can no longer tell the fixtures apart.
test('every invite, whatever its lane, promises the sign-in the flow performs', () => {
  for (const frag of [ANCHORED, SOLO, ORG]) {
    const { dom } = render(frag);
    assert.match(dom.step3.innerHTML, /Sign in with the email address this invite was sent to/,
      `${frag.slice(0, 24)}… must not tell the member the claim is passwordless`);
  }
});

test('141: the page and join-parse.mjs answer solo the same way, fixture for fixture', () => {
  // The lockstep the file header claims. A drift here is exactly d16110f again.
  //
  // THE OBSERVABLE MOVED with the change above: step 3 is now identical on every lane, so
  // asking it which fixture is solo would pass trivially and pin nothing. What the page
  // still decides off isSolo is WHETHER IT NAMES A ROCK, so that is what this compares.
  for (const frag of [ANCHORED, SOLO, ORG]) {
    const wantSolo = isSolo(parseJoinFragment('#' + frag));
    const { dom } = render(frag);
    const pageSaysSolo = dom.orgline.innerHTML === '';
    assert.equal(pageSaysSolo, wantSolo, `page and module disagree on ${frag.slice(0, 24)}…`);
  }
});

test('140: the page promises the 48 hours the claim TTL actually enforces', () => {
  // CLAIM_TTL_MS in cockpit/jobs/enrol-arrivals.mjs. The welcome email says 48
  // hours; this page said 14 days, a number nothing enforces anywhere.
  assert.doesNotMatch(VISIBLE, /14 days/, 'no unenforced expiry promise in anything the member reads');
  assert.match(render(SOLO).dom.expiry.textContent, /good for 48 hours/);
  const anchored = render(ANCHORED).dom.expiry.textContent;
  assert.match(anchored, /48 hours/, 'the anchored variant carries the same number');
  assert.match(anchored, /revoke it sooner/, 'and the caveat only an anchored member needs');
});

// ---- finding 158 -----------------------------------------------------------
// The FOURTH reader of the lane in the 135 -> 136 -> 139 chain, and the one that
// survived 136 in the very file 136 fixed: the anchor decided WHETHER to name an
// organisation and the lane was then printed as its name.
const BAD_ANCHOR = mk('crads-solo', 'weird01',
  ['weird01.crads-ai.com', '1.2.3.4', 'member', 'tok', '', '', '<b>Commonwealth Bank</b>']);
const shownOrg = (dom) => (dom.orgline2.innerHTML.match(/<span class="org">([^<]*)<\/span>/) || [])[1] || '';

test('158: the page names the rock that owns the pebble, not the staging lane', () => {
  // Live and verbatim on crads-ai.com, 2026-08-16: "You'll need the Crads-AI app
  // for crads-solo." The pebble is anchored to qa-r2-gmail.
  const { dom } = render(ANCHORED);
  assert.equal(shownOrg(dom), 'qa-r2-gmail');
  assert.doesNotMatch(dom.orgline2.innerHTML, /crads-solo/, 'the member has never seen that word and it is not theirs');
  assert.doesNotMatch(dom.orgline.innerHTML, /crads-solo/, 'the "Opening the app…" line carries the same name');
  assert.equal(dom.orgline.innerHTML, dom.orgline2.innerHTML, 'and it is the SAME string, painted twice');
});

test('158: a rock-minted link still names its lane, which really is that rock', () => {
  // The one case where the lane is the answer: a rock's own panel puts its handle
  // there and no anchor in the payload. Unchanged behaviour, asserted so the fix
  // above cannot quietly take it away.
  assert.equal(shownOrg(render(ORG).dom), 'acme');
});

test('158: a malformed anchor loses its NAME and keeps its sign-in step', () => {
  // The two questions have to be allowed to disagree. Only the paint is validated;
  // the solo test stays a bare truthiness check on the anchor so it cannot drift
  // from signInRequired() in member-connect.mjs, which is what actually enforces
  // the sign-in. Failing to nothing beats failing to something invented.
  const { dom } = render(BAD_ANCHOR);
  assert.equal(dom.orgline2.innerHTML, '', 'nothing printed');
  assert.match(dom.step3.innerHTML, /Sign in with the email address/, 'and the sign-in step is not gated on the name');
});

test('158: the page and join-parse.mjs pick the same name, fixture for fixture', () => {
  // Same lockstep guard as the solo test above, for the second question off the
  // same field. A drift here is d16110f again.
  for (const frag of [ANCHORED, SOLO, ORG, BAD_ANCHOR]) {
    assert.equal(shownOrg(render(frag).dom), orgLabel(parseJoinFragment('#' + frag)),
      `page and module disagree on ${frag.slice(0, 24)}…`);
  }
});

test('142: the page names the door button that exists', () => {
  // The door offers "I have an invitation" and "Join a community". The second
  // wants a rock handle, not an invite link, so "choose Join" pointed the reader
  // at the one screen this link cannot answer.
  assert.match(VISIBLE, /choose <b>I have an invitation<\/b>/);
  assert.doesNotMatch(VISIBLE, /choose <b>Join<\/b>/);
});
