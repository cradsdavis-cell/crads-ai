// door-server.mjs: the app's front door (D47). Lists this machine's installed
// identities (every mineral, one face), probes their liveness over the real
// SSH bridge, and routes into the one panel. Serverless day-to-day by design.
// The org-wizard and invite (member-connect) surfaces were DELETED 2026-09-01:
// creating is the door's own self-host flow (provision-routes), a second
// device joins by device-add (device-routes), so /go/wizard and /go/connect
// no longer name anything.
//
//   GET  /            the door page
//   GET  /identities  { identities:[{host,org,kind}], open:{panel,member} }
//   POST /probe       { host } -> { ok, login }   (host must be an installed identity)
//   GET  /go/<name>   302 to the live surface (panel|member — one server, two
//                     hash conventions); lazily starts it via opts.start[name]
//                     if wired, 404 only when the app says there is no identity
//                     behind it (or it never comes up)
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemBridge, runSsh } from './ssh-bridge.mjs';
import { removeIdentityAccess } from './member-connect.mjs';
import { fetchChangelog, plainRelease } from './updater.mjs';
import { inventoryRoutes } from './inventory-routes.mjs';
import { provisionRoutes } from './provision-routes.mjs';
import { deviceRoutes } from './device-routes.mjs';
import { crossOriginBlocked, refuseCrossOrigin } from './same-origin.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// The /go/<name> dead-end, in plain words and with a way back (2026-08-18).
// Self-contained on purpose: no vendor CSS, no fetch, nothing that can itself
// fail -- this page only ever renders when something already went wrong.
const SURFACE_WORDS = { panel: 'rock', member: 'pebble' };
function notRunningPage(name = '') {
  const what = SURFACE_WORDS[name] || 'that surface';
  return `<!doctype html><meta charset="utf-8"><title>Not open yet</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 :root{color-scheme:light dark}
 body{font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
      margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
      background:#FAF7EE;color:#173D2A}
 @media (prefers-color-scheme:dark){body{background:#12150F;color:#E8E4D9}}
 .card{max-width:30rem;text-align:left}
 h1{font-size:1.25rem;margin:0 0 .6rem}
 p{margin:0 0 .9rem}
 a.btn{display:inline-block;background:#173D2A;color:#FAF7EE;text-decoration:none;
       padding:.55rem 1rem;border-radius:8px;font-weight:600}
 @media (prefers-color-scheme:dark){a.btn{background:#E8E4D9;color:#12150F}}
 .fine{font-size:.875rem;opacity:.75}
</style>
<div class="card">
  <h1>This ${what} is not running yet</h1>
  <p>The app could not open it on this computer. That is usually because this
     machine has not finished learning what the box is.</p>
  <p class="fine">Quitting the app and opening it again fixes it most of the time.
     If it happens twice, it is a bug worth reporting rather than retrying.</p>
  <p><a class="btn" href="/">Back to my minerals</a></p>
</div>`;
}

export function createDoorServer(opts = {}) {
  const bridge = opts.bridge || systemBridge();
  const probe = opts.probe || ((host) => runSsh(host, 'echo login=$AIOS_LOGIN user=$(whoami)'));
  const forget = opts.forget || ((host) => removeIdentityAccess(host));
  // AUTO-OPEN THE PAYMENT PAGE (Sam, 2026-08-25: "it would be nice for the
  // billing link to open automatically"). The page cannot do this itself: a
  // window.open() fired from a 3s poll has no user gesture behind it and every
  // popup blocker eats it. The app already knows how to open a system browser
  // tab, so the page asks the server instead. Defaults to a refusal, so a door
  // server nobody wired this into simply never opens anything.
  const html = () => (opts.htmlText ?? readFileSync(opts.htmlPath || join(HERE, 'door.html')));
  const url = (name) => { const u = (opts.urls || {})[name]; return typeof u === 'function' ? u() : u; };
  const provision = provisionRoutes(opts.provision || {});
  // Wizard-local device enrolment (self-host pivot, 2026-09-01): the old
  // machine approves the new one over SSH, no account and no worker. Mounted
  // exactly like provision; injectables for tests ride opts.device.
  const device = deviceRoutes(opts.device || {});
  const inventory = inventoryRoutes({
    targets: () => bridge.targets(),
    // tier honesty (2026-08-19): serving an unsure row kicks the face probe in
    // the background, so the door's "Checking…" chip settles into the box's
    // own answer instead of parking the alias guess all session.
    probeFaces: opts.probeFaces,
  });

  // Shared body reader for the three POST routes below (D3 fix, 2026-07-28): past
  // MAX_BODY the old code called req.destroy() with no response, which is
  // indistinguishable client-side from the app being down. This answers a clean
  // 413 with a short plain-words body instead, then quietly drops any further
  // bytes the client keeps sending (no req.destroy(), so the 413 response is
  // never at risk of being truncated by killing the socket mid-flush).
  const MAX_BODY = 1e4;
  function readBody(req, res, cb) {
    let body = '';
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      body += c;
      if (body.length > MAX_BODY) {
        tooLarge = true;
        res.writeHead(413, { 'content-type': 'text/plain' });
        res.end('request body too large, keep it under 10KB');
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      cb(body);
    });
  }

  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];

    // One gate for every state-changing verb on this server (2026-08-20 audit).
    if (crossOriginBlocked(req)) return refuseCrossOrigin(res);

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html());
      return;
    }

    // Vendored frontend assets (tokens.css, inter/) — same contract as the panel
    // server; without this route the door's font link 404s silently (UI-overhaul).
    // Packaged exe: opts.vendor carries the SEA-embedded bytes (disk read would
    // miss inside the exe); the disk fallback keeps dev checkouts working.
    if (req.method === 'GET' && path.startsWith('/vendor/')) {
      const name = path.slice(8);
      if (!/^[a-z0-9._-]+(\/[a-z0-9._-]+)?$/i.test(name) || name.includes('..')) { res.writeHead(404); res.end(); return; }
      let body = (opts.vendor || {})[name] || null;
      if (!body) { try { body = readFileSync(join(HERE, 'vendor', name)); } catch { /* 404 below */ } }
      if (!body) { res.writeHead(404); res.end(); return; }
      const ct = name.endsWith('.css') ? 'text/css' : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript';
      res.writeHead(200, { 'content-type': ct });
      res.end(body);
      return;
    }

    // Self-update surface (2026-07-23): the door is what most multi-identity
    // users actually land on, so it must carry the update banner too. Same
    // contract as the panel server; polls nudge a throttled re-check.

    if (req.method === 'GET' && path === '/whats-new') {
      // the version chip's fold: recent release subjects from the rolling
      // release's changelog.json (CI-published). Empty list offline, never 500 —
      // "where are we up to" must not depend on the network being kind.
      // plainRelease() filters the internal half (QA runs, design notes, merges)
      // and tidies the rest: the people on the far end of this page are running a
      // business, not this repo.
      const get = opts.changelog || fetchChangelog;
      Promise.resolve(get()).then((entries) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(plainRelease(entries || [])));
      }).catch(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ entries: [], hidden: 0 }));
      });
      return;
    }
    if (req.method === 'GET' && path === '/update-status') {
      // AWAIT the re-check before answering, same as panel-server. This kicked the
      // refresh and then replied with the PREVIOUS value, so a freshly published
      // build read as "no update available" until a second poll a minute later.
      // panel-server was fixed for exactly this on 2026-07-30 and the door was
      // missed, which matters more here, not less: the door is the surface most
      // multi-identity users actually land on first.
      const answer = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify((opts.updater && opts.updater.status) || { available: false }));
      };
      if (opts.updater && opts.updater.refresh) {
        Promise.resolve(opts.updater.refresh()).then(answer).catch(answer);
      } else answer();
      return;
    }
    // Same handoff surface as panel-server: the door is where most people land, so
    // it must be able to follow an update rather than be orphaned by one.
    if (req.method === 'GET' && path === '/update-handoff') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify((opts.updater && opts.updater.handoff) || { phase: 'idle' }));
      return;
    }
    if (req.method === 'POST' && path === '/update-apply') {
      const u = opts.updater;
      if (!u || !u.apply || !u.status || !u.status.available) {
        res.writeHead(400); res.end('no update available'); return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('updating; the app will close and reopen itself in a few seconds');
      u.apply().catch((e) => console.error(`update failed: ${e.message || e}`));
      return;
    }

    if (req.method === 'GET' && path === '/identities') {
      let identities = [];
      try { identities = bridge.targets() || []; } catch { identities = []; }
      const open = {};
      for (const n of ['panel', 'member']) open[n] = !!url(n);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ identities, open }));
      return;
    }

    // ---- the mineral inventory (2026-08-13). ---------------------------------
    // ONE list, spec docs/superpowers/specs/2026-08-13-mineral-inventory.md.
    // The handler is SHARED with panel-server (ruling 8: build the model once,
    // mount it twice) and lives in inventory-routes.mjs, so the start screen
    // and the dashboard's header picker cannot drift into disagreeing about
    // what minerals this person has -- which is the exact failure this whole
    // pass exists to remove.
    //
    // /identities STAYS (it reads this machine's ssh config, no account
    // involved). The /account/* relays are gone with the account system
    // (2026-09-01): panel-server answers them 410, and enrolment is the
    // wizard-local device-add below.
    if (inventory(req, res, path)) return;

    // The self-host "Set up my own" flow (2026-09-01): the wizard UI over the
    // provisioning engine. Own module, mounted like inventory; everything it
    // needs is injectable for tests via opts.provision.
    if (provision(req, res, path)) return;

    // The two-machine device enrolment (offer / approve / complete).
    if (device(req, res, path)) return;

    if (req.method === 'GET' && path.startsWith('/go/')) {
      const name = path.slice(4);
      // WHICH mineral was clicked (2026-08-18). The identity has always ridden
      // the FRAGMENT (#host= / #box=), which is client-side only and never
      // reaches this server, so the starter could ask nothing better than "is
      // there ANY rock on this machine". For a rock provisioned or promoted in
      // this session that answer is no -- it still wears its <slug>-box alias --
      // while the door had just rendered it AS a rock, because the row's tier
      // comes from the account (inventory.mjs) and this side reads only the
      // local alias. Door says rock, app says no rock, member gets a 404 on
      // their first click (Harriet, 2026-08-18). The door now repeats the identity
      // as a QUERY param, which does reach us, so the starter can act on the one
      // that was actually clicked. Absent (an older page, or a bare hit) leaves
      // the previous behaviour exactly as it was.
      const q = new URLSearchParams(req.url.split('?')[1] || '');
      const want = { host: q.get('host') || '', box: q.get('box') || '' };
      const answer = (u) => {
        if (u) { res.writeHead(302, { location: u }); res.end(); }
        // Not a bare 404 body any more: this is a surface a brand-new member can
        // land on with one click, and unstyled black text on white with no way
        // back is a dead end, not an error message.
        else { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); res.end(notRunningPage(name)); }
      };
      const u = url(name);
      const starter = (opts.start || {})[name];
      if (u || !starter) { answer(u); return; }
      // Lazy start (2026-08-03): a surface can be down while a legitimate
      // identity sits behind it -- a pebble stamped or claimed mid-session never
      // started the member dashboard (the stamp hook only handles rocks), so
      // the door listed the new box but this route dead-ended on the 404 until
      // the app was reopened. Instead of teaching every identity-adding flow to
      // start the right surface, the door asks the app here, on demand. The
      // starter returns false when no matching identity exists (the 404 stays
      // honest); otherwise we wait for the surface's URL to appear -- it binds
      // port 0 and reports asynchronously on 'listening', hence the poll.
      (async () => {
        let started;
        try { started = await starter(want); } catch { started = false; }
        if (started === false) { answer(''); return; }
        const deadline = Date.now() + (opts.startWaitMs ?? 4000);
        let live = url(name);
        while (!live && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25));
          live = url(name);
        }
        answer(live);
      })();
      return;
    }

    if (req.method === 'POST' && path === '/probe') {
      readBody(req, res, async (body) => {
        let form; try { form = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
        let identities = [];
        try { identities = bridge.targets() || []; } catch { identities = []; }
        const host = String(form.host ?? '');
        if (!identities.some((t) => t.host === host)) { res.writeHead(400); res.end('host must be an installed identity'); return; }
        // D1 fix (2026-07-28): probe is an injectable at an SSH boundary. The
        // production default (runSsh) always resolves and never rejects, but a
        // caller-injected probe is not bound by that contract, so a rejection
        // here must never become an unhandled promise rejection -- that kills
        // the whole Node process, taking every route (page, /go/*,
        // /forget) down with it until something external restarts the
        // app. One bad identity must never take down the app: a rejection, or
        // an unexpected resolved shape, reads as a plain "not reachable" answer
        // for THIS request only.
        let r;
        try { r = await probe(host); } catch { r = null; }
        const stdout = (r && typeof r.stdout === 'string') ? r.stdout : '';
        const ok = !!(r && r.code === 0);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok, login: (stdout.match(/login=(\S*)/) || [])[1] || '' }));
      });
      return;
    }

    // Forget an identity on THIS computer only: removes the SSH Host block,
    // keypair, known-hosts pin and Claude Code entry the wizard installed.
    // Reaches at no box, repo or infrastructure. The UI offers it for
    // identities whose box does not answer (a deleted org lingering on the
    // door); forgetting a live one just means re-joining via a fresh invite.
    if (req.method === 'POST' && path === '/forget') {
      readBody(req, res, async (body) => {
        let form; try { form = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
        let identities = [];
        try { identities = bridge.targets() || []; } catch { identities = []; }
        const host = String(form.host ?? '');
        if (!identities.some((t) => t.host === host)) { res.writeHead(400); res.end('host must be an installed identity'); return; }
        // D2 fix (2026-07-28): forget is an injectable too, and the same class of
        // bug as D1 lived here -- the try/catch never actually guarded a rejected
        // promise, because the call wasn't awaited, so the rejection escaped the
        // try block entirely and could kill the process. Production's
        // removeIdentityAccess is synchronous today (latent, not live), but
        // awaiting here makes both sync throws and async rejections land in the
        // same catch, answered as a 500 for this one request.
        try {
          const r = await forget(host);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...r }));
        } catch (e) {
          res.writeHead(500); res.end(String(e.message || e));
        }
      });
      return;
    }

    // The pre-build /signin route left with the account system (2026-09-01):
    // nothing downstream needs a proven mailbox when the person provisions
    // their own metal with their own token.

    // ---- the Crads account, door side: RETIRED 2026-09-01 -------------------
    // /account, /account/signin, /account/signout (T5) and the T9 device leg
    // (/account/devices, /account/enrol-device) all left with the account
    // system. Identity is the SSH key; a new computer is let in by an already
    // connected one over SSH (device-routes.mjs), and the directory these
    // routes relayed to no longer exists. The jsonOut helper went with them.

    res.writeHead(404); res.end();
  });

  server.listen(opts.port ?? 0, opts.host || '127.0.0.1');
  return server;
}
