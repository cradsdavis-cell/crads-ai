// leave-detach.test.mjs — leaving a rock must actually leave it.
// Run: node --test wizard/panel/leave-detach.test.mjs
//
// Why this file exists. leave-org wrote /state/left.json, pushed a leave.json
// into the org's heartbeat repo, and stopped. It left heartbeat.conf,
// org-inbox.conf and org-contact.json in place, and nothing on the box has ever
// read left.json — one reference in either repo, the line that writes it.
//
// So after leaving, the page was byte-identical (Anchor still named the org,
// the Library still said attached, Leave was still offered), and worse: the
// hourly heartbeat job and the two-minute org-sync job kept running against the
// rock's repos. A member who had left kept sending status metadata to
// that rock indefinitely, while the verb's own message said "Effective
// now on your side."
//
// Both box jobs self-guard on their conf file and exit 0 without it, so
// removing the confs is the whole detach; re-anchoring to the Mountain is what
// makes every screen read correctly, exactly as eviction already does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMBER_VERBS } from './panel-server.mjs';

const cmd = () => MEMBER_VERBS['leave-org'].build({ confirm: 'leave' }).command;

test('the arming word is still required', () => {
  assert.throws(() => MEMBER_VERBS['leave-org'].build({ confirm: 'yes' }), /leave/i);
});

test('leaving stops the box talking to the rock', () => {
  const c = cmd();
  for (const conf of ['heartbeat.conf', 'org-inbox.conf']) {
    assert.match(c, new RegExp(`rm -f[^\\n]*${conf.replace('.', '\\.')}`),
      `${conf} must go, or its job keeps running against the org`);
  }
});

test('leaving re-anchors to the Mountain, so every screen reads right', () => {
  assert.match(cmd(), /anchor\s*=\s*"crads-ai"/, 'the anchor record is what the seat and the promote gate read');
});

test('the detach happens AFTER the leave is delivered, not before', () => {
  const c = cmd();
  const push = c.indexOf('git push');
  const detach = c.search(/rm -f[^\n]*heartbeat\.conf/);
  assert.ok(push > -1 && detach > -1, 'both steps must exist');
  assert.ok(detach > push, 'the push needs the very credentials the detach removes');
});

test('it still tells the rock, and still keeps the brain', () => {
  const c = cmd();
  assert.match(c, /leave\.json/, 'the org still learns of it through their own repo');
  assert.doesNotMatch(c, /rm -rf \/state\/brain|rm -f \/state\/brain/, 'the brain is the member\'s and is never touched');
});

test('the closing message no longer overclaims', () => {
  const c = cmd();
  const echo = c.slice(c.lastIndexOf('echo "OK:'));
  assert.doesNotMatch(echo, /their next console read/, 'that framing described a detach that did not happen');
});

// ---------------------------------------------------------------------------
// The same question from the other direction: after an EVICTION the box is
// Mountain-anchored, and the seat must say so. It derived `anchored` from the
// existence of heartbeat.conf, which eviction never touches, so an evicted
// member's seat kept naming the rock that had just evicted them.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const SRV = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'panel-server.mjs'), 'utf8');

test('the seat asks the anchor record, not a config file, whether it is anchored', () => {
  const line = SRV.split('\n').find((l) => l.includes('const anchored='));
  assert.ok(line, 'the derivation must still exist');
  assert.match(line, /own\.anchor/, 'the Mountain model makes ownership.json.anchor authoritative');
  assert.match(line, /crads-ai/, 'and the Mountain means "no rock above you"');
});

test('a box whose record predates the anchor field still works', () => {
  const line = SRV.split('\n').find((l) => l.includes('const anchored='));
  assert.match(line, /heartbeat\.conf/, 'the old signal remains as the fallback, not the primary');
});
