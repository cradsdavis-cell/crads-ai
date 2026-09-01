// server-lib.test.mjs: the wizard server's D44 redirect routes.
//   node --test wizard/ui/server-lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWizardServer } from './server-lib.mjs';

const listen = (opts) => new Promise((resolve) => {
  const s = createWizardServer({ port: 0, host: '127.0.0.1', htmlText: '<html>wizard</html>', engine: 'js', ...opts });
  s.on('listening', () => resolve(s));
});
const get = (s, path) => fetch(`http://127.0.0.1:${s.address().port}${path}`, { redirect: 'manual' });

test('/member and /panel redirect when their getters are live, 404 otherwise', async () => {
  let memberUrl = '';
  let panelUrl = '';
  const s = await listen({ memberUrl: () => memberUrl, panelUrl: () => panelUrl });
  try {
    assert.equal((await get(s, '/member')).status, 404);
    assert.equal((await get(s, '/panel')).status, 404);
    memberUrl = 'http://127.0.0.1:9999/';
    panelUrl = 'http://127.0.0.1:9998/';
    const m = await get(s, '/member');
    assert.equal(m.status, 302);
    assert.equal(m.headers.get('location'), memberUrl);
    const p = await get(s, '/panel');
    assert.equal(p.status, 302);
    assert.equal(p.headers.get('location'), panelUrl);
    const home = await get(s, '/');
    assert.match(await home.text(), /wizard/);
  } finally { s.close(); }
});

test('D52 nav: /door redirects when the door getter is live, 404 otherwise', async () => {
  let doorUrl = '';
  const s = await listen({ doorUrl: () => doorUrl });
  try {
    assert.equal((await get(s, '/door')).status, 404);
    doorUrl = 'http://127.0.0.1:9996/';
    const d = await get(s, '/door');
    assert.equal(d.status, 302);
    assert.equal(d.headers.get('location'), doorUrl);
  } finally { s.close(); }
});
