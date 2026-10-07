// Run: node --test wizard/panel/launch-plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launchPlan } from './launch-plan.mjs';

const app = readFileSync(new URL('../app.mjs', import.meta.url), 'utf8');

test('a first click on a Mac hands off to a detached pebble, like Windows', () => {
  // the 6 Oct bug: darwin served in the LaunchServices process, so a second
  // click only re-activated a windowless app
  assert.equal(launchPlan({ platform: 'darwin', sea: true, env: {} }), 'relaunch');
  assert.equal(launchPlan({ platform: 'win32', sea: true, env: {} }), 'relaunch');
});

test('the pebble serves, and never relaunches itself again', () => {
  for (const platform of ['darwin', 'win32']) {
    assert.equal(launchPlan({ platform, sea: true, env: { AIOS_RELAUNCHED: '1' } }), 'serve');
  }
});

test('a click while a copy answers reopens its window, on both platforms', () => {
  for (const platform of ['darwin', 'win32']) {
    assert.equal(launchPlan({ platform, sea: true, env: {}, live: true }), 'reopen');
  }
});

test('under the Mac window host the child only serves, even with a live copy recorded', () => {
  // the host owns the window and the Dock icon; a relaunch here would orphan
  // the server from the app that is supposed to stop it on quit
  assert.equal(launchPlan({ platform: 'darwin', sea: true, env: { AIOS_WINDOW_HOST: '1' } }), 'serve');
  assert.equal(launchPlan({ platform: 'darwin', sea: true, env: { AIOS_WINDOW_HOST: '1' }, live: true }), 'serve');
  // the flag means nothing on Windows, which keeps its own shape
  assert.equal(launchPlan({ platform: 'win32', sea: true, env: { AIOS_WINDOW_HOST: '1' } }), 'relaunch');
});

test('dev checkouts, linux and CI never relaunch', () => {
  assert.equal(launchPlan({ platform: 'darwin', sea: false, env: {} }), 'serve');
  assert.equal(launchPlan({ platform: 'linux', sea: true, env: {} }), 'serve');
  assert.equal(launchPlan({ platform: 'darwin', sea: true, env: { AIOS_NO_LAUNCH: '1' } }), 'serve');
});

test('app.mjs takes its launch decision from launchPlan, not a platform check of its own', () => {
  assert.match(app, /import \{ launchPlan \} from '\.\/panel\/launch-plan\.mjs';/);
  assert.match(app, /launchPlan\(\{ platform: process\.platform, sea: !!sea, env: process\.env/);
  assert.doesNotMatch(app, /process\.platform === 'win32' && !process\.env\.AIOS_RELAUNCHED/, 'the old Windows-only relaunch gate is gone');
});
