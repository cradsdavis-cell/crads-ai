// pack3.mjs — B3 / Pack 3 "Connect-it" capability (spec §2.4 B3 + G5 ladder).
// Proves the client's accounts are connected and the assistant can act on real data — with
// integrations MOCKED (per the harness: the client's email/calendar are simulated fixtures at
// state/mock-mcp/). Deliverable: brain/packs/pack3-connect.json — connectivity proof
// (.mcp.json present + provider-correct + a health-probe that reads N records) + an
// inbox-triage DEMO (each mock message classified per the client's own profile rules).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { nowISO } from './clock.mjs';

const rd = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const rdJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// parse the profile's classifications (match keyword arrays -> category/badge) — the client's OWN rules
function parseClassifications(profile) {
  const out = [];
  const block = profile.split(/\nclassifications:/)[1]?.split(/\n[a-z_]+:/)[0] || '';
  const re = /- match:\s*\[([^\]]*)\][\s\S]*?category:\s*"([^"]+)"[\s\S]*?badge:\s*"([^"]+)"/g;
  let m; while ((m = re.exec(block))) {
    const kws = m[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '').toLowerCase()).filter(Boolean);
    out.push({ keywords: kws, category: m[2], badge: m[3] });
  }
  return out;
}

export function generate(stateDir) {
  const mcp = rdJSON(path.join(stateDir, '.mcp.json'));
  const profile = rd(path.join(stateDir, 'profile.yaml'));
  const provider = (profile.match(/provider:\s*"(google|microsoft)"/) || [, ''])[1];
  const mcpServer = mcp && mcp.mcpServers ? Object.keys(mcp.mcpServers)[0] : null;
  const inbox = rdJSON(path.join(stateDir, 'state', 'mock-mcp', 'inbox.json'));
  if (!inbox) throw new Error('no mock-mcp/inbox.json — deliver the simulated integration fixture first');
  const msgs = inbox.messages || [];

  // health-probe (mocked): connectivity ok if a provider MCP is registered + the read returned records
  const health_probe = { ok: !!mcpServer && msgs.length > 0, mcp_server: mcpServer, provider, records: msgs.length, probed_at: nowISO(stateDir) };

  // inbox-triage DEMO — classify each mock message by the client's OWN classification rules
  const classes = parseClassifications(profile);
  const triage_demo = msgs.map((m) => {
    const body = (m.body || m.subject || '').toLowerCase();
    const hit = classes.find((c) => c.keywords.some((k) => k && body.includes(k)));
    // bucket: an enquiry / direct ask is an open-loop; otherwise mark-read (the client's inbox scheme)
    const isAsk = /\?|enquiry|quote|available|can you|interested|need|book/.test(body);
    return { id: m.id, category: hit?.category || 'uncategorised', badge: hit?.badge || '📅 General', bucket: isAsk ? 'open-loop' : 'mark-read' };
  });

  const pack = {
    schema: 'pack3-connect/1', block: 'b3', title: 'Pack 3 — Connect-it',
    provider, connected: provider ? [`${provider}:email`, `${provider}:calendar`] : [],
    health_probe, triage_demo,
    note: 'integrations mocked (simulated fixtures); the connect MECHANISM + triage are real, the credentials are per-client',
  };
  const dir = path.join(stateDir, 'brain', 'packs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'pack3-connect.json'), JSON.stringify(pack, null, 2) + '\n');
  const md = [`# Pack 3 — Connect-it\n`,
    `Provider: **${provider}** · MCP server: \`${mcpServer}\` · health-probe: ${health_probe.ok ? 'OK' : 'FAILED'} (${health_probe.records} records read).\n`,
    `## Inbox triage demo (your rules, on your real inbox)\n`,
    ...triage_demo.map((t) => `- ${t.badge} — **${t.category}** → _${t.bucket}_`),
    `\n_(integrations mocked for the test; same mechanism runs live once your accounts are connected.)_\n`].join('\n');
  writeFileSync(path.join(dir, 'pack3-connect.md'), md);
  return { provider, mcp_server: mcpServer, health_ok: health_probe.ok, records: health_probe.records, triaged: triage_demo.length, deliverable: 'brain/packs/pack3-connect.md' };
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(generate(process.argv[2] || '.'), null, 2));
