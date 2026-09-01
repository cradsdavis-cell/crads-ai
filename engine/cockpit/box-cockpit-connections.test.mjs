// box-cockpit-connections.test.mjs — the Email + Calendar row must not collapse
// two different worlds into one word. Run: node --test engine/cockpit/
//
// Why this file exists (2026-08-05). A member connected Gmail and Calendar in the
// Claude Code app, watched the row keep saying "not configured", and reasonably
// concluded the panel was broken. It was not: the probe reads /state/.mcp.json,
// which is what SCHEDULED JOBS load, while the app's connectors are held by the
// Claude account and reach interactive sessions only. Proven, not assumed: a
// headless `claude -p` run lists the .mcp.json servers and none of the account
// connectors, and cadence jobs are headless by construction.
//
// So there are three states, not two, and the middle one is the one that was
// missing: connected for you, not for your box when you are asleep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMBER_VERBS } from '../../wizard/panel/panel-server.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILDER = join(HERE, 'box-cockpit.mjs');

// A fake `claude` on PATH, so the probe's connector question is answerable in a
// test without an account, a network, or a real CLI.
function boxWith({ mcp, cliOut = '', cliFails = false } = {}) {
  const box = tmpDir('cc-conn-');
  mkdirSync(join(box, 'wiki'), { recursive: true });
  writeFileSync(join(box, 'wiki', 'index.md'), '# hi\n');
  writeFileSync(join(box, 'profile.yaml'), 'user_short: "Jane"\n');
  if (mcp) writeFileSync(join(box, '.mcp.json'), JSON.stringify(mcp));
  const bin = join(box, 'bin');
  mkdirSync(bin, { recursive: true });
  const claude = join(bin, 'claude');
  writeFileSync(claude, cliFails
    ? '#!/bin/sh\nexit 1\n'
    : `#!/bin/sh\ncat <<'EOF'\n${cliOut}\nEOF\n`);
  chmodSync(claude, 0o755);
  execFileSync(process.execPath, [BUILDER, box], {
    encoding: 'utf8',
    env: { ...process.env, PATH: bin + ':' + process.env.PATH, AIOS_CONNECTOR_PROBE: '1' },
  });
  const data = JSON.parse(readFileSync(join(box, 'cockpit', 'data.json'), 'utf8'));
  return (data.connections || []).find((c) => /email|gmail|workspace|microsoft/i.test(c.name)) || null;
}

const CONNECTED_CLI = `claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ✔ Connected`;

test('nothing anywhere still reads as not configured', () => {
  const row = boxWith({ cliOut: '' });
  assert.equal(row.state, 'pending');
  assert.match(row.status, /not configured/i);
});

test('THE MISSING STATE: connected in the app, but not for scheduled jobs', () => {
  const row = boxWith({ cliOut: CONNECTED_CLI });
  assert.equal(row.state, 'pending', 'still unfinished — jobs cannot use it');
  assert.match(row.status, /chat|session/i, 'must say WHERE it works');
  assert.match(row.status, /job/i, 'must say where it does NOT work');
  assert.doesNotMatch(row.status, /^not configured$/i, 'this was the wrong answer that started all this');
});

test('a server in .mcp.json is the state that actually serves the jobs', () => {
  const row = boxWith({ mcp: { mcpServers: { google: { command: 'run-google-mcp' } } }, cliOut: CONNECTED_CLI });
  assert.equal(row.state, 'configured');
  assert.match(row.status, /configured/i);
});

test('a connector that needs re-auth is not counted as connected', () => {
  const row = boxWith({ cliOut: 'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ! Needs authentication' });
  assert.match(row.status, /not configured/i, 'a broken connector is not a connection');
});

test('a connector unrelated to mail or calendar does not light the row', () => {
  const row = boxWith({ cliOut: 'claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected' });
  assert.match(row.status, /not configured/i);
});

test('the connector probe is cached, so a dashboard refresh is not a network call', () => {
  // `claude mcp list` health-checks every server. This builder runs on every
  // refresh, and only boxes WITHOUT .mcp.json reach the probe, so without a cache
  // the slowest path would be the one every unconfigured member takes constantly.
  const box = tmpDir('cc-cache-');
  mkdirSync(join(box, 'wiki'), { recursive: true });
  writeFileSync(join(box, 'wiki', 'index.md'), '# hi\n');
  writeFileSync(join(box, 'profile.yaml'), 'user_short: "Jane"\n');
  const bin = join(box, 'bin');
  mkdirSync(bin, { recursive: true });
  const calls = join(box, 'calls');
  writeFileSync(join(bin, 'claude'),
    `#!/bin/sh\necho x >> ${JSON.stringify(calls)}\ncat <<'EOF'\n${CONNECTED_CLI}\nEOF\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  const build = () => execFileSync(process.execPath, [BUILDER, box], {
    encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, AIOS_CONNECTOR_PROBE: '1' },
  });
  build(); build(); build();
  assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 1,
    'three refreshes must ask the CLI once');
});

test('the probe is OFF unless asked for, and the dashboard verb asks for it', () => {
  // Both halves matter. Ambient, the probe starts every stdio MCP server anywhere
  // a `claude` binary is on PATH. Absent from the verb, the middle state can never
  // be detected on a real box and the row silently regresses to the old lie.
  const box = tmpDir('cc-optin-');
  mkdirSync(join(box, 'wiki'), { recursive: true });
  writeFileSync(join(box, 'wiki', 'index.md'), '# hi\n');
  writeFileSync(join(box, 'profile.yaml'), 'user_short: "Jane"\n');
  const bin = join(box, 'bin');
  mkdirSync(bin, { recursive: true });
  const calls = join(box, 'calls');
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho x >> ${JSON.stringify(calls)}\necho ""\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH };
  delete env.AIOS_CONNECTOR_PROBE;
  execFileSync(process.execPath, [BUILDER, box], { encoding: 'utf8', env });
  assert.ok(!existsSync(calls), 'the builder must not shell out to claude unasked');

  const verb = MEMBER_VERBS['dashboard-data'].build();
  assert.match(verb.command, /AIOS_CONNECTOR_PROBE=1/, 'the box dashboard must opt in');
});

test('the dashboard still builds when the claude CLI is missing or fails', () => {
  // the probe is a nicety; the graph and every other card must not depend on it
  const row = boxWith({ cliOut: '', cliFails: true });
  assert.ok(row, 'the row must still exist');
  assert.match(row.status, /not configured/i);
});

test('the connector cache keeps every healthy name; only the card row filters to mail (R8)', () => {
  // The Connections page reads cockpit/connectors.json to render account
  // connectors honestly, so the probe must stop discarding non-mail names.
  const box = tmpDir('cc-full-');
  mkdirSync(join(box, 'wiki'), { recursive: true });
  writeFileSync(join(box, 'wiki', 'index.md'), '# hi\n');
  writeFileSync(join(box, 'profile.yaml'), 'user_short: "Jane"\n');
  const bin = join(box, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat <<'EOF'\nclaude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected\nAsana: https://mcp.asana.example/sse - ✔ Connected\nEOF\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  execFileSync(process.execPath, [BUILDER, box], { encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, AIOS_CONNECTOR_PROBE: '1' } });
  const cache = JSON.parse(readFileSync(join(box, 'cockpit', 'connectors.json'), 'utf8'));
  assert.deepEqual(cache.names.sort(), ['Asana', 'claude.ai Google Drive'], 'the cache is unfiltered');
  const data = JSON.parse(readFileSync(join(box, 'cockpit', 'data.json'), 'utf8'));
  const row = data.connections.find((c) => /email/i.test(c.name));
  assert.match(row.status, /not configured/i, 'no mail-ish connector: the card row stays honest');
});

test('server keys never reach the card raw: every name is labelled (2026-08-09 audit)', () => {
  // A real box rendered "gmail" / "drive" on the Overview card while the shot rig
  // (hand-capitalised fixture) showed "Gmail": this file carried a 3-entry label
  // map. Names now come from engine/lib/connection-labels.mjs, shared with the
  // Connections page.
  const box = tmpDir('cc-label-');
  mkdirSync(join(box, 'wiki'), { recursive: true });
  writeFileSync(join(box, 'wiki', 'index.md'), '# hi\n');
  writeFileSync(join(box, 'profile.yaml'), 'user_short: "Jane"\n');
  writeFileSync(join(box, '.mcp.json'), JSON.stringify({ mcpServers: {
    notion: { type: 'http', url: 'https://mcp.notion.com/mcp' },
    'youtube-transcript': { type: 'http', url: 'https://yt.example/mcp' },
  } }));
  execFileSync(process.execPath, [BUILDER, box], { encoding: 'utf8', env: { ...process.env } });
  const data = JSON.parse(readFileSync(join(box, 'cockpit', 'data.json'), 'utf8'));
  const names = (data.connections || []).map((c) => c.name);
  assert.ok(names.includes('Notion'), `expected Notion in ${names}`);
  assert.ok(names.includes('Youtube Transcript'), `unknown keys de-kebab + title-case, got ${names}`);
  for (const n of names) assert.doesNotMatch(n, /^[a-z]/, `raw key leaked to the card: "${n}"`);
});

test('a colon inside a server name is not a name boundary (finding 106)', () => {
  // Proven on a real rock: `claude mcp list` printed
  //   plugin:gsd:gsd: node /state/.claude-auth/plugins/... - ✔ Connected
  // and the old `split(':')[0]` cached the bare word "plugin", which the
  // Connections page then showed as a connection called "plugin". The separator
  // is colon-SPACE. Two cases here: a plugin line (dropped entirely, below) and
  // a non-plugin name that merely contains a colon (kept WHOLE, never truncated).
  const box = tmpDir('cc-colon-');
  mkdirSync(join(box, 'wiki'), { recursive: true });
  writeFileSync(join(box, 'wiki', 'index.md'), '# hi\n');
  writeFileSync(join(box, 'profile.yaml'), 'user_short: "Jane"\n');
  const bin = join(box, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat <<'EOF2'\nacme:crm: https://mcp.acme.example/sse - ✔ Connected\nEOF2\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  execFileSync(process.execPath, [BUILDER, box], { encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, AIOS_CONNECTOR_PROBE: '1' } });
  const cache = JSON.parse(readFileSync(join(box, 'cockpit', 'connectors.json'), 'utf8'));
  assert.deepEqual(cache.names, ['acme:crm'], 'the name is kept whole, not cut at its first colon');
});

test('a plugin-provided server is never cached as an account connector (finding 106)', () => {
  // Everything in this cache is rendered downstream as "connected to your Claude
  // account in the app" and "account connectors can never run in scheduled jobs".
  // A plugin stdio server is configured on THIS box and runs wherever `claude`
  // runs, jobs included, so both sentences are false of it.
  const box = tmpDir('cc-plugin-');
  mkdirSync(join(box, 'wiki'), { recursive: true });
  writeFileSync(join(box, 'wiki', 'index.md'), '# hi\n');
  writeFileSync(join(box, 'profile.yaml'), 'user_short: "Jane"\n');
  const bin = join(box, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat <<'EOF2'\nclaude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected\nplugin:gsd:gsd: node /state/.claude-auth/plugins/cache/gsd/server.cjs - ✔ Connected\nEOF2\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  execFileSync(process.execPath, [BUILDER, box], { encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, AIOS_CONNECTOR_PROBE: '1' } });
  const cache = JSON.parse(readFileSync(join(box, 'cockpit', 'connectors.json'), 'utf8'));
  assert.deepEqual(cache.names, ['claude.ai Gmail'], 'the account connector stays, the plugin server goes');
  for (const n of cache.names) assert.doesNotMatch(n, /^plugin/i, `plugin server leaked: "${n}"`);
});
