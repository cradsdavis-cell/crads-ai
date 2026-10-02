// mailchimp-mcp.test.mjs: run node --test engine/comms/mailchimp-mcp.test.mjs
//
// The on-box Mailchimp connection (2026-10-02). The server is driven over real
// stdio, the way Claude Code runs it, against a fake Mailchimp API that
// records every request. What is pinned: the key is routed by its data-center
// suffix and sent as HTTP Basic; nothing can send, schedule or delete; a new
// contact is "pending" unless consent is stated, and an existing contact's
// status is never touched; a draft is the only thing content can change; a
// dead key reads as words the member can act on; one request at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { dataCenter, subscriberHash, TOOLS, explain } from './mailchimp-mcp.mjs';

const SCRIPT = path.join(import.meta.dirname, 'mailchimp-mcp.mjs');
// A FAKE key, built at runtime: a literal in Mailchimp's real shape trips
// GitHub push protection on the public repo (it cannot tell a fixture from a key).
const KEY = '0123456789abcdef'.repeat(2) + '-us21';

test('the key routes by its data-center suffix; a key without one is refused', () => {
  assert.equal(dataCenter(KEY), 'us21');
  assert.equal(dataCenter(` ${KEY}\n`), 'us21', 'a pasted key may carry whitespace');
  assert.equal(dataCenter('0123456789abcdef0123456789abcdef'), null);
  assert.equal(dataCenter('not-a-key-us21'), null);
});

test('contacts are addressed by the MD5 of the lowercased email', () => {
  assert.equal(subscriberHash(' Ann@Example.com '), subscriberHash('ann@example.com'));
  assert.equal(subscriberHash('ann@example.com'), '257c57037d384ae37ea27a07e8a01665', 'md5, computed independently');
});

test('nothing in the tool table can send, schedule or delete', () => {
  const names = TOOLS.map((t) => t.name);
  assert.ok(names.length >= 10, 'a real tool set');
  for (const n of names) assert.doesNotMatch(n, /^(send_campaign|schedule|delete|remove_contact|unsubscribe)/, n);
  assert.ok(names.includes('send_test_email'), 'a TEST send is the one send there is');
  for (const t of TOOLS) assert.equal(t.inputSchema.type, 'object', `${t.name} has an object schema`);
});

test('a dead key, a plan refusal and a busy account each read as plain words', () => {
  assert.match(explain(401, {}), /expired or been revoked[\s\S]*Connections page/);
  assert.match(explain(403, { detail: 'Upgrade required' }), /Upgrade required[\s\S]*plan/);
  assert.match(explain(429, {}), /Try again in a minute/);
});

// ---- driven over stdio against a fake Mailchimp ---------------------------

async function fakeMailchimp(route) {
  const seen = [];
  let open = 0, peak = 0;
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      open++; peak = Math.max(peak, open);
      const u = new URL(req.url, 'http://x');
      seen.push({ method: req.method, path: u.pathname.replace(/^\/3\.0/, ''), query: Object.fromEntries(u.searchParams), auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
      await new Promise((r) => setTimeout(r, 15));   // long enough for overlap to show if it could happen
      const [status, json] = route(req.method, u.pathname.replace(/^\/3\.0/, ''), body ? JSON.parse(body) : undefined) || [404, { title: 'Resource Not Found', detail: 'nope' }];
      open--;
      if (status === 204) { res.writeHead(204); res.end(); return; }
      res.writeHead(status, { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}/3.0`, seen, peak: () => peak, close: () => srv.close() };
}

function startServer(base, key = KEY) {
  const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, MAILCHIMP_API_KEY: key, MAILCHIMP_API_BASE: base }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', id = 0;
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const m = JSON.parse(line);
      waiting.get(m.id)?.(m); waiting.delete(m.id);
    }
  });
  const rpc = (method, params) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  return { rpc, tool, notify: (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'), stop: () => child.kill() };
}

test('stdio: initialize, list tools, and every call carries the key as HTTP Basic', async () => {
  const f = await fakeMailchimp((m, p) => (p === '/lists' ? [200, { lists: [{ id: 'L1', name: 'Newsletter' }], total_items: 1 }] : null));
  const s = startServer(f.base);
  try {
    const init = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'crads-mailchimp');
    s.notify('notifications/initialized');
    const list = await s.rpc('tools/list', {});
    assert.equal(list.result.tools.length, TOOLS.length);
    const r = await s.tool('list_audiences', {});
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.lists[0].name, 'Newsletter');
    assert.equal(f.seen[0].auth, 'Basic ' + Buffer.from(`crads:${KEY}`).toString('base64'));
    assert.match(f.seen[0].query.fields, /lists\.id/, 'answers are trimmed to the fields that matter');
  } finally { s.stop(); f.close(); }
});

test('a new contact is pending unless consent is stated; status is never forced on an existing one', async () => {
  const f = await fakeMailchimp((m, p, b) => {
    if (m === 'PUT' && /\/members\//.test(p)) return [200, { email_address: b.email_address, status: b.status_if_new }];
    if (m === 'POST' && /\/tags$/.test(p)) return [204];
    return null;
  });
  const s = startServer(f.base);
  try {
    const a = await s.tool('add_or_update_contact', { audience_id: 'L1', email: 'Ann@Example.com', first_name: 'Ann', tags: ['wholesale'] });
    assert.equal(a.structuredContent.status, 'pending');
    assert.match(a.structuredContent.note, /emailed them to confirm/);
    const put = f.seen.find((x) => x.method === 'PUT');
    assert.equal(put.path, `/lists/L1/members/${subscriberHash('ann@example.com')}`);
    assert.equal(put.body.status_if_new, 'pending');
    assert.equal(put.body.status, undefined, 'never sets status: an existing contact keeps the one they chose');
    assert.equal(put.body.merge_fields.FNAME, 'Ann');
    assert.deepEqual(f.seen.find((x) => x.method === 'POST').body, { tags: [{ name: 'wholesale', status: 'active' }] });
    const b = await s.tool('add_or_update_contact', { audience_id: 'L1', email: 'bo@example.com', consent_confirmed: true });
    assert.equal(b.structuredContent.status, 'subscribed', 'stated consent subscribes');
    const c = await s.tool('add_or_update_contact', { audience_id: 'L1', email: 'cy@example.com', consent_confirmed: 'yes' });
    assert.equal(c.structuredContent.status, 'pending', 'only a real true counts as consent');
  } finally { s.stop(); f.close(); }
});

test('a draft is made with the audience\'s own from name; content only ever changes on a draft', async () => {
  const f = await fakeMailchimp((m, p) => {
    if (m === 'GET' && p === '/lists/L1') return [200, { campaign_defaults: { from_name: 'Driftwood Surf School', from_email: 'hello@shop.example' } }];
    if (m === 'POST' && p === '/campaigns') return [200, { id: 'C1', status: 'save' }];
    if (m === 'PUT' && p === '/campaigns/C1/content') return [200, {}];
    if (m === 'GET' && p === '/campaigns/C1') return [200, { id: 'C1', status: 'save' }];
    if (m === 'GET' && p === '/campaigns/C9') return [200, { id: 'C9', status: 'sent' }];
    return null;
  });
  const s = startServer(f.base);
  try {
    const d = await s.tool('create_draft_campaign', { audience_id: 'L1', subject: 'New beads in', html: '<p>Hi</p>' });
    assert.equal(d.structuredContent.campaign_id, 'C1');
    assert.match(d.structuredContent.note, /Nothing has been sent/);
    const post = f.seen.find((x) => x.method === 'POST' && x.path === '/campaigns');
    assert.equal(post.body.type, 'regular');
    assert.equal(post.body.settings.from_name, 'Driftwood Surf School');
    assert.equal(post.body.settings.reply_to, 'hello@shop.example');
    assert.ok(!f.seen.some((x) => /\/actions\/(send|schedule)/.test(x.path)), 'never sends or schedules');
    const ok = await s.tool('update_draft_content', { campaign_id: 'C1', html: '<p>Hi again</p>' });
    assert.equal(ok.isError, undefined);
    const before = f.seen.length;
    const no = await s.tool('update_draft_content', { campaign_id: 'C9', html: '<p>too late</p>' });
    assert.equal(no.isError, true);
    assert.match(no.content[0].text, /is sent, not a draft/);
    assert.ok(!f.seen.slice(before).some((x) => x.method === 'PUT'), 'a sent campaign is left exactly as it is');
  } finally { s.stop(); f.close(); }
});

test('a dead key comes back as a readable tool result, not a protocol error', async () => {
  const f = await fakeMailchimp(() => [401, { title: 'API Key Invalid', detail: 'Your API key may be invalid, or you\'ve attempted to access the wrong datacenter.' }]);
  const s = startServer(f.base);
  try {
    const r = await s.tool('account_info', {});
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /expired or been revoked/);
  } finally { s.stop(); f.close(); }
});

test('requests run one at a time, even when calls arrive together', async () => {
  const f = await fakeMailchimp(() => [200, { lists: [] }]);
  const s = startServer(f.base);
  try {
    await Promise.all([s.tool('list_audiences', {}), s.tool('list_audiences', {}), s.tool('list_audiences', {}), s.tool('account_info', {})]);
    assert.equal(f.peak(), 1, 'never more than one open request to Mailchimp');
  } finally { s.stop(); f.close(); }
});

test('a key with no data-center suffix is refused before any request', async () => {
  const f = await fakeMailchimp(() => [200, {}]);
  // no MAILCHIMP_API_BASE override: the address must come from the key
  const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, MAILCHIMP_API_KEY: 'nodashkey', MAILCHIMP_API_BASE: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const out = await new Promise((resolve) => {
      child.stdout.once('data', (d) => resolve(JSON.parse(String(d).split('\n')[0])));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'account_info', arguments: {} } }) + '\n');
    });
    assert.equal(out.result.isError, true);
    assert.match(out.result.content[0].text, /should end with a dash and a code like -us21/);
    assert.equal(f.seen.length, 0);
  } finally { child.kill(); f.close(); }
});
