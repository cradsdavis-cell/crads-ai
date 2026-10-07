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
//   node mcp-connect.mjs <state-dir> add-custom         (stdin: {name,url,token_b64?,scheme?})
//   node mcp-connect.mjs <state-dir> add-mailchimp      (stdin: {key_b64})
//   node mcp-connect.mjs <state-dir> check <key>        (does the saved server answer?)
//   node mcp-connect.mjs <state-dir> remove <key>       (featured or app-added)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { connectionLabel } from '../lib/connection-labels.mjs';
import { GOOGLE_KEY_RE, PRIMARY_GOOGLE_KEY, GOOGLE_CREDS_DIR, googleStateFiles } from '../lib/google-byo.mjs';
import { headersHelperCmd, HELPER_RE } from '../lib/mcp-header-helper.mjs';

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
//   3 = several Google accounts per box (2026-09-14): rows may carry MORE
//       than one byo:'google' entry (keys google, google-<slug>), each with
//       its own `email`, and add-google / set-google take a `key`. The page
//       gates ONLY its "Add another Google account" button on 3; a 2-box
//       still renders its single google row exactly as before.
//   4 = the guided connectors (2026-10-02): add-custom takes scheme:'basic'
//       (a WordPress application password is HTTP Basic, not Bearer), and the
//       `check <key>` verb asks a saved server for its tool list FROM THE BOX,
//       which is where jobs will call it. The page gates its Slack and
//       WordPress wizards on 4; a 3-box is told to update.
//   5 = Mailchimp on the box (2026-10-02): the add-mailchimp verb writes a
//       stdio server (engine/comms/mailchimp-mcp.mjs) carrying the member's
//       own API key; `check` speaks stdio too and, for Mailchimp, makes one
//       real read so a bad key is caught; the row carries key_expires_by
//       (keys made since 22 June 2026 die a year after creation).
//   6 = own header + another account (2026-10-06, a pebble's WooCommerce shop
//       and second Slack workspace): add-custom takes `header` (the token is
//       sent raw in that header, e.g. WooCommerce's X-MCP-API-Key, for
//       servers that refuse it in Authorization) and `another: true` (a
//       further TOKEN connection to an address already connected, under its
//       own name, because each token is a different account). The page gates
//       its header field and its "Add another Slack workspace" on 6.
const CONTRACT = 6;

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
// SEVERAL ACCOUNTS (2026-09-14, Sam's ruling): a member may connect more
// than one Google account, each as its OWN row and its own workspace-mcp
// server (key `google` for the first, `google-<slug>` for every further
// one; shape in engine/lib/google-byo.mjs). Each has its own key file, its
// own dead marker and its own probe ledger; nothing is shared between them
// but the credentials directory, where files are named by email.
const GWS_BIN = '/opt/gws/bin/workspace-mcp';   // baked into the image (Dockerfile.base)
const GOOGLE_TOOLS = ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'tasks', 'contacts'];
const TOKEN_TOOL = path.join(import.meta.dirname, 'mcp-token.mjs');
// Mailchimp (contract 5): our own zero-dependency server, shipped in the image
// beside this file, run by Claude Code with the member's key in its env.
const MAILCHIMP_SERVER = path.join(import.meta.dirname, 'mailchimp-mcp.mjs');
const MAILCHIMP_KEY_RE = /^[0-9a-f]{32}-[a-z]{2}\d{1,3}$/;
const isMailchimp = (def) => !!(def?.command && Array.isArray(def.args) && def.args.some((a) => /mailchimp-mcp\.mjs$/.test(String(a))) && def.env?.MAILCHIMP_API_KEY);

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

// A server whose definition carries its own credential (a header) is
// TOKEN-auth: no OAuth dance, credentialed from the moment it is written.
// Any header counts since contract 6: a service may want its key somewhere
// other than Authorization (WooCommerce's X-MCP-API-Key), and a header on a
// remote MCP definition exists to carry a credential.
const hasTokenHeader = (def) => !!(def?.headers && Object.keys(def.headers).length);
// Header names add-custom may write: an HTTP token, and none the MCP
// transport itself owns (a member key in Content-Type or Mcp-Session-Id
// would break every call, not sign one in).
const HEADER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const RESERVED_HEADERS = new Set(['accept', 'content-type', 'content-length', 'host', 'connection',
  'transfer-encoding', 'mcp-session-id', 'mcp-protocol-version', 'cookie', 'user-agent']);

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
  // the on-box Mailchimp server carries its key in env, not a header: it is a
  // token connection all the same. Its expiry is a "by about": a key made
  // before 22 June 2026 never expires, and the box cannot tell which it holds.
  if (isMailchimp(def)) {
    const added = Date.parse(def.env.CRADS_KEY_ADDED || '');
    const by = Number.isFinite(added) ? new Date(added + 365 * 864e5).toISOString().slice(0, 10) : null;
    return { key: k, label, blurb: 'audiences, contacts, draft campaigns and reports, with your own key', url: '', auth: 'token', state: 'on',
      status: 'working, including in scheduled jobs', configured: true, authorised: true, renews: false, mine, key_expires_by: by };
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

// One BYO row per Google account. Its states are the ordinary vocabulary the
// page already renders — only `byo: 'google'` (route presses to the wizard,
// not plain add) is special, which is what CONTRACT 2 announced; CONTRACT 3
// says there may be several. A signed-in key counts as working until the
// live probe proves otherwise (the account's own dead marker); there is no
// clock here any more, because a published key has no scheduled death.
function googleRow(key, def) {
  const base = { key, label: connectionLabel(key),
    blurb: 'gmail, calendar, drive and docs, with your own key', auth: 'byo', byo: 'google', mine: true };
  if (!def) {
    return { ...base, state: 'off', status: 'not connected', configured: false, authorised: false, renews: null };
  }
  const g = rdJSON(OAUTH_F, {})[key];
  const keyed = g?.provider === 'google-byo' ? (g.keyed_at || 0) : 0;
  if (!keyed) {
    return { ...base, state: 'needs-auth', status: 'added, waiting for you to sign in once',
      configured: true, authorised: false, renews: null, email: def.env?.USER_GOOGLE_EMAIL || null };
  }
  const dead = rdJSON(googleStateFiles(stateDir, key).dead, null);
  if (dead && dead.keyed_at === keyed) {
    return { ...base, state: 'needs-auth', status: 'sign-in expired, needs you once more',
      configured: true, authorised: false, renews: false, email: g.email };
  }
  return { ...base, state: 'on', status: 'working, including in scheduled jobs',
    configured: true, authorised: true, renews: true, email: g.email };
}

// The Google rows in order: the primary offer (always present, off when
// absent), then every further account this tool added, or that points at the
// baked workspace-mcp binary (a box restored from backup has the servers but
// may have lost mcp-added.json).
function googleRows(srv) {
  const mine = appAdded();
  const extra = Object.keys(srv)
    .filter((k) => k !== PRIMARY_GOOGLE_KEY && GOOGLE_KEY_RE.test(k) && (mine.has(k) || srv[k]?.command === GWS_BIN))
    .sort();
  return [googleRow(PRIMARY_GOOGLE_KEY, srv[PRIMARY_GOOGLE_KEY]), ...extra.map((k) => googleRow(k, srv[k]))];
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

  list.push(...googleRows(srv));

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

// Heal a lowercase scheme already on disk (2 Oct 2026): before mcp-token.mjs
// canonicalised it, a renewal could write "bearer <token>", which Zoom, Asana
// and Klaviyo refuse. Only OUR Authorization header on servers this tool added
// is touched, and only its first word; the token itself is never read out.
function healBearerCase() {
  const doc = rdJSON(MCP_F, null);
  if (!doc?.mcpServers) return;
  const mine = appAdded();
  let changed = false;
  for (const [k, d0] of Object.entries(doc.mcpServers)) {
    if (!(mine.has(k) || FEATURED[k]) || !d0?.headers) continue;
    for (const h of Object.keys(d0.headers)) {
      if (!/^authorization$/i.test(h)) continue;
      const v = String(d0.headers[h]);
      const m = v.match(/^(bearer|user)\s+(.+)$/i);
      if (m && !v.startsWith('Bearer ')) { d0.headers[h] = `Bearer ${m[2]}`; changed = true; }
    }
  }
  if (changed) writeMcp(doc);
}

// Give every renewing sign-in this tool made the headersHelper (2026-10-07):
// connections signed in before mcp-token.mjs wrote it would otherwise only get
// it at their next renewal. Scope: servers this tool added, with refresh
// material in the store and our Authorization header. A helper the member set
// is theirs; ours is rewritten if the engine ever moves.
function healHeadersHelper() {
  const doc = rdJSON(MCP_F, null);
  if (!doc?.mcpServers) return;
  const store = rdJSON(OAUTH_F, {});
  const mine = appAdded();
  const want = headersHelperCmd(stateDir);
  let changed = false;
  for (const [k, d0] of Object.entries(doc.mcpServers)) {
    if (!(mine.has(k) || FEATURED[k]) || !d0?.headers?.Authorization) continue;
    const s = store[k];
    if (!s || s.provider === 'google-byo' || !s.refresh_token) continue;
    if (d0.headersHelper && !HELPER_RE.test(d0.headersHelper)) continue;
    if (d0.headersHelper === want) continue;
    d0.headersHelper = want; changed = true;
  }
  if (changed) writeMcp(doc);
}

if (cmd === 'status') {
  // Heal on every read: a box provisioned before this fix (keith) has app-added
  // servers sitting behind the approval gate with no dialog anywhere to accept.
  ensureApproved(Object.keys(servers()).filter((k) => FEATURED[k] || UNAVAILABLE[k] || appAdded().has(k)));
  healBearerCase();
  healHeadersHelper();
  out({ ok: true, contract: CONTRACT, services: rows() });
}

if (cmd === 'add') {
  if (GOOGLE_KEY_RE.test(key)) out({ ok: false, error: 'Google connects through its own set-up flow (add-google), not a plain add' });
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
  if (FEATURED[name] || UNAVAILABLE[name] || GOOGLE_KEY_RE.test(name)) out({ ok: false, error: `"${name}" is a featured service, connect it from its own row` });
  let url;
  try { url = new URL(String(req.url || '')); } catch { out({ ok: false, error: 'that does not look like a URL' }); }
  if (url.protocol !== 'https:') out({ ok: false, error: 'only https servers can be connected' });
  const def = { type: /\/sse$/.test(url.pathname) ? 'sse' : 'http', url: url.href };
  if (req.header && !req.token_b64) out({ ok: false, error: 'a header name needs the key that goes in it' });
  if (req.token_b64) {
    let token = '';
    try { token = Buffer.from(String(req.token_b64), 'base64').toString('utf8').trim(); } catch { /* refused below */ }
    if (!token || /[\r\n]/.test(token) || token.length > 4096) out({ ok: false, error: 'that token does not look right' });
    const header = String(req.header || '').trim();
    // header (contract 6): the service names where its key goes. Authorization
    // keeps its schemes below; any other name carries the token exactly as
    // pasted, because that is what such a service checks (WooCommerce's
    // X-MCP-API-Key wants "consumer_key:consumer_secret", no prefix).
    if (header && !/^authorization$/i.test(header)) {
      if (!HEADER_RE.test(header)) out({ ok: false, error: 'a header name is letters, digits and dashes only, like X-API-Key' });
      if (RESERVED_HEADERS.has(header.toLowerCase())) out({ ok: false, error: `${header} is used by the connection itself, so a key cannot go there` });
      def.headers = { [header]: token };
    } else
    // scheme 'basic' (contract 4): the token is "username:password", the shape a
    // WordPress application password signs in with. Anything else stays Bearer,
    // which is what every API-token server before this one wanted.
    if (req.scheme === 'basic') {
      if (!/^[^:]+:.+$/.test(token)) out({ ok: false, error: 'a username and a password are both needed' });
      def.headers = { Authorization: `Basic ${Buffer.from(token, 'utf8').toString('base64')}` };
    } else if (req.scheme && req.scheme !== 'bearer') {
      out({ ok: false, error: `unknown sign-in scheme: ${String(req.scheme).slice(0, 20)}` });
    } else {
      def.headers = { Authorization: `Bearer ${token}` };
    }
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
  // `another` (contract 6): a further account at an address already connected,
  // e.g. a second Slack workspace (every workspace is mcp.slack.com). Allowed
  // only when THIS add carries its own token: a token is an account, so two
  // token rows at one address are two accounts, not a duplicate. An OAuth add
  // would share the one sign-in store entry per address, so it is still
  // refused, and a plain repeat press without `another` is refused as before.
  if (dupe && !(req.another === true && def.headers)) {
    out({ ok: false, error: req.another === true
      ? 'another account at the same address needs its own token'
      : `already connected as "${dupe[0]}" on this box` });
  }
  // A leftover sign-in under the same name must go (2 Oct 2026, found on a
  // pebble): Zapier was first added by OAuth at one address, then re-added
  // here with a token at a new one. The old record in .kernel/mcp-oauth.json
  // survived, mcp-refresh renewed it, and mcp-token.mjs set wrote the OLD
  // address and an OAuth header back over the working token connection.
  // Whatever is being saved now replaces that sign-in, so its refresh
  // material and Claude Code's copy are destroyed first, through the one
  // writer of the store. Every refusal above has already run, so a refused
  // add can never cost a working connection its sign-in.
  try { execFileSync('node', [TOKEN_TOOL, stateDir, 'forget', name], { stdio: 'ignore' }); } catch { /* nothing keyed */ }
  forgetCliToken(name);
  const fresh = rdJSON(MCP_F, {});   // forget may have rewritten the file
  fresh.mcpServers = fresh.mcpServers || {};
  fresh.mcpServers[name] = def;
  writeMcp(fresh); syncAllow(name, true); rememberAdded(name, true); ensureApproved([name]);
  out({ ok: true, contract: CONTRACT, key: name, action: 'add', auth: def.headers ? 'token' : 'oauth', services: rows() });
}

if (cmd === 'add-google') {
  // stdin, base64(JSON): { email, key? }. Only the server DEFINITION lands
  // here — the credential material takes the mcp-token.mjs set-google path,
  // so this file never touches a secret. Order in the wizard: add-google,
  // sign in, set-google, probe. `key` (default google) names the account row:
  // google-<slug> for a second, third... account, each its own server so the
  // assistant's tool names say which account they reach.
  let req = {};
  try { req = JSON.parse(Buffer.from(readFileSync(0, 'utf8').trim(), 'base64').toString('utf8')); }
  catch { out({ ok: false, error: 'expected base64 JSON on stdin' }); }
  const email = String(req.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) out({ ok: false, error: 'that does not look like an email address' });
  const gkey = String(req.key || PRIMARY_GOOGLE_KEY).trim().toLowerCase();
  if (!GOOGLE_KEY_RE.test(gkey)) out({ ok: false, error: 'that account name does not look right: up to 20 letters, digits or hyphens' });
  const doc = rdJSON(MCP_F, {});
  doc.mcpServers = doc.mcpServers || {};
  const prev = doc.mcpServers[gkey];
  if (prev && !appAdded().has(gkey) && prev.command !== GWS_BIN) {
    out({ ok: false, error: `a hand-added "${gkey}" server already exists on this box; remove it in Claude Code first` });
  }
  // one email, one row: the same account under two names would be two
  // servers over one credential file, and "disconnect" would lie for one
  const store = rdJSON(OAUTH_F, {});
  const twin = Object.entries(doc.mcpServers)
    .find(([k, d0]) => k !== gkey && GOOGLE_KEY_RE.test(k) && (d0?.env?.USER_GOOGLE_EMAIL === email || store[k]?.email === email));
  if (twin) out({ ok: false, error: `${email} is already connected as ${connectionLabel(twin[0])}; disconnect that row first` });
  doc.mcpServers[gkey] = {
    type: 'stdio',
    command: GWS_BIN,
    args: ['--single-user', '--tools', ...GOOGLE_TOOLS],
    env: {
      MCP_SINGLE_USER_MODE: '1',
      USER_GOOGLE_EMAIL: email,
      WORKSPACE_MCP_CREDENTIALS_DIR: GOOGLE_CREDS_DIR(stateDir),
      WORKSPACE_MCP_LOG_DIR: path.join(GOOGLE_CREDS_DIR(stateDir), 'logs'),
    },
  };
  writeMcp(doc); syncAllow(gkey, true); rememberAdded(gkey, true); ensureApproved([gkey]);
  out({ ok: true, contract: CONTRACT, key: gkey, action: 'add-google', services: rows() });
}

// CHECK (contract 4, 2026-10-02): ask a saved server for its tool list, from
// the box, with the very definition jobs will load. The guided wizards (Slack,
// WordPress) run this straight after saving, the way Telegram verifies its
// token: a pasted credential that is wrong, or a host that strips the
// Authorization header, should be found while the member is still on the
// page, not by a silent morning job. The credential never leaves this file;
// the answer says only whether it worked and, if not, which kind of no.
//
// Shapes: { working: true, server, tools } or { working: false, problem, status?, detail? }
// where problem is 'auth' (401/403), 'missing' (404/405 on the first call),
// 'unreachable' (no answer in time), 'sse' (old transport, not checked here)
// or 'other'. `detail` is at most 160 chars of the server's own words.
if (cmd === 'add-mailchimp') {
  // stdin, base64(JSON): { key_b64 }. The key is a secret, so never argv.
  let req = {};
  try { req = JSON.parse(Buffer.from(readFileSync(0, 'utf8').trim(), 'base64').toString('utf8')); }
  catch { out({ ok: false, error: 'expected base64 JSON on stdin' }); }
  let apiKey = '';
  try { apiKey = Buffer.from(String(req.key_b64 || ''), 'base64').toString('utf8').trim(); } catch { /* refused below */ }
  if (!MAILCHIMP_KEY_RE.test(apiKey)) out({ ok: false, error: 'that does not look like a Mailchimp API key: 32 letters and numbers, a dash, then a code like us21' });
  const doc = rdJSON(MCP_F, {});
  doc.mcpServers = doc.mcpServers || {};
  if (doc.mcpServers.mailchimp && !appAdded().has('mailchimp')) out({ ok: false, error: 'a hand-added "mailchimp" server already exists on this box; remove it in Claude Code first' });
  doc.mcpServers.mailchimp = { type: 'stdio', command: 'node', args: [MAILCHIMP_SERVER],
    env: { MAILCHIMP_API_KEY: apiKey, CRADS_KEY_ADDED: new Date().toISOString().slice(0, 10) } };
  writeMcp(doc); syncAllow('mailchimp', true); rememberAdded('mailchimp', true); ensureApproved(['mailchimp']);
  out({ ok: true, contract: CONTRACT, key: 'mailchimp', action: 'add', auth: 'token', services: rows() });
}

// stdio servers (contract 5): spawn the saved command with its saved env and
// speak newline-delimited JSON-RPC, the transport Claude Code uses for them.
// For Mailchimp, initialize + tools/list prove only that the server starts;
// one real read (account_info) proves the KEY, which is the thing a member
// can get wrong.
async function checkStdio(def) {
  const { spawn } = await import('node:child_process');
  return await new Promise((resolve) => {
    let child;
    try { child = spawn(def.command, def.args || [], { env: { ...process.env, ...(def.env || {}) }, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { resolve({ working: false, problem: 'unreachable' }); return; }
    const done = (v) => { clearTimeout(timer); try { child.kill(); } catch { /* gone */ } resolve(v); };
    const timer = setTimeout(() => done({ working: false, problem: 'unreachable' }), 20000);
    child.on('error', () => done({ working: false, problem: 'unreachable' }));
    let buf = '', server = '', tools = [];
    const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          if (m.error) return done({ working: false, problem: 'other', detail: String(m.error.message || '').slice(0, 160) });
          server = String(m.result?.serverInfo?.name || '').slice(0, 80);
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        } else if (m.id === 2) {
          tools = Array.isArray(m.result?.tools) ? m.result.tools : [];
          if (!isMailchimp(def)) return done({ working: true, server, tools: tools.length });
          send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'account_info', arguments: {} } });
        } else if (m.id === 3) {
          const text = String(m.result?.content?.[0]?.text || '');
          if (m.result?.isError) return done({ working: false, problem: /expired or been revoked/.test(text) ? 'auth' : 'other', detail: text.slice(0, 200) });
          let acct = {}; try { acct = JSON.parse(text); } catch { /* fine */ }
          return done({ working: true, server, tools: tools.length, account: String(acct.account_name || '').slice(0, 80) || undefined });
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'crads-check', version: '1' } } });
  });
}

async function checkServer(def) {
  if (def.command) return checkStdio(def);
  if (def.type === 'sse') return { working: false, problem: 'sse' };
  const base = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(def.headers || {}) };
  // a JSON error body (WordPress answers {"code":..,"message":..}) is reduced
  // to its message: the member reads the site's sentence, not its envelope
  const said = (t) => {
    let v = String(t || '');
    try { const j = JSON.parse(v); if (j && typeof j.message === 'string') v = j.message; else if (j?.error?.message) v = j.error.message; } catch { /* plain text */ }
    return v.replace(/\s+/g, ' ').trim().slice(0, 160);
  };
  // a Streamable-HTTP answer is JSON or an SSE stream carrying the JSON-RPC
  // reply as a data: line; take the first message that carries our id
  const readReply = async (r, id) => {
    const text = await r.text();
    if (/^\s*[{[]/.test(text)) { try { return JSON.parse(text); } catch { return null; } }
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try { const m = JSON.parse(line.slice(5)); if (m && m.id === id) return m; } catch { /* next line */ }
    }
    return null;
  };
  const post = (body, sid) => fetch(def.url, {
    method: 'POST', headers: sid ? { ...base, 'mcp-session-id': sid } : base,
    body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
  });
  let r;
  try {
    r = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'crads-check', version: '1' } } });
  } catch { return { working: false, problem: 'unreachable' }; }
  if (r.status === 401 || r.status === 403) return { working: false, problem: 'auth', status: r.status, detail: said(await r.text().catch(() => '')) };
  if (r.status === 404 || r.status === 405) return { working: false, problem: 'missing', status: r.status };
  if (!r.ok) return { working: false, problem: 'other', status: r.status, detail: said(await r.text().catch(() => '')) };
  const init = await readReply(r, 1);
  if (!init || init.error) return { working: false, problem: 'other', status: r.status, detail: said(init?.error?.message || 'the answer was not an MCP reply') };
  const sid = r.headers.get('mcp-session-id') || '';
  const server = said(init.result?.serverInfo?.name || '');
  try {
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
    const t = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid);
    if (t.status === 401 || t.status === 403) return { working: false, problem: 'auth', status: t.status, detail: said(await t.text().catch(() => '')) };
    const list = t.ok ? await readReply(t, 2) : null;
    if (!list || list.error) return { working: false, problem: 'other', status: t.status, detail: said(list?.error?.message || '') };
    const tools = Array.isArray(list.result?.tools) ? list.result.tools : [];
    // The WordPress MCP adapter answers with three doorway tools (discover, get
    // info, execute) whatever the site can do, so its tool count says nothing.
    // Ask the discover doorway instead: read-only, and the number the member
    // cares about is how many abilities sit behind it (WooCommerce: seven).
    const door = tools.find((x) => /discover-abilities$/.test(String(x?.name || '')));
    if (door) {
      try {
        const a = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: door.name, arguments: {} } }, sid);
        const res = a.ok ? (await readReply(a, 3))?.result : null;
        let list2 = res?.structuredContent?.abilities;
        if (!Array.isArray(list2)) { try { list2 = JSON.parse(res?.content?.[0]?.text || '').abilities; } catch { /* not that shape */ } }
        if (Array.isArray(list2)) return { working: true, server, tools: tools.length, abilities: list2.length };
      } catch { /* the doorway count below is still true */ }
    }
    return { working: true, server, tools: tools.length };
  } catch { return { working: false, problem: 'unreachable' }; }
}

if (cmd === 'check') {
  if (!NAME_RE.test(key)) out({ ok: false, error: 'bad service name' });
  const def = servers()[key];
  if (!def || !(def.url || def.command)) out({ ok: false, error: `"${key}" is not a connection on this box` });
  out({ ok: true, contract: CONTRACT, key, ...(await checkServer(def)) });
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
