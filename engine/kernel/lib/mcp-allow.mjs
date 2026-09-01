// mcp-allow.mjs — which MCP tools a scheduled job is allowed to call.
//
// WHY THIS IS DERIVED AND NOT JUST A FILE (2026-08-05). Connecting Gmail in the
// Claude Code app is genuinely easy, and a member who does it gets everything
// right except one invisible thing: the server lands in <state>/.mcp.json and the
// OAuth token in the box's own config dir, both correct, and their scheduled jobs
// still cannot call it, because the allowlist lived only in .kernel/mcp-allow,
// which nothing but our own tooling ever wrote. The member does the obvious thing
// in the obvious place and gets silence.
//
// A server in the box's own .mcp.json is one the member put on their own box, so
// their own jobs may use it. The explicit file is still honoured on top, because
// an operator-run connect.mjs writes patterns no .mcp.json entry implies.
//
// Pure on purpose: the runner does the file reading, this decides.

// The CLI's rule, learned the hard way: `mcp__*` is REFUSED in allow rules
// ("An allow pattern must name the scope it widens"), so every pattern must
// carry a literal server name before the glob.
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

export function derivePatterns({ mcpJson = '', allowFile = '' } = {}) {
  const out = new Set();
  try {
    const doc = JSON.parse(mcpJson);
    for (const name of Object.keys(doc?.mcpServers || {})) {
      // a name with a dot or space cannot be expressed as an allow pattern at
      // all, so skip it rather than emit something the CLI will reject wholesale
      if (SERVER_NAME.test(name)) out.add(`mcp__${name}__*`);
    }
  } catch { /* absent or malformed: contributes nothing, breaks nothing */ }
  for (const p of String(allowFile).split(',').map((s) => s.trim()).filter(Boolean)) out.add(p);
  return [...out];
}
