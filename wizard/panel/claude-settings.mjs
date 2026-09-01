// claude-settings.mjs: register an SSH connection in the Claude Code desktop
// app's settings (D56). The app reads `sshConfigs` from ~/.claude/settings.json
// (documented: id/name/sshHost required-ish, sshPort/sshIdentityFile/
// startDirectory optional), so writing an entry here makes the connection
// appear in the Environment dropdown with the right start folder — the user
// never types a host or picks a folder.
//
// Merge rules (never destructive):
//   - settings.json missing            -> created with just sshConfigs
//   - valid JSON object                -> sshConfigs entry upserted by id,
//                                         every other key left byte-identical
//   - invalid JSON / non-object shape  -> LEFT UNTOUCHED, {ok:false} returned
//     (a broken write here would take out the user's whole Claude Code config)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function claudeSettingsPath() {
  return join(homedir(), '.claude', 'settings.json');
}

// ---- the folder Claude Code opens (R18, 2026-08-23) -------------------------
// Both faces land in /state over SSH, and every boot (engine/box-up.sh,
// boot-rock.sh) the box links /state/<name> -> its brain root, <name> being a
// filesystem-safe form of the mineral's slug (engine/lib/open-folder.mjs), and
// writes that name to /state/open-folder. The app registers
// startDirectory: /state/<name> for BOTH tiers once it has read the file, and
// plain /state until then: a box born before this shipped has no link yet, and
// a startDirectory that does not exist is a Claude Code session that cannot
// open. OPEN_FOLDER_PROBE is the same command the panel's `open-folder` verb
// runs, so every reader agrees on the answer.
export const OPEN_FOLDER_PROBE = 'cat /state/open-folder 2>/dev/null || echo state';
const OPEN_FOLDER_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The last non-empty line of a probe's stdout -> the start directory. */
export function startDirectoryFor(probeOut) {
  const line = String(probeOut || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  return OPEN_FOLDER_RE.test(line) && line !== 'state' ? `/state/${line}` : '/state';
}

// Update ONE entry's startDirectory (by id) to what the box reports; touch
// nothing else. No entry -> no-op. Same never-destructive rules as register.
export function syncClaudeStartDir(id, probeOut, path = claudeSettingsPath()) {
  if (!id) return { ok: false, reason: 'id required' };
  const want = startDirectoryFor(probeOut);
  if (!existsSync(path)) return { ok: true, changed: false, startDirectory: want };
  let obj;
  try { obj = JSON.parse(readFileSync(path, 'utf8')); } catch {
    return { ok: false, reason: 'settings.json is not valid JSON; left untouched' };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, reason: 'settings.json has an unexpected shape; left untouched' };
  }
  const list = Array.isArray(obj.sshConfigs) ? obj.sshConfigs : [];
  const entry = list.find((c) => c && c.id === id);
  if (!entry) return { ok: true, changed: false, startDirectory: want };
  if (entry.startDirectory === want) return { ok: true, changed: false, startDirectory: want };
  entry.startDirectory = want;
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
  return { ok: true, changed: true, startDirectory: want };
}

export function registerClaudeSshConfig(entry, path = claudeSettingsPath()) {
  if (!entry || !entry.id || !entry.sshHost) return { ok: false, reason: 'entry needs id + sshHost' };
  let obj = {};
  if (existsSync(path)) {
    try { obj = JSON.parse(readFileSync(path, 'utf8')); } catch {
      return { ok: false, reason: 'settings.json is not valid JSON; left untouched' };
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      return { ok: false, reason: 'settings.json has an unexpected shape; left untouched' };
    }
  }
  const list = Array.isArray(obj.sshConfigs) ? obj.sshConfigs : [];
  const others = list.filter((c) => !c || c.id !== entry.id);
  obj.sshConfigs = [...others, {
    id: entry.id,
    name: entry.name || entry.id,
    sshHost: entry.sshHost,
    ...(entry.startDirectory ? { startDirectory: entry.startDirectory } : {}),
  }];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
  return { ok: true, replaced: others.length !== list.length };
}

// Inverse of register, same never-destructive rules: drop the sshConfigs entry
// with this id and touch nothing else. Used when an identity is removed from
// this computer (org deleted, dead box forgotten) so the Claude Code app's
// Environment dropdown stops offering a connection that no longer exists.
export function unregisterClaudeSshConfig(id, path = claudeSettingsPath()) {
  if (!id) return { ok: false, reason: 'id required' };
  if (!existsSync(path)) return { ok: true, removed: false };
  let obj;
  try { obj = JSON.parse(readFileSync(path, 'utf8')); } catch {
    return { ok: false, reason: 'settings.json is not valid JSON; left untouched' };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, reason: 'settings.json has an unexpected shape; left untouched' };
  }
  const list = Array.isArray(obj.sshConfigs) ? obj.sshConfigs : [];
  const keep = list.filter((c) => !c || c.id !== id);
  if (keep.length === list.length) return { ok: true, removed: false };
  obj.sshConfigs = keep;
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
  return { ok: true, removed: true };
}
