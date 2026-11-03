#!/usr/bin/env node
// odoo-mcp.mjs: an Odoo connection that runs ON THE MINERAL.
//
// WHY THIS EXISTS (2026-10-22, Sam's ruling). Every Odoo is its own instance,
// so there is no one hosted server to list. What exists instead: community
// servers (Python, and their safe mode needs a module installed inside the
// member's ERP), third-party MCP modules for Odoo 19, and Odoo's own server,
// which only Odoo Online carries (saas-19.4 on). So, as with Mailchimp, the
// member pastes an API key made in their own Odoo, it lives on their mineral,
// and this small server, run by Claude Code over stdio, is the only thing
// that ever holds it. Zero dependencies.
//
// TWO WAYS IN, one server. Odoo 19 and later answer JSON-2
// (POST /json/2/<model>/<method>, the key as a bearer token, named
// arguments). Odoo 14 to 18 only answer the older JSON-RPC object service
// (POST /jsonrpc, execute_kw with database, user ID and the key in place of
// the password), which Odoo removes in 22 (Online 21.1). The server tries
// JSON-2 first and falls back when the route does not exist, so the member
// never has to know which they run.
//
// WHAT IT WILL NOT DO, ON PURPOSE.
//   - Delete anything: there is no unlink, and an edit that would delete
//     lines (x2many commands 2, and 3/5/6 on a one2many) is refused.
//   - Post, confirm, send or pay: there is no tool that calls a button or any
//     method beyond reading, create, write and an internal note. An invoice is
//     only ever a draft, an invoice that is no longer a draft is never edited,
//     and no field that moves a record through its workflow (state, active,
//     payment_state...) can be written.
//   - Touch the books' plumbing, users, access or settings: writes to those
//     models are refused (WRITE_DENY below). Reading stays as wide as the
//     user's own Odoo access rights.
//   - Email anyone: a note is posted as an internal note, never a message to
//     the record's followers.
// Everything else Odoo itself still checks: the key acts as the user who
// made it, with exactly that user's access rights.
//
// Settings (written by mcp-connect.mjs add-odoo into the box's .mcp.json):
//   ODOO_URL       the member's Odoo address (https, or loopback for tests)
//   ODOO_API_KEY   the key (Preferences, Account Security, New API Key)
//   ODOO_DB        optional: only needed where one server hosts several
//   ODOO_LOGIN     optional: the sign-in email, needed only before Odoo 19
//   ODOO_PROTOCOL  tests only: 'json2' or 'jsonrpc', skipping the detection
//
// Requests run ONE AT A TIME: Odoo Online rate-limits, and a member's Odoo is
// often a small server.
//
//   ODOO_URL=https://acme.odoo.com ODOO_API_KEY=<key> node odoo-mcp.mjs
import { createInterface } from 'node:readline';
import { isMain } from '../lib/is-main.mjs';

export const SERVER = { name: 'crads-odoo', version: '1.0.0' };
const PROTOCOL = '2025-06-18';

// Models the assistant may read but never create or change. Prefix match.
export const WRITE_DENY = [
  'ir.', 'base.', 'bus.', 'res.users', 'res.groups', 'res.company', 'res.config',
  'account.payment', 'account.bank.statement', 'account.journal', 'account.account', 'account.tax',
  'account.fiscal', 'account.reconcile', 'account.partial.reconcile', 'account.full.reconcile', 'account.move.send',
  'payment.', 'mail.mail', 'mail.template', 'mail.compose', 'sms.', 'fetchmail.', 'website', 'stock.quant', 'hr.payslip',
];
// Fields that move a record through its workflow, or archive it. Never written.
export const FIELD_DENY = new Set(['state', 'active', 'payment_state', 'posted_before', 'is_move_sent', 'website_published', 'is_published']);

// "Odoo said" in words the member can act on. `said` is Odoo's own sentence.
export function explain(status, said) {
  const s = String(said || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (status === 401) return 'Odoo turned the API key down: it has expired (on Odoo 19 and later a key lasts three months at most) or been deleted. Make a new key in Odoo (your profile, Preferences, Account Security, New API Key) and paste it on the Connections page.';
  if (status === 403) return `Odoo refused that${s ? ` (${s})` : ''}. The user who made the API key is not allowed to do it in Odoo: an Odoo administrator can change that user's access rights.`;
  if (status === 404) return `Odoo could not find that${s ? ` (${s})` : ''}. Check the model name and record IDs; find_models lists what this Odoo has.`;
  if (status === 422 || status === 400) return `Odoo would not accept that${s ? `: ${s}` : ''}.`;
  if (status === 429) return 'Odoo is busy with too many requests right now. Try again in a minute.';
  return `Odoo said no (${status})${s ? `: ${s}` : ''}.`;
}

// An Odoo exception name, from either protocol, to the HTTP status JSON-2 uses.
const STATUS_BY_NAME = [[/AccessDenied/, 401], [/AccessError/, 403], [/MissingError/, 404], [/(UserError|ValidationError|RedirectWarning)/, 422]];
const statusFor = (name) => (STATUS_BY_NAME.find(([re]) => re.test(String(name || ''))) || [null, 500])[1];

// The address: an origin, https unless it is this machine (tests, and an Odoo
// on the same box). A key never travels in the clear.
export function odooOrigin(raw) {
  let v = String(raw || '').trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try {
    const u = new URL(v);
    const loop = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) return null;
    return u.origin;
  } catch { return null; }
}

// How the named JSON-2 arguments line up as JSON-RPC positional ones. Record
// IDs, when the method takes them, always come first.
const POSITIONAL = { search_read: ['domain'], search_count: ['domain'], read: ['fields'], fields_get: [], create: ['vals_list'], write: ['vals'], message_post: [], context_get: [] };

export function createClient({ url, key, db, login, protocol, fetchFn = fetch, timeoutMs = 60000 } = {}) {
  const root = odooOrigin(url);
  const apiKey = String(key || '').trim();
  let mode = protocol === 'json2' || protocol === 'jsonrpc' ? protocol : null;
  let uid = null, dbName = String(db || '').trim() || null;
  const reach = async (path, init) => {
    try { return await fetchFn(root + path, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw new Error(`Could not reach your Odoo at ${root} just now. Check it is up, and try again in a minute.`); }
  };
  const readJson = async (r) => { const t = await r.text(); try { return t ? JSON.parse(t) : {}; } catch { return null; } };
  const fail = (status, said) => { const e = new Error(explain(status, said)); e.status = status; throw e; };

  const json2 = async (model, method, named) => {
    const headers = { authorization: `bearer ${apiKey}`, 'content-type': 'application/json; charset=utf-8', accept: 'application/json', 'user-agent': 'crads-odoo/1.0' };
    if (dbName) headers['x-odoo-database'] = dbName;
    const r = await reach(`/json/2/${encodeURIComponent(model)}/${encodeURIComponent(method)}`, { method: 'POST', headers, body: JSON.stringify(named || {}) });
    const j = await readJson(r);
    if (!r.ok) fail(r.status, j?.message || (j?.name ? String(j.name).split('.').pop() : ''));
    return j;
  };
  let rpcId = 0;
  const rpc = async (path, params) => {
    const r = await reach(path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'crads-odoo/1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params, id: ++rpcId }) });
    const j = await readJson(r);
    if (!r.ok) fail(r.status, j?.error?.data?.message || j?.error?.message);
    if (j?.error) fail(statusFor(j.error.data?.name), j.error.data?.message || j.error.message);
    return j?.result;
  };
  // JSON-RPC needs the database by name and a user ID from a sign-in
  const signIn = async () => {
    if (uid) return;
    if (!dbName) {
      let list = null;
      try { list = await rpc('/web/database/list', {}); } catch { /* listing is often switched off */ }
      if (Array.isArray(list) && list.length === 1) dbName = list[0];
      else throw new Error('Your Odoo is older than 19 and did not say which database to use. Type the database name on the Connections page (it is in the address of Odoo\'s database manager, or ask whoever runs your Odoo).');
    }
    if (!login) throw new Error('Your Odoo is older than 19, so your mineral also needs the email you sign in to Odoo with. Add it on the Connections page.');
    const id = await rpc('/jsonrpc', { service: 'common', method: 'authenticate', args: [dbName, login, apiKey, {}] });
    if (!id) fail(401);
    uid = id;
  };
  // JSON-2 first. A 404 that is not Odoo's own JSON error means the route is
  // not there: an Odoo before 19.
  const detect = async () => {
    if (!root) throw new Error('Your Odoo address does not look right: it should be an https address like https://yourcompany.odoo.com. Fix it on the Connections page.');
    if (mode) return mode;
    const headers = { authorization: `bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'crads-odoo/1.0' };
    if (dbName) headers['x-odoo-database'] = dbName;
    const r = await reach('/json/2/res.users/context_get', { method: 'POST', headers, body: '{}' });
    const j = await readJson(r);
    if (r.status === 404 && !(j && j.name)) { mode = 'jsonrpc'; return mode; }
    if (!r.ok) fail(r.status, j?.message);
    mode = 'json2';
    if (Number.isInteger(j?.uid)) uid = j.uid;
    return mode;
  };

  const once = async (model, method, named = {}) => {
    if ((await detect()) === 'json2') return json2(model, method, named);
    await signIn();
    const { ids, ...rest } = named;
    const pos = (POSITIONAL[method] || []).map((k) => rest[k]);
    for (const k of POSITIONAL[method] || []) delete rest[k];
    const args = Array.isArray(ids) ? [ids, ...pos] : pos;
    return rpc('/jsonrpc', { service: 'object', method: 'execute_kw', args: [dbName, uid, apiKey, model, method, args, rest] });
  };
  let chain = Promise.resolve();
  // one request at a time (see the header): each call waits for the last
  const call = (model, method, named) => {
    const p = chain.then(() => once(model, method, named), () => once(model, method, named));
    chain = p.catch(() => {});
    return p;
  };
  const whoAmI = async () => {
    if ((await detect()) === 'json2') {
      if (!uid) uid = (await call('res.users', 'context_get', {}))?.uid;
    } else await signIn();
    return uid;
  };
  const version = async () => {
    // /web/version (19 on); older servers answer the webclient's JSON route
    try { const r = await reach('/web/version', { method: 'GET', headers: { accept: 'application/json' } }); if (r.ok) { const j = await readJson(r); if (j?.version) return String(j.version); } } catch { /* next */ }
    try { const v = await rpc('/web/webclient/version_info', {}); if (v?.server_version) return String(v.server_version); } catch { /* unknown */ }
    return null;
  };
  return { call, whoAmI, version, root, mode: () => mode, db: () => dbName };
}

// ---- guardrails --------------------------------------------------------------
const denied = (model) => WRITE_DENY.some((p) => String(model).startsWith(p));
const isCommand = (x) => Array.isArray(x) && Number.isInteger(x[0]) && x[0] >= 0 && x[0] <= 6;

// Walk a values object the way Odoo will apply it, and refuse anything that
// deletes, moves a workflow, or reaches a denied model, BEFORE it is sent.
// Field types come from fields_get, asked only when a value is a list.
export async function checkValues(c, model, vals, cache = new Map(), where = '') {
  if (denied(model)) throw new Error(`Changing ${model} is left to you in Odoo: your assistant can read it, not change it.`);
  if (!vals || typeof vals !== 'object' || Array.isArray(vals)) throw new Error('values must be an object of field names and values.');
  const fieldsOf = async (m) => {
    if (!cache.has(m)) cache.set(m, await c.call(m, 'fields_get', { attributes: ['type', 'relation'] }));
    return cache.get(m);
  };
  for (const [f, v] of Object.entries(vals)) {
    const at = where ? `${where}.${f}` : f;
    if (FIELD_DENY.has(f) || /^password/.test(f)) throw new Error(`${at} is not something your assistant changes: it moves a record through its workflow or archives it. Do that in Odoo.`);
    if (!Array.isArray(v) || !v.length) continue;
    const meta = (await fieldsOf(model))[f];
    if (!meta || !['one2many', 'many2many'].includes(meta.type)) continue;
    for (const cmd of v) {
      if (!isCommand(cmd)) {
        if (meta.type === 'one2many') throw new Error(`${at}: a plain list of IDs would replace (and delete) the existing lines. Add lines with [0, 0, {...}] and edit them with [1, id, {...}].`);
        continue;
      }
      const code = cmd[0];
      if (code === 2 || (meta.type === 'one2many' && [3, 5, 6].includes(code))) {
        throw new Error(`${at}: that would delete records. Your assistant does not delete anything in Odoo: remove the lines there yourself.`);
      }
      if ((code === 0 || code === 1) && cmd[2]) await checkValues(c, meta.relation, cmd[2], cache, at);
    }
  }
}

// Odoo's long HTML and text fields would swamp an answer: trim each string.
export function slim(v, max = 2000) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) + '…' : v;
  if (Array.isArray(v)) return v.map((x) => slim(x, max));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, slim(x, max)]));
  return v;
}

const str = (description) => ({ type: 'string', description });
const req = (props, required) => ({ type: 'object', properties: props, required, additionalProperties: false });
const MODEL = str('The technical model name, e.g. res.partner, crm.lead, sale.order, account.move. find_models lists them.');
const DOMAIN = { type: 'array', description: 'Optional Odoo search domain, e.g. [["customer_rank", ">", 0], ["city", "ilike", "sydney"]]. Empty means every record.' };
const FIELDS = { type: 'array', items: { type: 'string' }, description: 'The fields to return. Without them you get only id and display_name; describe_model lists the fields.' };
const IDS = (max) => ({ type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: max, description: `Record IDs (up to ${max}).` });
const MOVE_TYPE = { customer_invoice: 'out_invoice', customer_credit_note: 'out_refund', vendor_bill: 'in_invoice', vendor_refund: 'in_refund' };
const fieldsOr = (f) => (Array.isArray(f) && f.length ? f : ['display_name']);
const today = () => new Date().toISOString().slice(0, 10);

// The tool table. Every handler takes (client, args) and returns plain JSON;
// the stdio loop below wraps it as MCP content.
export const TOOLS = [
  {
    name: 'whoami',
    description: 'Which Odoo this is and who the API key belongs to: the user, their company, the Odoo version and how the mineral is talking to it.',
    inputSchema: req({}, []),
    run: async (c) => {
      const uid = await c.whoAmI();
      const [u] = await c.call('res.users', 'read', { ids: [uid], fields: ['name', 'login', 'company_id'] });
      return { user: u?.name, login: u?.login, company: Array.isArray(u?.company_id) ? u.company_id[1] : undefined,
        odoo_version: (await c.version()) || undefined, via: c.mode() === 'json2' ? 'JSON-2 API' : 'JSON-RPC (Odoo before 19)', database: c.db() || undefined };
    },
  },
  {
    name: 'find_models',
    description: 'Find the models (kinds of record) this Odoo has, by technical name or label: contacts are res.partner, CRM leads crm.lead, quotations and sales orders sale.order, invoices and bills account.move, products product.product.',
    inputSchema: req({ query: str('Part of a model name or label, e.g. "invoice" or "lead".') }, ['query']),
    run: async (c, a) => c.call('ir.model', 'search_read', { domain: ['&', ['transient', '=', false], '|', ['model', 'ilike', a.query], ['name', 'ilike', a.query]], fields: ['model', 'name'], limit: 50, order: 'model' }),
  },
  {
    name: 'describe_model',
    description: 'The fields of one model: technical name, label, type, whether required or read-only, the linked model for relations, and the choices for selection fields.',
    inputSchema: req({ model: MODEL, only: { type: 'array', items: { type: 'string' }, description: 'Optional: just these fields.' } }, ['model']),
    run: async (c, a) => {
      const all = await c.call(a.model, 'fields_get', { attributes: ['string', 'type', 'required', 'readonly', 'relation', 'selection'] });
      const keep = Array.isArray(a.only) && a.only.length ? new Set(a.only) : null;
      return Object.entries(all || {}).filter(([k]) => !keep || keep.has(k)).sort(([x], [y]) => x.localeCompare(y))
        .map(([k, f]) => ({ field: k, label: f.string, type: f.type, required: f.required || undefined, readonly: f.readonly || undefined,
          relation: f.relation || undefined, choices: Array.isArray(f.selection) ? f.selection.slice(0, 30).map((s) => s[0]) : undefined }));
    },
  },
  {
    name: 'search_records',
    description: 'Search one model and return matching records with the fields you name.',
    inputSchema: req({ model: MODEL, domain: DOMAIN, fields: FIELDS,
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Optional, default 20.' },
      offset: { type: 'integer', minimum: 0 }, order: str('Optional, e.g. "create_date desc".') }, ['model']),
    run: async (c, a) => slim(await c.call(a.model, 'search_read', { domain: a.domain || [], fields: fieldsOr(a.fields), limit: a.limit || 20, offset: a.offset || 0, order: a.order || undefined })),
  },
  {
    name: 'count_records',
    description: 'How many records of one model match a domain.',
    inputSchema: req({ model: MODEL, domain: DOMAIN }, ['model']),
    run: async (c, a) => ({ count: await c.call(a.model, 'search_count', { domain: a.domain || [] }) }),
  },
  {
    name: 'get_records',
    description: 'Read records by ID, with the fields you name.',
    inputSchema: req({ model: MODEL, ids: IDS(100), fields: FIELDS }, ['model', 'ids']),
    run: async (c, a) => slim(await c.call(a.model, 'read', { ids: a.ids, fields: fieldsOr(a.fields) })),
  },
  {
    name: 'create_record',
    description: 'Create one record, e.g. a contact, a CRM lead, a quotation or a product. Lines go in as [0, 0, {...}]. Workflow fields (state, active...) cannot be set: a quotation stays a quotation and an invoice stays a draft until the owner confirms it in Odoo. Users, access, settings, payments, journals and taxes are not created here.',
    inputSchema: req({ model: MODEL, values: { type: 'object', description: 'Field names and values.' } }, ['model', 'values']),
    run: async (c, a) => {
      await checkValues(c, a.model, a.values);
      const out = await c.call(a.model, 'create', { vals_list: [a.values] });
      return { id: Array.isArray(out) ? out[0] : out, model: a.model };
    },
  },
  {
    name: 'update_records',
    description: 'Change fields on up to 50 records of one model. Lines can be added ([0, 0, {...}]) or edited ([1, id, {...}]), never removed. An invoice or bill can only be edited while it is a draft. Workflow fields (state, active...) cannot be changed: confirming, posting, cancelling and archiving happen in Odoo.',
    inputSchema: req({ model: MODEL, ids: IDS(50), values: { type: 'object', description: 'Field names and their new values.' } }, ['model', 'ids', 'values']),
    run: async (c, a) => {
      await checkValues(c, a.model, a.values);
      if (a.model === 'account.move' || a.model === 'account.move.line') {
        const moves = a.model === 'account.move'
          ? await c.call('account.move', 'read', { ids: a.ids, fields: ['name', 'state'] })
          : (await c.call('account.move.line', 'read', { ids: a.ids, fields: ['parent_state'] })).map((l) => ({ name: `line ${l.id}`, state: l.parent_state }));
        const locked = moves.filter((m) => m.state !== 'draft');
        if (locked.length) throw new Error(`${locked.map((m) => m.name).join(', ')} ${locked.length === 1 ? 'is' : 'are'} no longer a draft, so ${locked.length === 1 ? 'it is' : 'they are'} left exactly as ${locked.length === 1 ? 'it is' : 'they are'}. Reset to draft in Odoo first if it really needs changing.`);
      }
      await c.call(a.model, 'write', { ids: a.ids, vals: a.values });
      return { updated: a.ids.length, model: a.model };
    },
  },
  {
    name: 'add_note',
    description: 'Post an internal note on one record\'s chatter (a lead, an order, a contact, an invoice). Notes are internal: no customer or follower is emailed.',
    inputSchema: req({ model: MODEL, id: { type: 'integer' }, note: str('The note, as plain text.') }, ['model', 'id', 'note']),
    run: async (c, a) => {
      if (denied(a.model)) throw new Error(`Notes on ${a.model} are left to you in Odoo.`);
      const msg = await c.call(a.model, 'message_post', { ids: [a.id], body: String(a.note), message_type: 'comment', subtype_xmlid: 'mail.mt_note' });
      return { posted: true, message_id: Array.isArray(msg) ? msg[0] : msg, note: 'Posted as an internal note. Nobody was emailed.' };
    },
  },
  {
    name: 'draft_invoice',
    description: 'Create a DRAFT customer invoice, credit note or vendor bill with its lines. Nothing is posted or sent: the owner reviews it in Odoo and confirms it there. Products and taxes are by ID (search product.product and account.tax first); without a product a line needs a description and price.',
    inputSchema: req({
      partner_id: { type: 'integer', description: 'The customer or vendor (res.partner ID).' },
      kind: { type: 'string', enum: Object.keys(MOVE_TYPE), description: 'Optional, default customer_invoice.' },
      lines: { type: 'array', minItems: 1, maxItems: 100, items: req({
        description: str('What the line is for.'), quantity: { type: 'number' }, unit_price: { type: 'number' },
        product_id: { type: 'integer' }, tax_ids: { type: 'array', items: { type: 'integer' } } }, []) },
      invoice_date: str('Optional, YYYY-MM-DD.'), due_date: str('Optional, YYYY-MM-DD.'), reference: str('Optional: the customer\'s reference or the vendor\'s bill number.'),
    }, ['partner_id', 'lines']),
    run: async (c, a) => {
      const line = (l) => {
        const v = { quantity: l.quantity ?? 1 };
        if (l.description) v.name = l.description;
        if (l.unit_price !== undefined) v.price_unit = l.unit_price;
        if (l.product_id) v.product_id = l.product_id;
        if (Array.isArray(l.tax_ids)) v.tax_ids = [[6, 0, l.tax_ids]];
        if (!v.name && !v.product_id) throw new Error('Each line needs a description or a product.');
        return [0, 0, v];
      };
      const vals = { move_type: MOVE_TYPE[a.kind || 'customer_invoice'], partner_id: a.partner_id, invoice_line_ids: a.lines.map(line) };
      if (a.invoice_date) vals.invoice_date = a.invoice_date;
      if (a.due_date) vals.invoice_date_due = a.due_date;
      if (a.reference) vals.ref = a.reference;
      await checkValues(c, 'account.move', vals);
      const out = await c.call('account.move', 'create', { vals_list: [vals] });
      const id = Array.isArray(out) ? out[0] : out;
      const [m] = await c.call('account.move', 'read', { ids: [id], fields: ['state', 'amount_untaxed', 'amount_total', 'currency_id', 'partner_id'] });
      return { id, state: m?.state, partner: Array.isArray(m?.partner_id) ? m.partner_id[1] : undefined, amount_untaxed: m?.amount_untaxed, amount_total: m?.amount_total,
        currency: Array.isArray(m?.currency_id) ? m.currency_id[1] : undefined,
        note: 'Saved as a draft. Nothing has been posted or sent: review it in Odoo (Invoicing or Accounting) and confirm it there.' };
    },
  },
  {
    name: 'open_invoices',
    description: 'Posted invoices (or vendor bills) not yet paid in full: number, partner, dates, total and amount still owed. Optionally only the overdue ones, or one partner\'s.',
    inputSchema: req({ side: { type: 'string', enum: ['customer', 'vendor'], description: 'Optional, default customer (money owed to you).' },
      overdue_only: { type: 'boolean' }, partner_id: { type: 'integer' }, limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Optional, default 50.' } }, []),
    run: async (c, a) => {
      const domain = [['move_type', '=', a.side === 'vendor' ? 'in_invoice' : 'out_invoice'], ['state', '=', 'posted'], ['payment_state', 'in', ['not_paid', 'partial']]];
      if (a.overdue_only) domain.push(['invoice_date_due', '<', today()]);
      if (a.partner_id) domain.push(['partner_id', '=', a.partner_id]);
      const rows = await c.call('account.move', 'search_read', { domain, limit: a.limit || 50, order: 'invoice_date_due asc',
        fields: ['name', 'partner_id', 'invoice_date', 'invoice_date_due', 'amount_total', 'amount_residual', 'currency_id', 'payment_state'] });
      return rows.map((r) => ({ id: r.id, number: r.name, partner: Array.isArray(r.partner_id) ? r.partner_id[1] : undefined, invoice_date: r.invoice_date || undefined,
        due: r.invoice_date_due || undefined, total: r.amount_total, owed: r.amount_residual, currency: Array.isArray(r.currency_id) ? r.currency_id[1] : undefined, payment_state: r.payment_state }));
    },
  },
];

// One JSON-RPC message in, at most one out (notifications get none).
export async function handle(msg, client) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  if (msg.id === undefined || msg.id === null) return null;   // a notification
  if (msg.method === 'initialize') return reply({ protocolVersion: msg.params?.protocolVersion || PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER });
  if (msg.method === 'ping') return reply({});
  if (msg.method === 'tools/list') return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (msg.method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === msg.params?.name);
    if (!tool) return fail(-32602, `unknown tool: ${String(msg.params?.name).slice(0, 60)}`);
    try {
      const out = await tool.run(client, msg.params?.arguments || {});
      // structuredContent must be an object; a list travels inside one
      const structured = Array.isArray(out) ? { records: out } : out;
      return reply({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: structured });
    } catch (e) {
      // an Odoo refusal is an ANSWER the assistant should read and relay, so
      // it travels as a tool result marked isError, not a protocol error
      return reply({ content: [{ type: 'text', text: e.message }], isError: true });
    }
  }
  return fail(-32601, `method not found: ${String(msg.method).slice(0, 60)}`);
}

if (isMain(import.meta.url)) {
  const e = process.env;
  const client = createClient({ url: e.ODOO_URL, key: e.ODOO_API_KEY, db: e.ODOO_DB, login: e.ODOO_LOGIN, protocol: e.ODOO_PROTOCOL });
  const rl = createInterface({ input: process.stdin });
  // replies may finish out of order; each is written whole, on its own line
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); return; }
    const out = await handle(msg, client);
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  });
}
