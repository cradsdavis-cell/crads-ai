// mcp-oauth-routes.mjs: the sign-in, run by the APP, with no CLI and no paste.
//
// The previous design drove `claude mcp login` on the box. Its callback listener
// therefore lived on the BOX, which the member's browser cannot reach: that dead
// "this site can't be reached" page is exactly why a paste step existed, and the
// CLI's need for a terminal is why it kept failing. Here the listener runs in the
// APP, on the member's own machine, so the browser lands somewhere real and the
// flow finishes by itself.
//
// Shape:
//   POST /mcp-oauth/start   {host,name,url}  -> {url} and a listener is waiting
//   GET  /mcp-oauth/status  ?name=           -> {state:'waiting'|'done'|'error'}
//   POST /mcp-oauth/cancel  {name}           -> tears the attempt down
//   GET  /mcp-oauth/callback ...             -> the browser lands HERE
//   GET  /mcp-oauth/redirect                 -> {uri} the fixed address a member's
//                                               own app must list (see below)
//
// A member's own client (2026-10-17, Asana v2). Most servers let the app
// register itself (DCR) with whatever localhost port this run happens to have.
// A provider without DCR needs the MEMBER to create an app on its developer
// console, and that app must list ONE redirect address, matched exactly. So a
// flow that brings its own client_id/client_secret is served by a second
// listener on a FIXED loopback port, MEMBER_REDIRECT, which the wizard shows
// for the member to paste. Both listeners share one handler.
//
// Secrets: the code verifier and the tokens live in memory for the duration of
// one flow. Tokens go straight to the box and are never written to disk here,
// never logged, and never put in a response body.
import http from 'node:http';
import { discover, register, authorizeUrl, exchange, tokenRecord, pkce, newState, stateMatches } from '../../engine/comms/mcp-oauth-lib.mjs';

export const MCP_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
// The fixed callback a member's own app lists. Change it and every member app
// made against the old value stops working, so it never moves.
export const MEMBER_REDIRECT_PORT = 38427;
export const MEMBER_REDIRECT = `http://localhost:${MEMBER_REDIRECT_PORT}/mcp-callback`;
// client ids and secrets are opaque strings; this only refuses junk and
// anything that could break out of a form body or a URL parameter
const CRED_RE = /^[A-Za-z0-9._~+/=-]{4,300}$/;

const PAGE = (title, body) => `<!doctype html><meta charset=utf-8><title>${title}</title>`
  + '<style>body{font:16px/1.5 system-ui,sans-serif;margin:12vh auto;max-width:30rem;padding:0 1.5rem;color:#20201d}'
  + 'h1{font-size:1.4rem;margin:0 0 .5rem}p{color:#57534e}</style>'
  + `<h1>${title}</h1><p>${body}</p>`;

export function createMcpOAuthRoutes({ state = {}, sendToBox, fetchFn = fetch, listen = true } = {}) {
  state.flows = state.flows || new Map();          // name -> flow
  state.server = state.server || null;
  state.memberServers = state.memberServers || null;

  const readJson = (req) => new Promise((resolve) => {
    let b = ''; req.on('data', (d) => { b += d; if (b.length > 64_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
  const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

  // The callback handler, shared by both listeners.
  async function onCallback(req, res) {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/mcp-callback') { res.writeHead(404); return res.end(); }
      const flow = [...state.flows.values()].find((f) => stateMatches(f.state, u.searchParams.get('state')));
      if (!flow) {
        // Either a forgery or a stale tab from an abandoned attempt. Both get the
        // same neutral answer: never confirm which.
        res.writeHead(400, { 'content-type': 'text/html' });
        return res.end(PAGE('That sign-in has expired', 'Start it again from the Connections page.'));
      }
      try {
        if (u.searchParams.get('error')) throw new Error(u.searchParams.get('error_description') || u.searchParams.get('error'));
        const code = u.searchParams.get('code');
        if (!code) throw new Error('the provider sent no authorization code');
        const raw = await exchange(fetchFn, flow.meta, {
          code, clientId: flow.clientId, clientSecret: flow.clientSecret,
          redirectUri: flow.redirectUri, verifier: flow.verifier, resource: flow.resource,
        });
        const rec = tokenRecord(raw);
        await sendToBox(flow.host, {
          name: flow.name, url: flow.url,
          token_endpoint: flow.meta.token_endpoint, client_id: flow.clientId, client_secret: flow.clientSecret,
          ...(flow.resource !== flow.url ? { resource: flow.resource } : {}),
          ...rec,
        });
        flow.status = 'done';
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(PAGE('Connected', `Your box can now use ${flow.name}, including in its scheduled jobs. You can close this tab.`));
      } catch (e) {
        flow.status = 'error';
        flow.error = String(e.message || e).slice(0, 200);
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(PAGE('That did not finish', 'Close this tab and check the Connections page, which says what went wrong.'));
      } finally {
        // the verifier is single-use; drop it the moment the exchange is over
        flow.verifier = null;
      }
  }

  // ONE listener for all DCR flows, started on demand and kept for the app's life.
  // A fixed-per-flow port would mean registering a new client for every retry.
  async function ensureListener() {
    if (state.server) return state.server.address().port;
    const srv = http.createServer(onCallback);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));   // loopback ONLY
    // UNREF: an auxiliary listener. The app's own server owns the process
    // lifetime, and holding the loop open here would keep a shutting-down app
    // (or a test runner) alive forever waiting on a callback nobody will make.
    srv.unref();
    state.server = srv;
    return srv.address().port;
  }

  // The fixed-port listener for member-owned clients. "localhost" may resolve
  // to ::1 or 127.0.0.1 depending on the machine, so it listens on both, and
  // ONLY on loopback. A port another program holds is a plain, fixable error.
  async function ensureMemberListener() {
    if (state.memberServers) return;
    const servers = [];
    for (const host of ['127.0.0.1', '::1']) {
      const srv = http.createServer(onCallback);
      try {
        await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(MEMBER_REDIRECT_PORT, host, resolve); });
        srv.unref();
        servers.push(srv);
      } catch (e) {
        // no IPv6 loopback on this machine is fine; a taken port is not
        if (host === '::1' && e && (e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT')) continue;
        for (const s2 of servers) s2.close();
        if (e && e.code === 'EADDRINUSE') throw new Error(`another program is using port ${MEMBER_REDIRECT_PORT} on this computer, so the sign-in cannot finish here. Close it, or restart the computer, and try again`);
        throw e;
      }
    }
    state.memberServers = servers;
  }

  return async function handleMcpOAuthRoute(req, res, path) {
    if (!path.startsWith('/mcp-oauth/')) return false;

    if (path === '/mcp-oauth/start' && req.method === 'POST') {
      const b = await readJson(req);
      const name = String(b.name || '').toLowerCase();
      if (!MCP_NAME_RE.test(name)) { json(res, 400, { ok: false, error: 'bad service name' }); return true; }
      let url;
      try { url = new URL(String(b.url || '')); } catch { json(res, 400, { ok: false, error: 'bad server url' }); return true; }
      if (url.protocol !== 'https:') { json(res, 400, { ok: false, error: 'only https servers can be connected' }); return true; }
      // A member's own client (no DCR at this provider): both halves or neither.
      const ownId = b.client_id == null ? '' : String(b.client_id).trim();
      const ownSecret = b.client_secret == null ? '' : String(b.client_secret).trim();
      if ((ownId || ownSecret) && !(CRED_RE.test(ownId) && CRED_RE.test(ownSecret))) {
        json(res, 400, { ok: false, error: 'the client ID and client secret both need pasting, exactly as your app shows them' });
        return true;
      }
      let resource = url.href;
      if (b.resource != null) {
        try { const r = new URL(String(b.resource)); if (r.protocol !== 'https:' || r.origin !== url.origin) throw 0; resource = r.href.replace(/\/+$/, ''); }
        catch { json(res, 400, { ok: false, error: 'bad resource' }); return true; }
      }
      try {
        let redirectUri, clientId, clientSecret;
        const meta = await discover(fetchFn, url.href);
        if (ownId) {
          if (listen) await ensureMemberListener();
          redirectUri = MEMBER_REDIRECT;
          clientId = ownId; clientSecret = ownSecret;
        } else {
          const port = listen ? await ensureListener() : (state.port || 0);
          redirectUri = `http://127.0.0.1:${port}/mcp-callback`;
          ({ clientId, clientSecret } = await register(fetchFn, meta, redirectUri));
        }
        const { verifier, challenge } = pkce();
        const st = newState();
        state.flows.set(name, {
          name, host: b.host, url: url.href, resource, meta, clientId, clientSecret,
          verifier, state: st, redirectUri, status: 'waiting', started: Date.now(),
        });
        json(res, 200, { ok: true, url: authorizeUrl({ meta, clientId, redirectUri, challenge, state: st, resource }) });
      } catch (e) {
        json(res, 200, { ok: false, error: String(e.message || e).slice(0, 200) });
      }
      return true;
    }

    if (path === '/mcp-oauth/redirect') {
      json(res, 200, { ok: true, uri: MEMBER_REDIRECT });
      return true;
    }

    if (path === '/mcp-oauth/status') {
      const name = new URL(req.url, 'http://x').searchParams.get('name') || '';
      const f = state.flows.get(name);
      json(res, 200, f ? { ok: true, state: f.status, error: f.error || null } : { ok: true, state: 'none' });
      return true;
    }

    if (path === '/mcp-oauth/cancel' && req.method === 'POST') {
      const b = await readJson(req);
      state.flows.delete(String(b.name || '').toLowerCase());
      json(res, 200, { ok: true });
      return true;
    }

    json(res, 404, { ok: false, error: 'unknown route' });
    return true;
  };
}
