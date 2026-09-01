// A member's mineral is UP and answering and simply refuses this machine's key.
// The app used to read that as "waiting for your box" and say "nothing you need
// to do" -- about the one state where there IS something to do and which never
// resolves on its own. Recognising the state correctly is the first half of this
// file, and it has not changed.
//
// The second half did, on 2026-08-11. The state used to end in a two-party
// ceremony: the app printed a 6-char code and told the member to find whoever
// set the mineral up and read it to them. Sam retired that outright ("the user
// shouldn't need a code or anything. They should just be allowed in through
// clicking the link that's emailed to them"), which T9 had already made possible
// in August: the device mints its own key, binds a token to it, and the MINERAL
// decides. So the dead end becomes a button, and the code is DELETED rather than
// hidden, route included, because a route that still answers is a route a future
// screen re-grows.
//
// Two ways in remain, and the screen has to pick the right one, because only one
// of them can work at a time:
//   OWNED     the signed-in account owns this mineral -> ask it directly (T9).
//   NOT OWNED nothing on this machine can vouch for it -> the emailed invitation
//             is the only route, and saying anything else strands them.
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
  assert.match(body[1], /let this computer in/i, 'names the action');
  assert.match(body[1], /decides for itself/i, 'and says who decides');
  assert.doesNotMatch(body[1], /nothing you need to do/i, 'never the reassuring lie');
});

// ------------------------------------------------- the two routes

test('the owned case asks the mineral directly, through T9', () => {
  assert.match(html, /fetch\('\/account\/devices'\)/, 'checks whether the account owns this mineral');
  assert.match(html, /fetch\('\/account\/enrol-device'/, 'and asks that one to admit the machine');
  assert.match(html, /body: JSON\.stringify\(\{ host: state\.host/, 'asking about THIS mineral, not the first in the list');
});

test('the not-owned case is sent to the emailed invitation, the only route left', () => {
  // Getting this branch wrong is worse than the code was: the button would be
  // offered to someone it cannot possibly work for, and the real route unsaid.
  // Anchored on the fetch, not on `var mine`: member.html has five of those and
  // the first one is a keyboard-idle check 500 lines away.
  const i = html.indexOf("fetch('/account/devices')");
  assert.ok(i > 0, 'the page filters the account list down to this mineral');
  const filtered = html.slice(i, html.indexOf('letIn.style.display', i));
  assert.match(filtered, /invitation link in your email/i, 'and names the invitation when it is not there');
  assert.match(filtered, /THIS computer/, 'on the machine that needs admitting, which is the part people miss');
});

test('the two names one mineral has are matched on the slug, never on equality', () => {
  // state.host is the local ssh alias (keith-box); a /my-boxes row carries the
  // registered host (keith.crads-ai.com). Comparing them directly offers the
  // button to nobody and sends every owner to an email that may not exist. Found
  // by driving it with a fixture that used the two real shapes.
  assert.match(html, /function slugOf\(h\)\{/, 'there is one place that reduces both names');
  assert.match(html, /slugOf\(b\.host\) === slugOf\(state\.host\)/, 'and the filter uses it');
  assert.doesNotMatch(html, /b\.host === state\.host/, 'never raw equality between the two naming schemes');
  assert.match(html, /letIn\.dataset\.host = mine\[0\]\.host/, 'the row keeps its own name for the ask');
  assert.match(html, /host: \$\('connLetIn'\)\.dataset\.host \|\| state\.host/,
    'and the ask sends the name the directory issued');
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
