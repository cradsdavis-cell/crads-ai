#!/usr/bin/env node
// mcp-header.mjs: the headersHelper for connections this box signs in to.
// See engine/lib/mcp-header-helper.mjs for why it exists.
//
//   node mcp-header.mjs <state-dir>    (Claude Code sets CLAUDE_CODE_MCP_SERVER_NAME)
//
// Prints that server's headers from <state-dir>/.mcp.json as one JSON object of
// strings, and always exits 0. Anything missing or unreadable prints {}, which
// leaves the fixed header in charge. Read-only and fast: Claude Code abandons a
// helper after 10 seconds, and the renewal job is what keeps the file fresh.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const stateDir = path.resolve(process.argv[2] || process.cwd());
const name = String(process.env.CLAUDE_CODE_MCP_SERVER_NAME || '');
const headers = {};
try {
  const doc = JSON.parse(readFileSync(path.join(stateDir, '.mcp.json'), 'utf8'));
  const h = name && Object.hasOwn(doc?.mcpServers || {}, name) ? doc.mcpServers[name].headers : null;
  if (h && typeof h === 'object') for (const [k, v] of Object.entries(h)) if (typeof v === 'string' && v) headers[k] = v;
} catch { /* {} below */ }
process.stdout.write(JSON.stringify(headers) + '\n');
