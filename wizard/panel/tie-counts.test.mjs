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

// ---- cross-surface consistency: one fixture, every surface, one answer -----

test('panel identity line, Pebbles tile and joinedCount all read the oracle', () => {
  // joinedCount is derived from the oracle, never from ties.length
  assert.match(html, /orgx\.joinedCount = oc \? oc\.joined : null;/,
    'renderRockState must set joinedCount from the oracle');
  assert.ok(!/orgx\.joinedCount = \(Array\.isArray\(st\.ties\) \? st\.ties : \[\]\)\.length/.test(html),
    'the ties.length arithmetic must not come back');
  // the identity line's pebble count
  assert.match(html, /var n = oc \? oc\.anchored : \(orgx\.index \|\| \[\]\)\.filter/,
    'renderRockIdentity anchors-count reads oc.anchored');
  // the Pebbles tile and page big numbers
  // split 2026-08-17 (lifecycle tile wording): wiring counts as setting-up,
  // joined stands alone — both still read the oracle first
  assert.match(html, /var tiedWiring = oc \? oc\.wiring/, 'tile wiring-count reads the oracle');
  assert.match(html, /var tiedJoined = oc \? oc\.joined/, 'tile joined-count reads the oracle');
  assert.ok(html.split('var total = oc ? (oc.anchored + oc.joined)').length === 3,
    'tile and page totals both read anchored + joined from the oracle');
  // the server-side rock-state payload carries the same oracle's answer
  assert.match(server, /counts: tieCounts\(ties, Array\.isArray\(index\) \? index : \[\]\)/,
    'panel-server attaches oracle counts to its fleet payload');
});

test('the account site\'s chips agree with the oracle on every explicit-rel fixture', (t) => {
  // The site draws one chip per live edge: TIE_CHIP[e.rel || 'joined']
  // (samdavis-site api/app/minerals.js). For explicit rels that is exactly the
  // oracle's split. For a REL-LESS edge the site says joined while the worker's
  // memberRel (and this oracle) say anchored: that divergence is real, filed as
  // finding 183, and pinned by the rel-less unit test above.
  const edges = [T('p1', 'anchored'), T('p2', 'anchored'), T('j1', 'joined'), T('l1', 'joined', { status: 'left' })];
  const live = edges.filter((e) => e.status !== 'left');
  const chips = { anchored: live.filter((e) => (e.tie || 'joined') === 'anchored').length,
    joined: live.filter((e) => (e.tie || 'joined') === 'joined').length };
  const oracle = tieCounts(edges, [R('p1'), R('p2')]);
  assert.equal(chips.anchored, oracle.anchored, 'anchored chips == oracle.anchored');
  assert.equal(chips.joined, oracle.joined, 'joined chips == oracle.joined');
});
