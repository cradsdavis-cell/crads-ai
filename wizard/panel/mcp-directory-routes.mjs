// wizard/panel/mcp-directory-routes.mjs: the directory behind the Connections page.
//
// Three routes, all app-side (the box is unchanged, spec ruling 5):
//   GET  /mcp-dir/catalogue      the baked curated tier
//   GET  /mcp-dir/search?q=      the official registry, filtered to usable rows
//   POST /mcp-dir/probe {url}    can this server's sign-in actually complete?
//
// Failure honesty (spec): the registry being down is a RESULT (registry_ok:
// false), never an error, because "Your connections" and the curated tier must
// render regardless. The probe answers in three honest shapes: DCR (sign-in),
// no-dcr (token field), no-answer (we could not check, so no button we cannot
// back). Nothing here caches beyond the request: a stale hit naming a dead
// server is worse than a search that says the registry did not answer.
import { CATALOGUE, CATEGORIES } from './mcp-catalogue.mjs';
import { discover } from '../../engine/comms/mcp-oauth-lib.mjs';

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
const PROBE_MS = 4000;          // per-fetch cap inside discover()
const PROBE_DEADLINE_MS = 4500; // cap across the WHOLE probe, see below
const SEARCH_MS = 5000;

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 65536) { req.destroy(); resolve({}); } });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// The registry is a third party writing into our page, so its url is parsed,
// not pattern-matched: a string regex passes things new URL() would reject, and
// the url is the one field that lands in an HTML attribute AND is posted back
// as a probe target. Quotes can never appear in a legitimate https url, so a
// url carrying one is refused outright rather than escaped downstream (the page
// escapes too; this is the belt to that pair of braces).
function safeRemoteUrl(raw) {
  const s = String(raw || '');
  if (!s || /["'`<>]/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  return u.href;
}

// registry row -> directory hit, or null when the row is not usable from a box:
// superseded versions and rows with no remote http endpoint are noise here.
function toHit(row) {
  const meta = row?._meta?.['io.modelcontextprotocol.registry/official'] || {};
  if (meta.isLatest === false) return null;
  if (meta.status && meta.status !== 'active') return null;
  const s = row?.server || {};
  const remote = (s.remotes || []).find((r) => /http/i.test(String(r.type || '')));
  const url = remote ? safeRemoteUrl(remote.url) : null;
  if (!url) return null;
  return { name: String(s.name || ''), title: String(s.title || s.name || ''), desc: String(s.description || '').slice(0, 100), url };
}

export function createMcpDirectoryRoutes({ fetchFn = fetch, probeDeadlineMs = PROBE_DEADLINE_MS } = {}) {
  const timed = (ms) => (u, o) => fetchFn(u, { ...o, signal: AbortSignal.timeout(ms) });

  return async function handleMcpDirectoryRoute(req, res, path) {
    if (!path.startsWith('/mcp-dir/')) return false;

    if (path === '/mcp-dir/catalogue' && req.method === 'GET') {
      json(res, 200, { ok: true, categories: CATEGORIES, entries: CATALOGUE });
      return true;
    }

    if (path === '/mcp-dir/search' && req.method === 'GET') {
      const q = (new URL(req.url, 'http://x').searchParams.get('q') || '').trim().slice(0, 80);
      if (!q) { json(res, 200, { ok: true, registry_ok: true, hits: [] }); return true; }
      try {
        const r = await timed(SEARCH_MS)(`${REGISTRY}?limit=30&search=${encodeURIComponent(q)}`);
        if (!r.ok) throw new Error(`registry answered ${r.status}`);
        const body = await r.json();
        const seen = new Set();
        const hits = (body.servers || []).map(toHit).filter(Boolean)
          .filter((h) => (seen.has(h.name) ? false : seen.add(h.name)));
        json(res, 200, { ok: true, registry_ok: true, hits });
      } catch {
        // the degrade path, not an error: the page keeps its curated results
        // and says the wider registry did not answer
        json(res, 200, { ok: true, registry_ok: false, hits: [] });
      }
      return true;
    }

    if (path === '/mcp-dir/probe' && req.method === 'POST') {
      const b = await readJson(req);
      let url;
      try { url = new URL(String(b.url || '')); } catch { json(res, 200, { ok: false, error: 'bad server url' }); return true; }
      if (url.protocol !== 'https:') { json(res, 200, { ok: false, error: 'bad server url' }); return true; }
      // PROBE_MS caps ONE fetch, but discover() makes up to three in sequence
      // (protected-resource, then two well-known paths), so a server that hangs
      // every leg costs three times the cap. The member is watching a spinner,
      // so the honest answer is a deadline across the whole probe: past it we
      // say the same thing a thrown discover() says, "we could not check".
      //
      // The probe leg is folded to a resolved shape BEFORE the race, so a
      // discover() that rejects after the deadline has already answered cannot
      // surface as an unhandled rejection.
      let timer = null;
      const probed = discover(timed(PROBE_MS), url.href).then((meta) => ({ meta }), () => ({}));
      const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({}), probeDeadlineMs); });
      const { meta } = await Promise.race([probed, deadline]);
      clearTimeout(timer);
      if (!meta) json(res, 200, { ok: true, can_signin: null, reason: 'no-answer' });
      else if (meta.registration_endpoint) json(res, 200, { ok: true, can_signin: true });
      else json(res, 200, { ok: true, can_signin: false, reason: 'no-dcr' });
      return true;
    }

    json(res, 404, { ok: false, error: 'unknown route' });
    return true;
  };
}
