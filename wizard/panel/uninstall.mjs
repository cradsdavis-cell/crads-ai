// uninstall.mjs — the way OUT of the app (SignPath Foundation terms, 2026-09-14:
// software that installs itself must announce it and ship an uninstall path).
// Two halves, dependency-free and injectable for tests, same shape as protocol.mjs:
//   registerUninstall(): the HKCU Add/Remove Programs entry (per-user, no admin) that
//     points Windows at `Crads-AI.exe --uninstall`. Idempotent (reg add /f).
//   uninstall(): what that flag does. Shortcuts, the Add/Remove entry, the crads-ai://
//     handler, then the program folder, which a running exe cannot delete from inside
//     itself, so a detached cmd does it after this process has exited.
// Deliberately NOT removed: %LOCALAPPDATA%\Crads-AI (the run file, startup/error logs
// and the person's local-mode brain), ~/.ssh entries, and anything on their server.
// Those are the person's data; the app only removes the app.
import { execFile, spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';

export const APP_NAME = 'Crads-AI';
export const UNINSTALL_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_NAME}`;
export const PROTOCOL_KEY = 'HKCU\\Software\\Classes\\crads-ai';

const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, (e, so) => (e ? rej(e) : res(so))));

export function wantsUninstall(argv) {
  return (argv || []).some((a) => String(a || '').toLowerCase() === '--uninstall');
}

// The `reg add` calls, as data, so the test pins every value and the runner stays dumb.
export function uninstallEntryCommands({ target, dir, ico = '', version = '', sizeBytes = 0, installDate = '' } = {}) {
  const key = UNINSTALL_KEY;
  const str = (name, value) => ['reg', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f']];
  const dword = (name, value) => ['reg', ['add', key, '/v', name, '/t', 'REG_DWORD', '/d', String(value), '/f']];
  const cmds = [
    str('DisplayName', APP_NAME),
    str('DisplayIcon', ico ? `${ico},0` : target),
    str('Publisher', 'crads-ai.com'),
    str('URLInfoAbout', 'https://crads-ai.com'),
    str('InstallLocation', dir),
    str('UninstallString', `"${target}" --uninstall`),
    str('QuietUninstallString', `"${target}" --uninstall`),
    dword('NoModify', 1),
    dword('NoRepair', 1),
  ];
  if (version) cmds.push(str('DisplayVersion', version));
  if (installDate) cmds.push(str('InstallDate', installDate));
  if (sizeBytes > 0) cmds.push(dword('EstimatedSize', Math.max(1, Math.round(sizeBytes / 1024))));
  return cmds;
}

export async function registerUninstall({ platform = process.platform, runner = run, ...facts } = {}) {
  if (platform !== 'win32') return { done: false, reason: `no Add/Remove entry on ${platform}` };
  try {
    for (const [cmd, args] of uninstallEntryCommands(facts)) await runner(cmd, args);
    return { done: true };
  } catch (e) { return { done: false, reason: String(e.message || e) }; }
}

// The detached command line that removes the program folder once this exe has exited.
// ping is the portable Windows sleep; taskkill closes a still-open window host; the
// rmdir retries because a file handle can outlive the process by a beat.
export function folderRemovalCommand(dir) {
  const q = dir.replace(/"/g, '');
  return `ping 127.0.0.1 -n 3 >nul & taskkill /F /IM "crads-ai-window*" >nul 2>&1 & `
    + `rmdir /s /q "${q}" & ping 127.0.0.1 -n 3 >nul & if exist "${q}" rmdir /s /q "${q}"`;
}

export async function uninstall({
  platform = process.platform, dir, shortcuts = [], runner = run,
  spawner = (cmd, args, opts) => spawn(cmd, args, opts), rm = unlinkSync, exists = existsSync,
} = {}) {
  if (platform !== 'win32') return { done: false, reason: `nothing installed on ${platform}` };
  const removed = [], failed = [];
  for (const lnk of shortcuts) {
    try { if (exists(lnk)) { rm(lnk); removed.push(lnk); } } catch { failed.push(lnk); }
  }
  for (const key of [UNINSTALL_KEY, PROTOCOL_KEY]) {
    try { await runner('reg', ['delete', key, '/f']); removed.push(key); } catch { failed.push(key); }
  }
  let folder = 'kept';
  if (dir) {
    try {
      const child = spawner('cmd.exe', ['/d', '/c', folderRemovalCommand(dir)], { detached: true, stdio: 'ignore', windowsHide: true });
      if (child && child.unref) child.unref();
      folder = 'scheduled';
    } catch { folder = 'failed'; failed.push(dir); }
  }
  return { done: failed.length === 0, removed, failed, folder };
}
