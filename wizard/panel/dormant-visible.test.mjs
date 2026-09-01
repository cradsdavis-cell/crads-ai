// A reconciler that ran and did NOTHING looked exactly like one that ran and
// found nothing: its output went to /dev/null, so the panel rendered a confident
// empty list. That is how a dormant join-reconcile survived on every rock ever
// stamped while members were being told "Request sent, waiting for their
// approval". The emptiness was the lie, and nothing on screen could contradict it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const server = readFileSync(join(HERE, 'panel-server.mjs'), 'utf8');
const panel = readFileSync(join(HERE, 'member.html'), 'utf8');

test('the two verbs whose emptiness is user-facing no longer discard the verdict', () => {
  for (const script of ['control/join-reconcile.mjs', 'control/invite-reconcile.mjs']) {
    const at = server.indexOf('[ -f ' + script + ' ]');
    assert.ok(at > -1, script + ' is still called');
    const call = server.slice(at, server.indexOf('} ||', at) + 1);
    assert.doesNotMatch(call, />\/dev\/null 2>&1/, script + ': its own verdict must not go to /dev/null');
    assert.match(call, /grep -i dormant/, script + ': a dormant run must be caught');
    assert.match(call, /__DORMANT__/, script + ': and marked for the panel');
  }
});

test('a dormant run still cannot break the list it rides alongside', () => {
  // the marker sits outside the JSON the panel slices out by bracket
  assert.doesNotMatch('__DORMANT__ join-reconcile: dormant (needs X).', /[[\]]/,
    'the marker carries no bracket, so it cannot corrupt the JSON slice');
});

test('the panel says so rather than showing a confident empty list', () => {
  assert.match(panel, /__DORMANT__/, 'the panel looks for the marker');
  assert.match(panel, /function renderJoinRequests\(list, dormant\)/, 'and passes it through');
  const fn = panel.split('function renderJoinRequests(list, dormant){')[1].split('\n  }')[0];
  assert.match(fn, /cannot currently see requests to join/i, 'it names the consequence, not the mechanism');
  assert.match(fn, /joinReqCard'\)\.style\.display = ''/, 'and shows the card, which is hidden when the list is empty');
});
