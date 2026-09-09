// provision-routes.mjs — the door's "Set up my own" flow (self-host pivot,
// 2026-09-01): the wizard UI over wizard/provision/engine.mjs.
//
// Mounted by door-server the same way inventory-routes is. The page collects a
// name, a provider (Hetzner or DigitalOcean, providers.mjs) and the person's
// OWN API token for it; this module runs the engine, then
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
//   GET  /provision/providers                            -> {providers: [...]} (providers.mjs, no functions)
//   POST /provision/validate  {token, provider?}         -> {ok, provider, symbol, chains, locations, server_types, defaults}
//   POST /provision/start     {token, name, provider?, location?, server_type?} -> {ok, alias}
//   GET  /provision/status                               -> the run, minus the token
//   POST /provision/destroy   {token?, name?, provider?} -> destroy-and-retry
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { providerOf, publicProviders, DEFAULT_PROVIDER, PROVIDERS } from '../provision/providers.mjs';
import { provisionSelfHost, destroySelfHost } from '../provision/engine.mjs';
import { installMemberAccess } from './member-connect.mjs';
import { pinHostForUser, runSsh } from './ssh-bridge.mjs';
import { registerClaudeSshConfig, syncClaudeStartDir, claudeSettingsPath, OPEN_FOLDER_PROBE } from './claude-settings.mjs';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

export function provisionRoutes(opts = {}) {
  const sshDir = opts.sshDir || join(homedir(), '.ssh');
  // (token, providerId) -> a client honouring the nine-method contract. Tests
  // inject a fake; production asks the registry.
  const makeClient = opts.makeClient || ((token, provider) => providerOf(provider).makeClient(token));
  const providerIdOf = (form) => {
    const id = String((form && form.provider) || DEFAULT_PROVIDER);
    return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? id : null;
  };
  const install = opts.install || installMemberAccess;
  const pin = opts.pin || pinHostForUser;
  // The boot probe goes through the whole chain on purpose: owner key -> sshd
  // ForceCommand -> enter-aios -> the container. Its echo answering IS the box
  // working, not a proxy for it (live-cert 2026-09-01).
  const probe = opts.probe || ((alias) => runSsh(alias, 'echo chain-ok'));
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  // Access is app-first: SSH only, no browser IDE. So the Environment entry in
  // the Claude Code app is not a nicety, it is the door the member walks
  // through, and the flow is not finished until it exists.
  const settingsPath = opts.settingsPath || claudeSettingsPath();
  const register = opts.register || registerClaudeSshConfig;
  const syncStartDir = opts.syncStartDir || syncClaudeStartDir;
  const openFolder = opts.openFolder || ((alias) => runSsh(alias, OPEN_FOLDER_PROBE));
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

  let run = null; // { slug, alias, provider, phase, steps[], ip, error, token, state }

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
          token, boxName: slug, ownerPubKey, state: run.state, provider: run.provider,
          onStep: (step, detail) => { run.steps.push(detail ? `${step} (${detail})` : step); },
          overrides: {
            client: makeClient(token, run.provider),
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
        // THE ENVIRONMENT ENTRY IN THE CLAUDE CODE APP.
        // The hosted-era connect flow wrote this (member-connect's
        // registerInClaude, with the same /test open-folder leg). This flow was
        // written without it, so a self-hosted box came up healthy, reachable
        // and pinned, and then simply never appeared in the dropdown: the one
        // surface that can open it. Found by Sam on the first working box,
        // 2026-09-01.
        //
        // Best-effort, on the rule the connect flow already states: a settings
        // refusal must never fail a build that worked. The box is up either way.
        try {
          register({ id: run.alias, name: run.slug, sshHost: run.alias, startDirectory: '/state' }, settingsPath);
          // /state/<name> is the folder the box wants opened, and it can only be
          // asked now the chain is proven. Registering a folder nobody has
          // confirmed exists is a session Claude Code cannot open, which is why
          // this is a second step and not a guess at install time.
          let of = null;
          try { of = await openFolder(run.alias); } catch { of = null; }
          if (of && of.code === 0) syncStartDir(run.alias, String(of.stdout || ''), settingsPath);
        } catch { /* the mineral is up; the dropdown entry is repairable by hand */ }
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
    if (req.method === 'GET' && path === '/provision/providers') { jsonOut(res, 200, { providers: publicProviders() }); return true; }

    if (req.method === 'POST' && path === '/provision/validate') {
      readBody(req, res, async (body) => {
        let form; try { form = JSON.parse(body); } catch { jsonOut(res, 400, { error: 'bad json' }); return; }
        const providerId = providerIdOf(form);
        if (!providerId) { jsonOut(res, 400, { error: 'unknown provider' }); return; }
        const P = providerOf(providerId);
        const client = makeClient(String(form.token || ''), providerId);
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
        // The provider's own shape rides along so the page never hard-codes
        // a currency symbol or a size chain (door.html read SH_CHAINS from
        // its own source until 2026-09-09).
        jsonOut(res, 200, {
          ok: true, provider: P.id, label: P.label, symbol: P.symbol, chains: P.sizeChains,
          locations, server_types: types, defaults: { location: P.defaults.location, server_type: P.defaults.serverType },
        });
      });
      return true;
    }

    if (req.method === 'POST' && path === '/provision/start') {
      readBody(req, res, (body) => {
        let form; try { form = JSON.parse(body); } catch { jsonOut(res, 400, { error: 'bad json' }); return; }
        const slug = String(form.name || '').toLowerCase();
        if (!SLUG_RE.test(slug)) { jsonOut(res, 400, { error: 'name must be 2-32 lowercase letters, digits or hyphens' }); return; }
        const providerId = providerIdOf(form);
        if (!providerId) { jsonOut(res, 400, { error: 'unknown provider' }); return; }
        if (!String(form.token || '')) { jsonOut(res, 400, { error: `a ${providerOf(providerId).label} API token is required` }); return; }
        if (run && (run.phase === 'provisioning' || run.phase === 'booting')) {
          jsonOut(res, 409, { error: 'a build is already running', alias: run.alias }); return;
        }
        run = {
          slug,
          alias: `${slug}-box`,
          provider: providerId,
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
        if (!token) { jsonOut(res, 400, { error: 'the hosting token is needed again to destroy (it is never stored)' }); return; }
        const state = (active && run.state) || loadState(slug);
        // The provider the run was started on wins over anything the form
        // says: a delete sent to the wrong provider is a server left running.
        const providerId = (active && run.provider) || state.provider || providerIdOf(form) || DEFAULT_PROVIDER;
        try {
          const r = await destroySelfHost({ token, state, provider: providerId, client: makeClient(token, providerId) });
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
