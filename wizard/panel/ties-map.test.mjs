// ties-map.test.mjs — what R9 (2026-08-09) left behind after the face
// collapse (2026-09-01). The box-side ties store survives: ties-write still
// validates and lands /state/ties.json atomically, and member-console-state
// still carries the rows, because a box's own record of what it joined is a
// box-local fact. What died is everything that PUSHED ties from the directory
// (syncTiesToBox and friends) and everything the map drew above the box from
// them (Mountain, anchor wires, fleet): the map now draws only the mineral
// itself and the communities it chose, read page-side from the community list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MEMBER_VERBS } from './panel-server.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');

// run the built ties-write command against a temp dir instead of /state
const writeTies = (dir, rows) => {
  const b64 = Buffer.from(JSON.stringify(rows), 'utf8').toString('base64');
  const spec = MEMBER_VERBS['ties-write'].build({ content_b64: b64 });
  const cmd = spec.command.replaceAll('/state/ties.json', join(dir, 'ties.json'));
  return execFileSync('bash', ['-c', cmd], { encoding: 'utf8', input: spec.stdin });
};

test('ties-write validates box-side and lands an atomic, shaped file', () => {
  const dir = tmpDir('ties-');
  const out = writeTies(dir, [
    { org: 'harbour-guild', org_display: 'Harbour Guild', tie: 'joined', status: 'active' },
    { org: 'acme-collab', org_display: 'Acme CoLab', tie: 'anchored', status: 'active' },
  ]);
  assert.match(out, /OK: ties recorded/);
  const j = JSON.parse(readFileSync(join(dir, 'ties.json'), 'utf8'));
  assert.equal(j.ties.length, 2);
  assert.deepEqual(j.ties[1], { org: 'acme-collab', org_display: 'Acme CoLab', tie: 'anchored', status: 'active' });
});

test('ties-write refuses a malformed payload and writes nothing', () => {
  const dir = tmpDir('ties-');
  for (const bad of [
    [{ org: 'UPPER CASE', tie: 'joined' }],
    [{ org: 'ok-org', tie: 'owner' }],
    { not: 'an array' },
  ]) {
    assert.throws(() => writeTies(dir, bad), /./, 'rejected: ' + JSON.stringify(bad).slice(0, 40));
    assert.ok(!existsSync(join(dir, 'ties.json')), 'nothing landed');
  }
});

test('console-state still carries the box-local facts, and worldFacts states only them', () => {
  const cmd = MEMBER_VERBS['member-console-state'].build().command;
  assert.ok(cmd.includes('ties.json'), 'console-state reads the ties file');
  // field-wise, not adjacency-wise: see the note in panel.test.mjs (2026-08-13)
  for (const f of ['anchored', 'name:nm', 'backup', 'ties']) {
    assert.ok(new RegExp('[{,]' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[,}]').test(cmd), `${f} rides the state line`);
  }
  // worldFacts no longer synthesises an org row: the world is the box, its
  // devices and any open support window, nothing more.
  assert.match(server, /return \{\s*box: \{/, 'worldFacts opens with the box');
  assert.ok(!/org: anchorOrg/.test(server), 'the legacy single org field is gone for good');
  assert.ok(!server.includes('anchorFacts'), 'no anchor synthesis remains server-side');
});

test('the directory tie push is RETIRED: nothing syncs ties down from above any more', () => {
  // syncTiesToBox / syncTiesToAll wrote directory edges into /state/ties.json
  // on every fresh pull. The directory is gone; the file is now written only
  // by explicit box-local acts (ties-write via join and leave flows), so the
  // push machinery must stay out of the server.
  assert.ok(!server.includes('syncTiesToBox'), 'the per-box push must stay gone');
  assert.ok(!server.includes('syncTiesToAll'), 'and the fleet-wide sweep with it');
  assert.ok(!server.includes('ensureEdgesFresh'), 'and the edge-freshness machinery it rode on');
});

test('the map draws the mineral and its chosen communities, dashed, and nothing above that', () => {
  const model = html.slice(html.indexOf('function netModel('), html.indexOf('function netLayout('));
  assert.match(model, /id: 'you', me: true/, 'the you card is the root fact');
  assert.match(model, /You own this mineral/, 'and says whose the mineral is');
  assert.match(model, /role: 'joinedAbove', kind: 'rock', tie: 'joined', tag: 'community'/,
    'each joined community draws as an informational card');
  assert.match(model, /state\.communities \|\| \[\]/, 'read from the mineral\'s own community list');
  assert.match(html, /stroke-dasharray="4 4"/, 'joined wires still draw dashed');
  assert.ok(!model.includes('anchor'), 'no anchor node is modelled');
  assert.ok(!html.includes("'anchor' : 'anchor rock'"), 'the anchor label is gone from the page');
  // The Mountain survives only as an orphaned CSS rule and its comment;
  // nothing models a node that would wear data-kind="mountain" any more.
  assert.ok(!/kind: ['"]mountain['"]/.test(html), 'no script draws a Mountain node');
});
