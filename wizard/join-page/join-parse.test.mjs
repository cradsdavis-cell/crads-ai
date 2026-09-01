import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJoinFragment, downloadFor } from './join-parse.mjs';

const payload = Buffer.from('jane01.crads-ai.com|203.0.113.9|member|inv_jane01_tok123').toString('base64url');
const FRAG = `v1.acme.jane01.${payload}`;

test('valid fragment parses to the full invite + app deep link', () => {
  const r = parseJoinFragment('#' + FRAG);
  assert.equal(r.ok, true);
  assert.equal(r.org, 'acme');
  assert.equal(r.slug, 'jane01');
  assert.equal(r.host, 'jane01.crads-ai.com');
  assert.equal(r.token, 'inv_jane01_tok123');
  assert.equal(r.appUrl, 'crads-ai://join/' + FRAG);
});

test('garbage, wrong version, bad names, undecodable payloads all refuse politely', () => {
  for (const f of ['', '#', 'v2.a.b.c', 'v1.acme', 'v1.!!.jane01.' + payload, 'v1.acme.JANE.' + payload, 'v1.acme.jane01.%%%']) {
    assert.equal(parseJoinFragment(f).ok, false, f);
  }
});

test('payload missing host or token refuses', () => {
  const bad = Buffer.from('|1.2.3.4|member|').toString('base64url');
  assert.equal(parseJoinFragment('v1.acme.jane01.' + bad).ok, false);
});

test('downloadFor picks by platform, flags phones, always has a url', () => {
  assert.match(downloadFor('Mozilla/5.0 (Windows NT 10.0)').label, /Windows/);
  assert.match(downloadFor('Mozilla/5.0 (Macintosh; Intel Mac OS X)').label, /Mac/);
  assert.equal(downloadFor('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)').mobile, true, 'iPhone is mobile, never "Download for Mac"');
  assert.equal(downloadFor('Mozilla/5.0 (Linux; Android 14)').mobile, true);
  assert.ok(!downloadFor('Mozilla/5.0 (Windows NT 10.0)').mobile);
  assert.ok(downloadFor('weird').url.startsWith('https://'));
  // FINDING: the button must fetch the FILE, not the release list. /releases/latest
  // 302s to the repo's release page here, because the rolling build is a prerelease
  // and GitHub excludes prereleases from `latest`, so every platform button dropped
  // the member on a list of four files and asked them to choose.
  assert.match(downloadFor('Mozilla/5.0 (Windows NT 10.0)').url, /\/crads-ai\.exe$/);
  assert.match(downloadFor('Mozilla/5.0 (Macintosh; Intel Mac OS X)').url, /\/crads-ai-mac\.zip$/);
  for (const ua of ['Mozilla/5.0 (Windows NT 10.0)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', 'weird']) {
    assert.ok(!/releases\/latest/.test(downloadFor(ua).url), `${ua} must not point at the empty latest`);
  }
  // An iPad reports "Mac", so the phone test has to win or a tablet is offered a
  // desktop bundle it cannot open.
  assert.equal(downloadFor('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)').mobile, true);
});

// ---- finding 136: the staging lane is not the anchor -----------------------
import { isSolo } from './join-parse.mjs';

const mk = (lane, slug, fields) => 'v1.' + lane + '.' + slug + '.'
  + Buffer.from(fields.join('|'), 'utf8').toString('base64url');

test('an anchored pebble is NOT solo, even though its lane is crads-solo', () => {
  // exactly what fulfil-arrivals mints for a rock-stamped pebble
  const inv = parseJoinFragment(mk('crads-solo', 'qa-member-four',
    ['qa-member-four.crads-ai.com', '178.104.168.45', 'member', 'tok', '', '', 'qa-r2-gmail']));
  assert.equal(inv.ok, true);
  assert.equal(inv.anchor, 'qa-r2-gmail');
  assert.equal(isSolo(inv), false, 'a rock-anchored pebble must keep its sign-in step');
});

test('a genuinely standalone pebble is solo', () => {
  const inv = parseJoinFragment(mk('crads-solo', 'solo-one',
    ['solo-one.crads-ai.com', '1.2.3.4', 'member', 'tok', '', '', '']));
  assert.equal(inv.anchor, '');
  assert.equal(isSolo(inv), true);
});

test('a link minted before the anchor existed keeps its old behaviour', () => {
  const solo = parseJoinFragment(mk('crads-solo', 'old-one',
    ['old-one.crads-ai.com', '1.2.3.4', 'member', 'tok']));
  assert.equal(solo.anchor, '', 'no anchor field on a pre-136 link');
  assert.equal(isSolo(solo), true, 'unchanged: the lane was the only signal it had');
  const org = parseJoinFragment(mk('acme', 'old-two',
    ['old-two.crads-ai.com', '1.2.3.4', 'member', 'tok']));
  assert.equal(isSolo(org), false);
});

test('the anchor is inert to a parser that reads the first four fields', () => {
  // parseInviteLink in member-connect.mjs destructures positionally, so a
  // seventh field must not disturb host/sip/user/token
  const inv = parseJoinFragment(mk('crads-solo', 'qa-member-four',
    ['qa-member-four.crads-ai.com', '178.104.168.45', 'member', 'tok', '', '', 'qa-r2-gmail']));
  assert.equal(inv.host, 'qa-member-four.crads-ai.com');
  assert.equal(inv.sip, '178.104.168.45');
  assert.equal(inv.user, 'member');
  assert.equal(inv.token, 'tok');
});

// ---- finding 158: naming the lane is a SECOND question off the same field ---
import { orgLabel } from './join-parse.mjs';

test('158: an anchored pebble is named by its anchor, never by its lane', () => {
  // Live and verbatim on crads-ai.com, 2026-08-16: "You'll need the Crads-AI app
  // for crads-solo." That pebble is anchored to qa-r2-gmail. 136 taught the page
  // to read the anchor to decide WHETHER to name an org; the name it then printed
  // was still the lane.
  const inv = parseJoinFragment(mk('crads-solo', 'qa-member-six',
    ['qa-member-six.crads-ai.com', '178.104.168.45', 'member', 'tok', '', '', 'qa-r2-gmail']));
  assert.equal(orgLabel(inv), 'qa-r2-gmail');
});

test('158: nothing to name on a standalone pebble, and the lane is not it', () => {
  const inv = parseJoinFragment(mk('crads-solo', 'solo-one',
    ['solo-one.crads-ai.com', '1.2.3.4', 'member', 'tok', '', '', '']));
  assert.equal(orgLabel(inv), '', 'crads-solo is a route handle; there is no organisation to name');
});

test('158: a rock-minted link is named by its lane, which really is that rock', () => {
  // The one case where the lane IS the answer: a rock's own panel mints with its
  // own handle in the lane and no anchor in the payload.
  const inv = parseJoinFragment(mk('acme', 'jane01', ['jane01.crads-ai.com', '1.2.3.4', 'member', 'tok']));
  assert.equal(orgLabel(inv), 'acme');
});

test('158: a malformed anchor loses its NAME and keeps its sign-in', () => {
  // The two questions must be able to disagree. isSolo stays a bare truthiness
  // test so it cannot drift from signInRequired() in member-connect.mjs, which is
  // what enforces the sign-in; only the printed name is validated, and it fails
  // to nothing rather than to something invented.
  const inv = parseJoinFragment(mk('crads-solo', 'weird01',
    ['weird01.crads-ai.com', '1.2.3.4', 'member', 'tok', '', '', '<b>Commonwealth Bank</b>']));
  assert.equal(inv.anchor, '<b>Commonwealth Bank</b>', 'parsed raw: the solo test needs it whole');
  assert.equal(orgLabel(inv), '', 'but nothing a member reads');
  assert.equal(isSolo(inv), false, 'and it still is not solo, so the sign-in step stands');
});

test('158: a bad invite names nothing at all', () => {
  assert.equal(orgLabel(parseJoinFragment('v2.a.b.c')), '');
  assert.equal(orgLabel(null), '');
});
