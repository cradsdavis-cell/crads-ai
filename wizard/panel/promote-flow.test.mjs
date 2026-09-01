// promote-flow.test.mjs — the member-side half of brokered promotion (Mountain
// model + promote ruling, 2026-08-04). Run: node --test wizard/panel/promote-flow.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPanelServer, promoteFlipCmd, promotePendingWriteCmd, PROMOTE_PENDING_CLEAR_CMD } from './panel-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSENT = "my personal brain becomes this rock's brain";

test('the worker-parity pins are RETIRED (2026-09-01): the panel is the sole authority now', () => {
  // Three byte-identical pins (consent sentence, platform lanes, org handle
  // rule) kept the panel and the directory worker from drifting apart. The
  // worker is deleted; the panel copy is the only copy, so there is nothing
  // left to drift from. If a second consumer of these strings ever appears,
  // re-grow the parity pin against IT, not against a resurrected worker.
  assert.ok(!existsSync(new URL('../../directory/worker.js', import.meta.url)),
    'the directory worker stays gone');
});

test('the shared rule admits what the directory admits', () => {
  const ORG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  assert.ok(ORG.test('a'), 'a single character handle is registrable');
  assert.ok(ORG.test('acme-collab'), 'the ordinary case');
  assert.ok(ORG.test('a'.repeat(63)), '63 characters is the ceiling the directory allows');
  assert.ok(!ORG.test('a'.repeat(64)), 'and 64 is not');
  assert.ok(!ORG.test('Acme Collab'), 'uppercase and spaces stay refused, both sides');
  assert.ok(!ORG.test('-lead'), 'and a leading hyphen');
  // the band the panel used to refuse while the directory accepted it
  const OLD = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
  const band = 'a'.repeat(41);
  assert.ok(ORG.test(band) && !OLD.test(band), 'the 41-to-63 dead band is exactly what this closes');
});

// A stub directory: records every request, answers from a script.
function stubDirectory(routes) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const key = `${req.method} ${req.url.split('?')[0]}`;
      calls.push({ key, auth: req.headers.authorization || '', body: body ? JSON.parse(body) : null });
      const r = routes[key] || { status: 404, json: { error: 'nope' } };
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  return { server, calls };
}

function memberBridge({ precopy, flip, own, unanchor, pending, mint }) {
  const ran = [];
  return {
    ran,
    targets: () => [{ host: 'jane01-box', org: 'jane01', kind: 'member' }],
    stream: (host, command, o = {}) => {
      ran.push(command);
      // The unanchor detach is checked BEFORE the flip: it carries `node -e`
      // inside it (the leave markers), so the old flip test would have claimed
      // it and the ordering assertions below would have been meaningless.
      const spec = /^cat .*ownership/.test(command) ? (own || { out: ['{"tier":"pebble","anchor":"crads-ai"}'], code: 0 })
        : /UNANCHOR-OK/.test(command) ? (unanchor || { out: ['UNANCHOR-OK'], code: 0 })
        // The pending marker is checked before the `node -e` arm: the flip
        // carries the marker's unlink inside it, so matching on the path alone
        // would let the flip be mistaken for a marker write.
        : /promotion-pending\.json$/.test(command) ? (pending || { out: [], code: 0 })
        : /PENDING-CLEARED/.test(command) ? (pending || { out: ['PENDING-CLEARED'], code: 0 })
        // the mint (self-registration leg) also contains `node -e`, so it is
        // told apart by its own marker before the flip arm can claim it
        : /PROMOTE_REG/.test(command) ? (mint || { out: ['PROMOTE_REG {"token":"box-minted-org-token-0001","domain":"crads-ai.com"}'], code: 0 })
        : /node -e/.test(command) ? flip : precopy;
      const ee = new EventEmitter();
      setImmediate(() => {
        for (const l of spec.out || []) { if (o.onStdout) o.onStdout(l); }
        ee.emit('close', spec.code ?? 0);
      });
      return ee;
    },
  };
}

async function start(bridge, dirUrl, extra = {}) {
  const server = createPanelServer({
    port: 0, host: '127.0.0.1', bridge, htmlText: '<html></html>', edition: 'member',
    directoryUrl: dirUrl, promoteIdToken: async () => 'test-id-token', ...extra,
  });
  await new Promise((r) => server.on('listening', r));
  return server;
}

const post = async (server, path, body) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
};

test('start: verifies the pre-copy on the box, then parks the request with the ID token', async (t) => {
  const dir = stubDirectory({ 'POST /promote-request': { status: 200, json: { ok: true, id: 'f'.repeat(32) } } });
  await new Promise((r) => dir.server.listen(0, '127.0.0.1', r));
  t.after(() => dir.server.close());
  const bridge = memberBridge({ precopy: { out: ['PRECOPY-OK git@github.com:jane/jane01-brain.git'], code: 0 }, flip: { out: [], code: 0 } });
  const server = await start(bridge, `http://127.0.0.1:${dir.server.address().port}`);
  t.after(() => server.close());
  const r = await post(server, '/promote/start', { host: 'jane01-box', org_handle: 'janes-org', org_display: "Jane's Org", consent: CONSENT });
  assert.equal(r.status, 200, r.text);
  const req = dir.calls.find((c) => c.key === 'POST /promote-request');
  assert.equal(req.auth, 'Bearer test-id-token');
  assert.equal(req.body.consent, CONSENT);
  assert.deepEqual(req.body.precopy, { repo: 'git@github.com:jane/jane01-brain.git', verified: true });
  assert.equal(req.body.slug, 'jane01');
});

test('start: no backup remote = no promotion, and the directory is never called', async (t) => {
  const dir = stubDirectory({});
  await new Promise((r) => dir.server.listen(0, '127.0.0.1', r));
  t.after(() => dir.server.close());
  const bridge = memberBridge({ precopy: { out: ['PRECOPY-NONE: no backup remote connected'], code: 78 }, flip: { out: [], code: 0 } });
  const server = await start(bridge, `http://127.0.0.1:${dir.server.address().port}`);
  t.after(() => server.close());
  const r = await post(server, '/promote/start', { host: 'jane01-box', org_handle: 'janes-org', consent: CONSENT });
  assert.equal(r.status, 409);
  assert.match(r.text, /connect your own GitHub backup first/i);
  assert.equal(dir.calls.length, 0);
});

test('start: the consent sentence is enforced panel-side too', async (t) => {
  const dir = stubDirectory({});
  await new Promise((r) => dir.server.listen(0, '127.0.0.1', r));
  t.after(() => dir.server.close());
  const bridge = memberBridge({ precopy: { out: [], code: 0 }, flip: { out: [], code: 0 } });
  const server = await start(bridge, `http://127.0.0.1:${dir.server.address().port}`);
  t.after(() => server.close());
  const r = await post(server, '/promote/start', { host: 'jane01-box', org_handle: 'janes-org', consent: 'sure' });
  assert.equal(r.status, 400);
  assert.match(r.text, /my personal brain becomes/);
  assert.equal(bridge.ran.length, 0, 'no consent, no box contact at all');
});

test('flip: refuses until the worker says done, then flips and tells the app', async (t) => {
  const id = 'e'.repeat(32);
  const progress = { status: 200, json: { stage: 'starting', pct: 2, done: false, failed: false } };
  const dir = stubDirectory({ 'GET /build-progress': progress, 'POST /register': { status: 200, json: { ok: true } } });
  await new Promise((r) => dir.server.listen(0, '127.0.0.1', r));
  t.after(() => dir.server.close());
  let promoted = null;
  const bridge = memberBridge({ precopy: { out: [], code: 0 }, flip: { out: ['promoted: this mineral is a rock, personal seat intact'], code: 0 } });
  const server = await start(bridge, `http://127.0.0.1:${dir.server.address().port}`, { onPromoted: (h, o) => { promoted = [h, o]; } });
  t.after(() => server.close());
  const early = await post(server, '/promote/flip', { host: 'jane01-box', id, org_handle: 'janes-org' });
  assert.equal(early.status, 409, 'not fulfilled yet: the box stays a pebble');
  assert.equal(promoted, null);
  progress.json = { stage: 'done', pct: 100, done: true, failed: false, slug: 'jane01' };
  const done = await post(server, '/promote/flip', { host: 'jane01-box', id, org_handle: 'janes-org' });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(promoted, ['jane01-box', 'janes-org']);
  // `cat /state/ownership.json` also matches the file name (the flip re-reads
  // the anchor before touching anything), so pin the WRITE, not the path.
  const flipCmd = bridge.ran.find((c) => /j\.tier=/.test(c));
  assert.ok(flipCmd.includes('j.tier="rock"'));
  assert.ok(flipCmd.includes('j.owner_slug="janes-org"'));
  assert.ok(flipCmd.includes('j.anchor="crads-ai"'), 'a rock is anchored to the Mountain, never to a rock');
});

test('the promote routes exist ONLY on the member edition', async (t) => {
  const bridge = { targets: () => [], stream: () => new EventEmitter() };
  const server = createPanelServer({ port: 0, host: '127.0.0.1', bridge, htmlText: '<html></html>' });
  await new Promise((r) => server.on('listening', r));
  t.after(() => server.close());
  const r = await post(server, '/promote/start', { host: 'x-box', org_handle: 'y', consent: CONSENT });
  assert.equal(r.status, 404, 'org edition must not carry the member promote surface');
});


// ---- the anchor comes off as part of the upgrade (Sam's ruling 2026-08-10) ----
// This replaces the 2026-08-04 refusal ("an anchored pebble cannot promote in
// place yet"). A rock is never anchored to a rock, so promotion ENDS the anchor
// rather than making the member end it first, and the community join survives.

test('start: an anchored pebble promotes, and the ask carries the rock it will unanchor from', async (t) => {
  const dir = stubDirectory({ 'POST /promote-request': { status: 200, json: { ok: true, id: 'a'.repeat(32) } } });
  await new Promise((r) => dir.server.listen(0, '127.0.0.1', r));
  t.after(() => dir.server.close());
  const bridge = memberBridge({
    own: { out: ['{"tier":"pebble","owner":"member","anchor":"harriets-rock"}'], code: 0 },
    precopy: { out: ['PRECOPY-OK git@github.com:jane/jane01-brain.git'], code: 0 }, flip: { out: [], code: 0 },
  });
  const server = await start(bridge, `http://127.0.0.1:${dir.server.address().port}`);
  t.after(() => server.close());
  const r = await post(server, '/promote/start', { host: 'jane01-box', org_handle: 'janes-org', consent: CONSENT });
  assert.equal(r.status, 200, r.text);
  const req = dir.calls.find((c) => c.key === 'POST /promote-request');
  assert.equal(req.body.unanchor_from, 'harriets-rock', 'the operator card must be able to say what changes hands');
});

test('start: an ORG-OWNED mineral still refuses (ownership moves before the anchor can)', async (t) => {
  const dir = stubDirectory({});
  await new Promise((r) => dir.server.listen(0, '127.0.0.1', r));
  t.after(() => dir.server.close());
  const bridge = memberBridge({
    own: { out: ['{"tier":"pebble","owner":"org","owner_slug":"harriets-rock","anchor":"harriets-rock"}'], code: 0 },
    precopy: { out: ['PRECOPY-OK x'], code: 0 }, flip: { out: [], code: 0 },
  });
  const server = await start(bridge, `http://127.0.0.1:${dir.server.address().port}`);
  t.after(() => server.close());
  const r = await post(server, '/promote/start', { host: 'jane01-box', org_handle: 'janes-org', consent: CONSENT });
  assert.equal(r.status, 409);
  assert.match(r.text, /"harriets-rock" owns this mineral/);
  assert.equal(dir.calls.length, 0, 'the directory is never asked');
  assert.ok(!bridge.ran.some((c) => /PRECOPY/.test(c)), 'no pre-copy push either');
});

test('flip: the edge is downgraded BEFORE the box detaches, then the tier flips', async (t) => {
  const id = 'b'.repeat(32);
  const dir = stubDirectory({
    'GET /build-progress': { status: 200, json: { stage: 'done', pct: 100, done: true, failed: false } },
    'POST /register': { status: 200, json: { ok: true } },
    'POST /rock-tie-downgrade': { status: 200, json: { ok: true, rel: 'joined' } },
  });
  await new Promise((r) => dir.server.listen(0, '127.0.0.1', r));
  t.after(() => dir.server.close());
  const bridge = memberBridge({
    own: { out: ['{"tier":"pebble","owner":"member","anchor":"harriets-rock"}'], code: 0 },
    precopy: { out: [], code: 0 }, flip: { out: ['promoted'], code: 0 },
  });
  const server = await start(bridge, `http://127.0.0.1:${dir.server.address().port}`);
  t.after(() => server.close());
  const r = await post(server, '/promote/flip', { host: 'jane01-box', id, org_handle: 'janes-org' });
  assert.equal(r.status, 200, r.text);
  const dg = dir.calls.find((c) => c.key === 'POST /rock-tie-downgrade');
  assert.equal(dg.body.org, 'harriets-rock');
  assert.equal(dg.auth, 'Bearer test-id-token', "the MEMBER's own token: their tie, their call");
  // Order is the whole point: a `left` reflect prunes an edge that is still
  // anchored, so the downgrade has to land before the leave marker is published.
  const detachAt = bridge.ran.findIndex((c) => /UNANCHOR-OK/.test(c));
  const flipAt = bridge.ran.findIndex((c) => /j\.tier=/.test(c));
  assert.ok(detachAt >= 0 && flipAt > detachAt, 'detach runs, and the tier flips after it');
});

test('flip: if the anchor cannot be ended, NOTHING on the mineral is touched', async (t) => {
  const id = 'c'.repeat(32);
  const dir = stubDirectory({
    'GET /build-progress': { status: 200, json: { stage: 'done', pct: 100, done: true, failed: false } },
    'POST /register': { status: 200, json: { ok: true } },
    'POST /rock-tie-downgrade': { status: 409, json: { error: 'harriets-rock owns this mineral' } },
  });
  await new Promise((r) => dir.server.listen(0, '127.0.0.1', r));
  t.after(() => dir.server.close());
  let promoted = null;
  const bridge = memberBridge({
    own: { out: ['{"tier":"pebble","owner":"member","anchor":"harriets-rock"}'], code: 0 },
    precopy: { out: [], code: 0 }, flip: { out: [], code: 0 },
  });
  const server = await start(bridge, `http://127.0.0.1:${dir.server.address().port}`, { onPromoted: () => { promoted = true; } });
  t.after(() => server.close());
  const r = await post(server, '/promote/flip', { host: 'jane01-box', id, org_handle: 'janes-org' });
  assert.equal(r.status, 409, r.text);
  assert.match(r.text, /Nothing has been changed on your mineral/);
  assert.equal(promoted, null);
  assert.ok(!bridge.ran.some((c) => /UNANCHOR-OK/.test(c)), 'no detach');
  assert.ok(!bridge.ran.some((c) => /j\.tier=/.test(c)), 'no tier flip');
});

test('flip: an unanchored pebble never calls the downgrade at all', async (t) => {
  const id = 'd'.repeat(32);
  const dir = stubDirectory({ 'GET /build-progress': { status: 200, json: { stage: 'done', pct: 100, done: true, failed: false } },
    'POST /register': { status: 200, json: { ok: true } } });
  await new Promise((r) => dir.server.listen(0, '127.0.0.1', r));
  t.after(() => dir.server.close());
  const bridge = memberBridge({ precopy: { out: [], code: 0 }, flip: { out: ['promoted'], code: 0 } });
  const server = await start(bridge, `http://127.0.0.1:${dir.server.address().port}`);
  t.after(() => server.close());
  const r = await post(server, '/promote/flip', { host: 'jane01-box', id, org_handle: 'janes-org' });
  assert.equal(r.status, 200, r.text);
  assert.equal(dir.calls.filter((c) => c.key === 'POST /rock-tie-downgrade').length, 0);
  assert.ok(!bridge.ran.some((c) => /UNANCHOR-OK/.test(c)), 'nothing to detach');
});

test('an unreadable ownership record refuses promotion (fail-closed), a missing anchor field passes as Mountain', async (t) => {
  const dir = stubDirectory({ 'POST /promote-request': { status: 200, json: { ok: true, id: 'd'.repeat(32) } } });
  await new Promise((r) => dir.server.listen(0, '127.0.0.1', r));
  t.after(() => dir.server.close());
  const unreadable = memberBridge({ own: { out: ['cat: /state/ownership.json: No such file'], code: 1 }, precopy: { out: [], code: 0 }, flip: { out: [], code: 0 } });
  const s1 = await start(unreadable, `http://127.0.0.1:${dir.server.address().port}`);
  t.after(() => s1.close());
  const r1 = await post(s1, '/promote/start', { host: 'jane01-box', org_handle: 'janes-org', consent: CONSENT });
  assert.equal(r1.status, 502);
  const legacy = memberBridge({ own: { out: ['{"tier":"pebble","owner":"member"}'], code: 0 }, precopy: { out: ['PRECOPY-OK git@github.com:jane/b.git'], code: 0 }, flip: { out: [], code: 0 } });
  const s2 = await start(legacy, `http://127.0.0.1:${dir.server.address().port}`);
  t.after(() => s2.close());
  const r2 = await post(s2, '/promote/start', { host: 'jane01-box', org_handle: 'janes-org', consent: CONSENT });
  assert.equal(r2.status, 200, r2.text);
});

// Finding 152's sibling (2026-08-16): the downgrade body carried only the org,
// so a member with two pebbles on that rock had the directory sort and pick.
// The promoting mineral could keep an anchor a rock may not hold while the
// OTHER pebble lost its anchor, its host and the seat its rock was paying for.
test('flip: the downgrade NAMES the mineral being promoted, never just the rock', async (t) => {
  const id = 'e'.repeat(32);
  const dir = stubDirectory({
    'GET /build-progress': { status: 200, json: { stage: 'done', pct: 100, done: true, failed: false } },
    'POST /register': { status: 200, json: { ok: true } },
    'POST /rock-tie-downgrade': { status: 200, json: { ok: true, rel: 'joined' } },
  });
  await new Promise((r) => dir.server.listen(0, '127.0.0.1', r));
  t.after(() => dir.server.close());
  const bridge = memberBridge({
    own: { out: ['{"tier":"pebble","owner":"member","anchor":"harriets-rock"}'], code: 0 },
    precopy: { out: [], code: 0 }, flip: { out: ['promoted'], code: 0 },
  });
  const server = await start(bridge, `http://127.0.0.1:${dir.server.address().port}`);
  t.after(() => server.close());
  const r = await post(server, '/promote/flip', { host: 'jane01-box', id, org_handle: 'janes-org' });
  assert.equal(r.status, 200, r.text);
  const dg = dir.calls.find((c) => c.key === 'POST /rock-tie-downgrade');
  assert.equal(dg.body.box_host, 'jane01-box', 'the mineral is named, so the directory never has to sort');
});

// ---- RESUME (2026-08-17) ---------------------------------------------------
// Only the seat's watcher calls /promote/flip, and until this shipped that
// watcher existed solely inside the click handler that started it. So anything
// that ended the page ended the promotion, while the card invited exactly that
// ("you can close this and come back"). The real cost showed up on the first
// live promotion: a register 400 stopped the watch, the retry fulfilled
// server-side, and the box sat registered as a rock and billed as one while its
// own ownership record still said pebble.

test('start: records the pending promotion ON THE BOX, so a later page can resume it', async (t) => {
  const id = 'a'.repeat(32);
  const dir = stubDirectory({ 'POST /promote-request': { status: 200, json: { ok: true, id } } });
  await new Promise((r) => dir.server.listen(0, '127.0.0.1', r));
  t.after(() => dir.server.close());
  const bridge = memberBridge({ precopy: { out: ['PRECOPY-OK git@github.com:jane/jane01-brain.git'], code: 0 }, flip: { out: [], code: 0 } });
  const server = await start(bridge, `http://127.0.0.1:${dir.server.address().port}`);
  t.after(() => server.close());
  const r = await post(server, '/promote/start', { host: 'jane01-box', org_handle: 'janes-org', consent: CONSENT });
  assert.equal(r.status, 200, r.text);
  const wrote = bridge.ran.find((c) => /promotion-pending\.json$/.test(c));
  assert.ok(wrote, 'the box is told a promotion is in flight');
  const b64 = (wrote.match(/printf %s '([A-Za-z0-9+/=]+)'/) || [])[1];
  const marker = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  assert.equal(marker.id, id, 'the marker carries the id the seat must watch');
  assert.equal(marker.org_handle, 'janes-org', 'and the handle the flip needs');
});

test('a marker that cannot be written never fails a promotion already parked', async (t) => {
  const dir = stubDirectory({ 'POST /promote-request': { status: 200, json: { ok: true, id: 'b'.repeat(32) } } });
  await new Promise((r) => dir.server.listen(0, '127.0.0.1', r));
  t.after(() => dir.server.close());
  const bridge = memberBridge({
    precopy: { out: ['PRECOPY-OK git@github.com:jane/jane01-brain.git'], code: 0 },
    flip: { out: [], code: 0 }, pending: { out: [], code: 1 },
  });
  const server = await start(bridge, `http://127.0.0.1:${dir.server.address().port}`);
  t.after(() => server.close());
  const r = await post(server, '/promote/start', { host: 'jane01-box', org_handle: 'janes-org', consent: CONSENT });
  assert.equal(r.status, 200, 'the request is at the directory; a marker is not worth refusing over');
});

test('the flip clears the marker in the same command that sets the tier', () => {
  const cmd = promoteFlipCmd('janes-org');
  assert.match(cmd, /tier="rock"/, 'it still flips the tier');
  assert.match(cmd, /unlinkSync\("\/state\/promotion-pending\.json"\)/,
    'a box that IS a rock must not keep resuming a promotion that already landed');
});

test('clear drops the marker and touches nothing else', async (t) => {
  const dir = stubDirectory({});
  await new Promise((r) => dir.server.listen(0, '127.0.0.1', r));
  t.after(() => dir.server.close());
  const bridge = memberBridge({ precopy: { out: [], code: 0 }, flip: { out: [], code: 0 } });
  const server = await start(bridge, `http://127.0.0.1:${dir.server.address().port}`);
  t.after(() => server.close());
  const r = await post(server, '/promote/clear', { host: 'jane01-box' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(bridge.ran, [PROMOTE_PENDING_CLEAR_CMD], 'exactly one command, and it is the rm');
  assert.ok(!bridge.ran.some((c) => /tier="rock"/.test(c)), 'clearing a failed promotion cannot make a rock');
  assert.equal(dir.calls.length, 0, 'and it never speaks to the directory');
});

test('clear refuses a host that is not a configured mineral', async (t) => {
  const dir = stubDirectory({});
  await new Promise((r) => dir.server.listen(0, '127.0.0.1', r));
  t.after(() => dir.server.close());
  const bridge = memberBridge({ precopy: { out: [], code: 0 }, flip: { out: [], code: 0 } });
  const server = await start(bridge, `http://127.0.0.1:${dir.server.address().port}`);
  t.after(() => server.close());
  const r = await post(server, '/promote/clear', { host: 'somebody-else-box' });
  assert.equal(r.status, 400);
  assert.equal(bridge.ran.length, 0, 'no box is touched');
});

test('the marker write interpolates nothing into a shell string', () => {
  const cmd = promotePendingWriteCmd('c'.repeat(32), 'janes-org');
  assert.match(cmd, /^printf %s '[A-Za-z0-9+/=]+' \| base64 -d > \/state\/promotion-pending\.json$/,
    'the payload reaches the box as base64, so no value is ever quoted into the command');
});

test('the seat reads the marker back out of the box state', () => {
  const panel = readFileSync(join(HERE, 'panel-server.mjs'), 'utf8');
  const verb = panel.match(/'member-console-state':[\s\S]*?\n  \},/);
  assert.ok(verb, 'the state verb must still exist');
  assert.match(verb[0], /promotion-pending\.json/, 'it reads the marker');
  assert.match(verb[0], /promotion:\(promo&&promo\.id\?/, 'and puts it on the wire for the seat');
});

// ---- SELF-REGISTRATION (Sam's ruling 2026-08-17: "a promoted rock is just ---
// the same as a normal rock"). A normal rock mints its own ORG_PULL_TOKEN and
// registers itself; the operator never holds it. The operator-held token was
// the single divergence behind every promoted-rock defect found on ingrid.

test('flip: the box mints its own key and the app claims the handle with it, before anything changes', async (t) => {
  const id = 'd'.repeat(32);
  const dir = stubDirectory({
    'GET /build-progress': { status: 200, json: { stage: 'done', pct: 100, done: true, failed: false } },
    'POST /register': { status: 200, json: { ok: true } },
  });
  await new Promise((r) => dir.server.listen(0, '127.0.0.1', r));
  t.after(() => dir.server.close());
  const bridge = memberBridge({ precopy: { out: [], code: 0 }, flip: { out: ['promoted'], code: 0 } });
  const server = await start(bridge, `http://127.0.0.1:${dir.server.address().port}`);
  t.after(() => server.close());
  const r = await post(server, '/promote/flip', { host: 'jane01-box', id, org_handle: 'janes-org' });
  assert.equal(r.status, 200, r.text);
  const reg = dir.calls.find((c) => c.key === 'POST /register');
  assert.ok(reg, 'the claim happened');
  assert.equal(reg.auth, 'Bearer test-id-token', 'carried by the MEMBER’s sign-in, which is what converts the reservation');
  assert.equal(reg.body.pull_token, 'box-minted-org-token-0001', 'with the token the BOX minted — the operator never saw one');
  assert.equal(reg.body.rock_ssh_host, 'jane01.crads-ai.com', 'slug from the app, domain from the box');
  // and the order is register-then-flip: a claim that fails must leave a pebble
  const mintAt = bridge.ran.findIndex((c) => /PROMOTE_REG/.test(c));
  const flipAt = bridge.ran.findIndex((c) => /j\.tier=/.test(c));
  assert.ok(mintAt >= 0 && flipAt > mintAt, 'the mint precedes the flip');
});

test('flip: a refused claim leaves the mineral a pebble, untouched', async (t) => {
  const id = 'c'.repeat(32);
  const dir = stubDirectory({
    'GET /build-progress': { status: 200, json: { stage: 'done', pct: 100, done: true, failed: false } },
    'POST /register': { status: 409, json: { error: 'org handle already registered' } },
  });
  await new Promise((r) => dir.server.listen(0, '127.0.0.1', r));
  t.after(() => dir.server.close());
  const bridge = memberBridge({ precopy: { out: [], code: 0 }, flip: { out: [], code: 0 } });
  const server = await start(bridge, `http://127.0.0.1:${dir.server.address().port}`);
  t.after(() => server.close());
  const r = await post(server, '/promote/flip', { host: 'jane01-box', id, org_handle: 'janes-org' });
  assert.equal(r.status, 409);
  assert.match(r.text, /stays a pebble and nothing has been changed/);
  assert.ok(!bridge.ran.some((c) => /j\.tier=/.test(c)), 'no tier write');
  assert.ok(!bridge.ran.some((c) => /UNANCHOR-OK/.test(c)), 'no anchor touched');
});

test('flip: a box that cannot mint refuses before the directory is even asked', async (t) => {
  const id = 'b'.repeat(32);
  const dir = stubDirectory({ 'GET /build-progress': { status: 200, json: { stage: 'done', pct: 100, done: true, failed: false } } });
  await new Promise((r) => dir.server.listen(0, '127.0.0.1', r));
  t.after(() => dir.server.close());
  const bridge = memberBridge({ precopy: { out: [], code: 0 }, flip: { out: [], code: 0 }, mint: { out: ['sh: cannot write .env'], code: 1 } });
  const server = await start(bridge, `http://127.0.0.1:${dir.server.address().port}`);
  t.after(() => server.close());
  const r = await post(server, '/promote/flip', { host: 'jane01-box', id, org_handle: 'janes-org' });
  assert.equal(r.status, 502);
  assert.match(r.text, /could not mint its own key/);
  assert.ok(!dir.calls.some((c) => c.key === 'POST /register'), 'no claim without a token to claim with');
});

test('the mint is idempotent in the command itself: an existing token is reused, never replaced', () => {
  const panel = readFileSync(join(HERE, 'panel-server.mjs'), 'utf8');
  const cmd = panel.match(/PROMOTE_MINT_CMD = ([\s\S]*?);\n/)[1];
  assert.match(cmd, /grep .'\^ORG_PULL_TOKEN=/, 'it reads the brain .env first');
  assert.match(cmd, /if \[ -z "\$T" \]/, 'and mints only when nothing is there');
  // persisted BEFORE it is spoken: a crash between mint and claim retries with
  // the SAME token, which is what the worker’s already:true answers to
  assert.match(cmd, /ORG_PULL_TOKEN=%s.*>> "\$BR\/\.env"/, 'the token lands in the brain .env, where a born rock keeps its own');
});
