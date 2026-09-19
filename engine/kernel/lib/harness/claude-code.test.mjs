// claude-code.test.mjs: P0 pin. The extraction must not change what reaches the CLI.
// Run: node --test engine/kernel/lib/harness/claude-code.test.mjs
//
// The expected strings below are the literals runner.mjs and org-publish.mjs carried
// inline until 2026-09-17. If one of these fails, the refactor changed what an
// unattended turn is allowed to do. That is a permissions change, not a test to update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildArgs, compileGrants, isolationEnv } from './claude-code.mjs';
import { grantsForJob, grantsForOrgPublish } from './grants.mjs';

const MCP = JSON.stringify({ mcpServers: { google_workspace: { command: 'x' }, 'bad.name': { command: 'y' } } });

test('skill job: the legacy allowlist, then derived MCP patterns, in the legacy order', () => {
  const g = grantsForJob({ skill: 'daily' }, { mcpJson: MCP, allowFile: 'mcp__todoist__find-tasks' });
  assert.equal(compileGrants(g), 'Skill,Bash,Read,Edit,Write,Glob,Grep,mcp__google_workspace__*,mcp__todoist__find-tasks');
});

test('skill job with nothing connected: exactly the legacy base string', () => {
  assert.equal(compileGrants(grantsForJob({ skill: 'weekly' })), 'Skill,Bash,Read,Edit,Write,Glob,Grep');
});

test('message job: no Bash, no MCP, even with servers connected (D4)', () => {
  const g = grantsForJob({ skill: 'message' }, { mcpJson: MCP, allowFile: 'mcp__todoist__*' });
  assert.equal(compileGrants(g), 'Skill,Read,Edit,Write,Glob,Grep');
});

test('org-publish: files only, plus --add-dir, argv identical to the old inline call', () => {
  const args = buildArgs({ prompt: 'P', grants: grantsForOrgPublish('/s/org/brain') });
  assert.deepEqual(args, ['-p', 'P', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write,Glob,Grep', '--add-dir', '/s/org/brain']);
});

test('skill job argv carries no --add-dir', () => {
  const args = buildArgs({ prompt: 'P', grants: grantsForJob({ skill: 'daily' }) });
  assert.deepEqual(args, ['-p', 'P', '--permission-mode', 'acceptEdits', '--allowedTools', 'Skill,Bash,Read,Edit,Write,Glob,Grep']);
});

test('isolation pins CLAUDE_CONFIG_DIR inside the mineral, over whatever the caller had', () => {
  const env = isolationEnv('/state', { CLAUDE_CONFIG_DIR: '/home/operator/.claude', KEEP: '1' });
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join('/state', '.claude-auth'));
  assert.equal(env.KEEP, '1');
});
