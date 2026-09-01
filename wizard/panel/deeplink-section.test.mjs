// deeplink-section.test.mjs — a deep-linked section must load with a real host.
// Run: node --test wizard/panel/deeplink-section.test.mjs
//
// Why this file exists. panel.html activated the section named by the hash at
// PARSE time, while state.host is still '' and the /targets fetch is in
// flight. Every verb that section loads then posts host:'' and gets back
// "host must be a configured <org>-rock target" (400), and the section
// paints its EMPTY state — which is a lie about the org, not a report about
// it. Landing on /panel.html#skills showed "No skills yet. Author one in the
// Claude Code app" for a rock that had a skill on disk and a member
// already running it, and nothing ever retried, so the skills were invisible
// and unpushable for the whole session. Found live on certrock 2026-08-04.
//
// member.html has always done this correctly: it calls secFromHash() INSIDE
// the targets callback, after state.host is set. panel.html now matches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(HERE, 'member.html'), 'utf8');

test('panel.html does not activate a hash section before targets resolve', () => {
  // the parse-time IIFE is the bug shape: secFromHash() called at top level,
  // outside any callback that has awaited /targets.
  assert.doesNotMatch(
    panel,
    /\(function\(\)\{\s*var h = secFromHash\(\); if \(h\) activateSec\(h\); \}\)\(\);/,
    'the parse-time hash activation must be gone',
  );
});

test('the hash section is activated inside the targets callback, after state.host', () => {
  const cb = panel.match(/fetch\('\/targets'\)[\s\S]*?\n  \}\);/);
  assert.ok(cb, 'the targets callback must still exist');
  const hostAt = cb[0].indexOf('state.host =');
  const secAt = cb[0].indexOf('secFromHash()');
  assert.ok(hostAt >= 0, 'the callback must set state.host');
  assert.ok(secAt > hostAt, 'the section must be activated only after state.host is known');
});

test('member.html keeps the ordering it already had', () => {
  const m = readFileSync(join(HERE, 'member.html'), 'utf8');
  const cb = m.match(/fetch\('\/targets'\)[\s\S]*?secFromHash\(\)/);
  assert.ok(cb, 'member.html must still resolve its section inside the targets callback');
});
