#!/usr/bin/env node
// mcp-connect.mjs: connect a service to the BOX, not just to the member's chats.
//
// THE PROBLEM (2026-08-05). Connecting Gmail in the Claude Code app connects it to
// the member's CLAUDE ACCOUNT: those connectors reach interactive sessions only,
// and the token lives on Anthropic's servers (verified: nothing lands in the local
// OAuth store). Cadence jobs are headless, so a member could connect Gmail, watch
// it answer when asked, and have their morning job stay blind.
//
// THE FIX. Servers in <state>/.mcp.json ARE loaded by headless runs, and their
// OAuth tokens persist in the box's own CLAUDE_CONFIG_DIR/.credentials.json. So
// the box carries its own connections, and this file is their state machine.
//
// THE 2026-08-09 REWORK, after Sam's ruling ("Crads-AI should not restrict what
// users can connect to"):
//   - the FEATURED list is only servers whose sign-in can actually complete with
//     zero secrets (dynamic client registration, verified per entry). The first
//     catalogue was three Google endpoints, and Google does not support DCR, so
//     every button dead-ended in an OAuth error a member could not read.
//   - anything else connects by URL (add-custom), with an optional API token for
//     services whose MCP wants a bearer header instead of OAuth. The catalogue is
//     a convenience, never a boundary.
//   - Google appears, honestly, as NOT connectable this way yet (the aggregator
//     route is chosen but not yet certified), instead of pretending.
//
//   node mcp-connect.mjs <state-dir> status
//   node mcp-connect.mjs <state-dir> add <key>          (featured key)
//   node mcp-connect.mjs <state-dir> add-custom         (stdin: {name,url,token_b64?})
//   node mcp-connect.mjs <state-dir> remove <key>       (featured or app-added)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { connectionLabel } from '../lib/connection-labels.mjs';

const stateDir = path.resolve(process.argv[2] || '/state');
const cmd = process.argv[3] || 'status';
const key = String(process.argv[4] || '');

// WHAT THIS BOX CAN DO, as a number the page can compare against.
//
// The app updates on its own schedule and the box updates on the member's, so
// the two halves of this feature are ALWAYS able to skew. The existing guard
// (`[ -f mcp-connect.mjs ]` in the panel verb) only catches a box so old the
// file is absent. A box with an OLDER copy passes that test and then fails in
// whatever way the missing field happens to cause.
//
// That is not hypothetical. On 2026-08-09, keith ran a box from before rows
// carried `url`. The page filled its address map from those rows, found
// nothing, and posted a blank url, so every Sign in press answered "bad server
// url": a raw error for what is really "your box is behind", which the page
// already knows how to say kindly.
//
// So: bump this whenever the SHAPE the page relies on changes, and teach the
// page the minimum it needs. Absent means 0, which is any box older than this.
//   1 = rows carry `url` (the address the page starts a sign-in with)
//   2 = the google row is BYO (byo:'google' + the add-google verb exist).
//       The page gates ONLY its Google wizard on 2 — everything else keeps
//       working against a 1-box, which sees Google as before. (rekey_due_at
//       shipped with early 2-boxes and is gone since the 2026-08-24
//       Production reshape; the page renders it only when present.)
const CONTRACT = 2;

const MCP_F = path.join(stateDir, '.mcp.json');
const OAUTH_F = path.join(stateDir, '.kernel', 'mcp-oauth.json');   // read-only here; mcp-token.mjs is the writer
const ALLOW_F = path.join(stateDir, '.kernel', 'mcp-allow');
const ADDED_F = path.join(stateDir, '.kernel', 'mcp-added.json');   // keys THIS tool added, so remove stays scoped to them
const CREDS_F = path.join(stateDir, '.claude-auth', '.credentials.json');
const CLAUDE_JSON = path.join(stateDir, '.claude-auth', '.claude.json');

// FEATURED, every entry's sign-in verified to complete with no secrets:
// notion/linear/sentry advertise a registration_endpoint (checked 2026-08-09);
// canva/vercel/apify completed real DCR sign-ins on the operator's own machine.
// Names come from connectionLabel() (engine/lib/connection-labels.mjs), the one
// label source shared with the Overview card's producer: two maps diverged once
// (2026-08-09 audit) and real boxes rendered raw lowercase keys.
const FEATURED = {
  notion: { url: 'https://mcp.notion.com/mcp', type: 'http', blurb: 'read and update your pages and databases' },
  linear: { url: 'https://mcp.linear.app/sse', type: 'sse', blurb: 'see and file issues' },
  sentry: { url: 'https://mcp.sentry.dev/mcp', type: 'http', blurb: 'read errors from your apps' },
  canva: { url: 'https://mcp.canva.com/mcp', type: 'http', blurb: 'work with your designs' },
  vercel: { url: 'https://mcp.vercel.com', type: 'http', blurb: 'see your deployments' },
  apify: { url: 'https://mcp.apify.com', type: 'http', blurb: 'run scrapers and read results' },
};

// Google, connectable at last (2026-08-17, Sam's ruling; design:
// docs/design-google-byo-connect.md). Google refuses dynamic registration, so
// the zero-secret flow can never work — instead the MEMBER'S OWN OAuth client
// is walked into existence by the app's wizard, the app runs the sign-in with
// it, and mcp-token.mjs set-google seeds the workspace-mcp credential file.
// One row, key 'google', replaces the three old "not yet" cards.
// Its truth source (reworked 2026-08-24): the wizard now publishes the
// member's app (External + In Production), so the key has NO scheduled death
// and no clock can honestly flip this row. google-rekey-ping.mjs live-probes
// the refresh token and writes a dead marker on a definitive invalid_grant;
// the row reads that marker. rekey_due_at is no longer emitted (older boxes
// still send it; the page renders it only when present).
const GOOGLE_DEAD_F = path.join(stateDir, '.kernel', 'google-key-dead.json');
const GWS_BIN = '/opt/gws/bin/workspace-mcp';   // baked into the image (Dockerfile.base)
const GOOGLE_TOOLS = ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'tasks', 'contacts'];
const TOKEN_TOOL = path.join(import.meta.dirname, 'mcp-token.mjs');

// The FIRST catalogue's dead ends: three Google endpoints whose sign-in could
// never complete. A box that still carries one (keith does) is recognised and
// told to clear it; nothing advertises these keys any more.
const UNAVAILABLE = {
  gmail: { blurb: 'read and triage your email' },
  calendar: { blurb: 'see and manage your schedule' },
  drive: { blurb: 'read your documents' },
};
const DEAD_URL = /googleapis\.com/;

const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(0); };
const rdJSON = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const servers = () => rdJSON(MCP_F, {}).mcpServers || {};
const appAdded = () => new Set(rdJSON(ADDED_F, []));
// Servers connected in Claude Code itself (local scope = projects[dir], user
// scope = top level of the config store). VERIFIED 2026-08-09: a default
// `claude mcp add` lands in LOCAL scope, which headless runs do not load at all
// so these work in the member's chats and are invisible to their jobs, and
// the page must say that rather than hide them.
const scopeServers = () => {
  const doc = rdJSON(CLAUDE_JSON, {});
  return { ...(doc.mcpServers || {}), ...(doc.projects?.[stateDir]?.mcpServers || {}) };
};
const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

// Only whether a token exists, when it expires, and whether it renews itself.
// Values never leave this file.
function tokenFor(name) {
  const store = rdJSON(CREDS_F, {}).mcpOAuth || {};
  for (const v of Object.values(store)) {
    if (v && v.serverName === name && v.accessToken) {
      return { expiresAt: v.expiresAt || null, canRefresh: !!v.refreshToken };
    }
  }
  return null;
}

// R8: drop this server's entries from the Claude Code credential store, and
// ONLY those. The same file holds the box's Claude sign-in (claudeAiOauth),
// which a disconnect must never touch. Unparseable or absent: leave it be.
function forgetCliToken(name) {
  let doc;
  try { doc = JSON.parse(readFileSync(CREDS_F, 'utf8')); } catch { return; }
  if (!doc || typeof doc !== 'object' || !doc.mcpOAuth || typeof doc.mcpOAuth !== 'object') return;
  const gone = Object.keys(doc.mcpOAuth).filter((k) => doc.mcpOAuth[k]?.serverName === name || k.split('|')[0] === name);
  if (!gone.length) return;
  for (const k of gone) delete doc.mcpOAuth[k];
  writeFileSync(CREDS_F, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
}

// A server whose definition carries its own credential (an Authorization header)
// is TOKEN-auth: no OAuth dance, credentialed from the moment it is written.
const hasTokenHeader = (def) => !!(def?.headers && Object.keys(def.headers).some((h) => /^authorization$/i.test(h)));

function describe(k, def, { label, blurb, mine, catalogUrl }) {
  const now = Date.now();
  // the page needs the ADDRESS to start a sign-in for a service we do not carry
  // in the catalogue; it is not a secret, it is what the member typed.
  // For a FEATURED service the catalogue is the fallback, and it is load-bearing:
  // the row's url is the ONLY thing the page can start a sign-in with (its own
  // fallback map is filled from these rows, so an empty one stays empty), and a
  // box entry written by an older version, or by hand, can carry no url at all.
  // Without this the Sign in button posts a blank url and the member is told
  // "bad server url" forever, which is what a live box did on 2026-08-09.
  let url = String(def?.url || catalogUrl || '');
  // Normalise so the directory's hide-connected match compares like-for-like: it
  // keys off registry urls it has already run through new URL().href, so a box
  // entry spelled bare-origin (or odd-cased host) must resolve to the same string
  // as the same endpoint spelled with a trailing slash. Without this a server the
  // box already carries reads as un-connected and gets a duplicate Connect card.
  try { if (url) url = new URL(url).href; } catch { /* not a url: report as typed */ }
  if (hasTokenHeader(def)) {
    return { key: k, label, blurb, url, auth: 'token', state: 'on', status: 'working, including in scheduled jobs',
      configured: true, authorised: true, renews: true, mine };
  }
  const tok = tokenFor(k);
  const expired = !!(tok?.expiresAt && tok.expiresAt < now);
  const authed = !!tok && !expired;
  return {
    key: k, label, blurb, url, auth: 'oauth',
    state: authed ? 'on' : 'needs-auth',
    status: authed ? 'working, including in scheduled jobs'
      : expired ? 'sign-in expired, needs you once more' : 'added, waiting for you to sign in once',
    configured: true, authorised: authed,
    expiresAt: tok?.expiresAt || null,
    renews: tok ? tok.canRefresh : null, mine,
  };
}

// The one BYO row. Its states are the ordinary vocabulary the page already
// renders — only `byo: 'google'` (route presses to the wizard, not plain add)
// is special, which is what CONTRACT 2 announces. A signed-in key counts as
// working until the live probe proves otherwise (the dead marker); there is
// no clock here any more, because a published key has no scheduled death.
function googleRow(srv) {
  const base = { key: 'google', label: connectionLabel('google'),
    blurb: 'gmail, calendar, drive and docs, with your own key', auth: 'byo', byo: 'google', mine: true };
  if (!srv.google) {
    return { ...base, state: 'off', status: 'not connected', configured: false, authorised: false, renews: null };
  }
  const g = rdJSON(OAUTH_F, {}).google;
  const keyed = g?.provider === 'google-byo' ? (g.keyed_at || 0) : 0;
  if (!keyed) {
    return { ...base, state: 'needs-auth', status: 'added, waiting for you to sign in once',
      configured: true, authorised: false, renews: null, email: srv.google.env?.USER_GOOGLE_EMAIL || null };
  }
  const dead = rdJSON(GOOGLE_DEAD_F, null);
  if (dead && dead.keyed_at === keyed) {
    return { ...base, state: 'needs-auth', status: 'sign-in expired, needs you once more',
      configured: true, authorised: false, renews: false, email: g.email };
  }
  return { ...base, state: 'on', status: 'working, including in scheduled jobs',
    configured: true, authorised: true, renews: true, email: g.email };
}

function rows() {
  const srv = servers();
  const mine = appAdded();
  const list = [];

  for (const [k, def] of Object.entries(FEATURED)) {
    if (srv[k]) list.push(describe(k, srv[k], { label: connectionLabel(k), blurb: def.blurb, mine: true, catalogUrl: def.url }));
    else list.push({ key: k, label: connectionLabel(k), blurb: def.blurb, url: def.url, auth: 'oauth', state: 'off', status: 'not connected', configured: false, authorised: false, renews: null, mine: true });
  }

  for (const [k, def] of Object.entries(UNAVAILABLE)) {
    if (srv[k] && DEAD_URL.test(String(srv[k].url || ''))) {
      // the first catalogue's dead end, still on the box: say so, and let them clear it
      list.push({ key: k, label: connectionLabel(k), blurb: def.blurb, auth: 'oauth', state: 'dead-end',
        status: 'sign-in can never finish on this endpoint, disconnect it', configured: true, authorised: false, renews: null, mine: true });
    }
    // absent: nothing to advertise — the single google row below is the offer.
    // srv[k] pointing somewhere non-Google (their own server): fall through,
    // the extras loop below reports it like any other server.
  }

  list.push(googleRow(srv));

  const known = new Set([...Object.keys(FEATURED), 'google', ...list.map((r) => r.key)]);
  for (const k of Object.keys(srv)) {
    if (known.has(k)) continue;
    known.add(k);
    list.push(describe(k, srv[k], {
      label: connectionLabel(k),
      blurb: mine.has(k) ? 'connected by you' : 'added by you in Claude Code',
      mine: mine.has(k),
    }));
  }

  // CHATS-ONLY: connected inside Claude Code (local/user scope). Sam's ask
  // 2026-08-09: these must appear here, not vanish. They are reported honestly
  // (jobs cannot see them) and carry one adopt action that moves the definition
  // to project scope, where jobs do. The sign-in survives adoption: the OAuth
  // store is keyed by server name + URL, which the move preserves.
  for (const [k, def] of Object.entries(scopeServers())) {
    if (known.has(k) || !NAME_RE.test(k)) continue;
    const token = hasTokenHeader(def);
    const tok = token ? null : tokenFor(k);
    list.push({
      key: k, label: connectionLabel(k), blurb: 'connected in Claude Code', auth: token ? 'token' : 'oauth',
      state: 'chat-only', adoptable: true, mine: false, configured: true,
      authorised: token || !!(tok && !(tok.expiresAt && tok.expiresAt < Date.now())),
      renews: token ? true : (tok ? tok.canRefresh : null),
      status: 'in your chats only, not in scheduled jobs',
    });
  }

  // ACCOUNT CONNECTORS (2026-08-09 audit, R8): connectors added in the app's
  // claude.ai settings live on Anthropic's servers, reach chats only, and can
  // NEVER be adopted — the box holds nothing to move. Sam's ruling: show them
  // honestly rather than leave them invisible. Names come from the cockpit's
  // cached `claude mcp list` probe (cockpit/connectors.json); this tool never
  // probes. A name that matches a catalogue row still waiting to be connected
  // annotates THAT row instead of duplicating it; a name the box already
  // serves for jobs is covered and skipped.
  try {
    const cc = rdJSON(path.join(stateDir, 'cockpit', 'connectors.json'), null);
    const fresh = cc && Array.isArray(cc.names) && (Date.now() - (cc.at || 0)) < 24 * 3600e3;
    for (const raw of fresh ? cc.names : []) {
      const label = String(raw).replace(/^claude\.ai\s+/i, '').trim();
      if (!label) continue;
      // The Google-family connectors (claude.ai "Gmail" / "Google Drive" /
      // "Google Calendar") all map to the ONE google row here, whose label
      // ("Google Workspace") equals none of them: annotate that row instead of
      // spawning stray account rows beside the real offer.
      if (/^(gmail|google\s+(drive|calendar|docs|workspace))$/i.test(label)) {
        const g = list.find((r) => r.key === 'google');
        if (g) {
          if (!g.configured && g.state === 'off') {
            g.status = 'in your chats via your Claude account, not in scheduled jobs. Connect it here for jobs';
          }
          continue;   // configured google covers it; either way, no extra row
        }
      }
      const match = list.find((r) => String(r.label).toLowerCase() === label.toLowerCase());
      if (match) {
        if (!match.configured && match.state === 'off') {
          match.status = 'in your chats via your Claude account, not in scheduled jobs. Connect it here for jobs';
        }
        continue;
      }
      list.push({
        key: 'account-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
        label, blurb: 'connected to your Claude account in the app', auth: 'oauth',
        state: 'account', adoptable: false, mine: false, configured: false, authorised: true, renews: null,
        status: 'in your chats only. Account connectors can never run in scheduled jobs; connect it to your box to schedule it',
      });
    }
  } catch { /* no cache, nothing to claim */ }
  return list;
}

const writeMcp = (doc) => writeFileSync(MCP_F, JSON.stringify(doc, null, 2) + '\n');
// THE APPROVAL GATE (found live 2026-08-09, keith): Claude Code refuses to use a
// .mcp.json server until it is approved once per project, and `mcp login` answers
// '"<name>" is from .mcp.json and awaiting approval. Run `claude` ... to review'.
// Interactively that is a trust dialog; on a box the servers are written by THIS
// tool at the member's explicit click, so that click IS the review, and the tool
// records the approval where the CLI reads it (verified: enabledMcpjsonServers
// in the config store's .claude.json flips 'Pending approval' to connectable).
// Hand-added servers are deliberately NOT healed here: the member approved those
// in the dialog when they added them, or should.
function ensureApproved(names) {
  if (!names.length) return;
  const doc = rdJSON(CLAUDE_JSON, {});
  doc.projects = doc.projects || {};
  const proj = doc.projects[stateDir] = doc.projects[stateDir] || {};
  const cur = new Set(Array.isArray(proj.enabledMcpjsonServers) ? proj.enabledMcpjsonServers : []);
  const before = cur.size;
  for (const n of names) cur.add(n);
  const trusted = proj.hasTrustDialogAccepted === true;
  if (cur.size === before && trusted) return;   // nothing to record
  proj.enabledMcpjsonServers = [...cur];
  proj.hasTrustDialogAccepted = true;
  writeFileSync(CLAUDE_JSON, JSON.stringify(doc, null, 2) + '\n');
}
const rememberAdded = (k, on) => {
  const s = appAdded(); on ? s.add(k) : s.delete(k);
  mkdirSync(path.dirname(ADDED_F), { recursive: true });
  writeFileSync(ADDED_F, JSON.stringify([...s]));
};
// Belt-and-braces with the kernel's derived allowlist (lib/mcp-allow.mjs): the
// derivation makes this file optional, but older images still read only the file,
// so keep writing it until no fleet box predates the derivation.
const syncAllow = (k, on) => {
  const pattern = `mcp__${k}__*`;
  let cur = [];
  try { cur = readFileSync(ALLOW_F, 'utf8').split(',').map((s) => s.trim()).filter(Boolean); } catch { /* none yet */ }
  const next = cur.filter((p) => p !== pattern);
  if (on) next.push(pattern);
  mkdirSync(path.dirname(ALLOW_F), { recursive: true });
  writeFileSync(ALLOW_F, next.join(','));
};

if (cmd === 'status') {
  // Heal on every read: a box provisioned before this fix (keith) has app-added
  // servers sitting behind the approval gate with no dialog anywhere to accept.
  ensureApproved(Object.keys(servers()).filter((k) => FEATURED[k] || UNAVAILABLE[k] || appAdded().has(k)));
  out({ ok: true, contract: CONTRACT, services: rows() });
}

if (cmd === 'add') {
  if (key === 'google') out({ ok: false, error: 'Google connects through its own set-up flow (add-google), not a plain add' });
  const def = FEATURED[key];
  if (!def) out({ ok: false, error: UNAVAILABLE[key] ? `${connectionLabel(key)} cannot be connected this way yet` : `unknown service: ${key}` });
  const doc = rdJSON(MCP_F, {});
  doc.mcpServers = doc.mcpServers || {};
  doc.mcpServers[key] = { type: def.type, url: def.url };
  writeMcp(doc); syncAllow(key, true); rememberAdded(key, true); ensureApproved([key]);
  out({ ok: true, contract: CONTRACT, key, action: 'add', services: rows() });
}

if (cmd === 'add-custom') {
  // stdin, base64(JSON): the URL is member input and the token is a secret, so
  // neither belongs in argv (readable via ps by anything on the box). The script
  // does its OWN decoding: the verb must NOT pipe through `base64 -d` first.
  // That double decode was a live bug found 2026-08-09: telegram-verify's verb
  // pre-decoded what the script then decoded again, mangling every real token.
  let req = {};
  try { req = JSON.parse(Buffer.from(readFileSync(0, 'utf8').trim(), 'base64').toString('utf8')); }
  catch { out({ ok: false, error: 'expected base64 JSON on stdin' }); }
  const name = String(req.name || '').toLowerCase();
  if (!NAME_RE.test(name)) out({ ok: false, error: 'name must be 2-32 chars: lowercase letters, digits, - or _' });
  if (FEATURED[name] || UNAVAILABLE[name] || name === 'google') out({ ok: false, error: `"${name}" is a featured service, connect it from its own row` });
  let url;
  try { url = new URL(String(req.url || '')); } catch { out({ ok: false, error: 'that does not look like a URL' }); }
  if (url.protocol !== 'https:') out({ ok: false, error: 'only https servers can be connected' });
  const def = { type: /\/sse$/.test(url.pathname) ? 'sse' : 'http', url: url.href };
  if (req.token_b64) {
    let token = '';
    try { token = Buffer.from(String(req.token_b64), 'base64').toString('utf8').trim(); } catch { /* refused below */ }
    if (!token || /[\r\n]/.test(token) || token.length > 4096) out({ ok: false, error: 'that token does not look right' });
    def.headers = { Authorization: `Bearer ${token}` };
  }
  const doc = rdJSON(MCP_F, {});
  doc.mcpServers = doc.mcpServers || {};
  if (doc.mcpServers[name] && !appAdded().has(name)) out({ ok: false, error: `"${name}" already exists on this box (added in Claude Code), pick another name` });
  // Dedup by ENDPOINT, not just by name. A server can already be wired under a
  // DIFFERENT name: connected in Claude Code (chats-only scope), or added earlier
  // spelled differently. The directory hides a connected card by matching the
  // normalised registry url against the box's rows, so a box entry spelled
  // bare-origin vs trailing-slash slips through, the card reappears, and a second
  // press writes a duplicate pointing at the SAME remote under an mcpSlug-derived
  // name. Refuse that: one endpoint, one entry. (2026-08-09, parked from review.)
  const sameEndpoint = (u) => { try { return new URL(u).href === url.href; } catch { return false; } };
  const dupe = Object.entries({ ...scopeServers(), ...doc.mcpServers })
    .find(([k, d0]) => k !== name && d0?.url && sameEndpoint(d0.url));
  if (dupe) out({ ok: false, error: `already connected as "${dupe[0]}" on this box` });
  doc.mcpServers[name] = def;
  writeMcp(doc); syncAllow(name, true); rememberAdded(name, true); ensureApproved([name]);
  out({ ok: true, contract: CONTRACT, key: name, action: 'add', auth: def.headers ? 'token' : 'oauth', services: rows() });
}

if (cmd === 'add-google') {
  // stdin, base64(JSON): { email }. Only the server DEFINITION lands here —
  // the credential material takes the mcp-token.mjs set-google path, so this
  // file never touches a secret. Order in the wizard: add-google, sign in,
  // set-google, probe.
  let req = {};
  try { req = JSON.parse(Buffer.from(readFileSync(0, 'utf8').trim(), 'base64').toString('utf8')); }
  catch { out({ ok: false, error: 'expected base64 JSON on stdin' }); }
  const email = String(req.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) out({ ok: false, error: 'that does not look like an email address' });
  const doc = rdJSON(MCP_F, {});
  doc.mcpServers = doc.mcpServers || {};
  const prev = doc.mcpServers.google;
  if (prev && !appAdded().has('google') && prev.command !== GWS_BIN) {
    out({ ok: false, error: 'a hand-added "google" server already exists on this box; remove it in Claude Code first' });
  }
  doc.mcpServers.google = {
    type: 'stdio',
    command: GWS_BIN,
    args: ['--single-user', '--tools', ...GOOGLE_TOOLS],
    env: {
      MCP_SINGLE_USER_MODE: '1',
      USER_GOOGLE_EMAIL: email,
      WORKSPACE_MCP_CREDENTIALS_DIR: path.join(stateDir, '.kernel', 'google-creds'),
      WORKSPACE_MCP_LOG_DIR: path.join(stateDir, '.kernel', 'google-creds', 'logs'),
    },
  };
  writeMcp(doc); syncAllow('google', true); rememberAdded('google', true); ensureApproved(['google']);
  out({ ok: true, contract: CONTRACT, key: 'google', action: 'add-google', services: rows() });
}

if (cmd === 'remove') {
  const removable = FEATURED[key] || UNAVAILABLE[key] || appAdded().has(key);
  // A server the member created in Claude Code by hand is theirs: report it,
  // never offer to delete it.
  if (!removable) out({ ok: false, error: `"${key}" was not added here, so it is not removed here` });
  const doc = rdJSON(MCP_F, {});
  doc.mcpServers = doc.mcpServers || {};
  // Deleting the entry takes its bearer header (if any) with it: the header
  // lives inside the entry, nowhere else.
  delete doc.mcpServers[key];
  writeMcp(doc); syncAllow(key, false); rememberAdded(key, false);
  // R8 (2026-08-23): Disconnect has ONE meaning, for every connector: the
  // credential is destroyed on this box. That is the .mcp.json entry above, the
  // .kernel/mcp-oauth.json refresh entry (and the Google key file it points at),
  // and the Claude Code token for this server. Until R8 only google did this;
  // every other remove kept the grant so a re-add would look instantly
  // authorised, which read as "broken then fixed" and left a live credential
  // on a box whose member believed it gone. mcp-token.mjs stays the single
  // owner of the oauth store, so hand off. The grant at the PROVIDER is not
  // ours to touch: the member revokes that in the provider's own settings, and
  // the OK line says so.
  try { execFileSync('node', [TOKEN_TOOL, stateDir, 'forget', key], { stdio: 'ignore' }); } catch { /* nothing keyed yet */ }
  forgetCliToken(key);
  out({ ok: true, contract: CONTRACT, key, action: 'remove',
    notice: `${connectionLabel(key)} is disconnected and its credential is gone from this box. The permission you granted at ${connectionLabel(key)} is yours to revoke there.`,
    services: rows() });
}

if (cmd === 'adopt') {
  // Move a chats-only Claude Code connection into project scope, where
  // scheduled jobs load it. The source entry is REMOVED, not copied: local
  // scope shadows project scope interactively, so a leftover copy would let
  // the two definitions drift while looking like one connection.
  if (!NAME_RE.test(key)) out({ ok: false, error: 'bad service name' });
  const def = scopeServers()[key];
  if (!def) out({ ok: false, error: `"${key}" is not a Claude Code connection on this box` });
  const doc = rdJSON(MCP_F, {});
  doc.mcpServers = doc.mcpServers || {};
  if (doc.mcpServers[key]) out({ ok: false, error: `"${key}" is already set up for jobs` });
  doc.mcpServers[key] = def;
  writeMcp(doc); syncAllow(key, true); rememberAdded(key, true);
  const cj = rdJSON(CLAUDE_JSON, {});
  if (cj.projects?.[stateDir]?.mcpServers) delete cj.projects[stateDir].mcpServers[key];
  if (cj.mcpServers) delete cj.mcpServers[key];
  writeFileSync(CLAUDE_JSON, JSON.stringify(cj, null, 2) + '\n');
  ensureApproved([key]);   // after the store write above, so the merge sees it
  out({ ok: true, contract: CONTRACT, key, action: 'adopt', services: rows() });
}

out({ ok: false, error: `unknown command: ${cmd}` });
