// mcp-token.test.mjs — run: node --test engine/comms/mcp-token.test.mjs
//
// Where an OAuth result lands on the box. The split is the point: the ACCESS
// token becomes a header Claude Code just sends (so nothing depends on its
// private credential store), and the REFRESH token — the long-lived credential —
// lives in a 0600 file that no session reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const SCRIPT = path.join(import.meta.dirname, 'mcp-token.mjs');
const box = () => { const d = tmpDir('mcptok-'); mkdirSync(path.join(d, '.kernel'), { recursive: true }); return d; };
const run = (d, args, stdin) => JSON.parse(execFileSync('node', [SCRIPT, d, ...args], { encoding: 'utf8', input: stdin }));
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const mcp = (d) => JSON.parse(readFileSync(path.join(d, '.mcp.json'), 'utf8'));
const oauth = (d) => JSON.parse(readFileSync(path.join(d, '.kernel', 'mcp-oauth.json'), 'utf8'));

const SET = { name: 'canva', url: 'https://mcp.canva.com/mcp', access_token: 'AT', refresh_token: 'RT', token_endpoint: 'https://mcp.canva.com/token', client_id: 'cid', expires_at: Date.now() + 3600e3 };

test('the access token becomes a header the CLI simply sends', () => {
  const d = box();
  const r = run(d, ['set'], b64(SET));
  assert.equal(r.ok, true);
  assert.equal(r.renews, true);
  const s = mcp(d).mcpServers.canva;
  assert.equal(s.headers.Authorization, 'Bearer AT');
  assert.equal(s.url, 'https://mcp.canva.com/mcp');
  assert.equal(s.type, 'http');
});

test('the REFRESH token never enters .mcp.json, and its file is 0600', () => {
  const d = box();
  run(d, ['set'], b64(SET));
  const raw = readFileSync(path.join(d, '.mcp.json'), 'utf8');
  assert.ok(!raw.includes('RT'), 'the long-lived credential must not sit in the file every session reads');
  assert.equal(oauth(d).canva.refresh_token, 'RT');
  assert.equal(statSync(path.join(d, '.kernel', 'mcp-oauth.json')).mode & 0o777, 0o600);
});

test('an sse url is detected, and https is required', () => {
  const d = box();
  run(d, ['set'], b64({ ...SET, name: 'linear', url: 'https://mcp.linear.app/sse' }));
  assert.equal(mcp(d).mcpServers.linear.type, 'sse');
  assert.equal(run(d, ['set'], b64({ ...SET, url: 'http://insecure.example/mcp' })).ok, false);
  assert.equal(run(d, ['set'], b64({ ...SET, name: 'BAD NAME' })).ok, false);
  assert.equal(run(d, ['set'], b64({ ...SET, access_token: '' })).ok, false);
});

test('a refresh that omits a new refresh token keeps the old one', () => {
  // most providers only return refresh_token on the FIRST exchange; dropping it
  // would silently turn a renewing connection into one that dies at expiry
  const d = box();
  run(d, ['set'], b64(SET));
  run(d, ['set'], b64({ name: 'canva', url: SET.url, access_token: 'AT2', expires_at: Date.now() + 60e3 }));
  assert.equal(oauth(d).canva.refresh_token, 'RT');
  assert.equal(mcp(d).mcpServers.canva.headers.Authorization, 'Bearer AT2');
  assert.equal(oauth(d).canva.client_id, 'cid', 'client identity survives a refresh too');
});

test('other servers and a member\'s own headers are never disturbed', () => {
  const d = box();
  writeFileSync(path.join(d, '.mcp.json'), JSON.stringify({ mcpServers: {
    ms365: { command: 'x' },
    canva: { type: 'http', url: 'https://mcp.canva.com/mcp', headers: { 'X-Mine': 'keep' } },
  } }));
  run(d, ['set'], b64(SET));
  const m = mcp(d);
  assert.ok(m.mcpServers.ms365, 'operator server survives');
  assert.equal(m.mcpServers.canva.headers['X-Mine'], 'keep', 'their own header survives');
  assert.equal(m.mcpServers.canva.headers.Authorization, 'Bearer AT');
});

test('forget strips only our header and drops the refresh material', () => {
  const d = box();
  writeFileSync(path.join(d, '.mcp.json'), JSON.stringify({ mcpServers: { canva: { type: 'http', url: SET.url, headers: { 'X-Mine': 'keep' } } } }));
  run(d, ['set'], b64(SET));
  const r = run(d, ['forget', 'canva']);
  assert.equal(r.ok, true);
  const s = mcp(d).mcpServers.canva;
  assert.ok(!s.headers.Authorization, 'our credential is gone');
  assert.equal(s.headers['X-Mine'], 'keep', 'theirs is not');
  assert.ok(!oauth(d).canva, 'refresh material gone');
});

// ---- set-google: the BYO-client landing (docs/design-google-byo-connect.md) ----

const GSET = { email: 'Jane.Doe@gmail.com', client_id: 'abc123.apps.googleusercontent.com', client_secret: 'GOCSPX-s3cr3t', access_token: 'GAT', refresh_token: 'GRT', scopes: ['openid', 'https://www.googleapis.com/auth/gmail.modify'] };
const gcreds = (d) => JSON.parse(readFileSync(path.join(d, '.kernel', 'google-creds', 'jane.doe@gmail.com.json'), 'utf8'));

test('set-google writes the workspace-mcp credential file, 0600, refresh fields embedded', () => {
  const d = box();
  const r = run(d, ['set-google'], b64(GSET));
  assert.equal(r.ok, true);
  assert.equal(r.email, 'jane.doe@gmail.com', 'email is lowercased');
  assert.ok(r.keyed_at > 0);
  assert.equal(r.rekey_due_at, undefined, 'a published key has no scheduled death (2026-08-24 reshape)');
  const c = gcreds(d);
  assert.equal(c.refresh_token, 'GRT');
  assert.equal(c.client_id, GSET.client_id);
  assert.equal(c.client_secret, GSET.client_secret, 'google-auth refreshes off the FILE, so the secret must be in it');
  assert.equal(c.token_uri, 'https://oauth2.googleapis.com/token');
  assert.deepEqual(c.scopes, GSET.scopes);
  assert.equal(c.expiry, '1970-01-01T00:00:00', 'no expiry given seeds a PAST one so the first call live-proves the refresh set');
  const f = path.join(d, '.kernel', 'google-creds', 'jane.doe@gmail.com.json');
  assert.equal(statSync(f).mode & 0o777, 0o600);
});

test('set-google records the clock (keyed_at) with NO secrets beside it', () => {
  const d = box();
  run(d, ['set-google'], b64(GSET));
  const g = oauth(d).google;
  assert.equal(g.provider, 'google-byo');
  assert.equal(g.email, 'jane.doe@gmail.com');
  assert.ok(g.keyed_at > 0);
  const raw = JSON.stringify(oauth(d));
  assert.ok(!raw.includes('GRT') && !raw.includes('GOCSPX'), 'refresh token and client secret live ONLY in the credential file');
});

test('set-google refuses the wrong file and the doomed grant', () => {
  const d = box();
  assert.equal(run(d, ['set-google'], b64({ ...GSET, client_id: 'not-a-google-client' })).ok, false, 'a non-Google client id is the wrong JSON');
  assert.equal(run(d, ['set-google'], b64({ ...GSET, refresh_token: '' })).ok, false, 'no refresh token = dies within the hour, refuse now');
  assert.equal(run(d, ['set-google'], b64({ ...GSET, email: 'not-an-email' })).ok, false);
  assert.equal(run(d, ['set-google'], b64({ ...GSET, scopes: [] })).ok, false);
  assert.equal(run(d, ['set-google'], b64({ ...GSET, scopes: ['https://evil.example/auth/x'] })).ok, false);
});

test('a re-key overwrites the file and moves the clock forward', () => {
  const d = box();
  const r1 = run(d, ['set-google'], b64(GSET));
  const r2 = run(d, ['set-google'], b64({ ...GSET, access_token: 'GAT2', refresh_token: 'GRT2' }));
  assert.ok(r2.keyed_at >= r1.keyed_at);
  assert.equal(gcreds(d).refresh_token, 'GRT2');
});

test('forget google deletes the key file itself — disconnect means the key is gone', () => {
  const d = box();
  run(d, ['set-google'], b64(GSET));
  const f = path.join(d, '.kernel', 'google-creds', 'jane.doe@gmail.com.json');
  statSync(f);   // exists before
  const r = run(d, ['forget', 'google']);
  assert.equal(r.ok, true);
  assert.throws(() => statSync(f), 'the credential file must be removed');
  assert.ok(!oauth(d).google);
});

test('show reports the 7-day re-key as the google expiry, never a value', () => {
  const d = box();
  run(d, ['set-google'], b64(GSET));
  writeFileSync(path.join(d, '.mcp.json'), JSON.stringify({ mcpServers: { google: { type: 'stdio', command: 'x' } } }));
  const raw = execFileSync('node', [SCRIPT, d, 'show'], { encoding: 'utf8' });
  assert.ok(!raw.includes('GRT') && !raw.includes('GOCSPX'), 'no secret in the report');
  const s = JSON.parse(raw).services.find((x) => x.name === 'google');
  assert.equal(s.connected, true);
  assert.equal(s.renews, true);
  assert.equal(s.expired, false);
  assert.equal(s.expires_at, null, 'no clock-derived expiry: the live probe owns the death signal');
});

test('show reports state and NEVER a value', () => {
  const d = box();
  run(d, ['set'], b64({ ...SET, expires_at: Date.now() - 1000 }));
  const raw = execFileSync('node', [SCRIPT, d, 'show'], { encoding: 'utf8' });
  assert.ok(!raw.includes('AT') || !raw.includes('"access_token"'), 'no token value in the report');
  assert.ok(!raw.includes('RT'), 'and certainly not the refresh token');
  const s = JSON.parse(raw).services[0];
  assert.equal(s.name, 'canva');
  assert.equal(s.connected, true);
  assert.equal(s.expired, true);
  assert.equal(s.renews, true);
});
