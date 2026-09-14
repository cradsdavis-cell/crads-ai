import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wantsUninstall, uninstallEntryCommands, registerUninstall, uninstall, folderRemovalScript, UNINSTALL_KEY, PROTOCOL_KEY } from './uninstall.mjs';

const facts = { target: 'C:\\Users\\a\\AppData\\Local\\Programs\\Crads-AI\\Crads-AI.exe', dir: 'C:\\Users\\a\\AppData\\Local\\Programs\\Crads-AI', ico: 'C:\\Users\\a\\AppData\\Local\\Programs\\Crads-AI\\crads-ai.ico', version: 'abcdef12', sizeBytes: 89 * 1024 * 1024, installDate: '20260914' };

test('--uninstall is recognised, case-insensitively, and nothing else is', () => {
  assert.equal(wantsUninstall(['C:\\x.exe', '--uninstall']), true);
  assert.equal(wantsUninstall(['C:\\x.exe', '--Uninstall']), true);
  assert.equal(wantsUninstall(['C:\\x.exe', 'crads-ai://box/a']), false);
  assert.equal(wantsUninstall(undefined), false);
});

test('the Add/Remove Programs entry carries what Windows shows and what it runs', () => {
  const cmds = uninstallEntryCommands(facts);
  const flat = cmds.map(([c, a]) => [c, ...a].join(' ')).join('\n');
  assert.ok(cmds.every(([c, a]) => c === 'reg' && a[0] === 'add' && a[1] === UNINSTALL_KEY && a.at(-1) === '/f'), 'every command is an idempotent reg add under the one key');
  assert.match(flat, /DisplayName \/t REG_SZ \/d Crads-AI/);
  assert.match(flat, /UninstallString \/t REG_SZ \/d "C:\\Users\\a\\AppData\\Local\\Programs\\Crads-AI\\Crads-AI\.exe" --uninstall/);
  assert.match(flat, /DisplayIcon \/t REG_SZ \/d .*crads-ai\.ico,0/);
  assert.match(flat, /InstallLocation \/t REG_SZ \/d C:\\Users\\a\\AppData\\Local\\Programs\\Crads-AI \/f/);
  assert.match(flat, /DisplayVersion \/t REG_SZ \/d abcdef12/);
  assert.match(flat, /EstimatedSize \/t REG_DWORD \/d 91136/);
  assert.match(flat, /NoModify \/t REG_DWORD \/d 1/);
  assert.match(flat, /Publisher \/t REG_SZ \/d crads-ai\.com/);
});

test('no icon yet: DisplayIcon falls back to the exe; unknown size/version are simply omitted', () => {
  const flat = uninstallEntryCommands({ target: 'C:\\p\\Crads-AI.exe', dir: 'C:\\p' }).map(([, a]) => a.join(' ')).join('\n');
  assert.match(flat, /DisplayIcon \/t REG_SZ \/d C:\\p\\Crads-AI\.exe/);
  assert.doesNotMatch(flat, /EstimatedSize|DisplayVersion|InstallDate/);
});

test('registerUninstall runs every command on windows, is an honest no-op elsewhere, never throws', async () => {
  const calls = [];
  const r = await registerUninstall({ platform: 'win32', runner: async (c, a) => { calls.push(a[3]); }, ...facts });
  assert.equal(r.done, true);
  assert.deepEqual(calls.slice(0, 2), ['DisplayName', 'DisplayIcon']);
  assert.equal((await registerUninstall({ platform: 'darwin', ...facts })).done, false);
  const bad = await registerUninstall({ platform: 'win32', runner: async () => { throw new Error('registry denied'); }, ...facts });
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
