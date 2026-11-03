#!/usr/bin/env node
// chat-retention.mjs <state-dir>: delete saved chats older than the member's retention.
//
// WHY (2026-10-26). Claude Code keeps every chat as a transcript under its config dir
// (<state>/.claude-auth/projects/**.jsonl) and clears ones older than
// `cleanupPeriodDays` (default 30) only when an interactive session starts up. On a
// mineral most turns are headless jobs and the member's sessions arrive over SSH, so a
// member found every chat since day one still on the box, 40 days in. They also rode
// every nightly snapshot (engine/backup.mjs), which is why policy.json now excludes them.
//
// So the engine enforces the same setting itself, nightly at 03:30 (ten minutes before
// the snapshot): one number, read from where Claude Code reads it, so the member changes
// it in one place and the two can never disagree. Missing or not a positive number: 30,
// Claude Code's own default. Only transcript files are touched, never a symlink, never
// anything outside projects/, and only by age (last write), so a chat still in use stays.
import { readFileSync, readdirSync, lstatSync, rmSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY = 86400000;
export const DEFAULT_DAYS = 30;

export function retentionDays(configDir) {
  try {
    const n = Number(JSON.parse(readFileSync(path.join(configDir, 'settings.json'), 'utf8')).cleanupPeriodDays);
    return Number.isFinite(n) && n >= 1 ? n : DEFAULT_DAYS;
  } catch { return DEFAULT_DAYS; }
}

export function pruneChats(stateDir, { now = Date.now(), configDir = path.join(stateDir, '.claude-auth') } = {}) {
  const days = retentionDays(configDir);
  const cutoff = now - days * DAY;
  const root = path.join(configDir, 'projects');
  let removed = 0, kept = 0;
  const walk = (dir) => {
    let entries; try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const p = path.join(dir, name);
      let st; try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(p);
        try { if (!readdirSync(p).length) rmdirSync(p); } catch { /* not empty, or gone */ }
      } else if (st.isFile() && name.endsWith('.jsonl')) {
        if (st.mtimeMs < cutoff) { rmSync(p, { force: true }); removed++; } else kept++;
      }
    }
  };
  walk(root);
  return { days, removed, kept };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = pruneChats(path.resolve(process.argv[2] || process.env.STATE_DIR || '/state'));
  console.log(`chat-retention: removed ${r.removed} saved chat(s) older than ${r.days} days, kept ${r.kept}`);
}
