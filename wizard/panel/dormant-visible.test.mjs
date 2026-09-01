// A reconciler that ran and did NOTHING looked exactly like one that ran and
// found nothing: its output went to /dev/null, so the panel rendered a confident
// empty list. That is how a dormant join-reconcile survived on every rock ever
// stamped while members were being told "Request sent, waiting for their
// approval". The emptiness was the lie, and nothing on screen could contradict it.
//
// RETIRED (face collapse, 2026-09-01): the join-request pipeline this file
// defended (join-reconcile, invite-reconcile, the __DORMANT__ marker and the
// renderJoinRequests card) died with the central directory. Joining a
// community is now a bundle pasted on the Communities tab, applied locally,
// with nothing to reconcile and no queue whose emptiness could lie. These pins
// hold the machinery gone; if a commons-era queue ever appears, its emptiness
// must carry the same ran-vs-found-nothing distinction this file was born for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const server = readFileSync(join(HERE, 'panel-server.mjs'), 'utf8');
const panel = readFileSync(join(HERE, 'member.html'), 'utf8');

test('the join-request reconcilers are RETIRED (2026-09-01): nothing calls them', () => {
  assert.ok(!server.includes('control/join-reconcile.mjs'), 'join-reconcile is not called');
  assert.ok(!server.includes('control/invite-reconcile.mjs'), 'invite-reconcile is not called');
});

test('the dormant marker and its card are RETIRED with the queue they explained', () => {
  assert.ok(!server.includes('__DORMANT__'), 'the server emits no dormancy marker');
  assert.ok(!panel.includes('__DORMANT__'), 'the panel looks for none');
  assert.ok(!panel.includes('renderJoinRequests'), 'the join-requests card stays gone');
  assert.ok(!panel.includes('joinReqCard'), 'and so does its container');
});
