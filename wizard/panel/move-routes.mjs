// move-routes.mjs: the door's "Move to a server" / "Move to this computer"
// routes, and the offer to delete the old server after a move down (Sam's
// rulings 2 and 3, 2026-10-14). Mounted by door-server the way provision-routes
// is. The page drives the wizard itself for a move up (/provision/* unchanged)
// and calls /move/up/start once the new server is ready.
//
//   GET  /move/plan?from=<alias>          -> what the page needs to start (direction, name, folder)
//   POST /move/up/start   {from, to}      -> a folder (<slug>-local) onto a server (<slug>-box)
//   POST /move/down/start {from, path?}   -> a server's brain into a folder on this computer
//   GET  /move/status                     -> the run: steps, error, result
//   POST /move/quote      {alias, token}  -> the server's name and monthly price (token never stored)
//   POST /move/delete     {alias, token, confirm} -> delete it, only after a VERIFIED move down
//
// THE DELETE GATE (ruling 3). Refused unless this app run moved that server's
// brain down AND checked it, the folder still checks out at the moment of the
// delete (brain-move.mjs stillVerified), the page sends back the server's own
// name as the confirmation, and this computer holds the build record that says
// which server it is. Then the wizard's own delete path, destroySelfHost, the
// same one "Remove the half-made server" uses.
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { providerOf, PROVIDERS } from '../provision/providers.mjs';
import { destroySelfHost } from '../provision/engine.mjs';
import { moveUp as realUp, moveDown as realDown, sshTransport, stillVerified, MoveRefusal } from './brain-move.mjs';
import { defaultBrainDir } from './local-targets.mjs';
import { resolveBrainPath } from './local-routes.mjs';

const BOX_RE = /^[a-z0-9][a-z0-9-]{0,62}-box$/;
const LOCAL_RE = /^[a-z0-9][a-z0-9-]{0,62}-local$/;
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

/** "€6.49 a month", from a provider's own price list. Null when the list does not say. */
export function monthlyWords(P, monthly) {
  const n = Number(monthly);
  if (!isFinite(n) || n <= 0) return null;
  return `${P.symbol || ''}${n.toFixed(2)} a month`;
}

/**
 * @param {object} o
 *   targets()            every identity (ssh boxes + local folders), as the door's bridge lists them
 *   transportFor(alias)  -> a brain-move transport (default: the system ssh)
 *   toolFiles            the engine files copied onto a server (brain-move MOVE_TOOL_FILES)
 *   assets               the local scaffold's engine bag (a folder made by a move down is set up with it)
 *   sshDir               where the build records live (<slug>-box.provision.json)
 *   makeClient(token, provider), forget(alias), moveUp, moveDown, home
 */
export function moveRoutes(o = {}) {
  const targets = () => { try { return (o.targets ? o.targets() : []) || []; } catch { return []; } };
  const transportFor = o.transportFor || ((alias) => sshTransport(alias));
  const sshDir = o.sshDir || join(homedir(), '.ssh');
  const makeClient = o.makeClient || ((token, provider) => providerOf(provider).makeClient(token));
  const up = o.moveUp || realUp;
  const down = o.moveDown || realDown;
  const home = o.home || homedir();
  const forget = o.forget || (() => ({}));
  let run = null;                       // { direction, from, to, phase, steps[], error, result }
  const verifiedDown = new Map();       // box alias -> verified moveDown result (this app run only)

  const recordOf = (alias) => {
    const p = join(sshDir, `${alias}.provision.json`);
    try { return { path: p, state: JSON.parse(readFileSync(p, 'utf8')) }; } catch { return { path: p, state: null }; }
  };
  const otherRecordsUse = (keyId, except) => {
    try {
      return readdirSync(sshDir).filter((f) => f.endsWith('.provision.json') && join(sshDir, f) !== except)
        .some((f) => { try { return JSON.parse(readFileSync(join(sshDir, f), 'utf8')).sshKeyId === keyId; } catch { return false; } });
    } catch { return false; }
  };
  const busy = () => run && run.phase === 'running';
  const begin = (direction, from, to) => { run = { direction, from, to, phase: 'running', steps: [], error: null, result: null }; return run; };
  const step = (r) => (words) => { r.steps.push(words); };
  const fail = (r, e) => { r.phase = 'failed'; r.error = e instanceof MoveRefusal ? e.message : `the move stopped: ${String(e && e.message || e).slice(0, 300)}`; };

  function readBody(req, res, cb) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) { res.writeHead(413); res.end(); req.removeAllListeners('end'); } });
    req.on('end', () => { let f; try { f = JSON.parse(body || '{}'); } catch { json(res, 400, { error: 'bad json' }); return; } cb(f); });
  }

  return function handle(req, res, path) {
    if (!path.startsWith('/move/')) return false;

    if (req.method === 'GET' && path === '/move/status') {
      json(res, 200, run || { phase: 'idle' });
      return true;
    }

    if (req.method === 'GET' && path === '/move/plan') {
      const from = new URL(req.url, 'http://x').searchParams.get('from') || '';
      const t = targets().find((x) => x.host === from);
      if (!t) { json(res, 400, { error: 'that is not a mineral this computer knows' }); return true; }
      if (t.kind === 'local') {
        json(res, 200, { direction: 'up', from, slug: t.org, name: t.name || t.org, path: t.path });
      } else {
        const slug = from.replace(/-box$/, '');
        const rec = recordOf(from).state;
        json(res, 200, { direction: 'down', from, slug, name: slug, default_path: defaultBrainDir(slug, home),
          provider: rec && rec.provider && PROVIDERS[rec.provider] ? PROVIDERS[rec.provider].label : null, built_here: !!(rec && rec.serverId) });
      }
      return true;
    }

    if (req.method === 'POST' && path === '/move/up/start') {
      readBody(req, res, (f) => {
        const from = String(f.from || ''); const to = String(f.to || '');
        const src = LOCAL_RE.test(from) ? targets().find((x) => x.host === from && x.kind === 'local') : null;
        const dst = BOX_RE.test(to) ? targets().find((x) => x.host === to && x.kind !== 'local') : null;
        if (!src) { json(res, 400, { error: 'that brain folder is not one this app knows' }); return; }
        if (!dst) { json(res, 400, { error: 'that server is not one this computer can open' }); return; }
        if (busy()) { json(res, 409, { error: 'a move is already running; wait for it' }); return; }
        const r = begin('up', from, to);
        json(res, 200, { ok: true });
        (async () => {
          try { r.result = await up({ folder: src.path, to, name: src.name, transport: transportFor(to), toolFiles: o.toolFiles, step: step(r) }); r.phase = 'done'; }
          catch (e) { fail(r, e); }
        })();
      });
      return true;
    }

    if (req.method === 'POST' && path === '/move/down/start') {
      readBody(req, res, (f) => {
        const from = String(f.from || '');
        const src = BOX_RE.test(from) ? targets().find((x) => x.host === from && x.kind !== 'local') : null;
        if (!src) { json(res, 400, { error: 'that server is not one this computer can open' }); return; }
        const slug = from.replace(/-box$/, '');
        const folder = f.path ? resolveBrainPath(f.path, home) : defaultBrainDir(slug, home);
        if (!folder) { json(res, 400, { error: 'the folder must be a full path (or start with ~/)' }); return; }
        if (busy()) { json(res, 409, { error: 'a move is already running; wait for it' }); return; }
        const r = begin('down', from, folder);
        json(res, 200, { ok: true, path: folder });
        (async () => {
          try {
            r.result = await down({ from, folder, transport: transportFor(from), toolFiles: o.toolFiles, assets: o.assets, step: step(r) });
            r.phase = 'done';
            if (r.result && r.result.verified) {
              verifiedDown.set(from, r.result);
              const rec = recordOf(from).state;
              r.result.deletable = !!(rec && rec.serverId);
            }
          } catch (e) { fail(r, e); }
        })();
      });
      return true;
    }

    if (req.method === 'POST' && (path === '/move/quote' || path === '/move/delete')) {
      readBody(req, res, async (f) => {
        const alias = String(f.alias || ''); const token = String(f.token || '');
        if (!BOX_RE.test(alias)) { json(res, 400, { error: 'name a server' }); return; }
        const slug = alias.replace(/-box$/, '');
        const name = `aios-${slug}`;
        const rec = recordOf(alias);
        if (!rec.state || !rec.state.serverId) {
          json(res, 404, { error: 'This computer did not build that server, so it cannot delete it for you. Delete it in your hosting company’s console, once you are happy with the copy on this computer.' });
          return;
        }
        const P = providerOf(rec.state.provider || 'hetzner');
        if (!token) { json(res, 400, { error: `paste your ${P.label} API token: it is never stored, so it is needed again here` }); return; }
        const client = makeClient(token, P.id);
        let v; try { v = await client.validateToken(); } catch (e) { v = { ok: false, reason: String(e && e.message || e) }; }
        if (!v.ok) { json(res, 401, { error: v.reason === 'unauthorized' ? `${P.label} did not accept that token` : `could not reach ${P.label}: ${v.reason}` }); return; }

        if (path === '/move/quote') {
          let type = rec.state.serverType || null; let loc = rec.state.location || null;
          if ((!type || !loc) && typeof client.describeServer === 'function') {
            try { const d = await client.describeServer(rec.state.serverId); type = type || d.serverType; loc = loc || d.location; } catch { /* priced below as unknown */ }
          }
          let monthly = null;
          try { const t = (await client.listServerTypes()).find((x) => x.name === type || x.id === type); monthly = t && t.prices ? t.prices[loc] ?? null : null; } catch { monthly = null; }
          json(res, 200, { ok: true, server: name, provider: P.label, console: P.console, ip: rec.state.serverIp || '', server_type: type, location: loc,
            monthly, symbol: P.symbol, cost_words: monthlyWords(P, monthly) || `whatever ${P.label} charges for it each month (see ${P.console})` });
          return;
        }

        // ---- delete: every gate, in order
        const done = verifiedDown.get(alias);
        if (!done) { json(res, 409, { error: 'The app offers to delete a server only after it has moved that server’s brain to this computer and checked the copy, in this session.' }); return; }
        const now = stillVerified(done);
        if (!now.ok) { json(res, 409, { error: `Not deleting: ${now.why}. The server is your only complete copy until this is fixed.` }); return; }
        if (String(f.confirm || '') !== name) { json(res, 400, { error: `To delete it, confirm the server's name: ${name}` }); return; }
        if (busy()) { json(res, 409, { error: 'a move is running; wait for it' }); return; }
        try {
          const keyId = rec.state.sshKeyId;
          const r = await destroySelfHost({ token, state: rec.state, provider: P.id, client });
          // Its SSH key goes too (found in the live drill, 2026-10-14: the server
          // went and `<slug>-owner` stayed in the account). Only when no other build
          // record on this computer names the same key; a failure here is reported,
          // never a reason to say the server is not gone.
          let keyGone = null;
          if (keyId != null && !otherRecordsUse(keyId, rec.path) && typeof client.deleteSshKey === 'function') {
            try { await client.deleteSshKey(keyId); keyGone = true; } catch { keyGone = false; }
          }
          try { unlinkSync(rec.path); } catch { /* gone */ }
          verifiedDown.delete(alias);
          let forgot = true; try { await forget(alias); } catch { forgot = false; }
          json(res, 200, { ok: true, destroyed: r.destroyed, key_removed: keyGone, server: name, forgot });
        } catch (e) {
          json(res, 500, { error: `${P.label} did not delete it: ${String(e && e.message || e).slice(0, 200)}. Nothing else was changed; try again, or delete it in ${P.console}.` });
        }
      });
      return true;
    }

    res.writeHead(404); res.end();
    return true;
  };
}

