// host.test.mjs: source guards for the Windows window host (host.cpp).
//
// The host only compiles on the Windows runner (MSVC + the WebView2 SDK), and
// the wizard-app smokes always hand it a url, so nothing there notices if the
// no-url path regresses. The class (2026-10-30, a member's black screen): a
// pinned taskbar icon started crads-ai-window-<tag>.exe with no url, which
// opened about:blank on the dark background with no app behind it. These pin
// the two halves of the fix in the source.
// Run: node --test wizard/assets/win-host/host.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('./host.cpp', import.meta.url)), 'utf8');
const APP_MJS = readFileSync(fileURLToPath(new URL('../../app.mjs', import.meta.url)), 'utf8');

test('a launch with no url hands over to Crads-AI.exe instead of a blank window', () => {
  assert.match(SRC, /if \(!haveUrl && !app\.empty\(\)\) return LaunchApp\(app\)/);
  // the hand-over has to come before the window exists, or the blank window flashes
  assert.ok(SRC.indexOf('return LaunchApp(app)') < SRC.indexOf('CreateWindowExW('), 'LaunchApp runs before the window is created');
  // --probe still returns before anything launches (the CI gate has no app beside it)
  assert.ok(SRC.indexOf('if (probe)') < SRC.indexOf('return LaunchApp(app)'), '--probe is answered first');
});

test('the app the host hands over to is the exe selfInstall writes beside it', () => {
  assert.match(APP_MJS, /const APP_NAME = 'Crads-AI';/);
  assert.match(APP_MJS, /join\(dir, `\$\{APP_NAME\}\.exe`\)/);
  assert.match(SRC, /dir \+ L"Crads-AI\.exe"/);
});

test('pinning the window pins the app, not the build-tagged host', () => {
  for (const key of ['PKEY_AppUserModel_ID', 'PKEY_AppUserModel_RelaunchCommand', 'PKEY_AppUserModel_RelaunchDisplayNameResource']) {
    assert.ok(SRC.includes(`set(${key},`), `${key} is set (Windows ignores the relaunch command without all three)`);
  }
  assert.ok(SRC.indexOf('PinToApp(hwnd, app)') < SRC.indexOf('ShowWindow(hwnd'), 'set before the window is shown');
});

test('app.mjs never opens the host without a url (that would now relaunch the app)', () => {
  for (const m of APP_MJS.matchAll(/spawn\(host, \[([^\]]*)\]/g)) {
    assert.notEqual(m[1].trim(), '', 'every spawn of the host passes the url');
  }
  assert.match(APP_MJS, /spawn\(host, \[url\]/);
});
