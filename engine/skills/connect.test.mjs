// connect.test.mjs — the /connect skill's load-bearing lines.
//
// This skill exists because "connect me to X" answered with a default
// `claude mcp add` produces a chats-only half-connection: invisible on the
// Connections page, never loaded by scheduled jobs. If the skill loses any of
// the lines below, the assistant drifts straight back into that trap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const md = readFileSync(new URL('./connect.md', import.meta.url), 'utf8');

test('the skill routes through the box machinery, never claude mcp add', () => {
  assert.match(md, /Never use `claude mcp add`/, 'the one rule that matters');
  assert.match(md, /mcp-connect\.mjs \/state add/, 'featured adds use the box tool');
  assert.match(md, /mcp-connect\.mjs \/state add-custom/, 'custom adds too');
  // the sign-in is NOT driveable in chat: the OAuth redirect lands on a
  // listener only the member's app provides. The old paste-back instructions
  // pointed at engine/comms/mcp-login.mjs, which was removed 2026-08-09 and
  // never existed in this tree — the skill must send people to the app.
  assert.doesNotMatch(md, /mcp-login/, 'the dead paste-back flow must not come back');
  assert.match(md, /Connections page in\ntheir Crads-AI app/i, 'sign-ins route to the app');
});

test('a brain folder on the person\'s own computer has its own branch: project-scope .mcp.json and Claude\'s connectors', () => {
  assert.match(md, /If `\/app\/engine\/comms\/mcp-connect\.mjs` does not exist/, 'the skill detects the no-server case first');
  assert.match(md, /## On this computer/);
  assert.match(md, /claude mcp add --transport http --scope project <name> <url>/, 'project scope, which is what the Connections page edits');
  assert.match(md, /claude\.ai\/customize\/connectors/, 'Gmail and Calendar come from the Claude account');
  assert.match(md, /type\s+`\/mcp`/, 'the sign-in is Claude Code\'s own');
});

test('secrets stay off command lines and out of replies', () => {
  assert.match(md, /never put a URL or token in\na command line/i);
  assert.match(md, /Never print a token/i);
});

test('the honesty rules survive: Google BYO, status-before-claiming, adopt', () => {
  assert.match(md, /member's own key/i, 'Google is the BYO route now, not "not yet"');
  assert.match(md, /one-time and stays put/i, 'the permanent sign-in is stated, never oversold as weekly');
  assert.match(md, /they choose\s+what it reaches/i, 'granular consent is stated: the member picks the services');
  assert.match(md, /really has dropped the key/i, 'an expired google row is a real (rare) death, not a fault in the product');
  assert.match(md, /Only claim "connected" after `status` says so/i);
  assert.match(md, /adopt <name>/, 'the chats-only escape hatch is offered');
});

test('frontmatter carries what the Skills page and skill-lint require', () => {
  assert.match(md, /^name: connect$/m);
  assert.match(md, /^category: box/m, 'skill-lint refuses pushes without category');
  assert.match(md, /natural asks like "connect me to Notion"/, 'triggers on the conversational ask, not just /connect');
});
