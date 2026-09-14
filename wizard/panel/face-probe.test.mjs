// face-probe.test.mjs — the box says what it is (promote ruling § 3, 2026-08-04).
// Run: node --test wizard/panel/face-probe.test.mjs
//
// The probe SURVIVES the face collapse (2026-09-01): there is no org edition
// to route to any more, but the door still asks a -box alias whether it is a
// rock so its tier chip tells the truth, and the registry keeps that answer
// across restarts. What died is the two-faces server behaviour the probe used
// to feed; the host-gate section below pins the one-server truth instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as fsForPersistence from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
// The registry persists to disk since 2026-08-17 (box-kinds.json); point it at
// a temp file BEFORE first use so tests never write the real ~/.crads-ai cache.
// The bridge resolves this path lazily at call time, which is what makes
// setting it here (after import, before any register call) sufficient.
process.env.AIOS_BOX_KINDS_PATH = join(tmpDir('fp-kinds-'), 'box-kinds.json');
import { parseOwnership, probePromotedHosts } from './face-probe.mjs';
import { listPanelTargets, registerPromotedHost, unregisterPromotedHost } from './ssh-bridge.mjs';
import { createPanelServer, MEMBER_VERBS } from './panel-server.mjs';

// ---------------------------------------------------------------- parsing
test('parseOwnership: takes the outermost object, survives transport banners', () => {
  const banner = 'Warning: Permanently added ...\nMOTD nonsense {not json}\n';
  const rec = parseOwnership(banner + '{"tier":"rock","owner_slug":"acme"}\n');
  assert.equal(rec.tier, 'rock');
  assert.equal(parseOwnership('no json here'), null);
  assert.equal(parseOwnership(''), null);
  assert.equal(parseOwnership('[1,2,3]'), null, 'an array is not an ownership record');
});

// ---------------------------------------------------------------- probing
test('probePromotedHosts: believes only a box that ANSWERS rock; failures leave the guess standing', async () => {
  const bridge = async (host) => {
    if (host === 'rocky-box') return { stdout: 'banner\n{"tier":"rock","owner_slug":"rocky-org"}' };
    if (host === 'pebbly-box') return { stdout: '{"tier":"pebble"}' };
    if (host === 'silent-box') return { stdout: '' };
    throw new Error('unreachable');
  };
  const targets = [
    { host: 'rocky-box', org: 'rocky', kind: 'member' },
    { host: 'pebbly-box', org: 'pebbly', kind: 'member' },
    { host: 'silent-box', org: 'silent', kind: 'member' },
    { host: 'down-box', org: 'down', kind: 'member' },
    { host: 'acme-rock', org: 'acme', kind: 'rock' }, // rocks are never probed
  ];
  const promoted = await probePromotedHosts(bridge, targets);
  assert.deepEqual(promoted, [{ host: 'rocky-box', org: 'rocky-org' }]);
});

// ---------------------------------------------------------------- registry
test('a registered promoted host gains a rock target under the SAME -box alias', () => {
  const dir = tmpDir('fp-test-');
  const cfg = join(dir, 'config');
  writeFileSync(cfg, ['Host promo1-box', '  HostName 192.0.2.9', 'Host other1-box', '  HostName 192.0.2.10'].join('\n'));
  registerPromotedHost('promo1-box', 'promo1-org');
  const t = listPanelTargets(cfg);
  assert.deepEqual(t.filter((x) => x.host === 'promo1-box'), [
    { host: 'promo1-box', org: 'promo1', kind: 'member' },
    { host: 'promo1-box', org: 'promo1-org', kind: 'rock', promoted: true },
  ], 'both faces, one box');
  assert.deepEqual(t.filter((x) => x.host === 'other1-box').map((x) => x.kind), ['member'], 'unregistered hosts are untouched');
});

test('a registry entry for a host no longer in the config is inert', () => {
  const dir = tmpDir('fp-test-');
  const cfg = join(dir, 'config');
  writeFileSync(cfg, 'Host real1-box\n  HostName 192.0.2.11\n');
  registerPromotedHost('ghost1-box', 'ghost-org');
  assert.ok(!listPanelTargets(cfg).some((t) => t.host === 'ghost1-box'));
});

// ---------------------------------------------------------------- host gate
async function post(server, path, body) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

test('ONE server, ONE verb table (2026-09-01): member verbs serve every alias kind, org verbs are gone', async (t) => {
  // The face collapse ended the org-edition /run: the served table is the
  // member verbs plus the Catalogue dozen, and it answers for the -box alias,
  // the legacy -rock alias AND the probe-set promoted flag alike. The old
  // test's subject (org verbs gated to the org face) is now the stronger
  // truth that org verbs are not reachable ANYWHERE.
  const { EventEmitter } = await import('node:events');
  const bridge = {
    targets: () => [
      { host: 'acme-rock', org: 'acme', kind: 'rock' },
      { host: 'promo2-box', org: 'promo2-org', kind: 'rock', promoted: true },
      { host: 'plain2-box', org: 'plain2', kind: 'member' },
    ],
    stream: (host, command, o = {}) => {
      const ee = new EventEmitter();
      setImmediate(() => { if (o.onStdout) o.onStdout('ran'); ee.emit('close', 0); });
      return ee;
    },
  };
  const server = createPanelServer({ port: 0, host: '127.0.0.1', bridge, htmlText: '<html></html>' });
  await new Promise((r) => server.on('listening', r));
  t.after(() => server.close());
  const verb = Object.keys(MEMBER_VERBS).find((v) => !MEMBER_VERBS[v].mutating && !MEMBER_VERBS[v].adminOnly);
  for (const host of ['plain2-box', 'acme-rock', 'promo2-box']) {
    const r = await post(server, '/run', { verb, host, args: {} });
    assert.notEqual(r.status, 400, `${host} must pass the one gate (got ${r.status}: ${r.text})`);
  }
  const noGhost = await post(server, '/run', { verb, host: 'ghost2-box', args: {} });
  assert.equal(noGhost.status, 400, 'an unknown host must NOT pass');
  // an old org-table verb is unknown everywhere (the table itself was deleted
  // 2026-09-09), even on a rock-alias target that would once have carried it
  const orgVerb = 'people-list';
  assert.ok(!MEMBER_VERBS[orgVerb], 'the fixture verb is not served, or this pin tests nothing');
  const noOrg = await post(server, '/run', { verb: orgVerb, host: 'acme-rock', args: {} });
  assert.equal(noOrg.status, 400, 'an org verb is refused even on a rock alias');
  assert.match(noOrg.text, /unknown verb/, 'as unknown, because it is not served at all');
});

test('the THIRD verb table (2026-09-11): a -local target is served LOCAL_VERBS, a strict subset, by kind', async (t) => {
  // The one server, still one face, but the table follows the target's kind:
  // a brain folder on this computer gets the local table and a box verb it
  // does not carry is unknown THERE while known on the box beside it.
  const { EventEmitter } = await import('node:events');
  const { LOCAL_VERBS } = await import('./local-verbs.mjs');
  const bridge = {
    targets: () => [
      { host: 'plain3-box', org: 'plain3', kind: 'member' },
      { host: 'mine-local', org: 'mine', kind: 'local', path: '/nowhere' },
    ],
    stream: (host, command, o = {}) => {
      const ee = new EventEmitter();
      setImmediate(() => { if (o.onStdout) o.onStdout('ran'); ee.emit('close', 0); });
      return ee;
    },
  };
  const server = createPanelServer({ port: 0, host: '127.0.0.1', bridge, htmlText: '<html></html>' });
  await new Promise((r) => server.on('listening', r));
  t.after(() => server.close());
  const shared = Object.keys(LOCAL_VERBS).find((v) => !LOCAL_VERBS[v].mutating);
  assert.ok(MEMBER_VERBS[shared], 'every local verb is also a member verb');
  for (const host of ['plain3-box', 'mine-local']) {
    const r = await post(server, '/run', { verb: shared, host, args: {} });
    assert.notEqual(r.status, 400, `${host} passes the one gate for ${shared} (got ${r.status}: ${r.text})`);
  }
  const boxOnly = Object.keys(MEMBER_VERBS).find((v) => !LOCAL_VERBS[v] && !MEMBER_VERBS[v].mutating && !MEMBER_VERBS[v].adminOnly);
  const onFolder = await post(server, '/run', { verb: boxOnly, host: 'mine-local', args: {} });
  assert.equal(onFolder.status, 400, `${boxOnly} is unknown on a folder`);
  assert.match(onFolder.text, /unknown verb/);
  const onBox = await post(server, '/run', { verb: boxOnly, host: 'plain3-box', args: {} });
  assert.notEqual(onBox.status, 400, `${boxOnly} stays served on the box`);
});

test('/org-teardown is RETIRED (2026-09-01): 404 for everyone; stop-hosting (/demote) is the only retire path', async (t) => {
  // The hosted era deleted whole rocks through this route with re-pasted cloud
  // codes. A self-hosted server is deleted where it lives, at the hosting
  // provider, so the route is gone rather than gated: even a promoted target
  // and an injected orgTeardown hook get a 404.
  const { EventEmitter } = await import('node:events');
  const bridge = {
    targets: () => [{ host: 'promo3-box', org: 'promo3-org', kind: 'rock', promoted: true }],
    stream: () => { const ee = new EventEmitter(); setImmediate(() => ee.emit('close', 0)); return ee; },
  };
  const server = createPanelServer({ port: 0, host: '127.0.0.1', bridge, htmlText: '<html></html>', orgTeardown: async () => ({ ok: true }) });
  await new Promise((r) => server.on('listening', r));
  t.after(() => server.close());
  const r = await post(server, '/org-teardown', { host: 'promo3-box', confirm: 'delete promo3-box forever' });
  assert.equal(r.status, 404, 'the route must stay gone, not merely refuse');
});

// ---------------------------------------------------------------- persistence
// (2026-08-17, ingrid.) The registry was in-memory only, so the app forgot a
// promoted rock at every restart and re-learned it from ONE un-retried ssh
// probe at launch — proven flaky from Sam's laptop, which rendered his real
// promoted rock pebble-only for a whole session. A born rock's face survives a
// restart because it lives in the ssh config; a promoted rock's now survives
// for the same reason: durable local knowledge, refreshed by the probe, still
// only ever WRITTEN from the box's own answer.
test('the promoted registry survives a restart (the cache file is the memory)', () => {
  const { readFileSync: rf } = fsForPersistence;
  registerPromotedHost('persist1-box', 'persist1-org');
  const onDisk = JSON.parse(rf(process.env.AIOS_BOX_KINDS_PATH, 'utf8'));
  assert.equal(onDisk['persist1-box'], 'persist1-org', 'a registration reaches disk');
  // demote is the one eraser, and it reaches disk too
  unregisterPromotedHost('persist1-box');
  const after = JSON.parse(rf(process.env.AIOS_BOX_KINDS_PATH, 'utf8'));
  assert.ok(!('persist1-box' in after), 'an unregister erases the cache entry');
});

test('a corrupt cache file is an empty cache, never a crash', () => {
  // The map is already loaded this process, so corruption is proven the other
  // way: write garbage, then confirm the next save round-trips clean JSON over
  // it rather than dying on the read path at next load.
  fsForPersistence.writeFileSync(process.env.AIOS_BOX_KINDS_PATH, 'not json {{{');
  registerPromotedHost('recover1-box', 'recover1-org');
  const j = JSON.parse(fsForPersistence.readFileSync(process.env.AIOS_BOX_KINDS_PATH, 'utf8'));
  assert.equal(j['recover1-box'], 'recover1-org');
});
