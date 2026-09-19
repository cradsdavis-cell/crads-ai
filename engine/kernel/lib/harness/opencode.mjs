// opencode.mjs: the first non-Claude harness (spec 2026-09-17). OpenCode headless
// (`opencode run`), MIT, reads this product's CLAUDE.md and .claude/skills IN PLACE,
// and serves sign-in entitlements (ChatGPT, GitHub Copilot) and any model endpoint URL.
//
// STATUS: built against OpenCode's published docs and pinned by fixtures. NOT yet run
// against a real opencode binary. Every assumption that only a live run can settle is
// tagged UNVERIFIED below and listed in the spec §10. Until the conformance suite has
// passed LIVE, nothing in the wizard offers this harness.
//
// The security story is compilePolicy(). Read it before changing anything here.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { runBin } from './spawn.mjs';

export const manifest = {
  id: 'opencode',
  bin: 'opencode',
  serves: [
    { provider: 'openai', source: 'signin' },
    { provider: 'github-copilot', source: 'signin' },
    { provider: 'ollama', source: 'endpoint' },
    { provider: 'openai-compatible', source: 'endpoint' },
  ],
  reads: { contextFile: 'CLAUDE.md', skillsDir: '.claude/skills' },
  signinCommand: 'opencode auth login',
  credentialPaths: ['.opencode-auth/'],
  isolationKeys: ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'],
};

// ---- the policy compiler ---------------------------------------------------------
// TOTAL and FAIL-CLOSED:
//   * "*": "deny" comes FIRST. OpenCode evaluates rules by pattern with the LAST match
//     winning, so the catch-all must precede every specific rule or it would override
//     them. A tool this compiler has never heard of (one a future OpenCode adds, say a
//     send-capable built-in) matches only "*" and is denied.
//   * It never emits "ask". What "ask" does under `opencode run` is undocumented, so no
//     rule may depend on it. Every tool is allow or deny.
//   * A grant whose server did not parse (server:null) grants nothing.
// Credential-shaped paths are denied to `read` even when files are granted: the model
// has no business reading the box's secrets or either harness's sign-in.
const SECRET_READ_DENY = ['*.env', '*.env.*', '*/secrets/*', '*.claude-auth/*', '*.opencode-auth/*', '*.kernel/gh/*'];
// Files a turn may never WRITE, even with files granted: each one reconfigures a later
// turn. A conversational turn has no shell and no connection, but it can edit files, and
// "write a config that gives the next turn a shell" is the two-step way round D4. Claude
// Code guards its own settings file itself (checked live 2026-09-17: the write is refused);
// OpenCode has no such guard, so the policy carries it. Belt to isolationEnv's braces, which
// stops project config being read at all.
const CONFIG_WRITE_DENY = ['*opencode.json', '*opencode.jsonc', '*.opencode/*', '*.opencode-auth/*', '*.claude-auth/*',
  '*.claude/settings*', '*.mcp.json', '*/secrets/*', '*.kernel/*', '*.env', '*.env.*'];

export function compilePolicy(grants) {
  const p = { '*': 'deny' };
  if (grants.files) {
    p.read = { '*': 'allow' };
    for (const pat of SECRET_READ_DENY) p.read[pat] = 'deny';
    p.edit = { '*': 'allow' };   // covers edit, write and patch
    for (const pat of CONFIG_WRITE_DENY) p.edit[pat] = 'deny';
    p.glob = 'allow';
    p.grep = 'allow';
    p.list = 'allow';
  }
  p.skill = grants.skills ? 'allow' : 'deny';
  p.bash = grants.shell ? 'allow' : 'deny';
  // Never granted to an unattended turn, whatever else is: these reach the outside
  // world or spawn turns whose policy we did not compile.
  p.webfetch = 'deny';
  p.websearch = 'deny';
  p.task = 'deny';
  p.question = 'deny';
  p.doom_loop = 'deny';
  const dirs = grants.addDirs || [];
  p.external_directory = dirs.length ? { '*': 'deny' } : 'deny';
  for (const d of dirs) p.external_directory[path.join(d, '*')] = 'allow';
  // MCP tools register as <server>_<tool> (OpenCode MCP docs). Whether the permission
  // matcher keys on that same name is UNVERIFIED, which is why deriveMcp() below does
  // not rely on it: a server that is not granted is never configured at all.
  for (const m of grants.mcp || []) {
    if (!m.server) continue;
    p[`${m.server}_${m.tool}`] = 'allow';
  }
  return p;
}

// ---- connections: derived from .mcp.json, never a second file ---------------------
// Only GRANTED servers are configured. A `message` job has no MCP grants, so it gets an
// empty block and there is no send-capable tool in the process to be talked into using.
// That is D4 by construction, independent of how permissions match MCP tool names.
export function deriveMcp(mcpJson, grants) {
  const granted = new Set((grants.mcp || []).map((m) => m.server).filter(Boolean));
  const out = {};
  let doc; try { doc = JSON.parse(mcpJson || '{}'); } catch { return out; }
  for (const [name, s] of Object.entries(doc?.mcpServers || {})) {
    if (!granted.has(name) || !s || typeof s !== 'object') continue;
    if (s.url) {
      out[name] = { type: 'remote', url: s.url, enabled: true, ...(s.headers ? { headers: s.headers } : {}) };
    } else if (s.command) {
      out[name] = { type: 'local', command: [s.command, ...(Array.isArray(s.args) ? s.args : [])], enabled: true,
        ...(s.env && Object.keys(s.env).length ? { environment: s.env } : {}) };
    }
  }
  return out;
}

// ---- isolation: the identity-leak rule, for OpenCode ------------------------------
// OpenCode keeps credentials in $XDG_DATA_HOME/opencode/auth.json and global config +
// a global AGENTS.md in $XDG_CONFIG_HOME/opencode. Left alone, a headless turn on a
// shared host would think with the OPERATOR's sign-in and the operator's instructions.
// It also reads ~/.claude/CLAUDE.md for compatibility: same leak, second door.
// Project-level CLAUDE.md and .claude/skills stay readable; that is the point.
//
// CONFIG IS NOT SHARED WITH THE INTERACTIVE SIDE (found on the real binary, 2026-09-17).
// OpenCode merges every config layer it finds, and a merged permission object keeps each
// key at the position of the layer that FIRST defined it. With "last match wins", our
// catch-all deny then lands AFTER another layer's `read` rule and denies every read; the
// same merge put an always-on MCP server (GSD's, fetched by npx at run time) into a
// conversational turn. It failed closed, but a policy that depends on what other layers
// happen to contain is not a policy. So an unattended turn reads exactly one config, ours:
//   XDG_CONFIG_HOME         -> .opencode-auth/headless, engine-owned, never seeded, so the
//                              plugins a member uses at the terminal (.opencode-auth/config)
//                              are not loaded by jobs. Scheduled skills do not use them.
//   ..._DISABLE_PROJECT_CONFIG  a file written into the mineral cannot reconfigure a turn.
// Sign-in (XDG_DATA_HOME) IS shared: the member signs in once, at the terminal.
// The remaining switches stop the harness phoning home on its own account.
export function isolationEnv(stateDir, base = process.env) {
  const root = path.join(stateDir, '.opencode-auth');
  return {
    ...base,
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CONFIG_HOME: path.join(root, 'headless'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_SHARE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
  };
}

// ---- model source -----------------------------------------------------------------
// signin: OpenCode resolves the provider from its own auth.json; we only name the model.
// endpoint: an OpenAI-compatible URL anywhere (Ollama, llama.cpp, LM Studio, vLLM, a
// flat-fee plan). The custom-provider shape is UNVERIFIED against a live binary.
// The key is a SECRET REF into <state>/secrets, never the key itself (same rule as
// telegram bot_token_ref). Local servers ignore the key but the SDK wants one.
export function modelConfig(stateDir, model = {}) {
  if (model.source !== 'endpoint') return model.id ? { model: `${model.provider}/${model.id}` } : {};
  if (!model.base_url || !model.id) throw new Error('assistant.model: an endpoint needs base_url and id');
  let apiKey = 'none';
  if (model.key_ref) {
    const ref = path.basename(String(model.key_ref));   // a ref is a file NAME, never a path
    try { apiKey = readFileSync(path.join(stateDir, 'secrets', ref), 'utf8').trim() || 'none'; }
    catch { throw new Error(`assistant.model.key_ref: no secret named "${ref}" on this mineral`); }
  }
  return {
    model: `endpoint/${model.id}`,
    provider: { endpoint: { npm: '@ai-sdk/openai-compatible', name: 'Model endpoint',
      options: { baseURL: model.base_url, apiKey }, models: { [model.id]: {} } } },
  };
}

export function buildConfig({ stateDir, grants, mcpJson, model }) {
  return {
    share: 'disabled',       // never upload a session
    autoupdate: false,       // the image pins the version; a self-updating harness voids the conformance run
    ...modelConfig(stateDir, model),
    mcp: deriveMcp(mcpJson, grants),
    permission: compilePolicy(grants),
  };
}

// `opencode run --format json` emits JSON events, one per line. The exact event shape is
// UNVERIFIED; this takes the text parts and falls back to raw stdout, so an unexpected
// shape degrades to "unparsed text reaches the outbox", never to silence.
export function parseOutput(stdout) {
  const parts = [];
  for (const line of String(stdout).split('\n')) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    try {
      const ev = JSON.parse(l);
      const part = ev.part || ev;
      if ((ev.type === 'text' || part.type === 'text') && typeof part.text === 'string') parts.push(part.text);
    } catch { /* not an event line */ }
  }
  return parts.length ? parts.join('') : String(stdout);
}

// A failed run exits 1 with an EMPTY stderr and one {"type":"error"} event on stdout
// (verified on opencode 1.18.31, 2026-09-17). Surface its message, not "exited 1":
// "Cannot connect to API ... http://10.0.0.2:11434" is what a member with a sleeping
// GPU box needs to read.
export function errorFrom(stdout) {
  for (const line of String(stdout || '').split('\n')) {
    try { const ev = JSON.parse(line); if (ev.type === 'error') { const d = ev.error?.data || {}; return [d.message || ev.error?.name, d.metadata?.url].filter(Boolean).join(' '); } } catch {}
  }
  return '';
}

export function buildArgs({ prompt }) {
  // No --auto: the policy is total, so there is nothing left to auto-approve, and
  // --auto would approve exactly the "not explicitly denied" gap we refuse to have.
  return ['run', '--format', 'json', prompt];
}

export async function run({ stateDir, cwd, prompt, grants, timeoutMs = 240000, spawnImpl, mcpJson = '', model = {} }) {
  const exec = spawnImpl || ((args, opts) => runBin(manifest.bin, args, opts));
  const config = buildConfig({ stateDir, grants, mcpJson, model });
  const env = {
    ...isolationEnv(stateDir),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_PERMISSION: JSON.stringify(config.permission),   // same policy, second door shut
  };
  let stdout;
  try { stdout = await exec(buildArgs({ prompt }), { cwd: cwd || stateDir, env, timeoutMs }); }
  catch (e) { throw new Error(errorFrom(e.stdout) || e.message); }
  return { text: parseOutput(stdout) };
}

// What a compiled turn is allowed to do, read back from the argv + env that would reach
// the process. The conformance suite asks every harness this same question.
export function inspect(args, env) {
  const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}');
  const p = cfg.permission || {};
  return {
    denyByDefault: Object.keys(p)[0] === '*' && p['*'] === 'deny' && !args.includes('--auto')
      && env.OPENCODE_PERMISSION === JSON.stringify(p),
    promptsPossible: JSON.stringify(p).includes('"ask"'),
    shell: p.bash !== 'deny',
    skills: p.skill === 'allow',
    mcpServers: Object.keys(cfg.mcp || {}),
  };
}
