// ms365-connect.test.mjs: run node --test engine/comms/ms365-connect.test.mjs
//
// Microsoft 365 on the box (contract 8, 2026-10-19). A FAKE server stands in
// for the baked @softeria/ms-365-mcp-server (CRADS_MS365_BIN): it prints
// Microsoft's device-code sentence on --login, then waits for the test to
// "approve" or "deny" by dropping a file, the way a member types the code at
// microsoft.com/devicelogin. What is proven here: the saved definition (the
// sign-in door, the cache inside .kernel, no keyring), the detached sign-in and
// its record, the row, the check, and that Disconnect destroys the sign-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { parseDeviceMessage, parseLoginResult, ms365Settings } from '../lib/ms365.mjs';

const CONNECT = path.join(import.meta.dirname, 'mcp-connect.mjs');
const LOGIN = path.join(import.meta.dirname, 'ms365-login.mjs');

// The fake: records the env it ran with, then behaves like the package.
const FAKE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const cache = process.env.MS365_MCP_TOKEN_CACHE_PATH;
const dir = path.dirname(cache);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'env-seen.json'), JSON.stringify({
  args: process.argv.slice(2), tenant: process.env.MS365_MCP_TENANT_ID || null,
  client: process.env.MS365_MCP_CLIENT_ID || null, keytar: process.env.MS365_MCP_USE_KEYTAR || null, cache }));
const ok = { success: true, message: 'Login successful', userData: { displayName: 'Mel Example', userPrincipalName: 'mel@example.com.au' } };
if (process.argv.includes('--verify-login')) {
  console.log(JSON.stringify(fs.existsSync(cache) ? ok : { success: false, message: 'No valid token found' }));
  process.exit(0);
}
if (process.argv.includes('--login')) {
  console.log('\\nTo sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code FAKE12345 to authenticate.\\n');
  const t = setInterval(() => {
    if (fs.existsSync(path.join(dir, 'approve'))) { clearInterval(t); fs.writeFileSync(cache, '{"enc":"x"}'); console.log(JSON.stringify(ok)); process.exit(0); }
    if (fs.existsSync(path.join(dir, 'deny'))) { clearInterval(t); console.log(JSON.stringify({ success: false, message: 'AADSTS50126: the user declined' })); process.exit(0); }
  }, 30);
} else {
  process.stdin.resume();
}
`;

function rig() {
  const d = tmpDir('ms365-');
  mkdirSync(path.join(d, '.claude-auth'), { recursive: true });
  const bin = path.join(d, 'fake-ms365.cjs');
  writeFileSync(bin, FAKE); chmodSync(bin, 0o755);
  const env = { ...process.env, CRADS_MS365_BIN: bin, CRADS_MS365_START_WAIT_MS: '8000' };
  const connect = (args, stdin) => JSON.parse(execFileSync('node', [CONNECT, d, ...args], { encoding: 'utf8', input: stdin, env }));
  const login = (cmd) => JSON.parse(execFileSync('node', [LOGIN, d, cmd], { encoding: 'utf8', env }));
  const kernel = path.join(d, '.kernel', 'ms365');
  return { d, bin, connect, login, kernel };
}
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const svc = (r, k) => r.services.find((s) => s.key === k);
const mcp = (d) => JSON.parse(readFileSync(path.join(d, '.mcp.json'), 'utf8')).mcpServers;
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timed out');
};

test('parse: the device-code sentence, the login result line', () => {
  assert.deepEqual(parseDeviceMessage('To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD12345 to authenticate.'),
    { url: 'https://microsoft.com/devicelogin', code: 'ABCD12345' });
  // the live wording, captured 2026-10-19 from Microsoft itself (code redacted)
  assert.deepEqual(parseDeviceMessage('\nTo sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code G7HK2LMQP to authenticate.\n'),
    { url: 'https://login.microsoft.com/device', code: 'G7HK2LMQP' });
  assert.equal(parseDeviceMessage('nothing to see'), null);
  const r = parseLoginResult('noise\n{"level":"info"}\n{"success":true,"userData":{"userPrincipalName":"a@b.c"}}\n');
  assert.equal(r.success, true);
  assert.equal(parseLoginResult('no json here'), null);
});

test('settings: work and personal doors; an app ID is a GUID; a tenant needs an app', () => {
  assert.equal(ms365Settings({ account: 'work' }).account, 'work');
  assert.equal(ms365Settings({ account: 'personal' }).account, 'personal');
  assert.match(ms365Settings({ account: 'team' }).error, /work or personal/);
  assert.match(ms365Settings({ client_id: 'not-a-guid' }).error, /GUID/);
  assert.match(ms365Settings({ tenant_id: 'contoso.com' }).error, /app ID too/);
  const own = ms365Settings({ client_id: '1A2B3C4D-1111-2222-3333-444455556666', tenant_id: 'Contoso.com' });
  assert.equal(own.client_id, '1a2b3c4d-1111-2222-3333-444455556666');
  assert.equal(own.tenant_id, 'contoso.com');
});

test('add-microsoft: the baked server, an explicit tool list, cache inside .kernel, no keyring, the right door', () => {
  const { d, bin, connect } = rig();
  const r = connect(['add-microsoft'], b64({ account: 'work' }));
  assert.equal(r.ok, true);
  assert.ok(r.contract >= 8, 'the page gates its wizard on 8');
  const def = mcp(d).microsoft;
  assert.equal(def.command, bin);
  // an explicit tool list, never the preset (a preset would override it)
  assert.equal(def.args[0], '--enabled-tools');
  assert.ok(!def.args.includes('--preset'));
  const allowed = new RegExp(def.args[1]);
  for (const t of ['send-mail', 'list-mail-messages', 'create-calendar-event', 'get-outlook-contact']) assert.match(t, allowed, `${t} is allowed`);
  for (const t of ['delete-mail-message', 'create-mail-rule', 'update-mail-rule', 'create-my-calendar-permission',
    'update-mailbox-settings', 'delete-outlook-contact', 'download-bytes-to-file']) assert.doesNotMatch(t, allowed, `${t} is never offered`);
  assert.equal(def.env.MS365_MCP_TENANT_ID, 'organizations', 'work accounts sign in at organizations');
  assert.equal(def.env.MS365_MCP_USE_KEYTAR, '0');
  assert.ok(def.env.MS365_MCP_TOKEN_CACHE_PATH.startsWith(path.join(d, '.kernel', 'ms365')), 'the cache never leaves .kernel');
  assert.equal(def.env.MS365_MCP_CLIENT_ID, undefined, 'no app named: the package signs in with its own');
  const row = svc(r, 'microsoft');
  assert.equal(row.byo, 'microsoft');
  assert.equal(row.state, 'needs-auth');
  assert.match(row.status, /sign in once/);
  // jobs can reach it: allow-listed and approved, like every app-added server
  assert.match(readFileSync(path.join(d, '.kernel', 'mcp-allow'), 'utf8'), /mcp__microsoft__\*/);
  const cj = JSON.parse(readFileSync(path.join(d, '.claude-auth', '.claude.json'), 'utf8'));
  assert.ok(cj.projects[d].enabledMcpjsonServers.includes('microsoft'));
});

test('add-microsoft: personal accounts use consumers; your own app carries its ID and tenant', () => {
  const { d, connect } = rig();
  connect(['add-microsoft'], b64({ account: 'personal' }));
  assert.equal(mcp(d).microsoft.env.MS365_MCP_TENANT_ID, 'consumers');
  connect(['add-microsoft'], b64({ account: 'work', client_id: '1a2b3c4d-1111-2222-3333-444455556666', tenant_id: 'contoso.com' }));
  const env = mcp(d).microsoft.env;
  assert.equal(env.MS365_MCP_CLIENT_ID, '1a2b3c4d-1111-2222-3333-444455556666');
  assert.equal(env.MS365_MCP_TENANT_ID, 'contoso.com');
});

test('refusals: bad input, a hand-added server, the plain add and add-custom paths', () => {
  const { d, connect } = rig();
  assert.match(connect(['add-microsoft'], b64({ account: 'work', client_id: 'nope' })).error, /GUID/);
  assert.equal(connect(['add', 'microsoft']).ok, false);
  assert.equal(connect(['add-custom'], b64({ name: 'microsoft', url: 'https://example.com/mcp' })).ok, false);
  writeFileSync(path.join(d, '.mcp.json'), JSON.stringify({ mcpServers: { microsoft: { type: 'http', url: 'https://mine.example/mcp' } } }));
  assert.match(connect(['add-microsoft'], b64({ account: 'work' })).error, /hand-added/);
  assert.equal(mcp(d).microsoft.url, 'https://mine.example/mcp', 'the member\'s own server is untouched');
});

test('sign-in: start shows the code, the run waits, approval finishes it, the row turns on', async () => {
  const { d, connect, login, kernel } = rig();
  connect(['add-microsoft'], b64({ account: 'work' }));
  const s = login('start');
  assert.equal(s.ok, true);
  assert.equal(s.stage, 'code');
  assert.equal(s.code, 'FAKE12345');
  assert.equal(s.url, 'https://login.microsoft.com/device');
  assert.ok(Date.parse(s.expires_at) > Date.now());
  // a second start (a page reload) rejoins the same run, same code
  assert.equal(login('start').code, 'FAKE12345');
  assert.match(svc(connect(['status']), 'microsoft').status, /enter the code/);
  // the sign-in ran with the definition's own env
  const seen = JSON.parse(readFileSync(path.join(kernel, 'env-seen.json'), 'utf8'));
  assert.ok(seen.args.includes('--login'));
  assert.equal(seen.tenant, 'organizations');
  assert.equal(seen.keytar, '0');
  writeFileSync(path.join(kernel, 'approve'), '');
  const done = await until(() => { const v = login('status'); return v.stage === 'done' && v; });
  assert.equal(done.user, 'mel@example.com.au');
  const row = svc(connect(['status']), 'microsoft');
  assert.equal(row.state, 'on');
  assert.equal(row.email, 'mel@example.com.au');
  // the record holds no token, ever
  assert.doesNotMatch(readFileSync(path.join(kernel, 'login.json'), 'utf8'), /enc|token/i);
  // the check proves the cached sign-in, from the box
  const c = connect(['check', 'microsoft']);
  assert.equal(c.working, true);
  assert.equal(c.account, 'mel@example.com.au');
});

test('sign-in: a declined sign-in fails in words, and the row stays waiting', async () => {
  const { connect, login, kernel } = rig();
  connect(['add-microsoft'], b64({ account: 'work' }));
  login('start');
  writeFileSync(path.join(kernel, 'deny'), '');
  const f = await until(() => { const v = login('status'); return v.stage === 'failed' && v; });
  assert.match(f.reason, /declined/);
  assert.equal(svc(connect(['status']), 'microsoft').state, 'needs-auth');
  assert.equal(connect(['check', 'microsoft']).working, false);
});

test('sign-in: cancel stops the run; start without a set-up is refused', async () => {
  const { connect, login } = rig();
  assert.equal(login('start').ok, false, 'nothing to sign in to yet');
  connect(['add-microsoft'], b64({ account: 'work' }));
  login('start');
  assert.equal(login('cancel').stage, 'cancelled');
  assert.equal(login('status').stage, 'cancelled');
});

test('switching door or app drops the old sign-in; a repeat press keeps it', async () => {
  const { connect, login, kernel } = rig();
  connect(['add-microsoft'], b64({ account: 'work' }));
  login('start');
  writeFileSync(path.join(kernel, 'approve'), '');
  await until(() => login('status').stage === 'done');
  connect(['add-microsoft'], b64({ account: 'work' }));
  assert.equal(login('status').stage, 'done', 'same settings: still signed in');
  connect(['add-microsoft'], b64({ account: 'personal' }));
  assert.equal(existsSync(path.join(kernel, 'token-cache.json')), false, 'a work sign-in cannot serve a personal door');
  assert.equal(login('status').stage, 'idle');
});

test('Disconnect destroys the sign-in: definition, cache, record', async () => {
  const { d, connect, login, kernel } = rig();
  connect(['add-microsoft'], b64({ account: 'work' }));
  login('start');
  writeFileSync(path.join(kernel, 'approve'), '');
  await until(() => login('status').stage === 'done');
  const r = connect(['remove', 'microsoft']);
  assert.equal(r.ok, true);
  assert.equal(mcp(d).microsoft, undefined);
  assert.equal(existsSync(kernel), false, 'nothing of the sign-in is left on the box');
  assert.equal(svc(r, 'microsoft'), undefined, 'no row once it is gone');
});
