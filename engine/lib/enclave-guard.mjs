#!/usr/bin/env node
// enclave-guard.mjs — Claude Code PreToolUse hook (org-publish job only): blocks any tool
// call whose input references an enclave path. Second layer of the spec §4 stack — the
// FIRST layer is the snapshot (enclave never copied), so this guard fails OPEN on weird
// input rather than wedging the publish job. Deny = exit 2 + stderr (Claude Code surfaces
// the reason to the model and refuses the call).
//   node enclave-guard.mjs <protected-path> [<protected-path>...]   (payload on stdin)
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  const protectedPaths = process.argv.slice(2).filter(Boolean);
  let payload = {};
  try { payload = JSON.parse(raw); } catch { process.exit(0); }
  const hay = JSON.stringify(payload.tool_input || {});
  const hit = protectedPaths.find((p) => hay.includes(p));
  if (hit) {
    console.error(`enclave-guard: blocked — tool input references the personal enclave (${hit}). Enclave content never leaves the box.`);
    process.exit(2);
  }
  process.exit(0);
});
