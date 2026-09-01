#!/usr/bin/env node
// connect.mjs — the MCP connect-mechanism (decisions D12).
//
// Reads profile.accounts, looks up the matching MCP server per provider in
// mcp-registry.json, and writes the box's .mcp.json (headless `claude -p` reads it
// at startup) + .kernel/mcp-allow (the tool allowlist the runner appends for skill
// jobs) + prints the per-client auth steps the operator runs once. Creds come from
// host env (${VAR} from secrets/) — never committed.
//
//   node connect.mjs <state-dir>
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const stateDir = path.resolve(process.argv[2] || process.env.STATE_DIR || '.');
const here = path.dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(await readFile(path.join(here, 'mcp-registry.json'), 'utf8'));
const profile = await readFile(path.join(stateDir, 'profile.yaml'), 'utf8');

// Minimal indentation parser for the 2-level `accounts:` block (no YAML dep).
function parseAccounts(yaml) {
  const lines = yaml.split('\n');
  const out = {};
  let i = lines.findIndex((l) => /^accounts:\s*$/.test(l));
  if (i < 0) return out;
  let cur = null;
  for (i++; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l)) break;               // dedented out of accounts
    if (!l.trim() || /^\s*#/.test(l)) continue;
    let m;
    if ((m = l.match(/^  (\w+):\s*$/))) { cur = m[1]; out[cur] = {}; }
    else if (cur && (m = l.match(/^    (\w+):\s*(.*)$/))) {
      let v = m[2].replace(/\s+#.*$/, '').trim().replace(/^"(.*)"$/, '$1');
      if (v === 'true') v = true; else if (v === 'false') v = false;
      out[cur][m[1]] = v;
    }
  }
  return out;
}

const acc = parseAccounts(profile);
const servers = {};
const allow = [];
const steps = [];
const warn = (s) => steps.push('⚠ ' + s);

// email + calendar share a provider -> one MCP per provider
const provider = acc.email?.provider || acc.calendar?.provider;
if (acc.email?.enabled || acc.calendar?.enabled) {
  const def = registry.providers[provider];
  if (!def) warn(`no registry entry for provider '${provider}' — add one to mcp-registry.json`);
  else if (!def.server) {
    // google since 2026-08-17: member-connected via the app's BYO wizard, not
    // operator-provisioned — the registry entry exists only to be recognised.
    def.auth_steps.forEach((s) => steps.push(`[${provider}] ${s}`));
  } else {
    servers[def.name] = def.server;
    allow.push(`mcp__${def.name}__*`);
    def.auth_steps.forEach((s) => steps.push(`[${provider}] ${s}`));
  }
}

// inbox triage — provider-asymmetric (D12)
if (acc.inbox_triage?.enabled) {
  if (acc.inbox_triage.mode === 'api') steps.push('[inbox] microsoft: direct read via Graph Mail.Read (covered by the ms365 MCP) — no CASA');
  else steps.push(`[inbox] google: set the client's forward rule -> ${acc.inbox_triage.forwarding_mailbox || '(operator mailbox)'}; operator mailbox read via the google MCP`);
}

// tasks
if (acc.tasks?.enabled && acc.tasks.provider && acc.tasks.provider !== 'none') {
  const def = registry.tasks[acc.tasks.provider];
  if (!def) warn(`no registry entry for tasks provider '${acc.tasks.provider}'`);
  else {
    servers[def.name] = def.server;
    allow.push(`mcp__${def.name}__*`);
    (def.auth_steps || []).forEach((s) => steps.push(`[tasks:${acc.tasks.provider}] ${s}`));
  }
}

await writeFile(path.join(stateDir, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2) + '\n');
await mkdir(path.join(stateDir, '.kernel'), { recursive: true });
await writeFile(path.join(stateDir, '.kernel', 'mcp-allow'), allow.join(','));

console.log(`wrote .mcp.json — servers: ${Object.keys(servers).join(', ') || '(none)'}`);
console.log(`tool allowlist (skills): ${allow.join(',') || '(none)'}`);
console.log('\nper-client auth steps (operator runs once):');
steps.forEach((s) => console.log('  - ' + s));
console.log('\nNOTE: any "REPLACE-with-..." command in .mcp.json means that provider\'s server is a registry placeholder — set the real command in engine/connect/mcp-registry.json.');
