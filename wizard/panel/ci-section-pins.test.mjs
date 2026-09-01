// ci-section-pins.test.mjs — the shell sections CI pins, checked from here too.
//   node --test wizard/panel/ci-section-pins.test.mjs
//
// Trap 28 (2026-08-10). `.github/workflows/wizard-app.yml` smoke-tests the built
// exe by grepping the served shell for a hardcoded list of `data-sec="…"`
// strings, and a second list of surfaces that must NOT appear. Renaming a
// section therefore has THREE places to change, and only two of them are
// reachable by any test in this repo: `node --test` over `*.test.mjs` cannot see
// workflow YAML, and neither can the qa-* sweep.
//
// So when the Rocks rebuild retired data-sec="rockbrain", every local suite went
// green, the merge landed on the shipping branch, `:v2` was promoted, and the
// FIRST signal that anything was wrong was the app-exe build going red on a
// commit already pushed. The exe is the surface users actually run, so the
// window between "merged" and "noticed" was a window in which the app could not
// be rebuilt at all.
//
// This file removes the third place from the danger list by reading the
// workflow's own lists and holding member.html to them. It is deliberately a
// PARSE of the YAML rather than a copy of the strings: a copy would be a fourth
// place to forget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const wf = readFileSync(new URL('../../.github/workflows/wizard-app.yml', import.meta.url), 'utf8');

// The two PowerShell loops the smoke runs: `foreach ($sec in 'a','b',…)` and
// `foreach ($gone in 'a','b',…)`. Pull the quoted items out of each.
function pinnedList(varName) {
  const m = wf.match(new RegExp("foreach \\(\\$" + varName + " in ([^)]*)\\)"));
  assert.ok(m, `the workflow still has a foreach ($${varName} in …) smoke loop`);
  const items = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  assert.ok(items.length > 0, `the $${varName} loop lists at least one string`);
  return items;
}

test('every section the exe smoke requires is actually in the shell', () => {
  const missing = pinnedList('sec').filter((s) => !html.includes(s));
  assert.deepEqual(missing, [],
    `wizard-app.yml requires these in the served shell and member.html lacks them: ${missing.join(', ')}`);
});

test('every surface the exe smoke forbids is actually gone from the shell', () => {
  const present = pinnedList('gone').filter((s) => html.includes(s));
  assert.deepEqual(present, [],
    `wizard-app.yml forbids these and member.html still carries them: ${present.join(', ')}`);
});

// The specific renames that taught the lesson, pinned by name so a revert is
// loud rather than merely red on a Windows runner ten minutes after the push.
// The face collapse (2026-09-01) retired the whole org-only page family, so the
// reader and the Rocks page joined rockbrain on the forbidden list, and the
// required list is the surviving one-face sidebar.
test('the retired org-face sections stay retired, in the shell and in CI', () => {
  const gone = pinnedList('gone');
  for (const dead of ['data-sec="rockbrain"', 'data-sec="rockreader"', 'data-sec="rocks"',
    'data-sec="pebbles"', 'data-sec="decisions"', 'data-sec="yourrock"']) {
    assert.ok(!html.includes(dead), `${dead} is gone from the shell`);
    assert.ok(gone.includes(dead), `and CI forbids the return of ${dead}`);
  }
  const sec = pinnedList('sec');
  for (const alive of ['data-sec="seat"', 'data-sec="commons"', 'data-sec="publish"',
    'data-sec="skills"', 'data-sec="library"']) {
    assert.ok(sec.includes(alive), `CI requires the surviving section ${alive}`);
  }
});
