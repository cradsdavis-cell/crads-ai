// mcp-header-helper.mjs: the `headersHelper` command a signed-in connection
// carries in .mcp.json (2026-10-07), shared by its writer (comms/mcp-token.mjs)
// and its repair pass (comms/mcp-connect.mjs status) so the two never disagree.
//
// Why. A sign-in's access token is written into .mcp.json as a fixed header,
// and the renewal job (comms/mcp-refresh.mjs, :14 and :44) rewrites it before
// it expires. Claude Code reads a fixed header ONCE, when a chat starts, so a
// chat left open past the token's life (an hour, for Asana) kept sending the
// dead one, and only a new chat worked again (a member, 2026-10-07). Claude
// Code runs a server's headersHelper at connect, on reconnect, and again when a
// call answers 401/403, retrying the call with what it prints. The helper
// prints the CURRENT headers from .mcp.json, which the renewal job keeps fresh,
// so an open chat picks up the renewed token on its next 401.
//
// Never a failure: Claude Code marks the connection FAILED if the helper fails
// (docs, "Use dynamic headers"), which would be worse than a stale token. So
// the command falls back to `{}`, and an empty object leaves the fixed header
// in charge, exactly the behaviour before this existed.
import path from 'node:path';

export const HEADER_TOOL = path.join(import.meta.dirname, '..', 'comms', 'mcp-header.mjs');
export const HELPER_RE = /mcp-header\.mjs/;

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export function headersHelperCmd(stateDir) {
  return `node ${q(HEADER_TOOL)} ${q(stateDir)} 2>/dev/null || echo '{}'`;
}
