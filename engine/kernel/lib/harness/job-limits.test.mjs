// job-limits.test.mjs: per-job limits (cockpit/job-limits.json, 2026-10-26).
// Run: node --test engine/kernel/lib/harness/job-limits.test.mjs
//
// The case that asked for it: a member's unattended inbox jobs read every incoming
// email and only sort and label, yet held every Gmail tool (send included) plus a
// shell, so "never send" lived only in their instructions. A limit must make the
// send tool absent, the shell absent, and the limit itself unwritable by the job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, compileGrants } from './claude-code.mjs';
import { compilePolicy, deriveMcp } from './opencode.mjs';
import { grantsForJob, parseJobLimits } from './grants.mjs';

const MCP = JSON.stringify({ mcpServers: { gmail: { command: 'g' }, xero: { command: 'x' } } });
const INBOX = JSON.stringify({
  'inbox-triage': {
    shell: false,
    tools: ['mcp__gmail__search_gmail_messages', 'mcp__gmail__modify_gmail_message_labels', 'Bash'],
    deny: ['mcp__gmail__send_gmail_message'],
  },
});

test('no limits file: grants are exactly as before (no deny, no protect)', () => {
  const g = grantsForJob({ skill: 'inbox-triage' }, { mcpJson: MCP });
  assert.equal(compileGrants(g), 'Skill,Bash,Read,Edit,Write,Glob,Grep,mcp__gmail__*,mcp__xero__*');
  assert.equal(g.deny, undefined);
  assert.ok(!buildArgs({ prompt: 'P', grants: g }).includes('--disallowedTools'));
});

test('a limited inbox job: no shell, only its listed MCP tools, send refused, config unwritable', () => {
  const g = grantsForJob({ skill: 'inbox-triage' }, { mcpJson: MCP, limitsJson: INBOX });
  // "Bash" in tools grants nothing: tools is MCP-only
  assert.equal(compileGrants(g), 'Skill,Read,Edit,Write,Glob,Grep,mcp__gmail__search_gmail_messages,mcp__gmail__modify_gmail_message_labels');
  const args = buildArgs({ prompt: 'P', grants: g });
  const denies = args[args.indexOf('--disallowedTools') + 1].split(',');
  assert.ok(denies.includes('mcp__gmail__send_gmail_message'));
  for (const p of ['cockpit/**', '.mcp.json', '**/.claude/**', '.kernel/**']) assert.ok(denies.includes(`Edit(${p})`), p);
});

test('another skill on the same box is untouched by a skill-specific limit', () => {
  const g = grantsForJob({ skill: 'weekly' }, { mcpJson: MCP, limitsJson: INBOX });
  assert.equal(compileGrants(g), 'Skill,Bash,Read,Edit,Write,Glob,Grep,mcp__gmail__*,mcp__xero__*');
});

test('"*" applies to every job; deny lists add up; a whole-server deny drops the server', () => {
  const lim = JSON.stringify({ '*': { deny: ['mcp__xero__*'] }, weekly: { deny: ['mcp__gmail__send_gmail_message'] } });
  const g = grantsForJob({ skill: 'weekly' }, { mcpJson: MCP, limitsJson: lim });
  assert.equal(compileGrants(g), 'Skill,Bash,Read,Edit,Write,Glob,Grep,mcp__gmail__*');
  assert.deepEqual(g.deny.map((d) => d.raw), ['mcp__xero__*', 'mcp__gmail__send_gmail_message']);
  assert.equal(g.protect, true);
});

test('a skill entry wins over "*" on shell', () => {
  const lim = JSON.stringify({ '*': { shell: false }, build: { shell: true } });
  assert.equal(grantsForJob({ skill: 'build' }, { limitsJson: lim }).shell, true);
  assert.equal(grantsForJob({ skill: 'daily' }, { limitsJson: lim }).shell, false);
});

test('a limits file that does not parse fails CLOSED: no shell, no MCP', () => {
  assert.equal(parseJobLimits('{ not json')._invalid, true);
  const g = grantsForJob({ skill: 'daily' }, { mcpJson: MCP, limitsJson: '{ not json' });
  assert.equal(compileGrants(g), 'Skill,Read,Edit,Write,Glob,Grep');
  assert.equal(g.protect, true);
});

test('limits never touch the conversational channel (D4 stays no shell, no MCP)', () => {
  const g = grantsForJob({ skill: 'message' }, { mcpJson: MCP, limitsJson: JSON.stringify({ '*': { shell: true, tools: ['mcp__gmail__*'] } }) });
  assert.equal(compileGrants(g), 'Skill,Read,Edit,Write,Glob,Grep');
});

test('opencode: a limited job gets no shell, the denied tool refused, the denied server unconfigured, config unwritable', () => {
  const lim = JSON.stringify({ 'inbox-triage': { shell: false, deny: ['mcp__gmail__send_gmail_message', 'mcp__xero__*'] } });
  const g = grantsForJob({ skill: 'inbox-triage' }, { mcpJson: MCP, limitsJson: lim });
  const p = compilePolicy(g);
  assert.equal(p.bash, 'deny');
  assert.equal(p.gmail_send_gmail_message, 'deny');
  assert.equal(p['*/cockpit/*'] ?? p.edit['*/cockpit/*'], 'deny');
  assert.deepEqual(Object.keys(deriveMcp(MCP, g)), ['gmail']);
});
