// remote-control-card.test.mjs — run: node --test wizard/panel/remote-control-card.test.mjs
//
// The Phone card (2026-10-14): Remote Control is ON BY DEFAULT on every server
// mineral, and this card is the member's off switch plus the honest status.
// Spec: docs/superpowers/specs/2026-10-14-remote-control-design.md. Structural
// hooks only, never copied prose (trap 6); the words the card shows come from
// the box's status verb and are pinned in engine/comms/remote-control.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MEMBER_VERBS } from './panel-server.mjs';
import { LOCAL_VERBS } from './local-verbs.mjs';

const html = readFileSync(path.join(import.meta.dirname, 'member.html'), 'utf8');
const conn = html.slice(html.indexOf('<section data-sec="connections">'), html.indexOf('<section data-sec="brain">'));

test('the card lives on Connections, server-only, starting collapsed', () => {
  for (const id of ['rcRow', 'rcChip', 'rcToggle', 'rcDetail', 'rcState', 'rcName', 'rcSwitch', 'rcNotice']) {
    assert.ok(conn.includes(`id="${id}"`), `${id} lives inside the Connections section`);
  }
  assert.match(conn, /<div id="rcRow" data-needs-box>/, 'hidden on a local folder (a server keeps it awake)');
  assert.match(conn, /id="rcDetail" style="display:none"/, 'detail starts collapsed');
  assert.match(conn, /data-mark="claude"/, 'the Claude mark');
  assert.ok(conn.indexOf('id="rcRow"') < conn.indexOf('id="tgHeroMount"'), 'above Telegram: conversation first, scheduled output second');
});

test('three verbs, each a single engine call; off and on are mutating', () => {
  const st = MEMBER_VERBS['remote-control-status'].build();
  assert.match(st.command, /engine\/comms\/remote-control\.mjs \/state status$/);
  assert.ok(!MEMBER_VERBS['remote-control-status'].mutating);
  assert.equal(MEMBER_VERBS['remote-control-off'].mutating, true);
  assert.match(MEMBER_VERBS['remote-control-off'].build().command, /remote-control\.mjs \/state off$/);
  assert.equal(MEMBER_VERBS['remote-control-on'].mutating, true);
  // Switching on starts it now, not at the scheduler's next two-minute pass.
  assert.match(MEMBER_VERBS['remote-control-on'].build().command, /remote-control\.mjs \/state on && \(bash \/app\/engine\/start-comms\.sh \/state/);
});

test('a local folder is not served these verbs (it needs a server)', () => {
  for (const v of ['remote-control-status', 'remote-control-on', 'remote-control-off']) assert.ok(!LOCAL_VERBS[v], v);
});

test('the page reads status on the warm Connections open and renders every state the box reports', () => {
  assert.match(html, /loadMcp\(\); tgStatus\(\); rcStatus\(\);/);
  for (const s of ['connected', 'starting', 'down', 'off', 'signed_out', 'error', 'unsupported']) {
    assert.match(html, new RegExp(`\\b${s}:\\s*\\[`), `RC_WORDS covers ${s}`);
  }
  // The switch follows the box's own `enabled`, never a guess.
  assert.match(html, /rcLastS && rcLastS\.enabled === false/);
  assert.match(html, /run\(turningOff \? 'remote-control-off' : 'remote-control-on'/);
});

test('the sign-in step discloses it, because it is on by default', () => {
  assert.match(html, /claudeWhy \+= '[^']*Claude app on your phone[^']*Connections\)';/);
});
