// wizard/panel/mcp-catalogue.test.mjs: run node --test wizard/panel/mcp-catalogue.test.mjs
//
// The catalogue is the only tier of the directory we VOUCH for (spec ruling 1),
// so its shape is load-bearing: a missing url is a dead Connect button, a
// duplicate key breaks the hide-connected logic, and a boxKey that drifts from
// the box's FEATURED set silently reroutes a one-click connect into add-custom,
// which the box refuses for featured names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CATALOGUE, CATEGORIES } from './mcp-catalogue.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;   // the box's rule for add-custom names

test('every entry is complete and well-formed', () => {
  assert.ok(CATALOGUE.length >= 20, 'a directory, not a stub');
  for (const e of CATALOGUE) {
    assert.match(e.key, NAME_RE, `${e.key}: key must satisfy the box name rule`);
    assert.ok(e.label && typeof e.label === 'string', `${e.key}: label`);
    assert.ok(e.blurb && e.blurb.length <= 80, `${e.key}: blurb, short`);
    assert.match(e.url, /^https:\/\//, `${e.key}: https only`);
    assert.ok(CATEGORIES.includes(e.category), `${e.key}: category '${e.category}' not in CATEGORIES`);
  }
});

test('keys and urls are unique', () => {
  const keys = CATALOGUE.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate key');
  const urls = CATALOGUE.map((e) => e.url);
  assert.equal(new Set(urls).size, urls.length, 'duplicate url');
});

// Lockstep with the box, same pattern as the mcp contract pair: read the file
// text, never import it (mcp-connect.mjs is a CLI that executes on import).
test('every boxKey names a real box FEATURED entry, with the same url', () => {
  // labels moved to engine/lib/connection-labels.mjs (2026-08-09 audit R1), so
  // FEATURED entries open with their url now
  const engine = readFileSync(new URL('../../engine/comms/mcp-connect.mjs', import.meta.url), 'utf8');
  const featured = new Map([...engine.matchAll(/^\s{2}(\w+): \{ url: '([^']+)'/gm)].map((m) => [m[1], m[2]]));
  assert.ok(featured.size >= 6, 'could not parse FEATURED from mcp-connect.mjs');
  for (const e of CATALOGUE.filter((x) => x.boxKey)) {
    assert.ok(featured.has(e.boxKey), `${e.key}: boxKey '${e.boxKey}' is not box-FEATURED`);
    assert.equal(e.url, featured.get(e.boxKey), `${e.key}: url must match the box byte-for-byte`);
  }
});

// The page now ships a real sign-in-kind filter (member.html's "One click" /
// "Needs a token" pills), so the catalogue is expected to carry BOTH auth
// kinds. What stays load-bearing is that every entry names one of the two:
// an entry with neither silently disappears from both pill views, since the
// page filters on an exact 'oauth' / 'token' match.
test('every entry declares a sign-in kind, and both kinds are represented', () => {
  for (const e of CATALOGUE) {
    assert.ok(e.auth === 'oauth' || e.auth === 'token', `${e.key}: auth must be 'oauth' or 'token', got ${JSON.stringify(e.auth)}`);
  }
  const kinds = new Set(CATALOGUE.map((e) => e.auth));
  assert.ok(kinds.has('oauth'), 'at least one oauth entry, so the "One click" pill has something to show');
  assert.ok(kinds.has('token'), 'at least one token entry, so the "Needs a token" pill has something to show');
});

test('every box FEATURED entry appears in the catalogue', () => {
  const engine = readFileSync(new URL('../../engine/comms/mcp-connect.mjs', import.meta.url), 'utf8');
  const featured = [...engine.matchAll(/^\s{2}(\w+): \{ url: '[^']+'/gm)].map((m) => m[1]);
  assert.ok(featured.length >= 6, 'could not parse FEATURED from mcp-connect.mjs');
  const boxKeys = new Set(CATALOGUE.map((e) => e.boxKey).filter(Boolean));
  for (const k of featured) assert.ok(boxKeys.has(k), `box-FEATURED '${k}' missing from the catalogue`);
});
