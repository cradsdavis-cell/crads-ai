// sharing-exactness.test.mjs — "Exactly what leaves your box" must be exact.
// Run: node --test wizard/panel/sharing-exactness.test.mjs
//
// Why this file existed. The Sharing page promised an exhaustive list of what
// left the box and then rebuilt the payload by hand, so the page and the
// emitter drifted; the fix read the really-pushed heartbeat and projected the
// rows from it, so the two views could never disagree again.
//
// RETIRED (face collapse, 2026-09-01): the Sharing page is gone because the
// thing it disclosed is gone. Nothing leaves a self-hosted mineral for a
// central receiver: no anchor rock, no directory, no heartbeat push to
// anyone. A page headed "what leaves your box" whose honest content is
// "nothing" is not a page. These pins hold the surface gone; if a
// commons-era share-back disclosure is ever born, it inherits this file's
// law: read the really-sent record, never a hand-built mirror of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');

test('the Sharing page is RETIRED (2026-09-01): the section and its machinery stay gone', () => {
  assert.ok(!html.includes('<section data-sec="sharing">'), 'no Sharing section');
  assert.ok(!html.includes('SHARE_FIELDS'), 'no field table to drift from an emitter');
  assert.ok(!html.includes('FLOOR_KEYS'), 'no floor projection');
  assert.ok(!html.includes('function renderPreview()'), 'no payload preview');
  assert.ok(!html.includes('state.hbShared'), 'nothing keeps a pushed heartbeat to render');
});

test('an old #sharing link lands on Help, where the one surviving card lives', () => {
  // Support access is the only Sharing-era card that still means anything
  // (letting the software maker in is a grant about THIS mineral, not about
  // data leaving it), so it moved to Help and the alias follows it.
  assert.match(html, /if \(name === 'sharing'\) name = 'help';/, 'activateSec aliases sharing to help');
  assert.match(html, /if \(h === 'sharing'\) h = 'help';/, 'and so does the hash reader');
});
