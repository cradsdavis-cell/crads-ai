// promote-flow.test.mjs — RETIRED (2026-09-01, the face collapse).
// Run: node --test wizard/panel/promote-flow.test.mjs
//
// What this file used to hold. The member-side half of brokered promotion
// (Mountain model + promote ruling, 2026-08-04): the consent sentence, the
// pre-copy check, the parked request, the resume marker, the box-minted key,
// the anchor coming off as part of the upgrade, the fail-closed flip. All of
// it rode the directory worker and the /promote/* routes, and the self-host
// pivot deleted both: a mineral that wants to host now initialises a commons
// (a role, not an edition), so there is no promotion to broker, no consent to
// park and no handle to claim. The pins below hold the stronger truths: the
// worker stays gone, the promote machinery stays unexported, the routes
// answer 404, and no promote card survives in the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as panel from './panel-server.mjs';

const { createPanelServer } = panel;

test('the worker-parity pins are RETIRED (2026-09-01): the panel is the sole authority now', () => {
  // Three byte-identical pins (consent sentence, platform lanes, org handle
  // rule) kept the panel and the directory worker from drifting apart. The
  // worker is deleted; the panel copy is the only copy, so there is nothing
  // left to drift from. If a second consumer of these strings ever appears,
  // re-grow the parity pin against IT, not against a resurrected worker.
  assert.ok(!existsSync(new URL('../../directory/worker.js', import.meta.url)),
    'the directory worker stays gone');
});

test('the promote machinery stays unexported: no code path can mint a rock in place', () => {
  for (const name of ['promoteFlipCmd', 'promotePendingWriteCmd', 'PROMOTE_PENDING_CLEAR_CMD',
    'PROMOTE_CONSENT', 'PRECOPY_CMD', 'PROMOTE_MINT_CMD', 'PROMOTE_UNANCHOR_CMD', 'unanchorCmd']) {
    assert.equal(panel[name], undefined, `${name} must stay unexported`);
  }
  // the two survivors of the old block: the demote half of the pair, and the
  // join-bundle checker the commons model reuses
  assert.ok(panel.DEMOTE_CMD, 'DEMOTE_CMD survives (stop hosting)');
  assert.ok(panel.checkJoinBundle, 'checkJoinBundle survives (commons bundles)');
});

test('the promote and handover routes answer 404 now', async () => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html></html>',
    bridge: { targets: () => [], stream: () => { throw new Error('no ssh in tests'); }, tty: () => {} } });
  await new Promise((r) => s.on('listening', r));
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    for (const [method, p] of [['POST', '/promote/start'], ['POST', '/promote/flip'],
      ['POST', '/promote/clear'], ['GET', '/promote/status'], ['POST', '/handover-ask']]) {
      const r = await fetch(base + p, method === 'GET' ? undefined
        : { method, headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 404, `${method} ${p} must stay gone`);
    }
  } finally { s.closeAllConnections?.(); s.close(); }
});

test('no promote card or consent sentence survives in member.html', () => {
  const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
  assert.ok(!html.includes("my personal brain becomes this rock's brain"),
    'the consent sentence is gone from the page');
  assert.ok(!html.includes('/promote/'), 'no fetch aims at the dead routes');
  assert.ok(!html.includes('promotion-pending'), 'and no resume watcher reads the old marker');
});
