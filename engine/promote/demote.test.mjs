// Demote refuses while members remain.
//
// Sam's ruling: a rock with members cannot become a pebble. (Until the
// self-host strip, 2026-09-01, demote also retired the org handle at the
// central directory before flipping; the directory is deleted, so the retire
// step and its tests went with it. The member guard is the rule that remains.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMOTE = path.join(HERE, 'demote.mjs');

function rig({ tier = 'rock', members = {}, org = 'promo-lab', token = 'tok-abc' } = {}) {
  const state = tmpDir('demote-');
  const brain = path.join(state, 'brain');
  mkdirSync(path.join(brain, 'registry', 'members'), { recursive: true });
  writeFileSync(path.join(state, 'ownership.json'), JSON.stringify({ owner: 'member', tier }));
  writeFileSync(path.join(brain, 'org-policy.yaml'), `\norg:\n  name: "${org}"\n  display_name: "Promo Lab"\n`);
  if (token) writeFileSync(path.join(brain, '.env'), `ORG_PULL_TOKEN=${token}\n`);
  for (const [slug, status] of Object.entries(members)) {
    writeFileSync(path.join(brain, 'registry', 'members', `${slug}.yaml`), `slug: "${slug}"\nstatus: "${status}"\n`);
  }
  return { state, brain };
}
const run = ({ state, brain }, args = [], dirUrl = 'http://127.0.0.1:9') => new Promise((res) => execFile('node',
  [DEMOTE, ...args],
  { env: { ...process.env, AIOS_STATE_DIR: state, AIOS_BRAIN_ROOT: brain, CRADS_DIRECTORY_URL: dirUrl } },
  (e, so, se) => res({ code: e ? e.code : 0, out: (so || '') + (se || '') })));
const tierOf = ({ state }) => JSON.parse(readFileSync(path.join(state, 'ownership.json'), 'utf8')).tier;

test('a box that is not a rock has nothing to demote', async () => {
  const r0 = rig({ tier: 'pebble' });
  const r = await run(r0);
  assert.equal(r.code, 1);
  assert.match(r.out, /not a rock/);
});

test('LIVE MEMBERS BLOCK IT, and every one is named', async () => {
  const r0 = rig({ members: { jane01: 'active', bob02: 'paused', old03: 'left' } });
  const r = await run(r0);
  assert.equal(r.code, 1);
  assert.match(r.out, /still has 2 member\(s\)/, 'left does not count, paused does');
  assert.match(r.out, /jane01 \(active\)/);
  assert.match(r.out, /bob02 \(paused\)/, 'a paused member is one resume away from expecting an org');
  assert.doesNotMatch(r.out, /old03/, 'a departed member is not a blocker');
  assert.equal(tierOf(r0), 'rock', 'and NOTHING was changed');
});

test('a rock with only departed members can demote', async () => {
  // Guard against a blocker that blocks everything.
  const r0 = rig({ members: { old03: 'left' } });
  const r = await run(r0);
  assert.equal(r.code, 0, r.out);
  assert.equal(tierOf(r0), 'pebble');
});

test('demote makes NO network call: there is no directory left to retire at', async () => {
  // CRADS_DIRECTORY_URL points at a dead port in every run() above; a demote
  // that still tried to retire the handle would hang or refuse. It must
  // succeed offline, and its source must hold no fetch at all.
  const r0 = rig({ token: '' });   // no pull token either: nothing to auth with
  const r = await run(r0);
  assert.equal(r.code, 0, r.out);
  assert.equal(tierOf(r0), 'pebble');
  const src = readFileSync(DEMOTE, 'utf8');
  assert.ok(!/fetch\s*\(/.test(src), 'no fetch in demote.mjs');
  assert.ok(!/directory\.crads-ai\.com/.test(src.replace(/^\s*\/\/.*$/gm, '')),
    'no directory URL outside comments');
});

test('the old --leave-handle-registered override is tolerated, not an error', async () => {
  // Old runbooks say to pass it; a demote that now chokes on its own
  // documented flag would strand an operator mid-procedure.
  const r0 = rig({});
  const r = await run(r0, ['--leave-handle-registered']);
  assert.equal(r.code, 0, r.out);
  assert.equal(tierOf(r0), 'pebble');
});

test('nothing is ever deleted', async () => {
  const r0 = rig({});
  await run(r0);
  assert.match(readFileSync(path.join(r0.brain, 'org-policy.yaml'), 'utf8'), /name: "promo-lab"/,
    'the org brain survives a demotion, under the never-delete rule');
});

// --- promote's guards, after Sam's 2026-08-04 rulings -----------------------
import { currentAnchor } from './seed-org.mjs';

const SEED = path.join(HERE, 'seed-org.mjs');
function seedRig({ anchor = '', env = 'GITHUB_TOKEN=t\nGH_OWNER=o\n', tier = 'pebble' } = {}) {
  const state = tmpDir('seedrig-');
  mkdirSync(path.join(state, 'secrets'), { recursive: true });
  writeFileSync(path.join(state, 'ownership.json'), JSON.stringify({ tier }));
  writeFileSync(path.join(state, 'secrets', 'provisioning.env.local'), env);
  if (anchor) writeFileSync(path.join(state, 'org-inbox.conf'), `ORG_GH_OWNER=${anchor}\nSLUG=jane01\n`);
  return state;
}
const seedRun = (state, args = ['acme-co', 'Acme']) => new Promise((res) => execFile('node',
  [SEED, ...args], { env: { ...process.env, AIOS_STATE_DIR: state } },
  (e, so, se) => res({ code: e ? e.code : 0, out: (so || '') + (se || '') })));

test('ROCKS CANNOT ANCHOR TO ROCKS: an anchored pebble is refused', async () => {
  // Sam's ruling. A promoted box keeps its old rock, but only as a COMMUNITY
  // tie, and its row lives on that rock's registry, so converting it is a
  // cross-box operation this step cannot do alone. Proceeding would leave a box
  // calling itself a rock while its anchor still lists it as an anchored member.
  const state = seedRig({ anchor: 'certrock' });
  const r = await seedRun(state);
  assert.equal(r.code, 1);
  assert.match(r.out, /cannot be anchored to a rock/);
  assert.match(r.out, /certrock/, 'and it names the rock to ask');
  assert.match(r.out, /Nothing has been changed/);
});

test('a standalone pebble passes the anchor check', async () => {
  // Guard against a check that blocks everything: this one must reach the next
  // step (it fails later, on the network, which is fine).
  const state = seedRig({ anchor: '' });
  const r = await seedRun(state);
  assert.doesNotMatch(r.out, /cannot be anchored to a rock/);
});

test('GITHUB ONLY: cloud tokens on the box are refused, not used', async () => {
  // Supersedes the earlier "stage the full platform token set" ruling. A rock
  // that provisions nothing must not hold a project-scoped Hetzner token.
  for (const k of ['HCLOUD_TOKEN', 'CF_API_TOKEN']) {
    const state = seedRig({ env: `GITHUB_TOKEN=t\nGH_OWNER=o\n${k}=secret\n` });
    const r = await seedRun(state);
    assert.equal(r.code, 1, `${k} must stop promotion`);
    assert.match(r.out, new RegExp(k), 'and name what to remove');
    assert.match(r.out, /GitHub credentials ONLY/);
  }
});

test('currentAnchor reads the box\'s own record, and copes with its absence', () => {
  assert.equal(currentAnchor(seedRig({ anchor: 'certrock' })), 'certrock');
  assert.equal(currentAnchor(seedRig({ anchor: '' })), '', 'a standalone box has none');
  assert.equal(currentAnchor('/nonexistent'), '', 'and a missing file is not an error');
});

test('the anchor is named by its HANDLE, not its GitHub account', () => {
  // The first version read ORG_GH_OWNER and told the user to go and ask
  // "cradsdavis-cell", a GitHub org, as though it were the rock. The box knows
  // the real handle: org-contact.json carries it.
  const state = tmpDir('anchor-');
  writeFileSync(path.join(state, 'org-inbox.conf'), 'ORG_GH_OWNER=cradsdavis-cell\nSLUG=jane01\n');
  writeFileSync(path.join(state, 'org-contact.json'), JSON.stringify({ org: 'certrock', admin_email: 'a@b.c' }));
  assert.equal(currentAnchor(state), 'certrock', 'the human-facing name wins');

  // and the conf alone still proves anchoring, because org-sync cannot run without it
  const onlyConf = tmpDir('anchor2-');
  writeFileSync(path.join(onlyConf, 'org-inbox.conf'), 'ORG_GH_OWNER=cradsdavis-cell\nSLUG=jane01\n');
  assert.equal(currentAnchor(onlyConf), 'cradsdavis-cell', 'still detected, just less precisely named');
});
