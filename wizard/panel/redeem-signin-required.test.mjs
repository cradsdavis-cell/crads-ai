// redeem-signin-required.test.mjs: finding 159 (2026-08-16), the app half.
//   node --test wizard/panel/redeem-signin-required.test.mjs
//
// crads-ai.com/join tells the member, in these words: "Sign in with the email address this
// invite was sent to. The invite only works for that address." Observed live: the link was
// opened SIGNED OUT, this surface auto-submitted, and the claim COMPLETED. Finding 136 put the
// sign-in STEP back on the page. This is the flow behind it, which had none, because the app
// decided by the LANE (crads-solo on every Mountain-minted invite, anchored or not) while the
// page decided by the ANCHOR. One field, two readers, opposite meanings: 136 exactly, one
// layer down.
//
// The two BOUNDARIES are asserted here too, and both of them pass on the pre-fix code as well,
// which is the point of writing them: a genuinely solo pebble must still claim with no browser
// window at all, and a broker that is merely DOWN must still fall back silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createMemberConnectServer, signInRequired, parseInviteLink, stageWithDirectory } from './member-connect.mjs';
import { parseJoinFragment, isSolo } from '../join-page/join-parse.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const tmp = () => tmpDir('mc-signin-');

/** Exactly the bytes cockpit/tools/invite-link.mjs mints: host|sip|user|token|||anchor. */
const link = (slug, anchor = '', lane = 'crads-solo') => {
  const payload = Buffer.from(`${slug}.crads-ai.com|198.51.100.7|member|tok-abc123|||${anchor}`, 'utf8').toString('base64url');
  return `https://crads-ai.com/join#v1.${lane}.${slug}.${payload}`;
};
const ANCHORED = link('six', 'acme-rock');   // a rock-stamped pebble, staged on the solo lane
const SOLO = link('solo01');                 // a standalone pebble: field 7 is empty

const listen = (opts) => new Promise((resolve) => {
  const s = createMemberConnectServer({ port: 0, host: '127.0.0.1', htmlText: '<html>connect</html>',
    claudeSettingsPath: join(tmp(), 'settings.json'), sshDir: tmp(), ...opts });
  s.on('listening', () => resolve(s));
});
const post = (s, body) => fetch(`http://127.0.0.1:${s.address().port}/redeem`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------------------
test('the page and the flow now agree about which invites are account-bound', () => {
  const page = parseJoinFragment(ANCHORED.split('#')[1]);
  assert.equal(isSolo(page), false, '/join prints the sign-in step for an anchored invite');
  assert.equal(signInRequired(parseInviteLink(ANCHORED)), true, 'and the flow behind it performs one');
  // The one place they still differ, deliberately: a ROCK-MINTED link (lane = the rock, no
  // anchor field). The page calls it non-solo off the lane, and Sam's 2026-08-09 ruling is
  // that on that lane the link IS the proof, so refusing a tokenless claim there would reverse
  // a live product decision this finding did not ask about. Named so nobody "finishes" it.
  const rockMinted = parseInviteLink(link('six', '', 'acme-rock'));
  assert.equal(signInRequired(rockMinted), false);
});

test('an ANCHORED invite runs the sign-in the page promised', async () => {
  let calls = 0;
  const staged = [];
  const s = await listen({
    idTokenProvider: async () => { calls += 1; return 'anchored.id.token'; },
    stageWithDirectory: async (i, pub, fp, extra) => { staged.push({ i, extra }); return true; },
  });
  try {
    const j = await (await post(s, { link: ANCHORED })).json();
    assert.equal(calls, 1, 'the lane says crads-solo; the anchor says a rock owns this mineral');
    assert.equal(j.id_token_sent, true);
    assert.equal(staged[0].extra.idToken, 'anchored.id.token');
  } finally { s.close(); }
});

test('an ANCHORED invite whose sign-in does not complete stages NOTHING', async () => {
  let stagedCalls = 0;
  const s = await listen({
    // the real failure shapes: window closed, popup blocked, offline for that one call
    idTokenProvider: async () => { throw new Error('the sign-in window was closed'); },
    stageWithDirectory: async () => { stagedCalls += 1; return true; },
  });
  try {
    const r = await post(s, { link: ANCHORED });
    assert.equal(r.status, 401);
    assert.match((await r.json()).error, /locked to the email address/);
    assert.equal(stagedCalls, 0, 'a swallowed sign-in used to stage tokenless and say nothing');
  } finally { s.close(); }
});

test('the WIRE body names the host and the anchor, so the broker can look the mineral up', async () => {
  const bodies = [];
  const fetcher = async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200 }; };
  await stageWithDirectory(parseInviteLink(ANCHORED), 'ssh-ed25519 AAAA key', 'ABC234',
    { idToken: 'a.b.c', fetcher, directoryUrl: 'https://dir.example' });
  assert.equal(bodies[0].host, 'six.crads-ai.com', 'names WHICH boxreg: row to read');
  assert.equal(bodies[0].anchor, 'acme-rock', 'and declares the anchor, which only ever adds a demand');
  // and a solo invite declares no anchor at all, so the field cannot be read as one
  await stageWithDirectory(parseInviteLink(SOLO), 'ssh-ed25519 AAAA key', 'ABC234',
    { fetcher, directoryUrl: 'https://dir.example' });
  assert.ok(!('anchor' in bodies[1]));
});

// ---------------------------------------------------------------------------------------
// BOUNDARY 1: the genuinely solo path. Passes before and after, on purpose.
// REVERSED BY Harriet's audit 2026-08-21, point 5, and kept as a test rather than deleted
// because the property it really guards (no frozen button) still has to hold.
//
// The old contract was "a solo invite never opens a browser window", on the grounds that a
// standalone pebble has no rock for a token to prove anything to. That stopped being true
// when POST /redeem became the token's own reader: it verifies, binds by nonce and records
// the address without any rock involved. Until then the invite link was the entire proof of
// a solo claim, so a forwarded link claimed the box, and cohort one arrives mostly on that
// lane. So the window IS opened now, and what survives from the old test is its second
// assertion: asking must not be able to hang.
test('a GENUINELY SOLO invite now runs the sign-in too, and still cannot hang', async () => {
  let calls = 0;
  const s = await listen({
    idTokenProvider: () => { calls += 1; return new Promise(() => {}); },   // never settles
    stageWithDirectory: async () => true,
    // A SERVER option, never a body field: the bound is the operator's, and a timeout the
    // caller could name is a timeout an attacker could set to zero.
    signInTimeoutMs: 50,
  });
  try {
    const started = Date.now();
    const j = await (await post(s, { link: SOLO })).json();
    assert.equal(calls, 1, 'the standalone lane is account-bound now, so it asks');
    // A provider that never settles is a member who closed the window: refused, not staged,
    // and not silently downgraded to the tokenless claim this whole change removes.
    assert.equal(j.staged, undefined, 'nothing is staged without the sign-in it just demanded');
    assert.match(String(j.error || ''), /locked to the email address/);
    assert.ok(Date.now() - started < 5000, 'and it must not hang waiting for one');
  } finally { s.close(); }
});

// BOUNDARY 2: a broker that is DOWN is not a broker that said no.
test('an unreachable broker still falls back silently, exactly as before', async () => {
  const s = await listen({
    idTokenProvider: async () => 'anchored.id.token',
    stageWithDirectory: async () => false,   // what an outage looks like to this caller
  });
  try {
    const r = await post(s, { link: ANCHORED });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).staged, false, 'nothing central is required');
  } finally { s.close(); }
});

test('a broker that REFUSES the account is told apart from a broker that is down', async () => {
  const inv = parseInviteLink(ANCHORED);
  const at = (status, body) => async () => ({ ok: false, status, json: async () => body });
  // 403: the account gate saying no about WHO this is. There is no honest fallback for that,
  // and returning r.ok made it arrive at the page as staged:false, which reads as "the broker
  // is down, carry on with the manual path". The silent downgrade wearing an outage's clothes.
  await assert.rejects(
    () => stageWithDirectory(inv, 'ssh-ed25519 AAAA key', 'ABC234',
      { fetcher: at(403, { error: 'that mineral belongs to a different account' }), directoryUrl: 'https://dir.example' }),
    /different account/);
  await assert.rejects(
    () => stageWithDirectory(inv, 'ssh-ed25519 AAAA key', 'ABC234',
      { fetcher: at(401, { error: 'this invite is locked to the address it was sent to' }), directoryUrl: 'https://dir.example' }),
    /locked to the address/);
  // Everything else keeps the fail-silent contract this function has always had. 400 included:
  // a malformed envelope is our bug, not the member's, and the Phase-1 manual path can still
  // complete that claim.
  for (const code of [400, 500, 502]) {
    assert.equal(await stageWithDirectory(inv, 'ssh-ed25519 AAAA key', 'ABC234',
      { fetcher: at(code, { error: 'nope' }), directoryUrl: 'https://dir.example' }), false, `HTTP ${code} stays silent`);
  }
  assert.equal(await stageWithDirectory(inv, 'ssh-ed25519 AAAA key', 'ABC234',
    { fetcher: async () => { throw new Error('ECONNREFUSED'); }, directoryUrl: 'https://dir.example' }), false,
  'and a dead socket most of all');
});
