// selfhost-assets.test.mjs — the exe carries the self-host wizard's cloud-init
// sources, and the app hands them to the provision routes.
// Run: node --test wizard/panel/selfhost-assets.test.mjs
//
// The class this pins (2026-09-01, found on the first real Windows run): a
// module that reads a repo path works in every dev checkout and fails only
// inside the packaged exe, where import.meta.url is the exe itself. The
// vendor/marks 404 of 2026-08-23 was the same shape. So: the three sources
// must be SEA assets in BOTH platform blocks of the workflow, and app.mjs must
// actually pass them to the door's provision routes — either half alone still
// ships the bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wf = readFileSync(new URL('../../.github/workflows/wizard-app.yml', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.mjs', import.meta.url), 'utf8');

test('the three cloud-init sources are SEA assets on both platforms', () => {
  for (const [name, path] of [
    ['cloud-init.template.yaml', 'provisioning/managed/cloud-init.template.yaml'],
    ['aios-host-update', 'provisioning/host/aios-host-update'],
    ['enter-aios', 'provisioning/host/enter-aios'],
  ]) {
    const hits = wf.split(`"${name}": "${path}"`).length - 1;
    assert.equal(hits, 2, `${name} must appear in BOTH sea-config blocks (windows + mac); found ${hits}`);
  }
});

// The LOCAL face's engine files (2026-09-11): same class, same two halves.
// The list is the module's own (LOCAL_ASSET_FILES), never a copy, and
// local-scaffold.test.mjs pins that list against the engine/skills directory.
test('every local-face engine asset is a SEA asset on both platforms, and app.mjs loads the bag through asset()', async () => {
  const { LOCAL_ASSET_FILES } = await import('./local-scaffold.mjs');
  assert.ok(LOCAL_ASSET_FILES.length >= 15, 'the list is not empty');
  for (const key of LOCAL_ASSET_FILES) {
    const hits = wf.split(`"${key}": "${key}"`).length - 1;
    assert.equal(hits, 2, `${key} must appear in BOTH sea-config blocks (windows + mac); found ${hits}`);
  }
  assert.match(app, /loadEngineAssets\(\{ read: \(name, fsPath\) => asset\(name, fsPath\) \}\)/, 'the bag reads through the SEA-first helper');
  assert.match(app, /local: \{ assets: localAssets \}/, 'the door mount carries the bag');
  assert.match(app, /localBridge\(\{ targets: listLocalTargets, assets: localAssets \}\)/, 'and so does the local transport');
});

test('app.mjs hands the sources to the provision routes', () => {
  assert.match(app, /provision: \{ files: selfHostFiles \}/, 'the door mount carries the files');
  for (const name of ['cloud-init.template.yaml', 'aios-host-update', 'enter-aios']) {
    assert.ok(app.includes(`asset('${name}'`), `${name} is loaded through the SEA asset helper`);
  }
});
