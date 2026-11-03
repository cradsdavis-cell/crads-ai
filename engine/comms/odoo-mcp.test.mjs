// odoo-mcp.test.mjs: run node --test engine/comms/odoo-mcp.test.mjs
//
// The on-box Odoo connection (2026-10-22). The server is driven over real
// stdio, the way Claude Code runs it, against a fake Odoo that speaks both
// JSON-2 (19 on) and the older JSON-RPC object service (14 to 18) and records
// every request. What is pinned: JSON-2 is tried first and the old route is
// used only when JSON-2 is not there; the key travels as a bearer token (or
// in place of the password on JSON-RPC) and never as anything else; nothing
// deletes, posts, confirms, archives or emails; an invoice is only ever a
// draft and a non-draft one is never edited; denied models are read-only; a
// dead key reads as words the member can act on; one request at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { TOOLS, explain, odooOrigin, slim, WRITE_DENY, FIELD_DENY } from './odoo-mcp.mjs';

const SCRIPT = path.join(import.meta.dirname, 'odoo-mcp.mjs');
// A FAKE key, built at runtime (Odoo keys are 40 hex characters).
const KEY = 'ab12'.repeat(10);

test('the address is an https origin; plain http only on this machine', () => {
  assert.equal(odooOrigin('acme.odoo.com'), 'https://acme.odoo.com');
  assert.equal(odooOrigin(' https://acme.odoo.com/odoo/action-123 '), 'https://acme.odoo.com', 'a pasted page address keeps only the origin');
  assert.equal(odooOrigin('http://erp.acme.com'), null, 'a key never crosses the internet in the clear');
  assert.equal(odooOrigin('http://127.0.0.1:8069'), 'http://127.0.0.1:8069');
  assert.equal(odooOrigin(''), null);
  assert.equal(odooOrigin('not a url at all'), null);
});

test('nothing in the tool table can delete, post, confirm, send or pay', () => {
  const names = TOOLS.map((t) => t.name);
  assert.ok(names.length >= 10, 'a real tool set');
  for (const n of names) assert.doesNotMatch(n, /(delete|unlink|remove|post_invoice|confirm|send|pay|archive|call_method|execute)/, n);
  for (const t of TOOLS) assert.equal(t.inputSchema.type, 'object', `${t.name} has an object schema`);
  for (const f of ['state', 'active', 'payment_state']) assert.ok(FIELD_DENY.has(f), f);
  for (const m of ['ir.', 'res.users', 'account.payment', 'account.journal']) assert.ok(WRITE_DENY.includes(m), m);
});

test('a dead key, a permission refusal and a busy server each read as plain words', () => {
  assert.match(explain(401), /expired[\s\S]*three months[\s\S]*Connections page/);
  assert.match(explain(403, 'You are not allowed to modify Contact'), /not allowed to modify Contact[\s\S]*access rights/);
  assert.match(explain(422, 'The partner is required'), /would not accept that: The partner is required/);
  assert.match(explain(429), /Try again in a minute/);
});

test('long strings are trimmed so an answer stays readable', () => {
  const out = slim([{ id: 1, body: 'x'.repeat(5000), nested: { t: 'y'.repeat(3000) } }]);
  assert.equal(out[0].body.length, 2001);
  assert.equal(out[0].nested.t.length, 2001);
  assert.equal(out[0].id, 1);
});

// ---- a fake Odoo ------------------------------------------------------------

const FIELDS = {
  'res.partner': { name: { type: 'char', string: 'Name' }, category_id: { type: 'many2many', relation: 'res.partner.category', string: 'Tags' },
    child_ids: { type: 'one2many', relation: 'res.partner', string: 'Contacts' }, active: { type: 'boolean', string: 'Active' } },
  'account.move': { name: { type: 'char' }, state: { type: 'selection', selection: [['draft', 'Draft'], ['posted', 'Posted']] },
    invoice_line_ids: { type: 'one2many', relation: 'account.move.line' }, partner_id: { type: 'many2one', relation: 'res.partner' }, ref: { type: 'char' } },
  'account.move.line': { name: { type: 'char' }, tax_ids: { type: 'many2many', relation: 'account.tax' }, price_unit: { type: 'float' } },
  'crm.lead': { name: { type: 'char' }, stage_id: { type: 'many2one', relation: 'crm.stage' }, description: { type: 'html' } },
};

function freshDb() {
  return {
    'res.users': { 2: { id: 2, name: 'Mel Driftwood', login: 'mel@driftwood.test', company_id: [1, 'Driftwood Surf School'] } },
    'res.partner': { 7: { id: 7, name: 'Kai Waters', display_name: 'Kai Waters', active: true } },
    'account.move': {
      30: { id: 30, name: 'INV/2026/0007', state: 'posted', move_type: 'out_invoice', partner_id: [7, 'Kai Waters'], invoice_date: '2026-09-01', invoice_date_due: '2026-09-15', amount_total: 450, amount_residual: 450, currency_id: [1, 'AUD'], payment_state: 'not_paid' },
      31: { id: 31, name: '/', state: 'draft', move_type: 'out_invoice', partner_id: [7, 'Kai Waters'] },
    },
    'account.move.line': {},
    'crm.lead': { 40: { id: 40, name: 'Group lessons', description: 'z'.repeat(4000) } },
  };
}

// json2: whether /json/2 exists (Odoo 19+) or 404s like an older Odoo
async function fakeOdoo({ json2 = true, dbs = ['driftwood'], key = KEY } = {}) {
  const db = freshDb();
  const seen = [];
  let open = 0, peak = 0, nextId = 100;
  // the ORM, as much of it as the tools use. Returns [status, body, errName].
  const orm = (model, method, ids, kw) => {
    const table = db[model] || (db[model] = {});
    const pick = (r, fields) => Object.fromEntries([['id', r.id], ...(fields || []).map((f) => [f, r[f] ?? false])]);
    if (method === 'context_get') return [200, { lang: 'en_AU', tz: 'Australia/Sydney', uid: 2 }];
    if (method === 'fields_get') return [200, FIELDS[model] || {}];
    if (method === 'read') return [200, ids.filter((i) => table[i]).map((i) => pick(table[i], kw.fields))];
    if (method === 'search_read') return [200, Object.values(table).filter((r) => (kw.domain || []).every((d) => !Array.isArray(d) || d[0] !== 'state' || r.state === d[2])).slice(0, kw.limit || 1e9).map((r) => pick(r, kw.fields))];
    if (method === 'search_count') return [200, Object.keys(table).length];
    if (method === 'create') {
      return [200, kw.vals_list.map((v) => {
        const id = nextId++;
        const rec = { id, ...v, ...(model === 'account.move' ? { state: 'draft', name: '/', amount_untaxed: 100, amount_total: 110, currency_id: [1, 'AUD'], partner_id: [v.partner_id, 'Kai Waters'] } : {}) };
        table[id] = rec;
        return id;
      })];
    }
    if (method === 'write') { for (const i of ids) Object.assign(table[i], kw.vals); return [200, true]; }
    if (method === 'message_post') return [200, 900];
    return [404, { name: 'odoo.exceptions.MissingError', message: `no method ${method}` }, 'odoo.exceptions.MissingError'];
  };
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      open++; peak = Math.max(peak, open);
      const u = new URL(req.url, 'http://x');
      const parsed = body ? JSON.parse(body) : undefined;
      seen.push({ method: req.method, path: u.pathname, auth: req.headers.authorization, db: req.headers['x-odoo-database'], body: parsed });
      await new Promise((r) => setTimeout(r, 10));   // long enough for overlap to show if it could happen
      open--;
      const send = (status, j, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof j === 'string' ? j : JSON.stringify(j)); };
      const m2 = u.pathname.match(/^\/json\/2\/([^/]+)\/([^/]+)$/);
      if (m2) {
        if (!json2) return send(404, '<html>404: Not Found</html>', 'text/html');
        if (req.headers.authorization !== `bearer ${key}`) return send(401, { name: 'werkzeug.exceptions.Unauthorized', message: 'Invalid apikey' });
        const { ids, context, ...kw } = parsed || {};
        const [st, out] = orm(decodeURIComponent(m2[1]), decodeURIComponent(m2[2]), ids || [], kw);
        return send(st, out);
      }
      if (u.pathname === '/web/version') return json2 ? send(200, { version: '19.0', version_info: [19, 0, 0, 'final', 0, ''] }) : send(404, 'nope', 'text/html');
      if (u.pathname === '/web/webclient/version_info') return send(200, { jsonrpc: '2.0', id: parsed.id, result: { server_version: '17.0' } });
      if (u.pathname === '/web/database/list') return send(200, { jsonrpc: '2.0', id: parsed.id, result: dbs });
      if (u.pathname === '/jsonrpc') {
        const { service, method, args } = parsed.params;
        const rpcErr = (name, message) => send(200, { jsonrpc: '2.0', id: parsed.id, error: { code: 200, message: 'Odoo Server Error', data: { name, message } } });
        if (service === 'common' && method === 'authenticate') return send(200, { jsonrpc: '2.0', id: parsed.id, result: args[2] === key && dbs.includes(args[0]) ? 2 : false });
        if (service === 'object' && method === 'execute_kw') {
          const [dbn, uid, pw, model, meth, pos, kw] = args;
          if (pw !== key || uid !== 2 || !dbs.includes(dbn)) return rpcErr('odoo.exceptions.AccessDenied', 'Access Denied');
          // positional back to named, the way the server lines them up
          const named = { ...kw };
          let ids = [];
          const POS = { search_read: ['domain'], search_count: ['domain'], read: ['fields'], create: ['vals_list'], write: ['vals'] };
          const recordMethod = ['read', 'write', 'message_post'].includes(meth);
          const rest = recordMethod ? (ids = pos[0], pos.slice(1)) : pos;
          (POS[meth] || []).forEach((k, i) => { named[k] = rest[i]; });
          const [st, out, errName] = orm(model, meth, ids, named);
          if (st !== 200) return rpcErr(errName, out.message);
          return send(200, { jsonrpc: '2.0', id: parsed.id, result: out });
        }
      }
      send(404, '<html>404</html>', 'text/html');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, db, seen, peak: () => peak, close: () => srv.close() };
}

function startServer(url, env = {}) {
  const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, ODOO_URL: url, ODOO_API_KEY: KEY, ODOO_DB: '', ODOO_LOGIN: '', ODOO_PROTOCOL: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const tool = async (name, args = {}) => {
    const r = (await rpc('tools/call', { name, arguments: args })).result;
    return { ...r, data: r.isError ? undefined : JSON.parse(r.content[0].text), text: r.content[0].text };
  };
  return { rpc, tool, stop: () => child.kill() };
}

test('stdio + JSON-2: initialize, list tools, whoami; the key is only ever a bearer token', async () => {
  const f = await fakeOdoo();
  const s = startServer(f.url);
  try {
    const init = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'crads-odoo');
    assert.equal((await s.rpc('tools/list', {})).result.tools.length, TOOLS.length);
    const me = await s.tool('whoami');
    assert.equal(me.isError, undefined, me.text);
    assert.equal(me.data.user, 'Mel Driftwood');
    assert.equal(me.data.company, 'Driftwood Surf School');
    assert.equal(me.data.odoo_version, '19.0');
    assert.match(me.data.via, /JSON-2/);
    const odooCalls = f.seen.filter((r) => r.path.startsWith('/json/2/'));
    assert.ok(odooCalls.length >= 2);
    for (const r of odooCalls) assert.equal(r.auth, `bearer ${KEY}`);
    assert.ok(!f.seen.some((r) => r.path === '/jsonrpc'), 'no fallback when JSON-2 answers');
  } finally { s.stop(); f.close(); }
});

test('JSON-RPC fallback (Odoo before 19): detects, finds the one database, signs in with the email and the key', async () => {
  const f = await fakeOdoo({ json2: false });
  const s = startServer(f.url, { ODOO_LOGIN: 'mel@driftwood.test' });
  try {
    const me = await s.tool('whoami');
    assert.equal(me.isError, undefined, me.text);
    assert.equal(me.data.user, 'Mel Driftwood');
    assert.match(me.data.via, /JSON-RPC/);
    assert.equal(me.data.database, 'driftwood', 'the only database, found by asking');
    assert.equal(me.data.odoo_version, '17.0');
    const auth = f.seen.find((r) => r.body?.params?.method === 'authenticate');
    assert.deepEqual(auth.body.params.args.slice(0, 3), ['driftwood', 'mel@driftwood.test', KEY]);
    // a write lines up positionally: ids first, then the values
    const up = await s.tool('update_records', { model: 'res.partner', ids: [7], values: { name: 'Kai Waters (Bondi)' } });
    assert.equal(up.isError, undefined, up.text);
    assert.equal(f.db['res.partner'][7].name, 'Kai Waters (Bondi)');
    const w = f.seen.find((r) => r.body?.params?.args?.[4] === 'write');
    assert.deepEqual(w.body.params.args[5], [[7], { name: 'Kai Waters (Bondi)' }]);
  } finally { s.stop(); f.close(); }
});

test('JSON-RPC fallback asks in words for what it is missing', async () => {
  const f = await fakeOdoo({ json2: false, dbs: ['one', 'two'] });
  try {
    let s = startServer(f.url, { ODOO_LOGIN: 'mel@driftwood.test' });
    assert.match((await s.tool('whoami')).text, /Type the database name/);
    s.stop();
    s = startServer(f.url, { ODOO_DB: 'one' });
    assert.match((await s.tool('whoami')).text, /email you sign in to Odoo with/);
    s.stop();
  } finally { f.close(); }
});

test('a dead key is words, on both routes', async () => {
  const f = await fakeOdoo({ key: 'cd34'.repeat(10) });
  const s = startServer(f.url);
  try {
    const r = await s.tool('whoami');
    assert.equal(r.isError, true);
    assert.match(r.text, /turned the API key down/);
    assert.ok(!r.text.includes(KEY));
  } finally { s.stop(); f.close(); }
  const g = await fakeOdoo({ json2: false, key: 'cd34'.repeat(10) });
  const t = startServer(g.url, { ODOO_LOGIN: 'mel@driftwood.test' });
  try { assert.match((await t.tool('whoami')).text, /turned the API key down/); } finally { t.stop(); g.close(); }
});

test('search returns only the named fields (id and display_name by default), trimmed', async () => {
  const f = await fakeOdoo();
  const s = startServer(f.url);
  try {
    const d = await s.tool('search_records', { model: 'res.partner' });
    assert.deepEqual(Object.keys(d.data[0]).sort(), ['display_name', 'id']);
    const lead = await s.tool('get_records', { model: 'crm.lead', ids: [40], fields: ['name', 'description'] });
    assert.equal(lead.data[0].description.length, 2001, 'a 4,000-character description comes back trimmed');
    const call = f.seen.find((r) => r.path === '/json/2/res.partner/search_read');
    assert.equal(call.body.limit, 20, 'a default limit, so a big table never floods the answer');
  } finally { s.stop(); f.close(); }
});

test('drafts only: draft_invoice makes a draft; a posted invoice is never edited; workflow fields are refused', async () => {
  const f = await fakeOdoo();
  const s = startServer(f.url);
  try {
    const inv = await s.tool('draft_invoice', { partner_id: 7, lines: [{ description: 'Group lesson, 5 people', quantity: 5, unit_price: 60, tax_ids: [3] }] });
    assert.equal(inv.isError, undefined, inv.text);
    assert.equal(inv.data.state, 'draft');
    assert.match(inv.data.note, /Nothing has been posted or sent/);
    const made = f.db['account.move'][inv.data.id];
    assert.equal(made.move_type, 'out_invoice');
    assert.deepEqual(made.invoice_line_ids[0], [0, 0, { quantity: 5, name: 'Group lesson, 5 people', price_unit: 60, tax_ids: [[6, 0, [3]]] }], 'taxes SET on a many2many is allowed');

    const posted = await s.tool('update_records', { model: 'account.move', ids: [30], values: { ref: 'changed' } });
    assert.equal(posted.isError, true);
    assert.match(posted.text, /INV\/2026\/0007 is no longer a draft/);
    assert.equal(f.db['account.move'][30].ref, undefined, 'the posted invoice is untouched');
    assert.equal((await s.tool('update_records', { model: 'account.move', ids: [31], values: { ref: 'PO 123' } })).isError, undefined, 'a draft can be edited');

    for (const values of [{ state: 'posted' }, { active: false }, { payment_state: 'paid' }]) {
      const r = await s.tool('update_records', { model: 'account.move', ids: [31], values });
      assert.equal(r.isError, true, JSON.stringify(values));
      assert.match(r.text, /workflow or archives it/);
    }
    assert.equal(f.db['account.move'][31].state, 'draft');
    const sneaky = await s.tool('create_record', { model: 'account.move', values: { partner_id: 7, state: 'posted' } });
    assert.equal(sneaky.isError, true, 'an invoice cannot be created posted');
  } finally { s.stop(); f.close(); }
});

test('nothing deletes: x2many delete, unlink and replace commands are refused before Odoo is asked', async () => {
  const f = await fakeOdoo();
  const s = startServer(f.url);
  try {
    const before = f.seen.length;
    const refusals = [
      ['res.partner', { child_ids: [[2, 9]] }],                     // DELETE
      ['res.partner', { child_ids: [[3, 9]] }],                     // one2many UNLINK deletes the line
      ['res.partner', { child_ids: [[5]] }],                        // one2many CLEAR
      ['res.partner', { child_ids: [[6, 0, [9]]] }],                // one2many SET drops the rest
      ['res.partner', { child_ids: [9, 10] }],                      // a bare id list = SET
      ['res.partner', { category_id: [[2, 4]] }],                   // DELETE on a many2many deletes the tag itself
      ['account.move', { invoice_line_ids: [[1, 5, { tax_ids: [[2, 1]] }]] }],   // nested
    ];
    for (const [model, values] of refusals) {
      const r = await s.tool('update_records', { model, ids: model === 'account.move' ? [31] : [7], values });
      assert.equal(r.isError, true, JSON.stringify(values));
      assert.match(r.text, /delete|replace/, JSON.stringify(values));
    }
    assert.ok(!f.seen.slice(before).some((r) => /\/write$/.test(r.path)), 'no write ever reached Odoo');
    // and the safe shapes go through: link a tag, drop a tag (relation only), add a line
    assert.equal((await s.tool('update_records', { model: 'res.partner', ids: [7], values: { category_id: [[4, 1], [3, 2]] } })).isError, undefined);
    assert.equal((await s.tool('update_records', { model: 'res.partner', ids: [7], values: { child_ids: [[0, 0, { name: 'Accounts' }]] } })).isError, undefined);
  } finally { s.stop(); f.close(); }
});

test('denied models are read-only; notes are internal; leads can be created', async () => {
  const f = await fakeOdoo();
  const s = startServer(f.url);
  try {
    for (const model of ['res.users', 'ir.config_parameter', 'account.payment', 'account.journal', 'mail.mail']) {
      const r = await s.tool('create_record', { model, values: { name: 'x' } });
      assert.equal(r.isError, true, model);
      assert.match(r.text, /left to you in Odoo/);
    }
    assert.equal((await s.tool('get_records', { model: 'res.users', ids: [2], fields: ['name'] })).data[0].name, 'Mel Driftwood', 'reading stays open');
    const lead = await s.tool('create_record', { model: 'crm.lead', values: { name: 'Corporate team day' } });
    assert.equal(lead.isError, undefined, lead.text);
    assert.equal(f.db['crm.lead'][lead.data.id].name, 'Corporate team day');
    const note = await s.tool('add_note', { model: 'crm.lead', id: 40, note: 'Called, wants a quote for 12.' });
    assert.equal(note.isError, undefined, note.text);
    const post = f.seen.find((r) => r.path === '/json/2/crm.lead/message_post');
    assert.equal(post.body.subtype_xmlid, 'mail.mt_note', 'an internal note: no follower is emailed');
    assert.deepEqual(post.body.ids, [40]);
  } finally { s.stop(); f.close(); }
});

test('open_invoices: posted, unpaid, oldest due first, in plain fields', async () => {
  const f = await fakeOdoo();
  const s = startServer(f.url);
  try {
    const r = await s.tool('open_invoices', { overdue_only: true });
    assert.equal(r.isError, undefined, r.text);
    assert.deepEqual(r.data, [{ id: 30, number: 'INV/2026/0007', partner: 'Kai Waters', invoice_date: '2026-09-01', due: '2026-09-15', total: 450, owed: 450, currency: 'AUD', payment_state: 'not_paid' }]);
    const q = f.seen.find((x) => x.path === '/json/2/account.move/search_read').body;
    assert.deepEqual(q.domain.slice(0, 3), [['move_type', '=', 'out_invoice'], ['state', '=', 'posted'], ['payment_state', 'in', ['not_paid', 'partial']]]);
    assert.equal(q.domain[3][0], 'invoice_date_due');
    assert.equal(q.order, 'invoice_date_due asc');
  } finally { s.stop(); f.close(); }
});

test('one request at a time, even when calls arrive together', async () => {
  const f = await fakeOdoo();
  const s = startServer(f.url);
  try {
    await Promise.all([1, 2, 3, 4, 5].map(() => s.tool('count_records', { model: 'res.partner' })));
    assert.equal(f.peak(), 1, 'never more than one open request to Odoo');
  } finally { s.stop(); f.close(); }
});
