// rocks-page.test.mjs — RETIRED (2026-09-01, the face collapse).
//   node --test wizard/panel/rocks-page.test.mjs
//
// What this file used to hold. The Rocks page (later Organisations) had to
// carry the rocks: one row per rock, drawers onto each rock's brain, catalogue
// and tie, honest unknown-vs-zero counts, the platform lane never rendered as
// a rock, the reader unreachable by URL. The self-host pivot removed the whole
// subject: rocks are a ROLE, not a directory of listed organisations, sharing
// rides commons repos, and the page, its reader and the routes that fed them
// are gone. The pins below hold the stronger truths: the sections stay out of
// member.html, hosted-era deep links land on the Communities page, and every
// feeding route answers 404.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPanelServer } from './panel-server.mjs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

test('the Rocks/Organisations page and its reader are RETIRED from member.html', () => {
  assert.ok(!html.includes('<section data-sec="rocks">'), 'the page section must stay gone');
  assert.ok(!html.includes('<section data-sec="rockbrain"'), 'and the old Rock brain tab');
  assert.ok(!html.includes('<section data-sec="rockreader"'), 'and the reader section');
  // an orphaned CSS selector may still name an old id; no FUNCTION may return
  for (const name of ['rockRow', 'rockCountLine', 'rockMineRefresh', 'rockLoadSubstance', 'rockConsumeWanted', 'rockJoinBlock', 'rockTieBlock']) {
    assert.ok(!html.includes(`function ${name}(`), `${name} must stay gone`);
  }
});

test('hosted-era deep links land on Communities, not nowhere', () => {
  // A bookmark from the hosted era must still open a living page: the commons
  // model's Communities page is the successor surface.
  assert.match(html, /if \(name === 'rocks' \|\| name\.indexOf\('rocks\/'\) === 0 \|\| name === 'rockbrain'\) name = 'commons';/,
    'activateSec remaps rocks, rocks/<handle> and rockbrain');
  assert.match(html, /if \(h === 'rocks' \|\| h\.indexOf\('rocks\/'\) === 0 \|\| h === 'rockbrain'\) h = 'commons';/,
    'and secFromHash mirrors it for hashchange arrivals');
});

test('every route that fed the page answers 404 now', async () => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html></html>',
    bridge: { targets: () => [], stream: () => { throw new Error('no ssh in tests'); } } });
  await new Promise((r) => s.on('listening', r));
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    for (const p of ['/rocks-board', '/rock-mine', '/rock-mine/refresh', '/rock-brains',
      '/rock-brain-page?org=x&id=y', '/rock-join-ask', '/rock-anchor-ask',
      '/rock-tie-downgrade', '/rock-leave']) {
      const method = p.startsWith('/rock-mine') || p.startsWith('/rock-brain') || p === '/rocks-board' ? 'GET' : 'POST';
      const r = await fetch(base + p, method === 'GET' ? undefined
        : { method, headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 404, `${p} must stay gone`);
    }
  } finally { s.closeAllConnections?.(); s.close(); }
});

test('the console-answer path went with the asks inbox: the verb stays deleted', async () => {
  // The asks inbox moved pages twice and always had exactly one answer path,
  // console-answer. Both died with the directory; nothing may quietly regrow
  // a consent verb that answers into a KV that no longer exists.
  const { VERBS, MEMBER_VERBS } = await import('./panel-server.mjs');
  assert.equal(VERBS['console-answer'], undefined, 'console-answer must stay out of VERBS');
  assert.equal(MEMBER_VERBS['console-answer'], undefined, 'and out of the member table');
});
