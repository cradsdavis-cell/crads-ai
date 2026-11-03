// claude-code.mjs: the default harness. Claude Code headless (`claude -p`), authed by
// the box's OWN Claude subscription.
//
// P0 of the second-harness spec (2026-09-17): this module must produce, byte for
// byte, the argv and env that runner.mjs and org-publish.mjs built inline before
// the extraction. claude-code.test.mjs pins that.
import path from 'node:path';
import { runBin } from './spawn.mjs';

export const manifest = {
  id: 'claude-code',
  bin: 'claude',
  serves: [{ provider: 'anthropic', source: 'signin' }],
  reads: { contextFile: 'CLAUDE.md', skillsDir: '.claude/skills' },
  signinCommand: 'claude',
  credentialPaths: ['.claude-auth/'],
  isolationKeys: ['CLAUDE_CONFIG_DIR'],
};

// grants -> the --allowedTools string. Order is load-bearing only for the
// byte-identity pin: Skill, Bash, then the five file tools, then MCP patterns.
export function compileGrants(grants) {
  const tools = [];
  if (grants.skills) tools.push('Skill');
  if (grants.shell) tools.push('Bash');
  // files: 'read' (teams, 2026-10-10) is the company agent's Slack turn: it may
  // look, never touch. true keeps all five, exactly as before.
  if (grants.files === 'read') tools.push('Read', 'Glob', 'Grep');
  else if (grants.files) tools.push('Read', 'Edit', 'Write', 'Glob', 'Grep');
  for (const m of grants.mcp || []) tools.push(m.raw);
  return tools.join(',');
}

// Auth (D11 corrected): the autonomous path MUST pin CLAUDE_CONFIG_DIR to the box's own
// .claude-auth. Otherwise headless claude defaults to $HOME/.claude, which on a shared
// operator host IS the operator's account (the cross-client identity leak). Pinned
// here so no caller (cron, kernel, telegram, org-publish) can forget it.
export function isolationEnv(stateDir, base = process.env) {
  return { ...base, CLAUDE_CONFIG_DIR: path.join(stateDir, '.claude-auth') };
}

// Job limits (grants.deny / grants.protect): the paths a limited turn may not write,
// because each one configures a later turn (gitignore-style, relative to the cwd,
// which is the state dir). Claude Code's Edit rules cover every built-in file writer.
export const PROTECTED_WRITES = ['cockpit/**', '.kernel/**', '.mcp.json', '**/.claude/**', '**/CLAUDE.md',
  'secrets/**', '.claude-auth/**'];

export function compileDenies(grants) {
  const out = (grants.deny || []).map((m) => m.raw);
  if (grants.protect) for (const p of PROTECTED_WRITES) out.push(`Edit(${p})`, `Write(${p})`);
  return out.join(',');
}

export function buildArgs({ prompt, grants }) {
  // acceptEdits auto-approves file edits (headless can't answer prompts); allowedTools
  // pre-approves the tool set so non-approved tools abort instead of prompting.
  const args = ['-p', prompt, '--permission-mode', 'acceptEdits', '--allowedTools', compileGrants(grants)];
  // Only a limited job carries this flag, so an unlimited job's argv is byte-identical to before.
  const denies = compileDenies(grants);
  if (denies) args.push('--disallowedTools', denies);
  for (const d of grants.addDirs || []) args.push('--add-dir', d);
  return args;
}

export async function run({ stateDir, cwd, prompt, grants, timeoutMs = 240000, spawnImpl }) {
  const exec = spawnImpl || ((args, opts) => runBin(manifest.bin, args, opts));
  const text = await exec(buildArgs({ prompt, grants }), { cwd: cwd || stateDir, env: isolationEnv(stateDir), timeoutMs });
  return { text: String(text ?? '') };
}

// What a compiled turn is allowed to do, read back from the argv + env that would reach
// the process. The conformance suite asks every harness this same question.
export function inspect(args) {
  const at = args.indexOf('--allowedTools');
  const tools = at >= 0 ? String(args[at + 1]).split(',').filter(Boolean) : [];
  const mode = args[args.indexOf('--permission-mode') + 1];
  const dt = args.indexOf('--disallowedTools');
  const denied = dt >= 0 ? String(args[dt + 1]).split(',').filter(Boolean) : [];
  return {
    denied: denied.filter((t) => t.startsWith('mcp__')),
    protectsConfig: denied.includes('Edit(cockpit/**)') && denied.includes('Edit(.mcp.json)'),
    denyByDefault: at >= 0 && mode === 'acceptEdits' && !args.includes('--dangerously-skip-permissions'),
    promptsPossible: false,                       // stdin is closed; an unapproved tool aborts
    shell: tools.includes('Bash'),
    skills: tools.includes('Skill'),
    writes: tools.includes('Edit') || tools.includes('Write'),
    mcpServers: tools.filter((t) => t.startsWith('mcp__')).map((t) => t.split('__')[1]),
  };
}
