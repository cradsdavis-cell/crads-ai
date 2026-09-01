// The org console RETIRED with P3 of the upgraded-pebble spec (2026-08-09):
// its ten verbs live on the app's Rocks / Overview / Pebbles surfaces now.
// What this file guards since then:
//   1. an old /console bookmark on the org face lands on the app, never a 404
//   2. the member's standalone seat page still lives at /console, untouched
//   3. /panel.html stays a routed path (old deep links carry #host= + #section)
//      and the root serve stamps the edition into the one shell
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPanelServer } from './panel-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const ROCK = { host: 'ic-rock', org: 'ic', kind: 'rock' };
const MEMBER = { host: 'jane01-box', org: 'jane01', kind: 'member' };
const bridge = (targets) => ({ targets: () => targets, stream: () => { throw new Error('not used'); } });
const listen = (opts) => new Promise((resolve) => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html>x</html>', ...opts });
  s.on('listening', () => resolve(s));
});

test('org /console redirects home; the member seat page survives at /console', async () => {
  const org = await listen({ bridge: bridge([ROCK]) });
  const mem = await listen({ bridge: bridge([MEMBER]), edition: 'member', consoleHtml: '<html>the seat page</html>' });
  try {
    const ro = await fetch(`http://127.0.0.1:${org.address().port}/console`, { redirect: 'manual' });
    assert.equal(ro.status, 302, 'the retired console bounces to the app');
    assert.equal(ro.headers.get('location'), '/');
    const rm = await fetch(`http://127.0.0.1:${mem.address().port}/console`);
    assert.equal(rm.status, 200);
    assert.match(await rm.text(), /the seat page/, 'the member standalone console is untouched');
  } finally { org.close(); mem.close(); }
});

test('the panel server serves that exact path', () => {
  const server = readFileSync(join(HERE, 'panel-server.mjs'), 'utf8');
  assert.match(server, /path === '\/panel\.html'/, 'the path old deep links carry is actually routed');
  assert.ok(!/consoleDefault/.test(server), 'the cutover redirect stays dead');
  assert.match(server, /__AIOS_EDITION__'", JSON\.stringify\(edition === 'member' \? 'member' : 'org'\)/,
    'the root serve stamps the edition into the shell');
});

test('the shell honours the asked-for rock (#host survives the landing)', () => {
  const shell = readFileSync(join(HERE, 'member.html'), 'utf8');
  assert.match(shell, /location\.hash\.match\(\/\^#host=/, 'the org boot reads #host=');
});
