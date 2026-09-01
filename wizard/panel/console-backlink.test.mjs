// The org console RETIRED with P3 of the upgraded-pebble spec (2026-08-09),
// and the standalone MEMBER console retired with the face collapse
// (2026-09-01): the seat tab of the one app shell is the console now.
// What this file guards since then:
//   1. an old /console bookmark, from either era, lands on the app's seat tab,
//      never a 404 and never a dead standalone page
//   2. /panel.html stays a routed path (old deep links carry #host= + #section)
//      and the shell ships unstamped: there is no edition to stamp
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPanelServer } from './panel-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const BOX = { host: 'jane01-box', org: 'jane01', kind: 'member' };
const bridge = (targets) => ({ targets: () => targets, stream: () => { throw new Error('not used'); } });
const listen = (opts) => new Promise((resolve) => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html>x</html>', ...opts });
  s.on('listening', () => resolve(s));
});

test('/console redirects to the seat tab of the one app, always', async () => {
  const s = await listen({ bridge: bridge([BOX]) });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/console`, { redirect: 'manual' });
    assert.equal(r.status, 302, 'the retired console bounces to the app');
    assert.equal(r.headers.get('location'), '/#seat', 'and lands on the seat, which is the console now');
  } finally { s.close(); }
});

test('the panel server serves that exact path, unstamped', () => {
  const server = readFileSync(join(HERE, 'panel-server.mjs'), 'utf8');
  assert.match(server, /path === '\/panel\.html'/, 'the path old deep links carry is actually routed');
  assert.ok(!/consoleDefault/.test(server), 'the cutover redirect stays dead');
  // The edition stamp is gone with the face collapse: the shell has one face
  // and ships as-is. The last placeholder rewrite (the /topology sandbox's
  // constant stamp) left when the sandbox page was deleted (2026-09-01), so no
  // stamp machinery of any kind survives in the server.
  assert.ok(!server.includes("JSON.stringify(edition"), 'no edition stamp in the root serve');
  assert.ok(!server.includes('__AIOS_EDITION__'), 'no placeholder rewrite survives anywhere');
});

test('the shell honours the asked-for mineral (#host survives the landing)', () => {
  const shell = readFileSync(join(HERE, 'member.html'), 'utf8');
  assert.match(shell, /location\.hash\.match\(\/\^#host=/, 'the boot reads #host=');
});
