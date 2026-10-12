#!/usr/bin/env node
// mail-guard.mjs: Claude Code PreToolUse hook for the shared-inbox turn (teams,
// 2026-10-11). The turn reads OUTSIDE mail, so it is the most exposed turn in a
// team, and the redesign after the security review gives it exactly one power:
// reading that mailbox. Every tool call must be a tool of the one granted mail
// server whose name says it reads (search, get, list, read, fetch, query) and
// says nothing that writes. Anything else, including every built-in tool, is
// refused. FAILS CLOSED.
//   node mail-guard.mjs <server>   (payload on stdin)
const READ = /(search|get|list|read|fetch|query|find)/i;
// Mail tools only (second security review, 2026-10-12): on a Google Workspace or
// Microsoft Graph server, Drive, Docs, Sheets, Calendar, Contacts and web search
// all have read-shaped names too, and an injected email could otherwise pull
// them into the digest every colleague reads.
const MAIL = /(gmail|mail|inbox|email)/i;   // not bare "message": Google Chat's get_messages is not mail
const OTHER = /(drive|doc|sheet|slide|calendar|event|contact|people|task|form|file|custom|web|chat|space|site)/i;
const WRITE = /(replace|send|draft|reply|forward|delete|trash|archive|label|modify|move|mark|create|update|batch|remove|insert|set|manage|import|upload|share|filter|write|append|post|patch|put|copy|run|exec|unsubscribe|accept|decline|respond)/i;

// ToolSearch only loads tool DESCRIPTIONS (Claude Code defers MCP tools behind it,
// found live 2026-10-11: blocking it blocked the reading too). It cannot touch
// mail; the tools it loads still pass through this guard one by one.
const LOADERS = new Set(['ToolSearch']);

export function allowed(server, toolName) {
  if (LOADERS.has(toolName)) return true;
  const prefix = `mcp__${server}__`;
  if (typeof toolName !== 'string' || !toolName.startsWith(prefix)) return false;
  const tool = toolName.slice(prefix.length);
  return READ.test(tool) && MAIL.test(tool) && !OTHER.test(tool) && !WRITE.test(tool);
}

if (process.argv[1] && process.argv[1].endsWith('mail-guard.mjs')) {
  const server = process.argv[2];
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let p; try { p = JSON.parse(raw); } catch { console.error('mail-guard: blocked, unreadable tool call'); process.exit(2); }
    if (!server || !allowed(server, p.tool_name)) {
      console.error(`mail-guard: blocked ${p.tool_name}. This turn may only read the shared inbox; it never sends, drafts, files or changes mail.`);
      process.exit(2);
    }
    process.exit(0);
  });
}
