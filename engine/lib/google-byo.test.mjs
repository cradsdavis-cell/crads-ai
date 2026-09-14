// google-byo.test.mjs — run: node --test engine/lib/google-byo.test.mjs
//
// The shape of "several Google accounts on one box" (2026-09-14): the key
// grammar, the slug the member's name becomes, the per-account state files,
// and the one regex the app mirrors by hand so the bundle stays engine-free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GOOGLE_KEY_RE, googleSlug, googleKeyFor, googleKeySlug, googleStateFiles, googleCredsFileName, googleEntries } from './google-byo.mjs';

test('the key grammar: google, or google-<slug of 1..20>', () => {
  for (const ok of ['google', 'google-work', 'google-acme-ltd', 'google-2nd', 'google-' + 'a'.repeat(20)]) assert.ok(GOOGLE_KEY_RE.test(ok), ok);
  for (const bad of ['google-', 'google--', 'google-Work', 'google_work', 'googles', 'gmail', 'google-' + 'a'.repeat(21), ' google', 'google-a b']) assert.ok(!GOOGLE_KEY_RE.test(bad), bad);
});

test('what the member types becomes a slug the grammar accepts, or nothing', () => {
  assert.equal(googleSlug('Work'), 'work');
  assert.equal(googleSlug('  Acme Ltd  '), 'acme-ltd');
  assert.equal(googleSlug('second gmail!'), 'second-gmail');
  assert.equal(googleSlug('a'.repeat(40)), 'a'.repeat(20), 'clipped to the grammar');
  assert.equal(googleSlug('---'), '');
  assert.equal(googleSlug(''), '');
  assert.equal(googleSlug(null), '');
  for (const label of ['Work', 'Acme Ltd', 'x'.repeat(50), 'client #2']) assert.ok(GOOGLE_KEY_RE.test(googleKeyFor(label)), label);
  assert.equal(googleKeyFor('Work'), 'google-work');
  assert.equal(googleKeyFor('!!!'), '', 'no usable name = no key, said rather than guessed');
  assert.equal(googleKeySlug('google-work'), 'work');
  assert.equal(googleKeySlug('google'), '');
});

test('state files: the primary keeps its pre-2026-09-14 names, every other account suffixes its slug', () => {
  const f = googleStateFiles('/state', 'google');
  assert.equal(f.dead, '/state/.kernel/google-key-dead.json');
  assert.equal(f.ledger, '/state/.kernel/google-rekey-ping.json');
  const w = googleStateFiles('/state', 'google-work');
  assert.equal(w.dead, '/state/.kernel/google-key-dead.work.json');
  assert.equal(w.ledger, '/state/.kernel/google-rekey-ping.work.json');
});

test('credential file names follow workspace-mcp byte-for-byte', () => {
  assert.equal(googleCredsFileName('jane@gmail.com'), 'jane@gmail.com.json');
  assert.equal(googleCredsFileName('jane+work@gmail.com'), 'jane%2Bwork@gmail.com.json');
  assert.equal(googleCredsFileName("o'brien@x.com"), 'o%27brien@x.com.json');
});

test('googleEntries lists only BYO rows with valid keys, primary first', () => {
  const store = {
    'google-work': { provider: 'google-byo', email: 'w@x' },
    notion: { refresh_token: 'r' },
    'google-bad key': { provider: 'google-byo' },
    google: { provider: 'google-byo', email: 'p@x' },
    'google-acme': { provider: 'google-byo', email: 'a@x' },
  };
  assert.deepEqual(googleEntries(store).map(([k]) => k), ['google', 'google-acme', 'google-work']);
  assert.deepEqual(googleEntries(null), []);
});

test('the app mirrors GOOGLE_KEY_RE by hand: the two must never drift', () => {
  const routes = readFileSync(path.join(import.meta.dirname, '..', '..', 'wizard', 'panel', 'google-connect-routes.mjs'), 'utf8');
  const m = routes.match(/^export const GOOGLE_KEY_RE = (\/.*\/);$/m);
  assert.ok(m, 'the routes file exports its own copy');
  assert.equal(m[1], GOOGLE_KEY_RE.toString());
  const page = readFileSync(path.join(import.meta.dirname, '..', '..', 'wizard', 'panel', 'member.html'), 'utf8');
  const slugFn = page.match(/function gwSlug\(label\)\{\s*return ([^\n]+);/);
  assert.ok(slugFn, 'the page carries the slug rule too');
  // the same inputs must slug the same way on the page as on the box
  const pageSlug = new Function('label', 'return ' + slugFn[1] + ';');
  for (const label of ['Work', '  Acme Ltd  ', 'second gmail!', 'a'.repeat(40), '---', '']) assert.equal(pageSlug(label), googleSlug(label), label);
});
