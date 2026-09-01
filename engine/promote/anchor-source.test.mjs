// anchor-source.test.mjs — ownership.json is the anchor record, not the contact
// card. Run: node --test engine/promote/anchor-source.test.mjs
//
// Why this file exists. currentAnchor() read org-contact.json first and
// org-inbox.conf second, and NEITHER is the anchor record: they are the org's
// contact card and the inbox wiring. The anchor record is ownership.json's
// `anchor` field — the uniform anchor rule's own store ("the ownership record
// names its anchor, never empty").
//
// The two disagree the moment a tie ends. evict-apply.sh re-anchors the box to
// the Mountain by flipping ownership.json, and correctly leaves the notice and
// the contact card on disk so the member can see WHO ended the tie and why.
// currentAnchor() then kept reading the old rock's name, so an evicted member
// pressing "Start a rock" was refused with:
//
//   this box is anchored to "certrock", and a rock cannot be anchored to a
//   rock. Ask certrock to convert your membership from anchored to community
//   first
//
// There is nobody to ask: certrock ended the tie. That is a permanent dead end
// on exactly the promise eviction makes ("they keep their box, re-anchored to
// Crads AI"). Reproduced end to end on 2026-08-04.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentAnchor } from './seed-org.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

function box({ ownership, contact, conf }) {
  const d = tmpDir('anchor-');
  if (ownership) writeFileSync(join(d, 'ownership.json'), JSON.stringify(ownership));
  if (contact) writeFileSync(join(d, 'org-contact.json'), JSON.stringify(contact));
  if (conf) writeFileSync(join(d, 'org-inbox.conf'), conf);
  return d;
}

test('the ownership record wins over a stale contact card', () => {
  const d = box({
    ownership: { tier: 'pebble', anchor: 'crads-ai' },       // evicted: Mountain
    contact: { org: 'certrock', admin_email: 'a@b.c' },      // the rock that evicted them
    conf: 'ORG_GH_OWNER=cradsdavis-cell\n',
  });
  assert.equal(currentAnchor(d), '', 'a Mountain-anchored box is not anchored to any rock');
});

test('a genuinely anchored box still reports its rock', () => {
  const d = box({
    ownership: { tier: 'pebble', anchor: 'certrock' },
    contact: { org: 'certrock' },
  });
  assert.equal(currentAnchor(d), 'certrock');
});

test('the ownership record names the rock even when the contact card is absent', () => {
  assert.equal(currentAnchor(box({ ownership: { tier: 'pebble', anchor: 'certrock' } })), 'certrock');
});

test('an older box with no anchor field falls back to the contact card', () => {
  // boxes stamped before the uniform anchor rule carry no `anchor` at all;
  // their contact card is still the best evidence they are anchored.
  const d = box({ ownership: { tier: 'pebble' }, contact: { org: 'certrock' } });
  assert.equal(currentAnchor(d), 'certrock');
});

test('and then the inbox conf, which proves anchoring even with no contact card', () => {
  const d = box({ ownership: { tier: 'pebble' }, conf: 'ORG_GH_OWNER=cradsdavis-cell\n' });
  assert.equal(currentAnchor(d), 'cradsdavis-cell');
});

test('a box with nothing at all stands alone', () => {
  assert.equal(currentAnchor(box({})), '');
});
