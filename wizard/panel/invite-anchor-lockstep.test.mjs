// invite-anchor-lockstep.test.mjs — the two parsers of one invite payload.
//   node --test wizard/panel/invite-anchor-lockstep.test.mjs
//
// Finding 136 (2026-08-16) was ONE FIELD READ BY TWO READERS WITH OPPOSITE
// MEANINGS: the invite's dotted `org` segment is the STAGING LANE the redeem is
// brokered through, which cockpit/jobs/fulfil-arrivals.mjs sets to `crads-solo`
// on every link it mints, anchored or not. The /join page read that as "this
// pebble has no organisation, so skip the sign-in step" and silently stripped
// sign-in from every rock-anchored pebble. The fix put the ANCHOR in the payload
// (field 7) and made the page test that instead.
//
// The page's parser learned the field. Its own header names the app's
// parseInviteLink as its "server-side twin", and the twin did not: it
// destructures six fields positionally and drops the seventh, so the app could
// not tell an anchored invite from a solo one however carefully the minter
// filled it in. Two parsers of one format, disagreeing about what the format is,
// is the shape 136 already cost a run. So this pins them to each other rather
// than to a hand-copied index.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInviteLink, isSoloInvite } from './member-connect.mjs';
import { parseJoinFragment, isSolo } from '../join-page/join-parse.mjs';

/** The exact shape cockpit/tools/invite-link.mjs mints: host|sip|user|token|||anchor. */
const link = (slug, anchor = '', lane = 'crads-solo') => {
  const payload = Buffer.from(`${slug}.crads-ai.com|198.51.100.7|member|tok-abc123|||${anchor}`, 'utf8')
    .toString('base64url');
  return `https://crads-ai.com/join#v1.${lane}.${slug}.${payload}`;
};

test('both parsers read the anchor out of the same field', () => {
  const l = link('jane01', 'acme-rock');
  const page = parseJoinFragment(l.split('#')[1]);
  const app = parseInviteLink(l);
  assert.equal(page.anchor, 'acme-rock', 'the /join page reads field 7 (it has since 136)');
  assert.equal(app.anchor, 'acme-rock', 'and so must its server-side twin, or the app cannot tell them apart');
  assert.equal(app.anchor, page.anchor);
});

test('a genuinely solo invite reports no anchor in either parser', () => {
  const l = link('solo01');
  assert.equal(parseJoinFragment(l.split('#')[1]).anchor, '');
  assert.equal(parseInviteLink(l).anchor, '', 'empty, never undefined: a reader testing truthiness must get the same answer');
});

test('a link minted before the anchor existed still parses, and claims no anchor', () => {
  // Four fields, the pre-136 shape. Old links must not suddenly read as anchored.
  const payload = Buffer.from('old01.crads-ai.com|198.51.100.7|member|tok-old', 'utf8').toString('base64url');
  const l = `https://crads-ai.com/join#v1.crads-solo.old01.${payload}`;
  assert.equal(parseInviteLink(l).anchor, '');
  assert.equal(parseJoinFragment(l.split('#')[1]).anchor, '');
  assert.equal(isSolo(parseJoinFragment(l.split('#')[1])), true, 'the lane test is the only signal an old link carries');
});

test('the anchor does not disturb the six fields the app already destructures', () => {
  const app = parseInviteLink(link('jane01', 'acme-rock'));
  assert.equal(app.slug, 'jane01');
  assert.equal(app.host, 'jane01.crads-ai.com');
  assert.equal(app.sip, '198.51.100.7');
  assert.equal(app.user, 'member');
  assert.equal(app.token, 'tok-abc123');
  assert.equal(app.tierName, '', 'fields 5 and 6 stay tier_name/tier_description (factory#2)');
  assert.equal(app.tierDescription, '');
});

// ---------------------------------------------------------------------------
// THE LANE IS STILL THE RIGHT ANSWER TO ITS OWN QUESTION, and this is here so
// the next reader does not "finish" 136 by pointing isSoloInvite at the anchor.
//
// isSoloInvite gates ONE thing: whether the redeem runs the browser sign-in
// handshake, because that produces an id_token for A ROCK TO VERIFY. The rock
// that verifies is the one that MINTED the invite and stored its token_hash
// (brain-template control/auto-approve.mjs, gate 5: `!tokenHash ||
// sha256(entry.token) !== tokenHash` refuses, fail-closed). A pebble the
// MOUNTAIN builds for a rock is minted by the Mountain, so the rock holds no
// token_hash for it and could only refuse; its claim is drained by
// cockpit/jobs/enrol-arrivals.mjs on the crads-solo lane, which never reads an
// id_token at all.
//
// So pointing this at the anchor would open a browser window the member must
// finish, to mint a proof nothing on either side reads. The lane names the
// APPROVER; the anchor names the OWNER. Different questions, and member-connect.html
// already carries the scar from answering the first one with `!!r.org`
// (2026-08-14: every self-serve member was told to read a six-character code to
// a rock that did not exist).
test('the solo predicate reads the lane, deliberately, and not the anchor', () => {
  const anchored = parseInviteLink(link('jane01', 'acme-rock'));
  assert.equal(anchored.anchor, 'acme-rock', 'it is anchored');
  assert.equal(isSoloInvite(anchored), true,
    'and still takes the solo REDEEM path, because the Mountain minted it and the Mountain approves it');
  const rockMinted = parseInviteLink(link('jane01', '', 'acme-rock'));
  assert.equal(isSoloInvite(rockMinted), false, 'a rock-minted link is approved by that rock, so it verifies');
});
