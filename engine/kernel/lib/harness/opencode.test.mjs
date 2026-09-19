// opencode.test.mjs: the OpenCode adapter's pure parts + the harness selector.
// Run: node --test engine/kernel/lib/harness/opencode.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { compilePolicy, deriveMcp, modelConfig, parseOutput, buildArgs, buildConfig, errorFrom, run, isolationEnv } from './opencode.mjs';
import { grantsForJob, grantsForOrgPublish, parseMcpPattern } from './grants.mjs';
import { readAssistant, checkPairing, getHarness, runTurn } from './index.mjs';
import { tmpDir } from '../../../../tests/tmp-dir.mjs';

const MCP = JSON.stringify({ mcpServers: {
  google_workspace: { type: 'stdio', command: '/opt/gws/bin/workspace-mcp', args: ['--single-user'], env: { A: 'b' } },
  todoist: { type: 'http', url: 'https://ai.todoist.net/mcp', headers: { Authorization: 'Bearer x' } },
  unused: { command: 'nope' },
} });

test('policy: catch-all deny is the FIRST key (last match wins, so it must precede the rest)', () => {
  const p = compilePolicy(grantsForJob({ skill: 'daily' }, { mcpJson: MCP }));
  assert.equal(Object.keys(p)[0], '*');
  assert.equal(p['*'], 'deny');
});

test('policy: never emits "ask", at any depth', () => {
  for (const g of [grantsForJob({ skill: 'daily' }, { mcpJson: MCP }), grantsForJob({ skill: 'message' }), grantsForOrgPublish('/o')]) {
    assert.ok(!JSON.stringify(compilePolicy(g)).includes('"ask"'));
  }
});

test('policy: outside-world and sub-turn tools are denied even to a full skill job', () => {
  const p = compilePolicy(grantsForJob({ skill: 'daily' }, { mcpJson: MCP }));
  for (const k of ['webfetch', 'websearch', 'task', 'question', 'doom_loop']) assert.equal(p[k], 'deny', k);
  assert.equal(p.bash, 'allow');
  assert.equal(p['google_workspace_*'], 'allow');
});

test('policy: credential-shaped paths stay unreadable when files are granted', () => {
  const p = compilePolicy(grantsForJob({ skill: 'daily' }));
  assert.equal(p.read['*'], 'allow');
  for (const k of ['*.env', '*/secrets/*', '*.claude-auth/*', '*.opencode-auth/*']) assert.equal(p.read[k], 'deny', k);
  assert.equal(Object.keys(p.read)[0], '*');
});

test('policy: an unparseable MCP grant grants nothing', () => {
  const g = { files: true, shell: false, skills: false, mcp: [parseMcpPattern('mcp__*'), parseMcpPattern('Bash')], addDirs: [] };
  const p = compilePolicy(g);
  assert.deepEqual(Object.keys(p).filter((k) => p[k] === 'allow' && !['edit', 'glob', 'grep', 'list'].includes(k)), []);
});

test('policy: org-publish may touch its one extra directory and no other', () => {
  const p = compilePolicy(grantsForOrgPublish('/s/org/brain'));
  assert.deepEqual(p.external_directory, { '*': 'deny', [path.join('/s/org/brain', '*')]: 'allow' });
  assert.equal(p.bash, 'deny'); assert.equal(p.skill, 'deny');
});

test('connections: only GRANTED servers are configured; shapes map to local/remote', () => {
  const g = grantsForJob({ skill: 'daily' }, { mcpJson: MCP });
  g.mcp = g.mcp.filter((m) => m.server !== 'unused');
  const m = deriveMcp(MCP, g);
  assert.deepEqual(Object.keys(m).sort(), ['google_workspace', 'todoist']);
  assert.deepEqual(m.google_workspace, { type: 'local', command: ['/opt/gws/bin/workspace-mcp', '--single-user'], enabled: true, environment: { A: 'b' } });
  assert.deepEqual(m.todoist, { type: 'remote', url: 'https://ai.todoist.net/mcp', enabled: true, headers: { Authorization: 'Bearer x' } });
});

test('connections: a message job configures NO server, whatever .mcp.json holds (D4 by construction)', () => {
  assert.deepEqual(deriveMcp(MCP, grantsForJob({ skill: 'message' }, { mcpJson: MCP })), {});
  assert.deepEqual(deriveMcp('not json', grantsForJob({ skill: 'daily' })), {});
});

test('model: sign-in names provider/model; nothing named means the harness default', () => {
  assert.deepEqual(modelConfig('/s', { source: 'signin', provider: 'openai', id: 'gpt-x' }), { model: 'openai/gpt-x' });
  assert.deepEqual(modelConfig('/s', { source: 'signin', provider: 'openai' }), {});
});

test('model: an endpoint needs url and id; the key is a secret REF, never a path', () => {
  const state = tmpDir('oc-model-');
  mkdirSync(path.join(state, 'secrets'));
  writeFileSync(path.join(state, 'secrets', 'plan_key'), 'sk-flat\n');
  const c = modelConfig(state, { source: 'endpoint', provider: 'openai-compatible', base_url: 'http://10.0.0.2:11434/v1', id: 'qwen3.6:27b', key_ref: '../../etc/plan_key' });
  assert.equal(c.model, 'endpoint/qwen3.6:27b');
  assert.equal(c.provider.endpoint.options.baseURL, 'http://10.0.0.2:11434/v1');
  assert.equal(c.provider.endpoint.options.apiKey, 'sk-flat');   // basename only: the traversal resolved inside secrets/
  assert.throws(() => modelConfig(state, { source: 'endpoint', provider: 'ollama', id: 'x' }), /needs base_url and id/);
  assert.throws(() => modelConfig(state, { source: 'endpoint', provider: 'ollama', base_url: 'http://x', id: 'm', key_ref: 'absent' }), /no secret named "absent"/);
});

test('config: sessions are never shared and the harness never self-updates', () => {
  const c = buildConfig({ stateDir: '/s', grants: grantsForJob({ skill: 'message' }), mcpJson: MCP, model: { source: 'signin', provider: 'openai' } });
  assert.equal(c.share, 'disabled'); assert.equal(c.autoupdate, false);
  assert.deepEqual(c.mcp, {});
});

test('argv: no --auto, ever', () => {
  assert.deepEqual(buildArgs({ prompt: 'P' }), ['run', '--format', 'json', 'P']);
});

test('output: text parts are joined; an unknown shape degrades to raw text, not silence', () => {
  const ev = [{ type: 'step_start' }, { type: 'text', part: { type: 'text', text: 'Hello ' } }, { type: 'text', part: { type: 'text', text: 'there.\nPROPOSE-SEND: x' } }];
  assert.equal(parseOutput(ev.map((e) => JSON.stringify(e)).join('\n')), 'Hello there.\nPROPOSE-SEND: x');
  assert.equal(parseOutput('plain words'), 'plain words');
});

test('selector: a mineral with no assistant block is claude-code, as before', () => {
  assert.deepEqual(readAssistant('identity:\n  assistant_name: "Idris"\ncadence:\n  enabled: false\n'),
    { harness: 'claude-code', model: { source: 'signin', provider: 'anthropic' } });
});

test('selector: reads the assistant block, stops at the next top-level key', () => {
  const y = 'assistant:\n  harness: opencode        # comment\n  model:\n    source: endpoint\n    provider: "ollama"\n    id: qwen3.6:27b\n    base_url: http://127.0.0.1:11434/v1\n    timeout_s: 900\ncadence:\n  harness: nope\n';
  assert.deepEqual(readAssistant(y), { harness: 'opencode', model: { source: 'endpoint', provider: 'ollama', id: 'qwen3.6:27b', base_url: 'http://127.0.0.1:11434/v1', timeout_s: 900 } });
});

test('selector: unknown harness and undeclared pairings are refused in plain words, never silently swapped', async () => {
  await assert.rejects(() => getHarness('../evil'), /is not one this mineral knows/);
  const cc = await getHarness('claude-code');
  assert.throws(() => checkPairing(cc.manifest, { provider: 'ollama', source: 'endpoint' }), /claude-code harness cannot think with ollama/);
  const oc = await getHarness('opencode');
  assert.throws(() => checkPairing(oc.manifest, { provider: 'anthropic', source: 'signin' }), /cannot think with anthropic/);
});

test('runTurn: the profile picks the harness, and the turn gets that harness\'s argv and isolated env', async () => {
  const state = tmpDir('oc-turn-');
  writeFileSync(path.join(state, 'profile.yaml'), 'assistant:\n  harness: opencode\n  model:\n    source: signin\n    provider: openai\n    timeout_s: 600\n');
  writeFileSync(path.join(state, '.mcp.json'), MCP);
  let seen;
  const r = await runTurn({ stateDir: state, prompt: 'hi', grants: grantsForJob({ skill: 'message' }, { mcpJson: MCP }),
    spawnImpl: async (args, opts) => { seen = { args, opts }; return JSON.stringify({ type: 'text', part: { type: 'text', text: 'ok' } }); } });
  assert.equal(r.text, 'ok');
  assert.equal(seen.args[0], 'run');
  assert.equal(seen.opts.timeoutMs, 600000);
  assert.ok(seen.opts.env.XDG_DATA_HOME.startsWith(state));
  assert.equal(seen.opts.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT, '1');
  assert.deepEqual(JSON.parse(seen.opts.env.OPENCODE_CONFIG_CONTENT).mcp, {});
});

// Event captured verbatim from opencode 1.18.31 pointed at a dead endpoint (2026-09-17).
const DEAD = '{"type":"error","timestamp":1789619880293,"sessionID":"ses_x","error":{"name":"APIError","data":{"message":"Cannot connect to API: Unable to connect. Is the computer able to access the url?","isRetryable":true,"metadata":{"url":"http://127.0.0.1:9/v1/chat/completions"}}}}';

test('a failed run surfaces the harness\'s own words and the URL, not "exited 1"', async () => {
  assert.match(errorFrom(DEAD), /^Cannot connect to API.*127\.0\.0\.1:9/);
  await assert.rejects(() => run({ stateDir: '/s', prompt: 'x', grants: grantsForJob({ skill: 'message' }), model: { source: 'signin', provider: 'openai' },
    spawnImpl: async () => { const e = new Error('opencode exited 1'); e.stdout = DEAD; throw e; } }), /Cannot connect to API/);
});

// Found on the real binary 2026-09-17: OpenCode MERGES every config layer, and a merged
// permission object keeps each key where the FIRST layer put it, so another layer's `read`
// rule lands before our catch-all deny and every read is refused; the same merge put GSD's
// always-on MCP server into a conversational turn. An unattended turn reads one config: ours.
test('isolation: unattended turns never share a config dir with the terminal, and ignore project config', () => {
  const env = isolationEnv('/state', {});
  assert.equal(env.XDG_CONFIG_HOME, path.join('/state', '.opencode-auth', 'headless'));
  assert.notEqual(env.XDG_CONFIG_HOME, path.join('/state', '.opencode-auth', 'config'), 'config/ is where the baked plugins live, for the terminal only');
  assert.equal(env.XDG_DATA_HOME, path.join('/state', '.opencode-auth', 'data'), 'the sign-in IS shared: signed in once, at the terminal');
  for (const k of ['OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_SHARE', 'OPENCODE_DISABLE_LSP_DOWNLOAD', 'OPENCODE_DISABLE_CLAUDE_CODE_PROMPT']) assert.equal(env[k], '1', k);
});

test('policy: a turn that may edit files may still not write the files that configure the NEXT turn', () => {
  const p = compilePolicy(grantsForJob({ skill: 'message' }));
  assert.equal(Object.keys(p.edit)[0], '*'); assert.equal(p.edit['*'], 'allow');
  for (const k of ['*opencode.json', '*.opencode/*', '*.opencode-auth/*', '*.claude/settings*', '*.mcp.json', '*/secrets/*', '*.kernel/*']) assert.equal(p.edit[k], 'deny', k);
});
