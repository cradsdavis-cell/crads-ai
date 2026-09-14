// app-boot.test.mjs: the desktop-app entry must BOOT, not just parse. On
// 2026-09-11 a merge dropped an import from app.mjs; every unit test stayed
// green because none of them execute main(), and the Windows exe smoke was
// the first thing to notice. This test spawns the entry the way the CI smoke
// does (no window, no self-install) and asserts it prints its loopback URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpDir } from '../tests/tmp-dir.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('app.mjs boots headless and prints its loopback URL', async () => {
  const home = tmpDir('app-boot-');
  const child = spawn(process.execPath, [join(here, 'app.mjs')], {
    env: { ...process.env, AIOS_NO_LAUNCH: '1', AIOS_NO_INSTALL: '1', HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no URL within 15s\nstdout: ' + out + '\nstderr: ' + err)), 15000);
    const check = () => { const m = out.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timer); resolve(m[0]); } };
    child.stdout.on('data', check);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('exited ' + code + ' before printing a URL\nstderr: ' + err)); });
  }).finally(() => child.kill('SIGKILL'));
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.doesNotMatch(err, /FATAL|ReferenceError/);
});
