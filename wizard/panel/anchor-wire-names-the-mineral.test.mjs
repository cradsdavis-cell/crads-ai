// anchor-wire-names-the-mineral.test.mjs: finding 152's LAST sibling, the app
// relay half (2026-08-17).
//
// 215353c taught the directory to refuse rather than sort when a caller holds
// several minerals and names none, and 0517925 taught the two member.html
// controls to say which. The relay in wizard/panel/panel-server.mjs
// `wireAnchoredTies` was not touched by either, and it is the ONE caller of
// /anchor-wire-claim that runs unattended on every edges refresh: it posted
// { org } and nothing else. affCaller() gives the worker {email, eh} and no
// .box, so with two bundles staged for one person the worker had no name at
// all to select on and answered 409 forever. Nothing on the screen said so:
// `if (!r.ok) continue` reads a 409 the same as "the rock has not adopted yet".
//
// The directory stub below is TRANSCRIBED from directory/worker.js as deployed
// (:v2 sha-110d91c): /anchor-wire-claim's asked/want/hit ladder, and
// edgeNamedBy's slug-strict-then-box-label ladder for /anchor-pubkeys. Faking
// it looser than the real thing is how a green test proves nothing.
//
// Run: node --test wizard/panel/anchor-wire-names-the-mineral.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPanelServer } from './panel-server.mjs';

const jwt = (email) => 'h.' + Buffer.from(JSON.stringify({ email })).toString('base64url') + '.s';
const boxLabel = (h) => String(h || '').toLowerCase().split('.')[0].replace(/-box$/, '');
const pub = (n) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb0eXAmpleKeyMaterial${String(n).repeat(40).slice(0, 40)}`;

const bundleFor = (slug) => ({
  ok: true, org: 'acme', slug,
  bundle: { inbox_repo: `acme-org/inbox-${slug}`, heartbeat_repo: `acme-org/heartbeat-${slug}`,
    pull_token: `pull-${slug}`, org_contact: { org: 'acme' } },
});

// ---- the directory, as worker.js actually answers ----------------------------
function fakeDirectory({ edges, stagedSlugs }) {
  const calls = [];
  const staged = new Map(stagedSlugs.map((s) => [s, bundleFor(s)]));
  const fetcher = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ url: u, body });
    if (u.includes('/edges?')) return { ok: true, status: 200, json: async () => ({ edges }) };
    if (u.includes('/rock-tie-notices')) return { ok: true, status: 200, json: async () => ({ notices: [] }) };
    if (u.endsWith('/anchor-wire-claim')) {
      // worker.js: `const asked = String(b.slug || '')`, `want = asked ||
      // boxLabel(caller.box || b.box_host || '')`. The app authenticates as the
      // MEMBER, so caller.box is always empty on this path.
      const asked = String(body.slug || '');
      const want = asked || boxLabel(body.box_host || '');
      const rows = [...staged.values()];
      let hit = want ? rows.find((r) => r.slug === want) : null;
      if (!hit) {
        if (asked) return { ok: false, status: 404, json: async () => ({ error: `nothing staged for ${asked} here` }) };
        if (rows.length > 1) return { ok: false, status: 409, json: async () => ({ error: 'more than one mineral of yours has a bundle waiting here: name yours with slug' }) };
        if (!rows.length) return { ok: false, status: 404, json: async () => ({ error: 'nothing staged for this mineral here' }) };
        hit = rows[0];
      }
      staged.delete(hit.slug);   // one-time: the claim deletes the bundle
      return { ok: true, status: 200, json: async () => hit };
    }
    if (u.endsWith('/anchor-pubkeys')) {
      // worker.js edgeNamedBy(edges, { slug, host: box_host }, 'anchored'):
      // an explicit slug is exact; otherwise the box LABEL is tried against
      // slugs first and boxes second, and either arm refuses when ambiguous.
      const live = edges.filter((e) => e.rel === 'anchored' && e.status !== 'left');
      let edge = null;
      if (body.slug) edge = live.find((e) => String(e.slug || '') === String(body.slug)) || null;
      else {
        const lbl = boxLabel(body.box_host || '');
        const bySlug = lbl ? live.filter((e) => String(e.slug || '').toLowerCase() === lbl) : [];
        const byBox = lbl ? live.filter((e) => boxLabel(e.box) === lbl) : [];
        if (bySlug.length) edge = bySlug.length === 1 ? bySlug[0] : null;
        else if (byBox.length) edge = byBox.length === 1 ? byBox[0] : null;
        else if (live.length === 1) edge = live[0];
      }
      if (!edge) {
        return { ok: false, status: 409, json: async () => ({ error: live.length > 1
          ? 'more than one of your minerals is anchored here: name this one with slug'
          : 'no anchored tie here' }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, slug: edge.slug }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  return { fetcher, calls, claims: () => calls.filter((c) => c.url.endsWith('/anchor-wire-claim')),
    posts: () => calls.filter((c) => c.url.endsWith('/anchor-pubkeys')) };
}

// Each mineral answers NOTWIRED to the probe, then echoes back the slug of
// whatever bundle it was handed: that is how the test sees WHICH mineral got
// WHICH bundle rather than trusting the call count.
function fakeBridge(hosts, log) {
  return {
    targets: () => hosts.map((h) => ({ host: h, kind: 'member', org: boxLabel(h) })),
    stream: (host, command, { onStdout, stdin } = {}) => {
      const rec = { host, command, stdin: stdin || '' };
      log.push(rec);
      const ee = new EventEmitter();
      setImmediate(() => {
        if (command.includes('NOTWIRED')) onStdout('NOTWIRED');
        else if (stdin && command.includes('org_inbox_deploy_key')) {
          let got = '';
          try { got = JSON.parse(Buffer.from(stdin.trim(), 'base64').toString()).slug || ''; } catch { got = ''; }
          rec.wiredSlug = got;
          onStdout(`OK: wired to acme\nPUBKEYS ${JSON.stringify({ inbox_pub: pub(1), heartbeat_pub: pub(2) })}`);
        } else onStdout('OK');
        ee.emit('close', 0);
      });
      return ee;
    },
    tty: () => {},
  };
}

const listen = (opts) => new Promise((resolve) => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html>x</html>', edition: 'member', ...opts });
  s.on('listening', () => resolve(s));
});

async function run({ edges, stagedSlugs, hosts }) {
  const dir = fakeDirectory({ edges, stagedSlugs });
  const verbs = [];
  const s = await listen({
    bridge: fakeBridge(hosts, verbs),
    directoryUrl: 'https://dir.example',
    communityFetcher: dir.fetcher,
    accountToken: async () => ({ ok: true, idToken: jwt('jane@x.com'), email: 'jane@x.com' }),
  });
  try { await new Promise((r) => setTimeout(r, 400)); } finally { s.close(); }
  const wires = verbs.filter((v) => v.stdin && v.command.includes('org_inbox_deploy_key'));
  return { dir, verbs, wires };
}

// ---- 1. two bundles staged: the claim has to say which ------------------------
test('two minerals on one rock: each claim names its own, and both get wired', async () => {
  const edges = [
    { org: 'acme', role: 'member', status: 'active', slug: 'pebble-four', rel: 'anchored', box: 'pebble-four.crads-ai.com' },
    { org: 'acme', role: 'member', status: 'active', slug: 'pebble-five', rel: 'anchored', box: 'pebble-five.crads-ai.com' },
  ];
  const { dir, wires } = await run({ edges, stagedSlugs: ['pebble-four', 'pebble-five'], hosts: ['pebble-four-box', 'pebble-five-box'] });

  const claims = dir.claims();
  assert.equal(claims.length, 2, 'one claim per anchored mineral');
  assert.deepEqual(claims.map((c) => c.body.slug).sort(), ['pebble-five', 'pebble-four'],
    'FAILS ON HEAD: the body was { org } only, so the directory had nothing to select on and 409ed both');
  // and the consequence the 409 had: nothing was ever wired
  assert.deepEqual(wires.map((w) => `${w.host}:${w.wiredSlug}`).sort(),
    ['pebble-five-box:pebble-five', 'pebble-four-box:pebble-four'],
    'each mineral wired its OWN bundle');
  assert.deepEqual(dir.posts().map((p) => p.body.slug).sort(), ['pebble-five', 'pebble-four'],
    'and the public halves are posted under the mineral that minted them');
});

// ---- 2. which mineral the bundle is carried TO --------------------------------
test('a second pebble that inherited the first pebble box_host is still wired on its own metal', async () => {
  // The inherited box is not contrived: worker.js says the slug-scoped edge
  // write copies `box` from the slug-less base row, "so a member's SECOND
  // pebble inherits the FIRST's host onto its edge". The target picker ORed
  // slug-match with box-prefix-match inside one find(), so the first host in
  // the list won the second edge on its box before the second host was ever
  // tried for an exact name.
  const edges = [
    { org: 'acme', role: 'member', status: 'active', slug: 'pebble-four', rel: 'anchored', box: 'pebble-four.crads-ai.com' },
    { org: 'acme', role: 'member', status: 'active', slug: 'pebble-five', rel: 'anchored', box: 'pebble-four.crads-ai.com' },
  ];
  const { wires } = await run({ edges, stagedSlugs: ['pebble-four', 'pebble-five'], hosts: ['pebble-four-box', 'pebble-five-box'] });
  const landed = Object.fromEntries(wires.map((w) => [w.wiredSlug, w.host]));
  assert.equal(landed['pebble-four'], 'pebble-four-box');
  assert.equal(landed['pebble-five'], 'pebble-five-box',
    "FAILS ON HEAD: pebble-five's bundle was carried to pebble-four's mineral");
});

// ---- 3. the twin call, five lines below --------------------------------------
test('the pubkeys relay names the mineral too, so a renamed registry seat still lands', async () => {
  // The rock renames the REGISTRY slug on a collision (-2..-9) and never the
  // mineral, and edges-reflect writes that renamed slug onto the edge. So the
  // local host label and the edge slug legitimately disagree, and box_host
  // alone then falls to the box arm, which is ambiguous the moment the two
  // edges share an inherited host. The slug is the name that survives both.
  const edges = [
    { org: 'acme', role: 'member', status: 'active', slug: 'jane01-2', rel: 'anchored', box: 'jane01.crads-ai.com' },
    { org: 'acme', role: 'member', status: 'active', slug: 'jane02', rel: 'anchored', box: 'jane01.crads-ai.com' },
  ];
  const { dir } = await run({ edges, stagedSlugs: ['jane01-2', 'jane02'], hosts: ['jane01-box', 'jane02-box'] });
  const posts = dir.posts();
  assert.equal(posts.length, 2, 'both minerals relayed their public halves');
  assert.deepEqual(posts.map((p) => p.body.slug).sort(), ['jane01-2', 'jane02'],
    'FAILS ON HEAD: box_host was the only name sent, and it matched no slug and two boxes');
});

// ---- 4. the regression the fix itself could have introduced -------------------
test('a lone bundle staged under a renamed registry seat is still claimed, named or not', async () => {
  // HONEST LABEL: this one does NOT fail on the HEAD that shipped before today.
  // It fails on the FIRST version of today's fix. Sending an explicit slug is
  // matched EXACTLY by the worker, and the rock stages under the REGISTRY seat
  // it renamed on a collision (-2..-9) while the edge still carries the asked
  // name until edges-reflect lands. Naming alone therefore turned a case that
  // used to work into a silent permanent 404, because `if (!r.ok) continue`
  // cannot tell that 404 from "the rock has not adopted yet". Finding 123 is
  // why "reflect will fix it shortly" is not a safe assumption on this fleet.
  const edges = [{ org: 'acme', role: 'member', status: 'active', slug: 'jane01', rel: 'anchored', box: 'jane01.crads-ai.com' }];
  const { dir, wires } = await run({ edges, stagedSlugs: ['jane01-2'], hosts: ['jane01-box'] });
  const claims = dir.claims();
  assert.equal(claims.length, 2, 'named first, then the unnamed retry the 404 earns');
  assert.equal(claims[0].body.slug, 'jane01', 'the name is still tried first');
  assert.equal(claims[1].body.slug, undefined, 'and the retry drops it, which is what this code sent before today');
  assert.deepEqual(wires.map((w) => `${w.host}:${w.wiredSlug}`), ['jane01-box:jane01-2'],
    'the one staged bundle reached the one mineral');
});

test('the unnamed retry can never take another mineral bundle: several staged is still a refusal', async () => {
  const edges = [{ org: 'acme', role: 'member', status: 'active', slug: 'jane01', rel: 'anchored', box: 'jane01.crads-ai.com' }];
  // two staged, neither under a name this member's one edge carries
  const { dir, wires } = await run({ edges, stagedSlugs: ['jane01-2', 'jane09'], hosts: ['jane01-box'] });
  assert.equal(dir.claims().length, 2, 'named, then unnamed');
  assert.equal(wires.length, 0, 'the directory 409ed the unnamed retry, and no bundle was taken');
});
