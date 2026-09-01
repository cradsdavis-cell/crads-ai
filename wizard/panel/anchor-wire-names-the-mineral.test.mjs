// anchor-wire-names-the-mineral.test.mjs — RETIRED (2026-09-01, the face
// collapse).
//
// What this file used to hold: finding 152's last sibling, the app relay half
// (2026-08-17). wireAnchoredTies was the one unattended caller of
// /anchor-wire-claim, and with two bundles staged for one person it posted
// { org } and nothing else, so the directory 409ed both forever and nothing
// on the screen said so. Five driven tests, against a directory stub
// transcribed from worker.js as deployed, pinned that every claim and every
// pubkeys relay NAMES the mineral. The self-host pivot deleted the relay, the
// routes it called and the worker that answered them: nothing stages a bundle
// for another person's mineral any more. The pins hold that the whole chain
// stays gone, in the same three places the old tests exercised it.
//
// Run: node --test wizard/panel/anchor-wire-names-the-mineral.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('the anchor-wire relay is RETIRED: no unattended caller survives in the server', () => {
  const server = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');
  const code = server.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!code.includes('wireAnchoredTies'), 'the relay must stay gone');
  assert.ok(!code.includes('/anchor-wire-claim'), 'and no code path names its route');
  assert.ok(!code.includes('/anchor-pubkeys'), 'nor the twin relay five lines below it');
});

test('the directory that answered the claim is RETIRED too', () => {
  // The stub in the old tests was transcribed from directory/worker.js; a
  // resurrected worker would re-arm the whole finding-152 family.
  assert.ok(!existsSync(new URL('../../directory/worker.js', import.meta.url)),
    'the worker source stays gone');
});
