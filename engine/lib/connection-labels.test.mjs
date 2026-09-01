// connection-labels.test.mjs — run: node --test engine/lib/connection-labels.test.mjs
//
// Pins the 2026-08-09 audit finding: a real box rendered raw lowercase keys
// ("gmail", "drive") on the Overview card because the card's producer carried
// its own 3-entry label map. The rule now: every consumer renders
// connectionLabel(key); no key reaches a member's screen raw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionLabel, CONNECTION_LABELS } from './connection-labels.mjs';

test('known keys get their proper names', () => {
  assert.equal(connectionLabel('gmail'), 'Gmail');
  assert.equal(connectionLabel('calendar'), 'Google Calendar');
  assert.equal(connectionLabel('drive'), 'Google Drive');
  assert.equal(connectionLabel('ms365'), 'Microsoft 365 (Outlook + Calendar)');
  assert.equal(connectionLabel('notion'), 'Notion');
});

test('unknown keys never render raw: de-kebab + title-case', () => {
  assert.equal(connectionLabel('youtube-transcript'), 'Youtube Transcript');
  assert.equal(connectionLabel('my_custom_server'), 'My Custom Server');
  assert.equal(connectionLabel('acme'), 'Acme');
});

test('degenerate input comes back harmless, not thrown', () => {
  assert.equal(connectionLabel(''), '');
  assert.equal(connectionLabel(null), '');
  assert.equal(connectionLabel('---'), '---');
});

test('no label in the map is itself a raw lowercase key', () => {
  for (const v of Object.values(CONNECTION_LABELS)) {
    assert.notEqual(v, v.toLowerCase(), `label "${v}" looks unlabelled`);
  }
});
