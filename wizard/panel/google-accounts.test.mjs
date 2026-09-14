// google-accounts.test.mjs — run: node --test wizard/panel/google-accounts.test.mjs
//
// Several Google accounts on one box (2026-09-14, Sam's ruling): one row and
// one key per account. Pins the page's structural hooks, never its copy
// (trap 6): every Google row button carries its row's key, the "Add another"
// offer exists and gates on contract 3, the wizard card has the naming step,
// and every /google-connect/* call names the account it is for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const page = readFileSync(path.join(import.meta.dirname, 'member.html'), 'utf8');
const between = (from, to) => { const a = page.indexOf(from); assert.ok(a >= 0, from); const b = page.indexOf(to, a); assert.ok(b > a, to); return page.slice(a, b); };

test('the Google row buttons carry their row key, so a second row acts on itself', () => {
  const rowFn = between('function mcpRowHtml(s){', 'function mcpAccountRowHtml');
  assert.match(rowFn, /data-mcp-google-setup="' \+ esc\(gk\) \+ '"/, 'Set up names its row');
  assert.match(rowFn, /data-mcp-google-signin="' \+ esc\(gk\) \+ '"/, 'Sign in names its row');
  assert.match(rowFn, /data-mcp-remove="' \+ esc\(gk\) \+ '"/, 'Disconnect names its row');
  assert.doesNotMatch(rowFn, /data-mcp-remove="google"/, 'no button is hard-wired to the primary any more');
  assert.match(rowFn, /s\.email \? esc\(s\.email\)/, 'the row says whose account it is');
});

test('"Add another Google account" is offered once a Google row is set up, and only on a contract-3 box', () => {
  const yours = between('function renderMcpYours(services){', 'var mcpDirSearchTimer');
  assert.match(yours, /mcpContract >= 3/, 'gated on the box contract, not the page\'s own guard');
  assert.match(yours, /gwRows\.some\(function\(s\)\{ return s\.configured; \}\)/, 'offered only once one account exists');
  assert.match(yours, /data-mcp-google-add/);
  // the contract is remembered from every reply that carries it
  assert.match(page, /function mcpNoteContract\(d\)/);
  const at = page.indexOf('function loadMcp(){');
  assert.ok(at >= 0);
  assert.match(page.slice(at, at + 2500), /mcpNoteContract\(d\)/, 'loadMcp records it');
});

test('the wizard card has the naming step, and every route call names the account', () => {
  assert.match(page, /id="gwLabelWrap"/);
  assert.match(page, /id="gwLabel"/);
  assert.match(page, /id="gwKeyNote"/);
  assert.match(page, /id="gwTitle"/);
  const wiz = between('var gwRow = null;', "document.querySelector('section[data-sec=\"connections\"]').addEventListener('click'");
  assert.match(wiz, /function gwSlug\(label\)/, 'the page slugs the name the same way the box does (pinned in engine/lib/google-byo.test.mjs)');
  assert.match(wiz, /function gwSettleKey\(\)/);
  assert.match(wiz, /'\/google-connect\/client'[\s\S]*?key: gwKey/, 'the file drop names the row');
  assert.match(wiz, /'\/google-connect\/start'[\s\S]*?key: gwKey/, 'the sign-in names the row');
  assert.match(wiz, /'\/google-connect\/status\?host=' \+ encodeURIComponent\(state\.host\) \+ '&key=' \+ encodeURIComponent\(gwKey\)/, 'the poll names the row');
  assert.match(wiz, /'\/google-connect\/cancel'[\s\S]*?key: gwKey/, 'cancel names the row');
});

test('the click wiring: Set up / Sign in open the card for THEIR row; Add another opens it unnamed', () => {
  const click = between("document.querySelector('section[data-sec=\"connections\"]').addEventListener('click'", 'var ad = e.target.closest');
  assert.match(click, /gwOpen\(rekey, gs\.getAttribute\(rekey \? 'data-mcp-google-signin' : 'data-mcp-google-setup'\) \|\| 'google'\)/);
  assert.match(click, /\[data-mcp-google-add\][\s\S]*?gwOpen\(false, ''\)/, "'' = a new further account: the name field decides the key");
});
