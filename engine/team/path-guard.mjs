#!/usr/bin/env node
// path-guard.mjs: Claude Code PreToolUse hook for the company agent's Slack turn
// (teams security review, 2026-10-11). The turn may Read, Glob and Grep, and the
// working directory is a throwaway copy of the company brain, but a working
// directory is not a boundary: without this, "read /state/secrets/team/brain"
// would have handed the company repo's only write key to whoever asked in Slack.
// Every path the tool names must resolve inside <root>. FAILS CLOSED: input it
// cannot read is refused (exit 2), unlike enclave-guard, because here the hook IS
// the boundary, not a second layer.
//   node path-guard.mjs <root>    (payload on stdin)
import path from 'node:path';
import { realpathSync } from 'node:fs';

const deny = (why) => { console.error(`path-guard: blocked, ${why}. This turn can read the company brain and nothing else.`); process.exit(2); };

export function outside(root, cwd, value) {
  if (typeof value !== 'string' || !value) return false;
  // a glob may start with a fixed part; judge the part before the first wildcard
  const fixed = value.split(/[*?{[]/)[0] || '.';
  const abs = path.resolve(cwd || root, fixed);
  let real = abs;
  try { real = realpathSync(abs); } catch { /* not there yet: judge the path as written */ }
  const r = path.resolve(root);
  return !(real === r || real.startsWith(r + path.sep)) || !(abs === r || abs.startsWith(r + path.sep));
}

if (process.argv[1] && process.argv[1].endsWith('path-guard.mjs')) {
  const root = process.argv[2];
  if (!root) deny('no root configured');
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let p; try { p = JSON.parse(raw); } catch { deny('unreadable tool call'); }
    const input = p.tool_input || {};
    for (const k of ['file_path', 'path', 'pattern', 'notebook_path']) {
      if (k === 'pattern' && p.tool_name === 'Grep') continue;   // Grep's pattern is a regex, not a path
      if (outside(root, p.cwd || root, input[k])) deny(`${k} points outside the company brain`);
    }
    process.exit(0);
  });
}
