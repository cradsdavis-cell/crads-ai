// tie-counts.test.mjs - one arithmetic for "how many members", pinned.
//   node --test wizard/panel/tie-counts.test.mjs
//
// The bug this file exists for (handshake audit 2026-08-17): member.html set
// orgx.joinedCount = st.ties.length, so qa-r2-gmail's rock, with two ANCHORED
// pebbles and zero joined members, introduced itself as "2 joined members"
// while its Pebbles tile said "2 anchored - 0 community" and the account site
// drew two anchored chips. Three surfaces, three counting rules. The oracle
// (tie-counts.mjs) is now the only arithmetic, and the cross-surface tests
// below pin every consumer to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { tieCounts } from './tie-counts.mjs';

const T = (slug, tie, over = {}) => ({ slug, tie, ...over });
const R = (slug, status = 'active') => ({ slug, status });

// ---- the arithmetic --------------------------------------------------------

test('the finding fixture: two anchored ties are ZERO joined members', () => {
  const c = tieCounts([T('p1', 'anchored'), T('p2', 'anchored')], [R('p1'), R('p2')]);
  assert.deepEqual(c, { anchored: 2, joined: 0, left: 0, wiring: 0 });
});

test('joined counts rel:joined and active, only', () => {
  const c = tieCounts(
    [T('j1', 'joined'), T('j2', 'joined', { status: 'left' }), T('a1', 'anchored')],
    [R('a1')]);
  assert.equal(c.joined, 1, 'one live joined tie');
  assert.equal(c.left, 1, 'the left tie is counted as left and nowhere else');
  assert.equal(c.anchored, 1);
});

test('left is never counted in anchored or joined, from either store', () => {
  const c = tieCounts([T('x', 'joined', { status: 'left' })], [R('gone', 'left')]);
  assert.deepEqual(c, { anchored: 0, joined: 0, left: 2, wiring: 0 });
});

test('an anchored tie with no seat yet is anchored AND wiring, not invisible', () => {
  const c = tieCounts([T('new', 'anchored')], []);
  assert.deepEqual(c, { anchored: 1, joined: 0, left: 0, wiring: 1 });
});

test('a tie whose seat exists is the seat\'s to count, whatever the seat\'s status', () => {
  // active seat: counted once, not twice
  assert.deepEqual(tieCounts([T('m', 'anchored')], [R('m')]),
    { anchored: 1, joined: 0, left: 0, wiring: 0 });
  // left seat with a lingering live edge: the finding-174 state. The seat has
  // closed; the stale edge is reconcile --check's to flag, not a member here
  assert.deepEqual(tieCounts([T('m', 'anchored')], [R('m', 'left')]),
    { anchored: 0, joined: 0, left: 1, wiring: 0 });
});

test('a rel-less tie is ANCHORED: the worker\'s memberRel is the authority', () => {
  // worker.js memberRel: a member edge with no rel predates rel shipping and
  // every one of those was anchored
  const c = tieCounts([{ slug: 'old', e: 'abc' }], []);
  assert.equal(c.anchored, 1);
  assert.equal(c.joined, 0, 'the account site defaults the OTHER way (e.rel || joined); the oracle must not copy that');
});

test('a paused seat sits in no bucket', () => {
  const c = tieCounts([], [R('p', 'paused'), R('a')]);
  assert.deepEqual(c, { anchored: 1, joined: 0, left: 0, wiring: 0 });
});

test('garbage in, zeros out', () => {
  assert.deepEqual(tieCounts(null, undefined), { anchored: 0, joined: 0, left: 0, wiring: 0 });
  assert.deepEqual(tieCounts([null, undefined], [null, { status: 'active' }]),
    { anchored: 0, joined: 0, left: 0, wiring: 0 });
});

// ---- one function, three runtimes ------------------------------------------

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');
const moduleSrc = readFileSync(new URL('./tie-counts.mjs', import.meta.url), 'utf8');

test('the served transform of the module parses as a classic script and is the same function', () => {
  const src = moduleSrc.replace(/^export /gm, '');
  const served = new Function(`${src}; return tieCounts;`)();
  const fixture = [[T('p1', 'anchored'), T('j1', 'joined')], [R('p1')]];
  assert.deepEqual(served(...fixture), tieCounts(...fixture),
    'the browser copy and the imported module must be the one arithmetic');
});

test('both servers serve /tie-counts.js by stripping the export, and the page loads it', () => {
  assert.ok(html.includes('<script src="/tie-counts.js"></script>'), 'member.html loads the oracle');
  assert.match(server, /path === '\/tie-counts\.js'/, 'panel-server serves it');
  assert.match(server, /replace\(\/\^export \/gm, ''\)/, 'panel-server strips the export');
  const harness = readFileSync(new URL('../dev-harness/harness.mjs', import.meta.url), 'utf8');
  assert.match(harness, /path === '\/tie-counts\.js'/, 'the dev harness serves it too, or every driven qa test 404s the oracle');
});

// ---- cross-surface consistency: RETIRED (2026-09-01, the face collapse) ----

test('the UI consumers are RETIRED: no panel surface counts a fleet any more', () => {
  // Three surfaces used to read the oracle (the identity line, the Pebbles
  // tile, joinedCount) and one server payload attached its counts. All four
  // died with the org face and /rock-mine; the account site whose chips the
  // last test compared (finding 183) is retired with the directory. The
  // arithmetic above stays pinned because the module still ships and is still
  // served; what must stay gone is any fleet-counting consumer in the panel.
  assert.ok(!html.includes('orgx.joinedCount'), 'joinedCount must stay gone');
  assert.ok(!html.includes('tieCounts('), 'no inline fleet arithmetic in the page');
  assert.ok(!server.includes('counts: tieCounts('), 'no server fleet payload carries counts');
  // comments may still name the dead route to explain its absence; code must not
  const code = server.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!code.includes('/rock-mine'), 'the fleet payload route itself stays gone');
});
