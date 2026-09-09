#!/usr/bin/env node
// harness.mjs — zero-dependency local fixture server for the Crads-AI UI
// surfaces. Serves the REAL, unmodified HTML files and stubs every backend
// endpoint they call with realistic data from fixtures.mjs, so Playwright can
// screenshot and exercise the whole app without a real box.
//
//   node wizard/dev-harness/harness.mjs [--port 4610]
//
// Surfaces (the invite /connect + /join pages and the org /wizard were DELETED
// 2026-09-01 with the invitation system and the hosted create flow):
//   /panel    → wizard/panel/member.html  (the one shell; /member is the same file)
//   /member   → wizard/panel/member.html
//   /door     → wizard/panel/door.html    (identity chooser + self-host create)
//
// States (page-level, non-invasive): open a surface with ?state=empty or
// ?state=error and every API call the page makes inherits that state via the
// Referer header (same-origin fetches carry the full page URL). A cookie
// fallback exists too: GET /state/<rich|empty|error> sets it for everything.
//
// SSE contracts mirrored from the real servers:
//   POST /run        → data: <json-string> per line · data:"__DONE__" / "__FAIL__<code>"
//   GET  /term/stream→ data: <base64 chunk> · event: exit
//   POST /provision  → same line protocol as /run

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as FX from './fixtures.mjs';
import { CATALOGUE, CATEGORIES } from '../panel/mcp-catalogue.mjs';
import { collapseLocal, mergeInventory } from '../panel/inventory.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(HERE, '..', 'panel');

const argPort = process.argv.indexOf('--port');
// `let`, and re-read from the socket after listen: `--port 0` then means "any
// free port", and the startup line reports the one actually bound. Fixed ports
// are this repo's most reliable source of false test failures (two runs on one
// box, or two qa-* files in one process, and the loser dies as
// "dev-harness exited early (1)"), so a test that does not care which port it
// gets should not have to pick one.
let PORT = argPort > -1 ? parseInt(process.argv[argPort + 1], 10) : 4610;

const PAGES = {
  // one shell (2026-08-09, one face since 2026-09-01): /panel and /member are
  // the same member.html, exactly like the real panel-server serve
  '/panel': join(PANEL_DIR, 'member.html'),
  '/member': join(PANEL_DIR, 'member.html'),
  '/door': join(PANEL_DIR, 'door.html'),
};
const REDIRECTS = {
  '/': '/door',
  '/go/panel': '/panel', '/go/member': '/member',
  '/dashboard': '/member',
};

const STATES = new Set(['rich', 'empty', 'error']);

// ---- request context: which surface is calling, in which state -------------
function ctxOf(req) {
  let surface = 'panel', state = null;
  try {
    const ref = new URL(req.headers.referer || '');
    const p = ref.pathname;
    if (p.startsWith('/member')) surface = 'member';
    else if (p.startsWith('/door')) surface = 'door';
    const s = ref.searchParams.get('state');
    if (s && STATES.has(s)) state = s;
  } catch { /* no referer */ }
  try {
    const own = new URL(req.url, 'http://localhost');
    const s = own.searchParams.get('state');
    if (s && STATES.has(s)) state = s;
  } catch { /* ignore */ }
  if (!state) {
    const m = String(req.headers.cookie || '').match(/(?:^|;\s*)hstate=(\w+)/);
    if (m && STATES.has(m[1])) state = m[1];
  }
  return { surface, state: state || 'rich' };
}

// A page-level switch beyond the three worlds, read the same way `?state=` is
// (referer first, then the request's own query): `?provision=ready` or
// `?setup=done` on the door URL. Kept out of ctxOf so the world stays a
// three-valued thing every stub can switch on.
function pageParam(req, name) {
  try {
    const v = new URL(req.headers.referer || '').searchParams.get(name);
    if (v) return v;
  } catch { /* no referer */ }
  try { return new URL(req.url, 'http://localhost').searchParams.get(name) || ''; } catch { return ''; }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, obj, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// stream fixture lines over the /run SSE protocol, gently paced so progress
// UIs (steps, logs) render like a live action rather than one blob
function streamRun(res, result, { paceMs = 12 } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const lines = [];
  for (const l of result.lines || []) for (const part of String(l).split('\n')) lines.push(part);
  let i = 0;
  const tick = () => {
    if (i < lines.length) {
      try { res.write(`data: ${JSON.stringify(lines[i++])}\n\n`); } catch { return; }
      setTimeout(tick, paceMs);
    } else {
      try { res.write(`data: ${JSON.stringify(result.code === 0 ? '__DONE__' : `__FAIL__${result.code}`)}\n\n`); } catch { /* gone */ }
      res.end();
    }
  };
  tick();
}

// ---- terminal sessions ------------------------------------------------------
let termSeq = 0;
const terms = new Map(); // id -> { res, queue, host, closed }

function termEmit(t, b64) {
  if (t.res) { try { t.res.write(`data: ${b64}\n\n`); } catch { /* viewer gone */ } }
  else t.queue.push(b64);
}

const server = createServer(async (req, res) => {
  // The app's OWN OAuth routes (2026-08-09). Faked so the Connections page can be
  // driven end to end: start hands back a consent URL, then the flow flips to done
  // a few seconds later, exactly as a real browser callback would.
  if (req.url.startsWith('/mcp-oauth/')) {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/mcp-oauth/start') {
      globalThis.__mcpFlow = { at: Date.now() };
      return res.end(JSON.stringify({ ok: true, url: 'https://auth.example.com/consent?x=1' }));
    }
    if (u.pathname === '/mcp-oauth/status') {
      const f = globalThis.__mcpFlow;
      return res.end(JSON.stringify({ ok: true, state: !f ? 'none' : (Date.now() - f.at > 3000 ? 'done' : 'waiting') }));
    }
    if (u.pathname === '/mcp-oauth/cancel') { globalThis.__mcpFlow = null; return res.end(JSON.stringify({ ok: true })); }
    return res.end(JSON.stringify({ ok: false, error: 'unknown' }));
  }

  // Google BYO connect (design-google-byo-connect.md, 2026-08-17): the wizard
  // card's app routes, forwarded to the shared fixture state so the box row and
  // the flow agree. Happy path walks waiting -> working -> done across polls
  // with append-only steps; an email containing "denied" walks the failure.
  if (req.url.startsWith('/google-connect/')) {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && u.pathname === '/google-connect/client') {
      const b = await readBody(req);
      return res.end(JSON.stringify(FX.googleConnectClient(b)));
    }
    if (req.method === 'POST' && u.pathname === '/google-connect/start') {
      await readBody(req);
      return res.end(JSON.stringify(FX.googleConnectStart()));
    }
    if (req.method === 'GET' && u.pathname === '/google-connect/status') {
      return res.end(JSON.stringify(FX.googleConnectStatus()));
    }
    if (req.method === 'POST' && u.pathname === '/google-connect/cancel') {
      await readBody(req);
      return res.end(JSON.stringify(FX.googleConnectCancel()));
    }
    return res.end(JSON.stringify({ ok: false, reason: 'unknown' }));
  }

  // The connections directory (2026-08-09). /mcp-dir/catalogue answers with the
  // real curated tier so page work matches production; search + probe are stubbed
  // so a shot or a page test never needs the registry or a real MCP server.
  if (req.url.startsWith('/mcp-dir/')) {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/mcp-dir/catalogue') {
      return res.end(JSON.stringify({ ok: true, categories: CATEGORIES, entries: CATALOGUE }));
    }
    if (u.pathname === '/mcp-dir/search') {
      const q = u.searchParams.get('q') || '';
      if (q.includes('regdown')) return res.end(JSON.stringify({ ok: true, registry_ok: false, hits: [] }));
      return res.end(JSON.stringify({ ok: true, registry_ok: true, hits: [
        { name: 'io.example/crm', title: 'Example CRM', desc: 'customers and deals', url: 'https://mcp.example-crm.com/mcp' },
      ] }));
    }
    if (u.pathname === '/mcp-dir/probe') {
      const b = await readBody(req);
      const target = String(b.url || '');
      if (target.includes('tokenonly')) return res.end(JSON.stringify({ ok: true, can_signin: false, reason: 'no-dcr' }));
      if (target.includes('silent')) return res.end(JSON.stringify({ ok: true, can_signin: null, reason: 'no-answer' }));
      return res.end(JSON.stringify({ ok: true, can_signin: true }));
    }
    return res.end(JSON.stringify({ ok: false, error: 'unknown' }));
  }

  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const { surface, state } = ctxOf(req);

  // ---- pages + assets -------------------------------------------------------
  if (req.method === 'GET' && REDIRECTS[path]) {
    res.writeHead(302, { location: REDIRECTS[path] }); res.end(); return;
  }
  if (req.method === 'GET' && PAGES[path]) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    // served as-is: the edition stamp died with the face collapse, and the
    // topology page (the last placeholder carrier) left the tree 2026-09-01
    res.end(readFileSync(PAGES[path]));
    return;
  }
  // the counting oracle, exactly as panel-server serves it: the module body is
  // ES5-clean and stripping the export keyword is the whole build step
  // the rate card the Billing card reads (panel-server proxies crads-ai.com/api/pricing;
  // the harness answers the v3.1 indicative numbers so the card renders a figure)
  if (req.method === 'GET' && path === '/pricing') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ currency: 'aud', charging: false, hosting: 4900, direct: 7900, tiers: [
      { key: 'crads-rock-tier-1', seats: 3, fee: 8900 }, { key: 'crads-rock-tier-2', seats: 6, fee: 9900 }, { key: 'crads-rock-tier-3', seats: 12, fee: 13900 },
      { key: 'crads-rock-tier-4', seats: 25, fee: 20900 }, { key: 'crads-rock-tier-5', seats: 50, fee: 32900 }, { key: 'crads-rock-tier-6', seats: 100, fee: 54900 },
      { key: 'crads-rock-tier-7', seats: null, fee: 94900 } ] }));
    return;
  }
  if (req.method === 'GET' && path === '/tie-counts.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(readFileSync(join(PANEL_DIR, 'tie-counts.mjs'), 'utf8').replace(/^export /gm, ''));
    return;
  }
  if (req.method === 'GET' && path.startsWith('/vendor/')) {
    const name = path.slice(8);
    if (!/^[a-z0-9._-]+(\/[a-z0-9._-]+)?$/i.test(name) || name.split('/').includes('..')) { res.writeHead(404); res.end(); return; }
    const file = join(PANEL_DIR, 'vendor', name);
    if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': name.endsWith('.css') ? 'text/css'
      : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript' });
    res.end(readFileSync(file));
    return;
  }
  if (req.method === 'GET' && path.startsWith('/state/')) {
    const s = path.slice(7);
    if (!STATES.has(s)) { res.writeHead(400); res.end('state must be rich|empty|error'); return; }
    FX.resetFlows();   // a fresh world means fresh flow state too (see fixtures.mjs)
    res.writeHead(200, { 'set-cookie': `hstate=${s}; Path=/`, 'content-type': 'text/plain' });
    res.end(`harness state → ${s}\n`);
    return;
  }

  // Chromium asks for this unprompted, once per browser, and a 404 lands in the
  // page console as "Failed to load resource". Every qa-* test asserts a clean
  // console, so that stray error roamed between contexts and failed a different
  // test on each run: an hour of chasing a product bug that was never there.
  // 204 rather than an icon: there is nothing to serve and nothing to look at.
  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  // ---- shared app endpoints ---------------------------------------------------
  if (req.method === 'GET' && path === '/update-status') { sendJson(res, { available: false }); return; }
  // The door's self-host wizard (2026-09-01) reads its run state at load when
  // the flow is re-entered; idle is the truthful harness answer (no build ever
  // runs here — the harness stubs Hetzner out of existence, same as billing).
  //
  // Since 2026-09-09 the whole flow is stubbed (fixtures.mjs, "the door's
  // self-host wizard"): validate answers a catalogue, start arms a run that
  // walks to ready across status polls, destroy resets, and `?provision=` on
  // the door URL lands the flow on a chosen screen for the docs shots. Hetzner
  // is still stubbed out of existence: nothing here can create anything.
  if (req.method === 'GET' && path === '/provision/status') { sendJson(res, FX.provisionStatus(pageParam(req, 'provision'))); return; }
  // the registry itself (providers.mjs), exactly as door-server serves it
  if (req.method === 'GET' && path === '/provision/providers') { sendJson(res, { providers: FX.provisionProviders() }); return; }
  if (req.method === 'POST' && path === '/provision/validate') { const a = FX.provisionValidate(await readBody(req)); sendJson(res, a.body, a.status); return; }
  if (req.method === 'POST' && path === '/provision/start') { const a = FX.provisionStart(await readBody(req)); sendJson(res, a.body, a.status); return; }
  if (req.method === 'POST' && path === '/provision/destroy') { const a = FX.provisionDestroy(await readBody(req)); sendJson(res, a.body, a.status); return; }
  // the finish checklist's two chips; `?setup=done` on the door URL flips both
  if (req.method === 'GET' && path === '/setup-steps') { sendJson(res, FX.setupSteps(pageParam(req, 'setup') === 'done')); return; }
  // The version chip fetches this on EVERY face at load, unprompted, so a missing
  // route here is the favicon trap above wearing a new shirt: one 404, one console
  // error, every driven test on every face red. Both real servers promise 200 +
  // {entries,hidden} and never 404 (panel-server.mjs, door-server.mjs), so the
  // harness promises the same. Entries rather than an empty list, so the hover
  // summary and the fold have something to paint in the shots rig.
  if (req.method === 'GET' && path === '/whats-new') {
    sendJson(res, {
      entries: [
        { plain: 'Your rock now backs up to its own GitHub repository, not somebody else’s', when: 'today' },
        { plain: 'The Skills page tells you when a schedule cannot run yet, instead of arming it anyway', when: 'today' },
        { plain: 'Connection status moved to the Connections page, the one surface that can change it', when: 'yesterday' },
      ],
      hidden: 4,
    });
    return;
  }
  if (req.method === 'POST' && path === '/update-apply') { res.writeHead(200); res.end('ok (harness stub)'); return; }
  // followHandoff() polls this after an apply; 'idle' is the resting answer both
  // real servers give, and the one that keeps the poll harmless here.
  if (req.method === 'GET' && path === '/update-handoff') { sendJson(res, { phase: 'idle' }); return; }
  if (req.method === 'GET' && path === '/targets') { sendJson(res, FX.targets(surface, state)); return; }

  if (req.method === 'POST' && path === '/run') {
    const form = await readBody(req);
    // ?signedout=1 on the PAGE url (read via referer, same idiom as ?world=org)
    const signedOut = /[?&]signedout=1/.test(String(req.headers.referer || ''));
    const result = FX.runVerb(surface, String(form.verb || ''), form.args, state, { signedOut });
    streamRun(res, result);
    return;
  }

  // ---- the Network page (spec 2026-08-04) -----------------------------------
  // syncVaultKey rides netOpen; nothing published means the page stops there,
  // so this one stub keeps the vault quiet without fixturing the whole store
  if (req.method === 'POST' && path === '/vault/sync') {
    await readBody(req);
    sendJson(res, { ok: true, published: false });
    return;
  }
  if (req.method === 'POST' && path === '/devices/self-heal') {
    await readBody(req);
    sendJson(res, state === 'error' ? { ok: false, reason: 'unreachable (harness error state)' }
      : { ok: true, enrolled: false, slug: 'work-laptop' });
    return;
  }

  // ---- terminal ---------------------------------------------------------------
  if (req.method === 'POST' && path === '/term/open') {
    const form = await readBody(req);
    if (state === 'error') { res.writeHead(500); res.end('cannot reach the box over SSH (harness error state)'); return; }
    const id = `t${++termSeq}`;
    const t = { res: null, queue: [], host: String(form.host || 'box'), closed: false };
    terms.set(id, t);
    // feed the fake transcript in, chunk by chunk, like a live shell
    const chunks = FX.termTranscript(t.host);
    chunks.forEach((b64, i) => setTimeout(() => { if (!t.closed) termEmit(t, b64); }, 150 + i * 120));
    sendJson(res, { id });
    return;
  }
  if (req.method === 'GET' && path === '/term/stream') {
    const t = terms.get(url.searchParams.get('id') || '');
    if (!t) { res.writeHead(404); res.end('no such terminal'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    t.res = res;
    for (const b64 of t.queue) { try { res.write(`data: ${b64}\n\n`); } catch { break; } }
    t.queue = [];
    res.on('close', () => { t.closed = true; t.res = null; });
    return;
  }
  if (req.method === 'POST' && path === '/term/input') {
    const form = await readBody(req);
    const t = terms.get(String(form.id || ''));
    if (!t) { res.writeHead(404); res.end('no such terminal'); return; }
    // echo the keystrokes back so typing feels alive (a real pty echoes too)
    try { termEmit(t, String(form.data_b64 || '')); } catch { /* ignore */ }
    res.writeHead(200); res.end('ok');
    return;
  }
  if (req.method === 'POST' && path === '/term/close') {
    const form = await readBody(req);
    const t = terms.get(String(form.id || ''));
    if (t) { t.closed = true; terms.delete(String(form.id || '')); }
    res.writeHead(200); res.end('ok');
    return;
  }

  // ---- panel: org teardown (never succeeds in the harness) --------------------
  if (req.method === 'POST' && path === '/org-teardown') {
    await readBody(req);
    streamRun(res, { code: 1, lines: ['▸ verifying ownership…', 'harness: teardown is stubbed and never runs'] });
    return;
  }

  // ---- door --------------------------------------------------------------------
  if (req.method === 'GET' && path === '/identities') { sendJson(res, FX.identities(state)); return; }

  // ---- the mineral inventory (spec 2026-08-13) ------------------------------
  // Deliberately routed through the REAL merge (wizard/panel/inventory.mjs)
  // rather than a hand-written imitation of its output. A fixture that
  // reimplements the rule it is meant to exercise is how the old
  // /account/minerals fixture drifted three fields behind production and
  // certified a shape nothing served (finding 10).
  // Ruling 6's record. ACKNOWLEDGES WITHOUT WRITING, deliberately: the real
  // panel-server persists to ~/.crads-ai/last-used.json, and a screenshot run
  // must not reach out of the harness and change what the operator's own app
  // opens next time. Its presence here is not cosmetic -- without it every
  // dashboard shot logged a 404 for a call the page makes on every boot, which
  // is the class of gap that let findings 8 and 9 survive certification.
  if (req.method === 'POST' && path === '/last-used') {
    readBody(req).then(() => sendJson(res, { ok: true, harness: 'not persisted' }));
    return;
  }
  if (req.method === 'GET' && path === '/inventory') {
    sendJson(res, { stage: 'local', account: 'pending',
      rows: mergeInventory({ local: collapseLocal(FX.identities(state).identities), account: null }) });
    return;
  }
  if (req.method === 'GET' && path === '/inventory/full') {
    const local = collapseLocal(FX.identities(state).identities);
    // 'empty' = a fresh install (the creator takeover owns the screen);
    // 'error' = signed in but the directory is unreachable, which must degrade
    // to the on-machine list plus an honest line, never to a blank screen.
    if (state === 'error') {
      sendJson(res, { stage: 'full', account: 'unreachable', email: '',
        rows: mergeInventory({ local, account: null }) });
      return;
    }
    const email = FX.accountEmail(state);
    if (!email) { sendJson(res, { stage: 'full', account: 'signed-out', email: '', rows: mergeInventory({ local, account: null }) }); return; }
    sendJson(res, { stage: 'full', account: 'ok', email,
      rows: mergeInventory({ local, account: FX.myMinerals(state), boxes: FX.myBoxes(state), email }) });
    return;
  }
  if (req.method === 'POST' && path === '/probe') {
    const form = await readBody(req);
    sendJson(res, FX.probe(String(form.host || ''), state));
    return;
  }
  if (req.method === 'POST' && path === '/forget') { await readBody(req); sendJson(res, { ok: true }); return; }

  // ---- the Crads account row (T5, 2026-08-10) -------------------------------
  // rich = signed in with two minerals; empty = signed out; error = signed in
  // but the directory is unreachable (the row shows the email, the list hides)
  if (req.method === 'GET' && path === '/account') {
    sendJson(res, { email: state === 'empty' ? '' : 'mel@driftwoodsurf.school' }); return;
  }
  // The not-let-in path reads this to decide whether the account can vouch for
  // this computer: same `boxes` rows the inventory merge already uses, so the
  // slug match in member.html lines up with the fixture's own hosts.
  if (req.method === 'GET' && path === '/account/devices') {
    if (state === 'empty') { sendJson(res, { ok: false, reason: 'sign-in-needed' }, 401); return; }
    sendJson(res, { ok: true, boxes: FX.myBoxes(state) });
    return;
  }
  if (req.method === 'GET' && path === '/account/minerals') {
    if (state === 'empty') { sendJson(res, { error: 'sign-in-needed' }, 401); return; }
    if (state === 'error') { sendJson(res, { error: 'the directory could not be reached' }, 502); return; }
    sendJson(res, { email: 'mel@driftwoodsurf.school', minerals: [
      { org: 'mel', org_display: 'Aster', slug: 'mel', tie: 'anchored', status: 'active' },
      { org: 'driftwood-surf-school', org_display: 'Driftwood Surf School', slug: 'mel', tie: 'joined', status: 'active' },
    ] });
    return;
  }
  // The create-flow sign-in (door pstep3). Since the sign-in gate (2026-08-17)
  // the page probes {silent:true} on entering the naming screen: the rich state
  // models a machine whose disk session answers (fields open with no click),
  // empty models a fresh machine (the probe is refused, the gate shows).
  // An interactive submit signs in on every state, like the real browser flow.
  if (req.method === 'POST' && path === '/signin') {
    // harness readBody parses JSON itself: the flag arrives as a property
    const silent = (await readBody(req)).silent === true;
    // default (null) is the rich fixture, same convention as every route above
    if (silent && (state === 'empty' || state === 'error')) { sendJson(res, { error: 'sign-in did not complete', reason: 'sign-in-needed' }, 401); return; }
    sendJson(res, { ok: true, email: 'mel@driftwoodsurf.school', id_token: 'h.e30.s' });
    return;
  }
  if (req.method === 'POST' && path === '/account/signin') { await readBody(req); sendJson(res, { ok: true, email: 'mel@driftwoodsurf.school' }); return; }
  if (req.method === 'POST' && path === '/account/signout') { await readBody(req); sendJson(res, { ok: true }); return; }

  // ---- rock ties (rulings 2026-08-05 + 2026-08-09) --------------------------------
  if (req.method === 'GET' && path === '/rocks-board') { sendJson(res, FX.rocksBoard(state)); return; }
  if (req.method === 'GET' && path === '/rock-mine') { sendJson(res, FX.rockMine(state)); return; }
  if (req.method === 'POST' && path === '/rock-mine/refresh') { await readBody(req); sendJson(res, { ok: true }); return; }
  if (req.method === 'GET' && path === '/community-catalogs') { sendJson(res, FX.communityCatalogs(state)); return; }
  // the rock strength card's published-skill truth (S4/S5): proxied in the app,
  // answered here so shots never reach the live directory
  if (req.method === 'GET' && path === '/own-catalog') { sendJson(res, state === 'empty' ? { ok: true, items: 0 } : { ok: true, items: 2 }); return; }
  // the public brain, member side (S9): what tied rocks chose to share.
  // `org` is the JOIN KEY onto rockMine's ties (rockBrainOf filters on it), so
  // it must be the same slug the rest of the fixtures use: `harbour-guild`.
  // Until 2026-08-13 it read `harbour`, which joined onto nothing — harmless
  // while Rock brain was its own nav tab reading this endpoint directly, but
  // after the 2026-08-10 rebuild put the reader behind a rock's drawer it meant
  // the anchor rock rendered "does not share a brain with its members yet" and
  // no page button existed to open the reader with.
  if (req.method === 'GET' && path === '/rock-brains') {
    sendJson(res, state === 'empty' ? { signedIn: true, rocks: [] } : { signedIn: true, rocks: [{
      org: 'harbour-guild', rock: 'Harbour Guild', updated: Date.now(), items: [
        { id: 'notes/vision', title: 'Vision', updated: 1 },
        { id: 'notes/vocabulary', title: 'Vocabulary', updated: 2 },
        { id: 'programs/visibility-sprint', title: 'Visibility sprint', updated: 3 },
      ] }] });
    return;
  }
  if (req.method === 'GET' && path === '/rock-brain-page') {
    sendJson(res, { ok: true, page: { id: 'notes/vision', title: 'Vision',
      content_b64: Buffer.from('# Vision\n\nWhere Harbour Guild is going, and why members ride along.\n\n- one clear promise\n- shipped weekly\n', 'utf8').toString('base64') } });
    return;
  }
  if (req.method === 'GET' && path === '/community-item') { sendJson(res, { error: 'sign-in-needed' }, 401); return; }
  if (req.method === 'POST' && (path === '/rock-join-ask' || path === '/rock-anchor-ask')) { await readBody(req); sendJson(res, { ok: true, id: 'stub-ask', tie: path === '/rock-anchor-ask' ? 'anchored' : 'joined' }); return; }
  if (req.method === 'POST' && path === '/rock-leave') { await readBody(req); sendJson(res, { ok: true }); return; }
  // R23 (iteration 2): anchored -> joined, member-initiated; the real route
  // answers the worker's JSON plus the box-side detach line
  if (req.method === 'POST' && path === '/rock-tie-downgrade') {
    const b = await readBody(req);
    if (state === 'error') { sendJson(res, { error: 'could not reach the directory just now. Try again in a moment.' }, 502); return; }
    sendJson(res, { ok: true, org: b.org, host: b.host, tie: 'joined', anchor: 'crads-ai', detach: 'UNANCHOR-OK' });
    return;
  }

  // ---- own-brain (the seat's Backup card) ----------------------------------
  if (req.method === 'GET' && path === '/own-brain/status') { sendJson(res, FX.ownBrainStatus()); return; }
  if (req.method === 'POST' && path === '/own-brain/start') {
    await readBody(req);
    sendJson(res, { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' });
    return;
  }
  // The ROCK's own GitHub connect (2026-08-10). The harness walks the same three
  // stages the real flow does, on a timer, so the card can be DRIVEN: code shown,
  // approved, connected. Nothing here talks to GitHub.
  // The brokered ask (2026-08-10): a rock with no hosting credentials files a
  // request instead of building. AIOS_FX_ASK_FAILS drives the refusal path.
  // The public progress read the Pebbles page follows after asking. Walks the
  // real stage percentages on a clock so the live steps can be DRIVEN.
  if (req.method === 'GET' && path === '/build-progress') { sendJson(res, FX.buildProgress()); return; }
  if (req.method === 'POST' && path === '/pebble-build-request') {
    const form = await readBody(req);
    if (process.env.AIOS_FX_ASK_FAILS) { sendJson(res, { error: 'that email is already on this rock' }); return; }
    sendJson(res, { ok: true, id: 'req-abc123', handle: 'driftwood', email: String(form.email || '') });
    return;
  }
  if (req.method === 'POST' && path === '/org-github/start') {
    await readBody(req);
    FX.orgGitHubBegin();
    sendJson(res, { userCode: 'WXYZ-9876', verificationUri: 'https://github.com/login/device', expiresIn: 900 });
    return;
  }
  if (req.method === 'GET' && path === '/org-github/status') { sendJson(res, FX.orgGitHubStatus()); return; }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end(`harness: no stub for ${req.method} ${path}\n`);
});

server.listen(PORT, '127.0.0.1', () => {
  PORT = server.address().port;   // resolves --port 0; identical when one was named
  console.log(`dev-harness up on http://localhost:${PORT}`);
  console.log('surfaces: /panel /member /door');
  console.log('states:   append ?state=empty or ?state=error to a surface URL');
});
