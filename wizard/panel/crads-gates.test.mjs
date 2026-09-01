// crads-gates.test.mjs: RETIREMENT PINS for T5's Google-to-Crads gate switch.
//
// The file used to test the WIRING of the crads account into the panel: the
// startup session seed that populated /rock-mine without a sign-in button,
// the silent re-mint that carried an aged token past the old 50-minute wall,
// the door's account row, and the anti-drift pins that kept every switched
// gate pointing at crads-account. The whole layer is deleted (self-host
// pivot, 2026-09-01): no accounts, no directory, no tokens to mint or age.
// What this file holds now is that the directory-fed surfaces those gates
// protected STAY GONE, which is the stronger version of every test it had.
// Run: node --test wizard/panel/crads-gates.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPanelServer } from './panel-server.mjs';
import { createDoorServer } from './door-server.mjs';

const listen = (make, opts) => new Promise((resolve) => {
  const s = make({ port: 0, host: '127.0.0.1', htmlText: '<html>x</html>', ...opts });
  s.on('listening', () => resolve(s));
});
const get = (s, path) => fetch(`http://127.0.0.1:${s.address().port}${path}`);

test('the directory-fed panel routes are RETIRED (2026-09-01): every one answers 404', async () => {
  // /rock-mine was the startup seed's whole audience, and /rock-brain-page was
  // where communityToken's re-mint proved itself. Both read the central
  // directory with a minted account token; neither the reader nor the token
  // exists now. Pinned as routes, not prose: a route that still answers is a
  // route a future screen re-grows.
  const s = await listen(createPanelServer, {
    bridge: { targets: () => [], stream: () => {}, tty: () => {} },
  });
  try {
    for (const p of ['/rock-mine', '/rock-mine/refresh', '/rock-brains',
      '/rock-brain-page?org=acme&id=x', '/own-catalog', '/community-catalogs']) {
      const r = await get(s, p);
      assert.equal(r.status, 404, `${p} must stay gone`);
    }
  } finally { s.close(); }
});

test('console-state pulls nothing from the directory: the env slots are stubbed empty', () => {
  // The verb keeps its box-local read (the seat still needs the mineral's own
  // state), but the five directory pulls that used to ride it are pinned to
  // literal "{}" with no curl anywhere near them. This is what "the directory
  // pulls are stubbed" means as bytes, so it cannot quietly become a fetch.
  const panel = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');
  const verb = panel.match(/'console-state':[\s\S]*?\n  \},/);
  assert.ok(verb, 'the state verb must still exist');
  assert.match(verb[0], /PLAT="\{\}"; HANDOVER="\{\}"; TIEREQ="\{\}"; TIES="\{\}"; PNAMES="\{\}";/,
    'every directory slot is a stubbed empty object');
  assert.doesNotMatch(verb[0], /curl/, 'and no network call fills any of them');
});

test('the door account row is RETIRED (2026-09-01): the account routes answer 404', async () => {
  // The row, T5 and the whole crads-account layer left with the self-host
  // pivot; door.test.mjs pins every /account route as a 404. This file keeps
  // only the module-level truths above it.
  const s = createDoorServer({ port: 0, bridge: { targets: () => [] } });
  await new Promise((r) => s.on('listening', r));
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    for (const p of ['/account', '/account/devices']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 404, `${p} must stay gone`);
    }
  } finally { s.closeAllConnections?.(); s.close(); }
});

test('anti-drift RETIRED (2026-09-01): no gate defaults to crads-account any more', () => {
  // The switched gates all pointed sign-in at the crads account. The account
  // system is deleted; the door and panel no longer import crads-account at
  // all, which is the stronger version of what this test used to hold.
  const door = readFileSync(new URL('./door-server.mjs', import.meta.url), 'utf8');
  assert.ok(!door.includes("import('./crads-account.mjs')"), 'the door never reaches for the account module');
});
