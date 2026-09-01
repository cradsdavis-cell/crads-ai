// ties-map.test.mjs — R9 (2026-08-09 grilling): the Network map draws ties
// made AFTER stamp time. The structural gap it closes: the map's org node came
// only from /state/org-contact.json (written once, at stamp), ties lived in
// directory KV and never landed on the box, and worldFacts ignored the
// anchored flag it already had — so a later-made tie could never render.
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

test('console-state carries ties, and worldFacts draws every tie with the anchor first', () => {
  const cmd = MEMBER_VERBS['member-console-state'].build().command;
  assert.ok(cmd.includes('ties.json'), 'console-state reads the ties file');
  // field-wise, not adjacency-wise: see the note in panel.test.mjs (2026-08-13)
  for (const f of ['anchored', 'name:nm', 'backup', 'ties']) {
    assert.ok(new RegExp('[{,]' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[,}]').test(cmd), `${f} rides the state line`);
  }
  assert.match(server, /orgs\.some\(\(o\) => o\.tie === 'anchored'\) && \(orgName \|\| state\.anchored\)/,
    'the anchored flag + the stamp-time seed still cover a box the write has not reached');
  assert.match(server, /org: anchorOrg \? \{ label: anchorOrg\.label \}/, 'the legacy single org field survives one release');
});

test('the app writes ties down whenever fresh edges land, filtered per box', () => {
  assert.match(server, /const syncTiesToBox = async \(host, explicit\)/);
  assert.match(server, /String\(x\.slug \|\| ''\) === slug \|\| String\(x\.box \|\| ''\)\.indexOf\(slug\) === 0/,
    'slug first, box host as the T6 slug-reconciliation fallback; one owner’s several pebbles never wear each other’s ties');
  // E2 (2026-08-10): emptiness never clobbers a good ties.json — only an
  // explicit act (a leave) may clear the file.
  assert.match(server, /if \(!rows\.length && !explicit\) return;/, 'the no-clobber guard');
  assert.match(server, /syncTiesToAll\(true\);\s+\/\/ a leave is the one act/, 'leave is the explicit path');
  const calls = (server.match(/syncTiesToAll\(/g) || []).length;
  assert.ok(calls >= 3, `full refresh + silent repair + leave all sync (${calls} call sites)`);
});

test('the map renders orgs: anchor emphasised on top, joined rocks dashed beside it', () => {
  // Rebuilt 2026-08-10. R9 still holds (every rock tie draws, the anchor
  // emphasised) but joined rocks are no longer satellites off the box's
  // shoulder: they sit on the TOP ROW beside the anchor, because the map's
  // rule is now "above you is whatever has a claim on you, below you is what
  // you anchor" — and a community you joined anchors nothing of yours.
  assert.match(html, /Array\.isArray\(w\.orgs\) && w\.orgs\.length \? w\.orgs/, 'new shape preferred, legacy org still draws');
  assert.match(html, /tag: 'joined rock'/, 'joined rocks are labelled');
  assert.match(html, /role: 'joinedAbove'/, 'and they are placed above, never below');
  assert.match(html, /stroke-dasharray="4 4"/, 'joined wires draw dashed');
  assert.match(html, /'anchor' : 'anchor rock'/, 'the anchor node names its role');
});
