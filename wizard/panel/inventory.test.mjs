// inventory.test.mjs — the merge rules behind the one-list door.
// Spec: docs/superpowers/specs/2026-08-13-mineral-inventory.md
//
// Every case here pins a finding or a ruling from that spec's audit, per the
// standing rule (a fix lands with the test that pins it, in the same commit).
// The module is pure, so all of this runs with no network, no ~/.ssh and no
// directory worker — which is the point: ruling 4 makes offline a first-class
// state, and a rule that could only be exercised online would rot exactly where
// it matters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collapseLocal, mergeInventory, orderInventory, anchorAlias, heldOf,
  slugOfHost, slugOfTarget, tierFromAlias,
} from './inventory.mjs';

const localOf = (...targets) => collapseLocal(targets);

// ---------------------------------------------------------------- join key
test('the join key survives both directions and a stray suffix', () => {
  assert.equal(slugOfHost('aster.crads-ai.com'), 'aster');
  assert.equal(slugOfHost('aster-box.crads-ai.com'), 'aster');
  assert.equal(slugOfHost('ASTER.crads-ai.com'), 'aster');
  assert.equal(slugOfTarget({ org: 'aster' }), 'aster');
  assert.equal(tierFromAlias('acme-rock'), 'rock');
  assert.equal(tierFromAlias('aster-box'), 'pebble');
});

// ------------------------------------------------------- ruling 7: one row
test('RULING 7: a promoted box collapses to ONE row, and it is a rock', () => {
  // listPanelTargets emits BOTH of these for a promoted box: the member row
  // from the `-box` alias, plus the PROMOTED overlay's rock row under the same
  // alias (ssh-bridge.mjs:187). The door drew two cards for one mineral, which
  // asserts the D44 two-editions model that the 2026-08-09 ruling reversed.
  const rows = localOf(
    { host: 'aster-box', org: 'aster', kind: 'member' },
    { host: 'aster-box', org: 'aster', kind: 'rock', promoted: true },
  );
  assert.equal(rows.length, 1, 'a mineral is a mineral');
  assert.equal(rows[0].tier, 'rock', "the box's own answer beats the alias suffix");
  assert.equal(rows[0].alias, 'aster-box', 'a promoted rock keeps its -box alias');
});

test('collapse is order-independent: the rock row may arrive first', () => {
  const rows = localOf(
    { host: 'aster-box', org: 'aster', kind: 'rock', promoted: true },
    { host: 'aster-box', org: 'aster', kind: 'member' },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tier, 'rock');
});

test('two genuinely different minerals are never collapsed', () => {
  const rows = localOf(
    { host: 'acme-rock', org: 'acme', kind: 'rock' },
    { host: 'aster-box', org: 'aster', kind: 'member' },
  );
  assert.equal(rows.length, 2);
});

// ------------------------------------- finding 8: the subtraction that never was
test('FINDING 8: a mineral already on this machine is never offered as connectable', () => {
  // listEnrollable returns EVERY registered box with no subtraction, and
  // acctDevices rendered all of it, so the door offered to connect this
  // computer to minerals this computer already had open. This is the exact
  // question Sam asked and the exact way it was answered wrongly.
  const rows = mergeInventory({
    local: localOf({ host: 'aster-box', org: 'aster', kind: 'member' }),
    account: [{ host: 'aster.crads-ai.com', label: 'Aster', tier: 'pebble', held_by: 'you' }],
    boxes: [{ host: 'aster.crads-ai.com' }],
    email: 'sam@crads-ai.com',
  });
  assert.equal(rows.length, 1, 'one mineral, one row, not one per source list');
  assert.equal(rows[0].onDevice, true);
  assert.equal(rows[0].enrollable, false, 'already here: nothing to connect');
});

test('an account mineral NOT on this machine is the one that offers Connect', () => {
  const rows = mergeInventory({
    local: [],
    account: [{ host: 'harbour.crads-ai.com', label: 'Harbour Guild', tier: 'rock', held_by: 'someone else' }],
    boxes: [{ host: 'harbour.crads-ai.com' }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].onDevice, false);
  assert.equal(rows[0].enrollable, true);
  assert.equal(rows[0].alias, '', 'nothing to dial until it admits this machine');
  assert.equal(rows[0].host, 'harbour.crads-ai.com',
    'the ask must carry the name the directory issued, never the slug or a local alias');
});

test('FINDING 9: a grant with no registered box offers no button it cannot honour', () => {
  // The old hint pointed at a "Connect this computer" control that only drew
  // when /account/devices returned rows, so the instruction dangled. The
  // mirror-image bug is a button with nothing on the other end of the request.
  const rows = mergeInventory({
    local: [],
    account: [{ host: 'notyet.crads-ai.com', label: 'Not Yet', tier: 'pebble', held_by: 'you' }],
    boxes: [],
  });
  assert.equal(rows[0].onDevice, false);
  assert.equal(rows[0].enrollable, false, 'listed so you know it exists; not offered as actionable');
});

// ------------------------------------------- ruling 5: key vs account, flagged
test('RULING 5: a key-opened mineral with no grant is LISTED and FLAGGED', () => {
  // Sam, 2026-08-10: signed in with an unrelated account and read the list as
  // that account's holdings. The key stays sovereign, so the row must open;
  // the row must also say what it was measured against.
  const rows = mergeInventory({
    local: localOf({ host: 'legacy-box', org: 'legacy', kind: 'member' }),
    account: [],
    email: 'other@example.com',
  });
  assert.equal(rows.length, 1, 'never hidden: the key is what opens it');
  assert.equal(rows[0].onDevice, true);
  assert.equal(rows[0].flagged, true);
  assert.equal(rows[0].flagAccount, 'other@example.com', 'names the account it is NOT on');
});

test('RULING 5 / RULING 4: null account is "we do not know yet" and flags NOTHING', () => {
  // The load-bearing distinction. [] means we asked and this account holds
  // nothing (so every local row is genuinely off-account). null means offline,
  // signed out, or the worker is down — flagging there would accuse every
  // mineral on the machine of being unauthorised every time a plane took off.
  const rows = mergeInventory({
    local: localOf({ host: 'aster-box', org: 'aster', kind: 'member' }),
    account: null,
    email: '',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].flagged, false, 'unknown is not the same as absent');
  assert.equal(rows[0].flagAccount, '');
});

// ------------------------------------------------- ruling 4: offline is first class
test('RULING 4: with no account layer at all, the machine list still renders whole', () => {
  const rows = mergeInventory({
    local: localOf(
      { host: 'acme-rock', org: 'acme', kind: 'rock' },
      { host: 'aster-box', org: 'aster', kind: 'member' },
    ),
    account: null,
  });
  assert.equal(rows.length, 2, 'nothing on this machine becomes unopenable because a server was down');
  assert.deepEqual(rows.map((r) => r.tier), ['rock', 'pebble'], 'tier from the alias, never blank');
  assert.deepEqual(rows.map((r) => r.label), ['acme', 'aster'], 'the slug stands in until a label arrives');
});

test('the account tier wins over the alias guess once it answers', () => {
  // FINDING 4: tier was already on the wire (door-server.mjs:337) and thrown
  // away. A promoted box whose alias still ends -box is exactly the case where
  // the suffix lies and the directory's mineral record does not.
  const rows = mergeInventory({
    local: localOf({ host: 'aster-box', org: 'aster', kind: 'member' }),
    account: [{ host: 'aster.crads-ai.com', label: 'Aster', tier: 'rock', held_by: 'you' }],
  });
  assert.equal(rows[0].tier, 'rock');
  assert.equal(rows[0].label, 'Aster', 'the human name replaces the slug once known');
});

// ------------------------------------------------ ruling 6: who holds it
test('RULING 6: an org-held pebble names its holder, and is NOT "shared"', () => {
  // "Shared with you" is false for a member's own working assistant, and false
  // in exactly the anchored shape cohort one ships in.
  assert.deepEqual(heldOf({ held_by: 'Acme CoLab' }), { held: 'org', holder: 'Acme CoLab' });
  assert.deepEqual(heldOf({ held_by: 'you' }), { held: 'you', holder: '' });
  assert.deepEqual(heldOf({ held_by: 'someone else' }), { held: 'other', holder: '' });
  assert.deepEqual(heldOf({}), { held: 'unknown', holder: '' }, 'offline says nothing rather than guessing');

  const rows = mergeInventory({
    local: localOf({ host: 'aster-box', org: 'aster', kind: 'member' }),
    account: [{ host: 'aster.crads-ai.com', label: 'Aster', tier: 'pebble', held_by: 'Acme CoLab' }],
  });
  assert.equal(rows[0].held, 'org');
  assert.equal(rows[0].holder, 'Acme CoLab');
});

// ------------------------------------------------------------------ ordering
test('order: last-used leads, then the rest of this machine, then elsewhere', () => {
  const rows = mergeInventory({
    local: localOf(
      { host: 'acme-rock', org: 'acme', kind: 'rock' },
      { host: 'aster-box', org: 'aster', kind: 'member' },
    ),
    account: [
      { host: 'acme.crads-ai.com', label: 'Acme', tier: 'rock', held_by: 'you' },
      { host: 'aster.crads-ai.com', label: 'Aster', tier: 'pebble', held_by: 'you' },
      { host: 'harbour.crads-ai.com', label: 'Harbour Guild', tier: 'rock', held_by: 'someone else' },
    ],
    boxes: [{ host: 'harbour.crads-ai.com' }],
  });
  const ordered = orderInventory(rows, 'aster-box');
  assert.deepEqual(ordered.map((r) => r.label), ['Aster', 'Acme', 'Harbour Guild']);
});

test('with no last-used record NOTHING is anchored', () => {
  // The old door drew the primary-pick accent rail on identities[0], which is
  // SSH-config parse order wearing the clothes of a recommendation.
  const rows = mergeInventory({
    local: localOf({ host: 'acme-rock', org: 'acme', kind: 'rock' }),
    account: null,
  });
  assert.equal(anchorAlias(rows, ''), '', 'parse order is not a recommendation');
  assert.equal(anchorAlias(rows, 'acme-rock'), 'acme-rock');
  assert.equal(anchorAlias(rows, 'gone-box'), '', 'a stale record anchors nothing');
});

test('ordering is stable when there is no last-used and labels tie-break', () => {
  const rows = mergeInventory({
    local: localOf(
      { host: 'zeta-box', org: 'zeta', kind: 'member' },
      { host: 'alpha-box', org: 'alpha', kind: 'member' },
    ),
    account: null,
  });
  assert.deepEqual(orderInventory(rows, '').map((r) => r.slug), ['alpha', 'zeta']);
});

// --------------------------------------------------------------- degenerate
test('junk in the target list never produces a row', () => {
  assert.deepEqual(collapseLocal([null, undefined, {}, { org: 'x' }]), [],
    'a target with no host cannot be dialled, so it is not a mineral');
  assert.deepEqual(mergeInventory({}), []);
  assert.deepEqual(mergeInventory({ local: [], account: [], boxes: [] }), []);
});
