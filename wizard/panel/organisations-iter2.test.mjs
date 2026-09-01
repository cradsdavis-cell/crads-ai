// organisations-iter2.test.mjs — RETIRED (2026-09-01, the face collapse).
// Run: node --test wizard/panel/organisations-iter2.test.mjs
//
// What this file used to hold. Panel iteration 2's R23 + R4 on the
// Organisations page: "Ask to anchor" only while the picked mineral had no
// anchor, "Change to join" on the anchored row calling POST
// /rock-tie-downgrade, ownership lines on org-owned rows, no "Behind the
// door" browse. The self-host pivot removed anchoring itself: nothing anchors
// a self-hosted mineral, so the page, both ask flows and the downgrade route
// are gone. The pins hold that none of it comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPanelServer } from './panel-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');

test('the anchor flows are RETIRED from member.html', () => {
  const code = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const name of ['rockHasAnchor', 'rockJoinBlock', 'rockTieBlock', 'rockDowngrade', 'rockAskAnchor', 'rockLocalAnchor']) {
    assert.ok(!code.includes(name), `${name} must stay gone`);
  }
  assert.ok(!html.includes('Ask to anchor'), 'no surface offers an anchor ask');
  assert.ok(!html.includes('Change to join'), 'no surface offers a tie downgrade');
});

test('the tie-downgrade and leave routes answer 404 now', async () => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html></html>',
    bridge: { targets: () => [], stream: () => { throw new Error('no ssh in tests'); } } });
  await new Promise((r) => s.on('listening', r));
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    for (const p of ['/rock-tie-downgrade', '/rock-leave']) {
      const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 404, `${p} must stay gone`);
    }
  } finally { s.closeAllConnections?.(); s.close(); }
});
