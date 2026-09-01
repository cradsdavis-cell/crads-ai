// provision-routes.mjs — the door's "Set up my own" flow (self-host pivot,
// 2026-09-01): the wizard UI over wizard/provision/engine.mjs.
//
// Mounted by door-server the same way inventory-routes is. The page collects a
// name and the person's OWN Hetzner token; this module runs the engine, then
// finishes what the engine deliberately leaves alone: the SSH identity on THIS
// machine (Host block + keypair via installMemberAccess — minted BEFORE birth
// so the only key on the box is the owner's), the boot wait through the
// enter-aios chain, and the known-hosts pin after a verified connect.
//
// Custody: the token lives in this process for the life of one run and is
// never written anywhere (the persisted resume state is the ENGINE's state,
// which the engine already refuses to put a token in). One run at a time: this
// is a person making their own box, not a fleet tool.
//
//   POST /provision/validate  {token}                    -> {ok, locations, server_types}
//   POST /provision/start     {token, name, location?, server_type?} -> {ok, alias}
//   GET  /provision/status                               -> the run, minus the token
//   POST /provision/destroy   {token?}                   -> destroy-and-retry
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HetznerClient } from '../provision/hetzner.mjs';
import { provisionSelfHost, destroySelfHost, DEFAULT_SERVER_TYPE, DEFAULT_LOCATION } from '../provision/engine.mjs';
import { installMemberAccess } from './member-connect.mjs';
import { pinHostForUser, runSsh } from './ssh-bridge.mjs';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

export function provisionRoutes(opts = {}) {
  const sshDir = opts.sshDir || join(homedir(), '.ssh');
  const makeClient = opts.makeClient || ((token) => new HetznerClient(token));
  const install = opts.install || installMemberAccess;
  const pin = opts.pin || pinHostForUser;
  // The boot probe goes through the whole chain on purpose: owner key -> sshd
  // ForceCommand -> enter-aios -> the container. Its echo answering IS the box
  // working, not a proxy for it (live-cert 2026-09-01).
  const probe = opts.probe || ((alias) => runSsh(alias, 'echo chain-ok'));
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const bootTimeoutMs = opts.bootTimeoutMs ?? 15 * 60_000;
  const bootPollMs = opts.bootPollMs ?? 15_000;

  // Engine resume-state rides a file next to the identity it belongs to, so a
  // crashed app can resume or destroy-and-retry after a restart (token
  // re-entered; it was never on disk).
  const statePath = (slug) => join(sshDir, `${slug}-box.provision.json`);
  const loadState = (slug) => {
    try { return JSON.parse(readFileSync(statePath(slug), 'utf8')); } catch { return {}; }
  };
  const saveState = (slug, state) => {
    mkdirSync(sshDir, { recursive: true });
    writeFileSync(statePath(slug), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  };

  let run = null; // { slug, alias, phase, steps[], ip, error, token, state }

  const view = () => {
    if (!run) {
      // An interrupted earlier run is visible even after a restart: any
      // provision state file whose flow never reached 'ready' offers resume.
      return { phase: 'idle' };
    }
    const { token, state, ...rest } = run;
    return { ...rest, server_id: state?.serverId ?? null };
  };

  function drive() {
    (async () => {
      const { slug, token } = run;
      try {
        run.phase = 'provisioning';
        // Key before birth: installMemberAccess with a placeholder address
        // mints (or reuses) the keypair and writes the Host block; the second
        // call below repairs HostName to the real IP — repair-on-rerun is
        // installAccess's own documented behaviour (2026-08-14), so a crash in
        // between leaves nothing worse than a dead-address block the door
        // already knows how to Forget.
        const pre = install({ slug, host: '0.0.0.0', user: 'member' }, sshDir);
        const ownerPubKey = String(pre.publicKey).trim().split('\n')[0];
        const r = await provisionSelfHost({
          token, boxName: slug, ownerPubKey, state: run.state,
          onStep: (step, detail) => { run.steps.push(detail ? `${step} (${detail})` : step); },
          overrides: {
            client: makeClient(token),
            ...(opts.files ? { files: opts.files } : {}),
            ...(run.location ? { location: run.location } : {}),
            ...(run.serverType ? { serverType: run.serverType } : {}),
          },
        });
        saveState(slug, run.state);
        run.ip = r.ip;
        install({ slug, host: r.ip, user: 'member' }, sshDir);
        run.phase = 'booting';
        // First boot pulls the image; minutes, not seconds. Silence here is
        // normal, so the deadline is generous and the page says what's happening.
        const deadline = Date.now() + bootTimeoutMs;
        for (;;) {
          let p; try { p = await probe(run.alias); } catch { p = null; }
          if (p && p.code === 0 && String(p.stdout || '').includes('chain-ok')) break;
          if (Date.now() > deadline) throw new Error('the server was created but its workspace never answered; Retry checks again, or Start over rebuilds it');
          await sleep(bootPollMs);
        }
        pin(run.ip, { sshDir });
        run.state.booted = true;
        saveState(slug, run.state);
        run.phase = 'ready';
        run.token = null;
      } catch (e) {
        saveState(slug, run.state);
        run.error = String((e && e.message) || e);
        run.phase = 'failed';
      }
    })();
  }

  function readBody(req, res, cb) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) { res.writeHead(413); res.end(); req.removeAllListeners('end'); } });
    req.on('end', () => cb(body));
  }
  const jsonOut = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  return function handle(req, res, path) {
    if (!path.startsWith('/provision/')) return false;

    if (req.method === 'GET' && path === '/provision/status') { jsonOut(res, 200, view()); return true; }

    if (req.method === 'POST' && path === '/provision/validate') {
      readBody(req, res, async (body) => {
        let form; try { form = JSON.parse(body); } catch { jsonOut(res, 400, { error: 'bad json' }); return; }
        const client = makeClient(String(form.token || ''));
        const v = await client.validateToken();
        if (!v.ok) { jsonOut(res, 401, { ok: false, reason: v.reason }); return; }
        // Both catalogues ride the validate answer so the form can offer real
        // choices; either failing soft leaves the defaults, not a dead form.
        let locations = []; let types = []; let availability = {};
        try { locations = await client.listLocations(); } catch { locations = []; }
        try { types = await client.listServerTypes(); } catch { types = []; }
        try { availability = await client.listAvailability(); } catch { availability = {}; }
        // Hetzner sells each type per datacentre, not globally (found live:
        // cpx11 @ nbg1 refused). Stamp each type with the locations that sell
        // it so the page can filter as the location changes; an empty list
        // (availability unreadable) means "offer everywhere", never a dead form.
        for (const ty of types) {
          ty.locations = Object.entries(availability)
            .filter(([, ids]) => ids.includes(ty.id))
            .map(([loc]) => loc);
        }
        jsonOut(res, 200, { ok: true, locations, server_types: types, defaults: { location: DEFAULT_LOCATION, server_type: DEFAULT_SERVER_TYPE } });
      });
      return true;
    }

    if (req.method === 'POST' && path === '/provision/start') {
      readBody(req, res, (body) => {
        let form; try { form = JSON.parse(body); } catch { jsonOut(res, 400, { error: 'bad json' }); return; }
        const slug = String(form.name || '').toLowerCase();
        if (!SLUG_RE.test(slug)) { jsonOut(res, 400, { error: 'name must be 2-32 lowercase letters, digits or hyphens' }); return; }
        if (!String(form.token || '')) { jsonOut(res, 400, { error: 'a Hetzner API token is required' }); return; }
        if (run && (run.phase === 'provisioning' || run.phase === 'booting')) {
          jsonOut(res, 409, { error: 'a build is already running', alias: run.alias }); return;
        }
        run = {
          slug,
          alias: `${slug}-box`,
          phase: 'starting',
          steps: [],
          ip: null,
          error: null,
          token: String(form.token),
          state: loadState(slug),   // resume semantics: a half-made run picks up where it stopped
          location: String(form.location || '') || null,
          serverType: String(form.server_type || '') || null,
        };
        drive();
        jsonOut(res, 200, { ok: true, alias: run.alias });
      });
      return true;
    }

    if (req.method === 'POST' && path === '/provision/destroy') {
      readBody(req, res, async (body) => {
        let form; try { form = JSON.parse(body || '{}'); } catch { form = {}; }
        const active = run && run.phase !== 'ready';
        const slug = active ? run.slug : String(form.name || '').toLowerCase();
        const token = (active && run.token) || String(form.token || '');
        if (!slug || !SLUG_RE.test(slug)) { jsonOut(res, 400, { error: 'nothing to destroy' }); return; }
        if (!token) { jsonOut(res, 400, { error: 'the Hetzner token is needed again to destroy (it is never stored)' }); return; }
        const state = (active && run.state) || loadState(slug);
        try {
          const r = await destroySelfHost({ token, state, client: makeClient(token) });
          try { unlinkSync(statePath(slug)); } catch { /* already gone */ }
          if (active) run = null;
          jsonOut(res, 200, { ok: true, destroyed: r.destroyed });
        } catch (e) {
          jsonOut(res, 500, { error: String((e && e.message) || e) });
        }
      });
      return true;
    }

    res.writeHead(404); res.end();
    return true;
  };
}
