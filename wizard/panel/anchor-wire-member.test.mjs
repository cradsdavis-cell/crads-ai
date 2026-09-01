// anchor-wire-member.test.mjs — what T7 left behind after the face collapse
// (2026-09-01). The verb builders (anchor-wire, anchor-pubkeys, mineral-claim)
// still ride MEMBER_VERBS, so their command contracts stay pinned below. The
// APP FLOW around them is gone: the startup sweeps that claimed staged
// bundles, relayed public keys to the directory and claimed minerals for the
// signed-in account (wireAnchoredTies, claimMinerals) were deleted with the
// directory itself, and the adopted-row UI died with the org face. Those
// halves are pinned as retired at the end.
// Run: node --test wizard/panel/anchor-wire-member.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPanelServer, MEMBER_VERBS } from './panel-server.mjs';

const jwt = (email) => 'h.' + Buffer.from(JSON.stringify({ email })).toString('base64url') + '.s';
const KEY1 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb0eXAmpleKeyMaterial0000000000000000000000000';
const KEY2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb0eXAmpleKeyMaterial1111111111111111111111111';
const BUNDLE = { ok: true, org: 'acme', slug: 'jane01',
  bundle: { inbox_repo: 'acme-org/inbox-jane01', heartbeat_repo: 'acme-org/heartbeat-jane01', pull_token: 'pull-x', org_contact: { org: 'acme' } } };

// ---- verb builds: the command carries the contract ----------------------------
test('anchor-wire verb: bundle rides stdin, refusals + minting + PUBKEYS are in the script', () => {
  assert.throws(() => MEMBER_VERBS['anchor-wire'].build({ content_b64: 'not-base64!!' }));
  const b64 = Buffer.from(JSON.stringify(BUNDLE)).toString('base64');
  const v = MEMBER_VERBS['anchor-wire'].build({ content_b64: b64 });
  assert.equal(v.stdin, b64 + '\n', 'the bundle rides stdin, never argv');
  assert.match(v.command, /org-owned; its org wires it/, 'the org-owned refusal is in words');
  assert.match(v.command, /already carries a channel for/, 'the wrong-rock refusal is in words');
  assert.match(v.command, /ssh-keygen -q -t ed25519/, 'keys are minted ON the mineral');
  assert.match(v.command, /\[ -f \/state\/secrets\/org_inbox_deploy_key \] \|\|/, 'minting is idempotent');
  assert.match(v.command, /PUBKEYS /, 'only the public halves are printed');
  assert.ok(!/heartbeat_deploy_key"[^.]/.test(v.command.replace(/readFileSync\("\/state\/secrets\/[a-z_]+\.pub"/g, '')), 'no private key is ever read for output');
  assert.equal(MEMBER_VERBS['anchor-wire'].mutating, true);
});

test('anchor-pubkeys verb: org-scoped read, wired answers PUBKEYS, everything else NOTWIRED', () => {
  assert.throws(() => MEMBER_VERBS['anchor-pubkeys'].build({ org: 'Bad Org!' }));
  const v = MEMBER_VERBS['anchor-pubkeys'].build({ org: 'acme' });
  assert.match(v.command, /org-contact\.json/, 'wired-to-WHOM is checked, not just wired');
  assert.match(v.command, /NOTWIRED/, 'the miss is a named answer');
  assert.ok(!MEMBER_VERBS['anchor-pubkeys'].mutating, 'the probe never mutates');
});

// ---- the app flow: RETIRED (2026-09-01) ---------------------------------------
//
// Four driven tests exercised the startup wiring end to end (claim once, wire,
// relay, the T8 leave chain, the quiet 404). The wiring is deleted server-side:
// no directory, no staged bundle, no relay target. The pin holds that the
// machinery stays out of the server source.
test('the anchor adoption flow is RETIRED: no startup sweep wires or claims anything', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');
  const code = server.replace(/^\s*\/\/.*$/gm, '');
  for (const name of ['wireAnchoredTies', 'claimMinerals', 'ensureEdgesFresh', 'refreshCommunityMine']) {
    assert.ok(!code.includes(name), `${name} must stay gone`);
  }
});

// ---- ownership: the account claims the minerals it can reach -----------------
test('mineral-claim verb: the claim rides stdin, the RULES live in the tested module not the shell', () => {
  assert.throws(() => MEMBER_VERBS['mineral-claim'].build({ content_b64: 'not-base64!!' }));
  const payload = Buffer.from(JSON.stringify({ account_id: 'acc_' + 'a'.repeat(24), email: 'sam@x.com' })).toString('base64');
  const v = MEMBER_VERBS['mineral-claim'].build({ content_b64: payload });
  assert.equal(v.stdin, payload + '\n', 'the account rides stdin, never argv');
  assert.match(v.command, /mineral-identity\.mjs/, 'the rules come from the tested module');
  assert.match(v.command, /claimOwner/, 'and it is the claim path, not a raw file write');
  assert.match(v.command, /predates the ownership model/, 'an older mineral gets a sentence, not a stack trace');
  assert.match(v.command, /MINERAL /, 'it reports back what it recorded');
  assert.equal(MEMBER_VERBS['mineral-claim'].mutating, true);
  assert.ok(!MEMBER_VERBS['mineral-identity'].mutating, 'the read never mutates');
});

// (The driven claim-sweep test is retired with the flow above: the account
// system is gone, so nothing claims minerals for a signed-in identity.)

// ---- T8 UI half: RETIRED (2026-09-01) -----------------------------------------
//
// The adopted-row card (badge, wiring honesty, the metal-less Manage fold, the
// never-accused-of-going-dark rule) lived on the org face's fleet grid, and no
// mineral renders another's row any more. members-iter2.test.mjs pins the
// fleet surface as gone; here the specific strings stay dead too.
test('the adopted-row card is RETIRED from member.html', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('buildTieCard'), 'the tie-card builder must stay gone');
  const code = html.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!code.includes("'adopted'") && !code.includes('"adopted"'), 'no adopted badge string survives in code');
});
