import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wantsUninstall, uninstallEntryRegText, registerUninstall, uninstall, folderRemovalScript, UNINSTALL_KEY, PROTOCOL_KEY } from './uninstall.mjs';

const facts = { target: 'C:\\Users\\a\\AppData\\Local\\Programs\\Crads-AI\\Crads-AI.exe', dir: 'C:\\Users\\a\\AppData\\Local\\Programs\\Crads-AI', ico: 'C:\\Users\\a\\AppData\\Local\\Programs\\Crads-AI\\crads-ai.ico', version: 'abcdef12', sizeBytes: 89 * 1024 * 1024, installDate: '20260914' };

test('--uninstall is recognised, case-insensitively, and nothing else is', () => {
  assert.equal(wantsUninstall(['C:\\x.exe', '--uninstall']), true);
  assert.equal(wantsUninstall(['C:\\x.exe', '--Uninstall']), true);
  assert.equal(wantsUninstall(['C:\\x.exe', 'crads-ai://box/a']), false);
  assert.equal(wantsUninstall(undefined), false);
});

test('the Add/Remove Programs entry is one .reg import carrying what Windows shows and what it runs', () => {
  const reg = uninstallEntryRegText(facts);
  const lines = reg.split('\r\n');
  assert.equal(lines[0], 'Windows Registry Editor Version 5.00');
  assert.equal(lines[2], `[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Crads-AI]`);
  assert.ok(lines.includes('"DisplayName"="Crads-AI"'));
  assert.ok(lines.includes('"UninstallString"="\\"C:\\\\Users\\\\a\\\\AppData\\\\Local\\\\Programs\\\\Crads-AI\\\\Crads-AI.exe\\" --uninstall"'), 'backslashes doubled, inner quotes escaped: ' + reg);
  assert.ok(lines.includes('"DisplayIcon"="C:\\\\Users\\\\a\\\\AppData\\\\Local\\\\Programs\\\\Crads-AI\\\\crads-ai.ico,0"'));
  assert.ok(lines.includes('"InstallLocation"="C:\\\\Users\\\\a\\\\AppData\\\\Local\\\\Programs\\\\Crads-AI"'));
  assert.ok(lines.includes('"DisplayVersion"="abcdef12"'));
  assert.ok(lines.includes('"EstimatedSize"=dword:00016400'), '89 MiB in KiB, hex');
  assert.ok(lines.includes('"NoModify"=dword:00000001'));
  assert.ok(lines.includes('"Publisher"="crads-ai.com"'));
  assert.equal(reg.slice(-4), '\r\n\r\n', 'reg.exe wants a trailing blank line');
});

test('no icon yet: DisplayIcon falls back to the exe; unknown size/version are simply omitted', () => {
  const reg = uninstallEntryRegText({ target: 'C:\\p\\Crads-AI.exe', dir: 'C:\\p' });
  assert.match(reg, /"DisplayIcon"="C:\\\\p\\\\Crads-AI\.exe"/);
  assert.doesNotMatch(reg, /EstimatedSize|DisplayVersion|InstallDate/);
});

test('registerUninstall writes the .reg, imports it in ONE call, removes the temp file; honest no-op elsewhere; never throws', async () => {
  const calls = [], removed = [];
  const r = await registerUninstall({ platform: 'win32', runner: async (c, a) => { calls.push([c, ...a]); }, writeReg: () => 'C:\\Temp\\e.reg', rm: (p) => removed.push(p), ...facts });
  assert.equal(r.done, true);
  assert.deepEqual(calls, [['reg', 'import', 'C:\\Temp\\e.reg']]);
  assert.deepEqual(removed, ['C:\\Temp\\e.reg']);
  assert.equal((await registerUninstall({ platform: 'darwin', ...facts })).done, false);
  const bad = await registerUninstall({ platform: 'win32', runner: async () => { throw new Error('registry denied'); }, writeReg: () => 'C:\\Temp\\e.reg', rm: () => {}, ...facts });
  assert.equal(bad.done, false); assert.match(bad.reason, /denied/);
});

test('uninstall removes shortcuts + both registry keys, then schedules the folder removal detached', async () => {
  const regs = [], spawned = [], rmd = [], scripts = [];
  const shortcuts = ['C:\\u\\Start Menu\\Crads-AI.lnk', 'C:\\u\\Desktop\\Crads-AI.lnk', 'C:\\u\\gone.lnk'];
  const r = await uninstall({
    platform: 'win32', dir: facts.dir, shortcuts,
    runner: async (c, a) => { regs.push([c, ...a].join(' ')); },
    spawner: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { unref() {} }; },
    rm: (p) => rmd.push(p), exists: (p) => !p.endsWith('gone.lnk'),
    writeScript: (text) => { scripts.push(text); return 'C:\\Temp\\crads-ai-uninstall-1.cmd'; },
  });
  assert.equal(r.done, true);
  assert.deepEqual(rmd, shortcuts.slice(0, 2), 'a shortcut the person already deleted is not an error');
  assert.deepEqual(regs, [`reg delete ${UNINSTALL_KEY} /f`, `reg delete ${PROTOCOL_KEY} /f`]);
  assert.equal(r.folder, 'scheduled');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, 'cmd.exe');
  assert.equal(spawned[0].opts.detached, true, 'the folder removal must outlive this process');
  assert.deepEqual(spawned[0].args, ['/d', '/c', 'C:\\Temp\\crads-ai-uninstall-1.cmd'], 'cmd runs a script path, never a quoted multi-command string');
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /rmdir \/s \/q "C:\\Users\\a\\AppData\\Local\\Programs\\Crads-AI"/);
});

test('a missing protocol key (never registered) does not fail the uninstall as a whole', async () => {
  const r = await uninstall({ platform: 'win32', dir: '', shortcuts: [], runner: async (c, a) => { if (a[1] === PROTOCOL_KEY) throw new Error('not found'); }, spawner: () => ({ unref() {} }) });
  assert.deepEqual(r.failed, [PROTOCOL_KEY]);
  assert.equal(r.folder, 'kept');
});

test('the removal script waits, closes the window host, retries the rmdir once, and deletes itself', () => {
  const c = folderRemovalScript('C:\\p\\Crads-AI');
  const lines = c.split('\r\n');
  assert.equal(lines[0], '@echo off');
  assert.match(lines[1], /^ping 127\.0\.0\.1 -n 3 >nul$/);
  assert.match(lines[2], /^taskkill/);
  assert.equal((c.match(/rmdir \/s \/q "C:\\p\\Crads-AI"/g) || []).length, 2);
  assert.match(lines.at(-2), /del "%~f0"/);
});

test('app.mjs wires the flag before the single-instance dance and registers the entry from selfInstall', () => {
  const app = readFileSync(new URL('../app.mjs', import.meta.url), 'utf8');
  assert.ok(app.includes("from './panel/uninstall.mjs'"), 'app.mjs imports the module');
  const flag = app.indexOf('wantsUninstall(process.argv)');
  const dance = app.indexOf('no live instance; relaunching self HIDDEN');
  assert.ok(flag > -1 && dance > -1 && flag < dance, '--uninstall must be handled before the app relaunches itself hidden');
  assert.ok(app.includes('registerUninstall('), 'selfInstall registers the Add/Remove entry');
});
