// mcp-allow.test.mjs — run: node --test engine/kernel/lib/mcp-allow.test.mjs
//
// The gap this closes, found live 2026-08-05: a member connected Gmail in the
// Claude Code app, which put the server in <state>/.mcp.json and the OAuth token
// in the box's own config dir — everything correct — and their scheduled jobs
// still could not call it, because the allowlist lived in a separate file only
// our own tooling ever wrote. The member did the obvious thing in the obvious
// place and got silence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePatterns } from './mcp-allow.mjs';

const mcp = (...names) => JSON.stringify({ mcpServers: Object.fromEntries(names.map((n) => [n, { type: 'http' }])) });

test('a server the member added in Claude Code is usable by their jobs', () => {
  assert.deepEqual(derivePatterns({ mcpJson: mcp('gmail') }), ['mcp__gmail__*']);
});

test('anything they add is covered, not just the three we ship a button for', () => {
  // "pretty much anything you can think of" — the catalogue is a convenience,
  // never the boundary of what works
  assert.deepEqual(
    derivePatterns({ mcpJson: mcp('notion', 'linear', 'todoist') }).sort(),
    ['mcp__linear__*', 'mcp__notion__*', 'mcp__todoist__*'],
  );
});

test('the explicit file is still honoured, and merged without duplicates', () => {
  const r = derivePatterns({ mcpJson: mcp('gmail'), allowFile: 'mcp__ms365__*,mcp__gmail__*' });
  assert.deepEqual(r.sort(), ['mcp__gmail__*', 'mcp__ms365__*']);
});

test('an operator pattern no .mcp.json entry implies still survives', () => {
  assert.deepEqual(derivePatterns({ mcpJson: '{}', allowFile: 'mcp__ms365__*' }), ['mcp__ms365__*']);
});

test('every pattern names its server, because a bare wildcard is REFUSED', () => {
  // verified against the CLI: "Wildcard tool name mcp__* is not supported in
  // allow rules. An allow pattern must name the scope it widens."
  for (const p of derivePatterns({ mcpJson: mcp('gmail', 'calendar') })) {
    assert.match(p, /^mcp__[A-Za-z0-9_-]+__\*$/);
  }
});

test('a name that cannot be expressed as a pattern is skipped, not emitted broken', () => {
  // claude.ai connectors carry names with spaces and dots; emitting those would
  // produce a rule the CLI rejects, and a rejected rule can take the run with it
  const r = derivePatterns({ mcpJson: mcp('claude.ai Gmail', 'gmail') });
  assert.deepEqual(r, ['mcp__gmail__*']);
});

test('absent, empty and malformed config contribute nothing and throw nothing', () => {
  assert.deepEqual(derivePatterns(), []);
  assert.deepEqual(derivePatterns({ mcpJson: '', allowFile: '' }), []);
  assert.deepEqual(derivePatterns({ mcpJson: '{ not json' }), []);
  assert.deepEqual(derivePatterns({ mcpJson: JSON.stringify({ mcpServers: null }) }), []);
  // a malformed .mcp.json must not lose the operator's explicit patterns
  assert.deepEqual(derivePatterns({ mcpJson: '{ not json', allowFile: 'mcp__ms365__*' }), ['mcp__ms365__*']);
});
