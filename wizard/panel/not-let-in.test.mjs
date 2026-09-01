// A member's mineral is UP and answering and simply refuses this machine's key.
// The app used to read that as "waiting for your box" and say "nothing you need
// to do" -- about the one state where there IS something to do and which never
// resolves on its own. Recognising the state correctly is the first half of this
// file, and it has not changed.
//
// The second half changed twice. On 2026-08-11 the two-party code ceremony
// died ("the user shouldn't need a code or anything") and the dead end became
// T9's account-backed "Let this computer in" button. Then the account system
// itself died (self-host pivot, 2026-09-01), and the button, the entitlement
// ask and the emailed-invitation branch all went with it. ONE way in remains,
// and it involves no third party: another of the person's own computers, one
// that already opens the mineral, adds this one from its Map page over SSH
// (device-routes.mjs). The denied copy now says exactly that, and the old
// account relays answer 410 tombstones so a stale page gets a sentence
// instead of a hang.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');
const server = readFileSync(join(HERE, 'panel-server.mjs'), 'utf8');
const door = readFileSync(join(HERE, 'door-server.mjs'), 'utf8');

const RE = (() => {
  const m = html.match(/var NOT_LET_IN_RE = (\/.*\/[a-z]*);/);
  assert.ok(m, 'the app still recognises a refused key');
  return eval(m[1]);
})();

// ------------------------------------------------- recognising the state

test('a refused key is recognised, whatever ssh phrases it', () => {
  for (const real of [
    'member@178.104.130.54: Permission denied (publickey,password).',
    'Permission denied (publickey).',
    'Permission denied (publickey,keyboard-interactive).',
    'Received disconnect from 1.2.3.4 port 22:2: Too many authentication failures',
  ]) assert.ok(RE.test(real), 'should read as not-let-in: ' + real);
});

test('and is not confused with the states that already had honest copy', () => {
  for (const other of [
    'Error response from daemon: No such container: aios',
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
    'ssh: connect to host 1.2.3.4 port 22: Connection refused',
    'ssh: connect to host 1.2.3.4 port 22: Connection timed out',
    'ssh: Could not resolve hostname nope: Name or service not known',
  ]) assert.ok(!RE.test(other), 'should NOT read as not-let-in: ' + other);
});

test('the box-down branch still wins over it', () => {
  // a dead container reports through the same transport; its copy is already right
  assert.match(html, /function notLetIn\(r\)\{ return !boxDown\(r\) &&/);
});

// ------------------------------------------------- no code, anywhere

// The connection-error handler alone. Scoped deliberately: member.html elsewhere
// runs GitHub's OWN device flow, which legitimately says "read a short code", and
// a whole-file ban would fail on it and teach the next person to delete the
// assertion rather than the ceremony.
// Comments are stripped before the check: the comment that RECORDS the ruling
// has to be able to say the word "code" without failing the test that enforces it.
const showConnError = (() => {
  const i = html.indexOf('function showConnError(');
  assert.ok(i > 0, 'the handler is still there to check');
  return html.slice(i, html.indexOf('\n  function hideConnError', i))
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
})();

test('the app never asks anyone to read a code to anyone', () => {
  // The whole point of the ruling. Checked as absence in both files, because the
  // UI and the route died together and either one surviving re-grows the other.
  //
  // NOT what this forbids (2026-08-20): the Telegram pairing code, which the
  // mineral mints and the member types into their OWN Telegram to prove the bot
  // is being linked by the person at this screen. There is no second human, no
  // reading a code TO anyone, and nobody approving anybody. What the ruling
  // killed is a code one person recites to another to be let in. The assertions
  // below stay exactly as strict about that; the pairing block is labelled
  // "Pairing code" so the two never get confused for each other.
  assert.doesNotMatch(html, /device-code/, 'the page must not fetch a code');
  assert.doesNotMatch(html, /connCodeVal|Your code:/, 'and must not have anywhere to put one');
  assert.doesNotMatch(server, /path === '\/device-code'/, 'and the server must not answer for one');
  assert.doesNotMatch(showConnError, /code|read it to|approve it once/i,
    'and the not-let-in state must not mention one at all');
});

test('the copy still tells them the mineral is fine, and now names a route that works', () => {
  const body = html.match(/\$\('connErrBody'\)\.textContent = denied\s*\n?\s*\? '([^']+)'/);
  assert.ok(body, 'the denied branch has its own copy');
  assert.match(body[1], /up and answering/i, 'says the mineral is not the problem');
  assert.match(body[1], /add this one from its Map page/, 'names the one action that works: device-add from an already-connected computer');
  assert.match(body[1], /a computer that already has access/, 'and says which machine can do it');
  assert.match(body[1], /Nothing new is made/, 'and that nothing is created by letting it in');
  assert.doesNotMatch(body[1], /nothing you need to do/i, 'never the reassuring lie');
});

// ------------------------------------------------- the account leg is gone

test('the "Let this computer in" button is RETIRED (2026-09-01): no element, no handler, no ask', () => {
  // The button asked the central account whether it owned this mineral, then
  // asked the directory to admit the machine. Both services are deleted, so
  // the whole leg is pinned as ABSENT: element, entitlement fetch, enrol ask
  // and the emailed-invitation fallback copy that rode with them. Comments may
  // still record the retirement; live constructs may not come back.
  assert.doesNotMatch(html, /id="connLetIn"/, 'no button element');
  assert.doesNotMatch(html, /\$\('connLetIn'\)/, 'no handler or visibility machinery');
  assert.doesNotMatch(html, /fetch\('\/account\/devices'\)/, 'no entitlement ask');
  assert.doesNotMatch(html, /fetch\('\/account\/enrol-device'/, 'no admit ask');
  assert.doesNotMatch(html, /invitation link in your email/i, 'no route via an invitation that can no longer be sent');
});

test('the panel answers the dead account relays with 410 tombstones, in plain words', async () => {
  // A page from an old build still calls these; it must get a sentence that
  // names the replacement, not a hang or a bare 404 it cannot explain.
  const { createPanelServer } = await import('./panel-server.mjs');
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html>x</html>',
    bridge: { targets: () => [], stream: () => {}, tty: () => {} } });
  await new Promise((r) => s.on('listening', r));
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const dev = await fetch(`${base}/account/devices`);
    assert.equal(dev.status, 410, 'gone for good, not not-found');
    const devBody = await dev.json();
    assert.equal(devBody.retired, true);
    assert.match(devBody.reason, /add this computer from one that already opens the mineral \(Map page\)/,
      'the tombstone names the way in that works now');
    const enr = await fetch(`${base}/account/enrol-device`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(enr.status, 410);
    assert.equal((await enr.json()).retired, true);
  } finally { s.closeAllConnections?.(); s.close(); }
});

test('the enrol relays are retired: gone from the door, answered honestly by the panel', () => {
  // SELF-HOST STRIP (2026-09-01), both halves. The door removed the routes
  // outright (device admission is local now, device-routes.mjs). The panel
  // still ANSWERS them (a page that calls them must get a sentence, not a
  // 404): production gets a 410 with the local-device-add pointer, and only an
  // injected test module ever reaches the old relay machinery.
  for (const route of ["path === '/account/devices'", "path === '/account/enrol-device'"]) {
    assert.ok(!door.includes(route), `door-server must not relay ${route} any more`);
    assert.ok(server.includes(route), `panel-server must still answer ${route}`);
  }
  assert.match(server, /the central account service has been retired/,
    'the retired answer says what happened and what to do instead');
  assert.ok(!/deviceEnrolModule \|\| await import\('\.\/device-enrol\.mjs'\)/.test(server),
    'production never falls through to the directory relay module');
});
