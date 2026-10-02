#!/usr/bin/env node
// mailchimp-mcp.mjs: a Mailchimp Marketing connection that runs ON THE MINERAL.
//
// WHY THIS EXISTS (2026-10-02, Sam's ruling). Mailchimp publishes no official
// MCP server for its Marketing API (audiences, campaigns, reports); the only
// official one covers Transactional email (Mandrill). The hosted community
// servers relay a member's Mailchimp through somebody else's machines, which
// is exactly what the product refuses everywhere else. So the member pastes
// their OWN API key, it lives on their mineral, and this small server, run by
// Claude Code over stdio like the Google connection, is the only thing that
// ever holds it. Zero dependencies: the Marketing API is plain HTTPS with the
// key as HTTP Basic, addressed by the key's data-center suffix (-us21).
//
// WHAT IT WILL NOT DO, ON PURPOSE. No tool sends or schedules a campaign: a
// newsletter to a whole audience cannot be taken back, so the member presses
// Send in Mailchimp. No tool deletes a contact, an audience or a campaign.
// A new contact is added as "pending" (Mailchimp emails them to confirm)
// unless the caller states the member has the contact's consent; Mailchimp's
// API terms forbid using the API to send spam, and "subscribed" puts the
// proof of consent on the business owner. An existing contact's status is
// never changed here.
//
// The key: MAILCHIMP_API_KEY in this server's env (written by mcp-connect.mjs
// add-mailchimp into the box's .mcp.json, which already holds every other
// connection's credential). Keys made since 22 June 2026 expire a year after
// creation; a 401 says so in words the member can act on.
//
// Requests run ONE AT A TIME: Mailchimp allows 10 simultaneous connections per
// account, and that budget is shared with the member's other integrations.
//
//   MAILCHIMP_API_KEY=<key> node mailchimp-mcp.mjs        (stdio MCP server)
//   MAILCHIMP_API_BASE=http://127.0.0.1:N/3.0             (tests only: a fake API)
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { isMain } from '../lib/is-main.mjs';

export const SERVER = { name: 'crads-mailchimp', version: '1.0.0' };
const PROTOCOL = '2025-06-18';
const KEY_RE = /^[0-9a-f]{32}-([a-z]{2}\d{1,3})$/;

// "abc...-us21" -> "us21". The suffix IS the address; a key without one
// cannot be routed, so it is refused before any request is made.
export function dataCenter(key) {
  const m = String(key || '').trim().match(KEY_RE);
  return m ? m[1] : null;
}

// Mailchimp addresses a contact by the MD5 of their lowercased email.
export const subscriberHash = (email) => createHash('md5').update(String(email).trim().toLowerCase()).digest('hex');

// The plain words for each way Mailchimp says no. `detail` is Mailchimp's own
// sentence (its errors are problem+json: title, status, detail).
export function explain(status, body) {
  const said = String(body?.detail || body?.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (status === 401) return 'Mailchimp turned the API key down: it has expired or been revoked. Make a new key in Mailchimp (Profile, Extras, API keys) and paste it on the Connections page.';
  if (status === 403) return `Mailchimp refused that${said ? ` (${said})` : ''}. Either the account's plan does not include it, or the person who made the API key does not have permission for it.`;
  if (status === 404) return `Mailchimp could not find that${said ? ` (${said})` : ''}. Check the audience, contact or campaign ID.`;
  if (status === 429) return 'Mailchimp is busy with too many requests from this account right now. Try again in a minute.';
  return `Mailchimp said no (${status})${said ? `: ${said}` : ''}.`;
}

export function createClient({ key, base, fetchFn = fetch, timeoutMs = 60000 } = {}) {
  const dc = dataCenter(key);
  const root = base || (dc ? `https://${dc}.api.mailchimp.com/3.0` : null);
  const auth = 'Basic ' + Buffer.from(`crads:${String(key || '').trim()}`).toString('base64');
  let chain = Promise.resolve();
  // one request at a time (see the header): each call waits for the last
  const call = (method, path, { query, body } = {}) => {
    const run = async () => {
      if (!root) throw new Error('That Mailchimp API key does not look right: it should end with a dash and a code like -us21. Paste it again on the Connections page.');
      const u = new URL(root.replace(/\/$/, '') + path);
      for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
      let r;
      try {
        r = await fetchFn(u, { method, headers: { authorization: auth, 'content-type': 'application/json', accept: 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      } catch { throw new Error('Could not reach Mailchimp just now. Try again in a minute.'); }
      if (r.status === 204) return {};
      const text = await r.text();
      let json = null;
      try { json = text ? JSON.parse(text) : {}; } catch { /* not json */ }
      if (!r.ok) { const e = new Error(explain(r.status, json)); e.status = r.status; throw e; }
      return json ?? {};
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  };
  return { call, root };
}

const str = (description) => ({ type: 'string', description });
const req = (props, required) => ({ type: 'object', properties: props, required, additionalProperties: false });
const AUDIENCE = str('The audience (list) ID, from list_audiences.');
const EMAIL = str('The contact\'s email address.');

// The tool table. Every handler takes (client, args) and returns plain JSON;
// the stdio loop below wraps it as MCP content. Field lists keep answers small:
// Mailchimp's full objects run to hundreds of lines each.
export const TOOLS = [
  {
    name: 'account_info',
    description: 'Who this Mailchimp account belongs to: account name, company, plan type and total contacts.',
    inputSchema: req({}, []),
    run: async (c) => c.call('GET', '/', { query: { fields: 'account_name,email,contact.company,pricing_plan_type,total_subscribers' } }),
  },
  {
    name: 'list_audiences',
    description: 'Every audience (Mailchimp also calls them lists): ID, name, contact counts, and when a campaign last went to it.',
    inputSchema: req({}, []),
    run: async (c) => c.call('GET', '/lists', { query: { count: 100, fields: 'lists.id,lists.name,lists.stats.member_count,lists.stats.unsubscribe_count,lists.stats.campaign_last_sent,lists.date_created,total_items' } }),
  },
  {
    name: 'list_tags_and_segments',
    description: 'The tags and saved segments in one audience, with their IDs (a segment ID can target a draft campaign).',
    inputSchema: req({ audience_id: AUDIENCE }, ['audience_id']),
    run: async (c, a) => ({
      tags: (await c.call('GET', `/lists/${encodeURIComponent(a.audience_id)}/tag-search`, { query: { count: 100 } })).tags || [],
      segments: (await c.call('GET', `/lists/${encodeURIComponent(a.audience_id)}/segments`, { query: { count: 100, fields: 'segments.id,segments.name,segments.type,segments.member_count' } })).segments || [],
    }),
  },
  {
    name: 'search_contacts',
    description: 'Find contacts by name or email, across every audience or within one.',
    inputSchema: req({ query: str('Part of a name or an email address.'), audience_id: { ...AUDIENCE, description: 'Optional: search only this audience.' } }, ['query']),
    run: async (c, a) => {
      const r = await c.call('GET', '/search-members', { query: { query: a.query, list_id: a.audience_id } });
      const slim = (m) => ({ email: m.email_address, name: m.full_name, status: m.status, audience_id: m.list_id, tags: (m.tags || []).map((t) => t.name) });
      return { matches: (r.exact_matches?.members || []).map(slim), similar: (r.full_search?.members || []).slice(0, 20).map(slim) };
    },
  },
  {
    name: 'get_contact',
    description: 'One contact in one audience: status, name fields, tags, and when they joined.',
    inputSchema: req({ audience_id: AUDIENCE, email: EMAIL }, ['audience_id', 'email']),
    run: async (c, a) => c.call('GET', `/lists/${encodeURIComponent(a.audience_id)}/members/${subscriberHash(a.email)}`,
      { query: { fields: 'email_address,full_name,status,merge_fields,tags,timestamp_opt,last_changed,stats' } }),
  },
  {
    name: 'add_or_update_contact',
    description: 'Add a contact to an audience, or update an existing contact\'s name fields and tags. A NEW contact is added as "pending": Mailchimp emails them to confirm before they receive anything. Only set consent_confirmed when the business owner has told you this person agreed to receive emails; then they are added as subscribed. An existing contact\'s subscription status is never changed by this tool.',
    inputSchema: req({
      audience_id: AUDIENCE, email: EMAIL,
      first_name: str('Optional.'), last_name: str('Optional.'),
      merge_fields: { type: 'object', description: 'Optional: other audience fields by their merge tag, e.g. {"COMPANY": "Acme"}.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional: tags to add.' },
      consent_confirmed: { type: 'boolean', description: 'True only when the owner has confirmed this person agreed to be emailed.' },
    }, ['audience_id', 'email']),
    run: async (c, a) => {
      const merge = { ...(a.merge_fields || {}) };
      if (a.first_name) merge.FNAME = a.first_name;
      if (a.last_name) merge.LNAME = a.last_name;
      const path = `/lists/${encodeURIComponent(a.audience_id)}/members/${subscriberHash(a.email)}`;
      // status_if_new only: an existing contact keeps the status they chose
      const m = await c.call('PUT', path, { body: { email_address: String(a.email).trim(), status_if_new: a.consent_confirmed === true ? 'subscribed' : 'pending', merge_fields: merge } });
      if (Array.isArray(a.tags) && a.tags.length) await c.call('POST', `${path}/tags`, { body: { tags: a.tags.map((name) => ({ name, status: 'active' })) } });
      return { email: m.email_address, status: m.status,
        note: m.status === 'pending' ? 'Added as pending: Mailchimp has emailed them to confirm, and they receive nothing until they do.' : undefined };
    },
  },
  {
    name: 'tag_contact',
    description: 'Add tags to, or remove tags from, one contact. A tag that does not exist yet is created.',
    inputSchema: req({ audience_id: AUDIENCE, email: EMAIL,
      add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } } }, ['audience_id', 'email']),
    run: async (c, a) => {
      const tags = [...(a.add || []).map((name) => ({ name, status: 'active' })), ...(a.remove || []).map((name) => ({ name, status: 'inactive' }))];
      if (!tags.length) return { changed: 0 };
      await c.call('POST', `/lists/${encodeURIComponent(a.audience_id)}/members/${subscriberHash(a.email)}/tags`, { body: { tags } });
      return { changed: tags.length };
    },
  },
  {
    name: 'list_campaigns',
    description: 'Recent campaigns, newest first: ID, title, subject, status (save = draft, sent, schedule...), audience and send time.',
    inputSchema: req({ status: { type: 'string', enum: ['save', 'paused', 'schedule', 'sending', 'sent'], description: 'Optional filter.' },
      count: { type: 'integer', minimum: 1, maximum: 100, description: 'Optional, default 20.' } }, []),
    run: async (c, a) => c.call('GET', '/campaigns', { query: { count: a.count || 20, status: a.status, sort_field: 'create_time', sort_dir: 'DESC',
      fields: 'campaigns.id,campaigns.status,campaigns.send_time,campaigns.create_time,campaigns.emails_sent,campaigns.recipients.list_id,campaigns.recipients.list_name,campaigns.settings.title,campaigns.settings.subject_line,total_items' } }),
  },
  {
    name: 'create_draft_campaign',
    description: 'Create a DRAFT email campaign for an audience (optionally a saved segment), with its subject and content. Nothing is sent: the owner reviews it and presses Send in Mailchimp. From name and reply-to default to the audience\'s own settings.',
    inputSchema: req({
      audience_id: AUDIENCE, subject: str('The subject line.'),
      html: str('The email body as HTML. Give this or plain_text.'), plain_text: str('The email body as plain text.'),
      preview_text: str('Optional: the preview line inboxes show.'), title: str('Optional: the internal name in Mailchimp.'),
      segment_id: { type: 'integer', description: 'Optional: send only to this saved segment.' },
      from_name: str('Optional.'), reply_to: str('Optional.'),
    }, ['audience_id', 'subject']),
    run: async (c, a) => {
      const list = await c.call('GET', `/lists/${encodeURIComponent(a.audience_id)}`, { query: { fields: 'campaign_defaults' } });
      const d = list.campaign_defaults || {};
      const recipients = { list_id: a.audience_id };
      if (a.segment_id) recipients.segment_opts = { saved_segment_id: a.segment_id };
      const camp = await c.call('POST', '/campaigns', { body: { type: 'regular', recipients, settings: {
        subject_line: a.subject, preview_text: a.preview_text, title: a.title || a.subject,
        from_name: a.from_name || d.from_name, reply_to: a.reply_to || d.from_email } } });
      if (a.html || a.plain_text) await c.call('PUT', `/campaigns/${camp.id}/content`, { body: a.html ? { html: a.html } : { plain_text: a.plain_text } });
      return { campaign_id: camp.id, status: camp.status, note: 'Saved as a draft. Nothing has been sent: review it under Campaigns in Mailchimp and send it from there.' };
    },
  },
  {
    name: 'update_draft_content',
    description: 'Replace the content of a campaign that is still a draft. Refuses a campaign that has been scheduled or sent.',
    inputSchema: req({ campaign_id: str('From list_campaigns or create_draft_campaign.'), html: str('New body as HTML.'), plain_text: str('New body as plain text.'),
      subject: str('Optional: a new subject line.') }, ['campaign_id']),
    run: async (c, a) => {
      const camp = await c.call('GET', `/campaigns/${encodeURIComponent(a.campaign_id)}`, { query: { fields: 'id,status' } });
      if (camp.status !== 'save') throw new Error(`That campaign is ${camp.status}, not a draft, so it is left exactly as it is.`);
      if (a.subject) await c.call('PATCH', `/campaigns/${encodeURIComponent(a.campaign_id)}`, { body: { settings: { subject_line: a.subject } } });
      if (a.html || a.plain_text) await c.call('PUT', `/campaigns/${encodeURIComponent(a.campaign_id)}/content`, { body: a.html ? { html: a.html } : { plain_text: a.plain_text } });
      return { campaign_id: camp.id, updated: true };
    },
  },
  {
    name: 'send_test_email',
    description: 'Send a TEST of a draft campaign to up to six addresses (the owner\'s own inboxes), so they can see it before sending for real. Mailchimp limits test sends per day (24 on the Free plan).',
    inputSchema: req({ campaign_id: str('The draft campaign.'), emails: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 } }, ['campaign_id', 'emails']),
    run: async (c, a) => {
      await c.call('POST', `/campaigns/${encodeURIComponent(a.campaign_id)}/actions/test`, { body: { test_emails: a.emails.slice(0, 6), send_type: 'html' } });
      return { sent_test_to: a.emails.slice(0, 6) };
    },
  },
  {
    name: 'campaign_report',
    description: 'How a sent campaign did: emails sent, opens, clicks, unsubscribes, bounces.',
    inputSchema: req({ campaign_id: str('A sent campaign.') }, ['campaign_id']),
    run: async (c, a) => c.call('GET', `/reports/${encodeURIComponent(a.campaign_id)}`, { query: {
      fields: 'id,campaign_title,subject_line,send_time,emails_sent,unsubscribed,bounces,opens.unique_opens,opens.open_rate,clicks.unique_clicks,clicks.click_rate,list_name' } }),
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
      return reply({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out });
    } catch (e) {
      // a Mailchimp refusal is an ANSWER the assistant should read and relay,
      // so it travels as a tool result marked isError, not a protocol error
      return reply({ content: [{ type: 'text', text: e.message }], isError: true });
    }
  }
  return fail(-32601, `method not found: ${String(msg.method).slice(0, 60)}`);
}

if (isMain(import.meta.url)) {
  const client = createClient({ key: process.env.MAILCHIMP_API_KEY, base: process.env.MAILCHIMP_API_BASE });
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
