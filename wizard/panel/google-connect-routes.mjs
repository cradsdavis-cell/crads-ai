// google-connect-routes.mjs: the app-side half of "connect Google with the
// member's own key" (docs/design-google-byo-connect.md, Sam-ruled 2026-08-17).
//
// Google refuses dynamic client registration, so the zero-secret flow the other
// connections use can never complete against it. The member creates their OWN
// Desktop-app OAuth client in the Google console (published: In Production,
// per the 2026-08-24 reshape — so the sign-in is one-time, no weekly re-key)
// and drops the downloaded JSON here; this module parses it, runs the loopback
// sign-in with THEIR client, ASKS for the full workspace scope union but
// honours whatever subset the member ticks on Google's granular consent
// screen, proves the key against one granted service, and hands the result to
// the box (mcp-token.mjs set-google, the single writer).
//
// Pattern sibling: own-brain-routes.mjs. Same factory shape (handler returning
// true when it answered), same stage machine (idle -> waiting -> working ->
// done | failed), same append-only steps[] narration, same supersession guard
// on every resume-after-await, same JSON-content-type gate on POST (the
// no-preflight CSRF hole).
//
// Secrets: the client id + secret live in app memory only, per host, for the
// span of one connect. They are never written to disk app-side, never echoed
// in a response, never logged, and are dropped the moment a flow finishes
// (either way): after that the box holds the only copy, which is also what the
// weekly re-key needs.
import { signInForTokens } from './google-signin.mjs';

// The EXACT scope union the box seeds into the workspace-mcp credential file,
// byte-for-byte from the installed package's auth/scopes.py (v1.24.1 recon):
// BASE_SCOPES + TOOL_SCOPES_MAP for the v1 service set (gmail, calendar,
// drive, docs, sheets, tasks, contacts), deduped. workspace-mcp validates
// tool calls LOCALLY against the credential file's scopes array, so consent
// must be asked for this same union or tools fail after a "working" verdict.
export const GOOGLE_WORKSPACE_SCOPES = [
  // BASE_SCOPES
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid',
  // gmail
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  // calendar
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  // drive (docs + sheets re-list drive.readonly / drive.file; deduped here)
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  // docs
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/documents',
  // sheets
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  // tasks
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/tasks.readonly',
  // contacts
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/contacts.readonly',
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Google's consent screen is GRANULAR: each service gets its own tick-box and
// the member may untick any of them. So the live probe must test a service
// they actually granted — first match wins. Docs/Sheets have no id-free read
// endpoint, so a docs-or-sheets-only grant ships unprobed rather than failing
// a key that is in fact fine.
const IDENTITY_SCOPES = new Set([
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]);
const PROBES = [
  { match: /\/auth\/calendar/, label: 'calendar', url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1', fix: 'check the Calendar service is turned on for your project' },
  { match: /\/auth\/gmail\./, label: 'mailbox', url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile', fix: 'check the Gmail service is turned on for your project' },
  { match: /\/auth\/drive/, label: 'files', url: 'https://www.googleapis.com/drive/v3/about?fields=user', fix: 'check the Drive service is turned on for your project' },
  { match: /\/auth\/tasks/, label: 'task lists', url: 'https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=1', fix: 'check the Tasks service is turned on for your project' },
  { match: /\/auth\/contacts/, label: 'contacts', url: 'https://people.googleapis.com/v1/people/me?personFields=names', fix: 'check the People service is turned on for your project' },
];

// workspace-mcp parses tz-naive UTC with no fractional seconds; mcp-token.mjs
// seeds a PAST expiry when this is absent, so a 0/absent expires_in is fine.
export const expiryFrom = (expiresIn, now = Date.now()) =>
  new Date(now + (Number(expiresIn) || 0) * 1000).toISOString().replace(/Z$/, '').replace(/\..*$/, '');

/**
 * @param {object} o
 * @param {object} o.state  holder for stashed clients + in-flight flows ({} is fine; one per mount)
 * @param {object} o.opts   injectables:
 *   runVerb(host, verb, args) -> parsed box reply; MUST throw unless the box
 *     answered ok:true (the sendToBox stance: a silent failure would leave the
 *     page saying "Connected" over nothing). Built by the panel around its own
 *     target gate, so a host this app does not manage is refused there.
 *   signIn   -> signInForTokens substitute (tests)
 *   fetcher  -> fetch substitute for the calendar probe (tests)
 * @returns {(req, res, path) => boolean} true when the request was handled
 */
export function createGoogleConnectRoutes({ state = {}, opts = {} } = {}) {
  state.clients = state.clients || new Map();   // host -> {email, client_id, client_secret}
  state.flows = state.flows || new Map();       // host -> the in-flight flow

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const readBody = (req, res, cb) => {
    // A cross-origin page can fire a no-preflight "simple" POST at this loopback
    // port; requiring the JSON content-type forces a preflight no hostile page passes.
    if (!/application\/json/i.test(String(req.headers['content-type'] || ''))) {
      json(res, 415, { ok: false, reason: 'json only' });
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e5) req.destroy(); });
    req.on('end', () => {
      let form;
      try { form = JSON.parse(body); } catch { json(res, 400, { ok: false, reason: 'bad json' }); return; }
      cb(form);
    });
  };

  return function handleGoogleConnectRoute(req, res, path) {
    // ---- step 2 of the wizard: the member drops their client_secret_*.json --
    if (req.method === 'POST' && path === '/google-connect/client') {
      readBody(req, res, (form) => {
        const host = String(form.host || '');
        const email = String(form.email || '').trim().toLowerCase();
        if (!host) { json(res, 400, { ok: false, reason: 'no box named' }); return; }
        if (!EMAIL_RE.test(email) || email.length > 254) { json(res, 200, { ok: false, reason: 'that does not look like an email address' }); return; }
        let doc;
        try { doc = JSON.parse(Buffer.from(String(form.client_json_b64 || ''), 'base64').toString('utf8')); }
        catch { json(res, 200, { ok: false, reason: 'that file is not the JSON Google gave you: download it again from the console' }); return; }
        // Google downloads exactly one of these shapes; `web` means the member
        // picked the wrong client type at the last console step, and a web
        // client can never complete a loopback flow, so name the fix precisely.
        if (doc && doc.web && !doc.installed) {
          json(res, 200, { ok: false, reason: 'that is a Web application client: go back to the console and create a Desktop app client' });
          return;
        }
        const inst = (doc && doc.installed) || {};
        const clientId = String(inst.client_id || '');
        const clientSecret = String(inst.client_secret || '');
        if (!/\.apps\.googleusercontent\.com$/.test(clientId)) {
          json(res, 200, { ok: false, reason: 'that JSON holds no Google OAuth client (expected an id ending .apps.googleusercontent.com): download the file again from the console' });
          return;
        }
        if (!clientSecret) { json(res, 200, { ok: false, reason: 'that JSON is missing its client secret: download the file again from the console' }); return; }
        (async () => {
          try {
            // The server DEFINITION lands first (no secret in it); the
            // credential material only ships after a proven sign-in.
            await opts.runVerb(host, 'mcp-add-google', {
              payload_b64: Buffer.from(JSON.stringify({ email }), 'utf8').toString('base64'),
            });
            state.clients.set(host, { email, client_id: clientId, client_secret: clientSecret });
            // Last 6 chars only: enough for the member to recognise their own
            // key on the card, useless to anyone else.
            json(res, 200, { ok: true, client: '…' + clientId.slice(-6) });
          } catch (e) {
            json(res, 200, { ok: false, reason: String(e.message || e).slice(0, 200) });
          }
        })();
      });
      return true;
    }

    // ---- step 3 + 4: sign in with THEIR client, prove the key, ship it ------
    if (req.method === 'POST' && path === '/google-connect/start') {
      readBody(req, res, (form) => {
        const host = String(form.host || '');
        const client = state.clients.get(host);
        if (!client) { json(res, 200, { ok: false, reason: 'drop your key file first' }); return; }
        const st = { stage: 'waiting', steps: [], email: client.email };
        state.flows.set(host, st);
        json(res, 200, { ok: true, stage: 'waiting' });
        (async () => {
          const fail = (reason) => {
            st.stage = 'failed'; st.reason = reason;
            // the secret's job is over either way; the box holds the only copy
            state.clients.delete(host);
          };
          try {
            st.steps.push('opening your browser');
            st.steps.push('waiting for you to approve in the browser (the unverified-app warning is YOURS to click through: Advanced, then Go to app)');
            const signIn = opts.signIn || signInForTokens;
            const r = await signIn({
              clientId: client.client_id, clientSecret: client.client_secret,
              scopes: GOOGLE_WORKSPACE_SCOPES, loginHint: client.email,
            });
            if (state.flows.get(host) !== st) return;   // superseded: newest flow owns the state
            if (!r.ok) { fail(r.reason || 'the sign-in did not complete'); return; }
            st.stage = 'working';
            const tokens = r.tokens || {};
            if (!tokens.refresh_token) {
              // access_type=offline + prompt=consent were sent, so an absent
              // refresh_token means the member skipped an approval screen.
              fail('Google did not include a refresh token: sign in again and approve every screen');
              return;
            }
            // the box seeds the credential file from what was actually
            // GRANTED — the member may have unticked services on Google's
            // consent screen, and workspace-mcp validates tool calls against
            // this list; the requested union is only the fallback when Google
            // omits the scope string
            const granted = String(tokens.scope || '').trim();
            const scopes = granted ? granted.split(/\s+/) : GOOGLE_WORKSPACE_SCOPES.slice();
            if (granted && !scopes.some((s) => !IDENTITY_SCOPES.has(s))) {
              fail('you left every service unticked on Google\'s screen, so there is nothing this key can reach: sign in again and tick at least one');
              return;
            }
            // prove the key against a service the member actually granted
            const probeFor = PROBES.find((p) => scopes.some((s) => p.match.test(s)));
            if (probeFor) {
              st.steps.push(`proving the key against your ${probeFor.label}`);
              const fetcher = opts.fetcher || fetch;
              let probe;
              try { probe = await fetcher(probeFor.url, { headers: { authorization: `Bearer ${tokens.access_token}` } }); }
              catch (e) { if (state.flows.get(host) !== st) return; fail(`Google could not be reached to test the key: ${String(e.message || e).slice(0, 120)}`); return; }
              if (state.flows.get(host) !== st) return;
              if (probe.status !== 200) { fail(`Google would not show your ${probeFor.label} with this key (HTTP ${probe.status}): ${probeFor.fix}`); return; }
            } else {
              // docs/sheets-only grants have no safe id-free probe; the first
              // real tool call live-proves the refresh set instead
              st.steps.push('the services you picked have no safe test call; skipping the live test');
            }
            st.steps.push('delivering the key to your box');
            const payload = {
              email: client.email, client_id: client.client_id, client_secret: client.client_secret,
              access_token: tokens.access_token, refresh_token: tokens.refresh_token,
              scopes,
              expiry: expiryFrom(tokens.expires_in),
            };
            let reply;
            try {
              reply = await opts.runVerb(host, 'mcp-token-set-google', {
                payload_b64: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
              });
            } catch (e) {
              if (state.flows.get(host) !== st) return;
              fail(`the box did not store the key: ${String(e.message || e).slice(0, 160)}`);
              return;
            }
            if (state.flows.get(host) !== st) return;
            // runVerb already refused a non-ok reply; this belt covers an
            // injected runner that resolves with a refusal instead of throwing.
            if (!reply || reply.ok !== true) { fail('the box did not confirm the key landed'); return; }
            st.stage = 'done';
            st.email = String(reply.email || client.email);
            st.rekey_due_at = reply.rekey_due_at;
            st.steps.push('your box can use Google now, including in its scheduled jobs');
            state.clients.delete(host);
          } catch (e) {
            if (state.flows.get(host) !== st) return;
            fail(String(e.message || e).slice(0, 200));
          }
        })();
      });
      return true;
    }

    if (req.method === 'GET' && path === '/google-connect/status') {
      const host = new URL(req.url, 'http://x').searchParams.get('host') || '';
      const st = state.flows.get(host);
      const stash = state.clients.get(host);
      json(res, 200, st
        ? { ok: true, stage: st.stage, steps: st.steps, reason: st.reason || null, email: st.email || null, rekey_due_at: st.rekey_due_at || null }
        : { ok: true, stage: 'idle', steps: [], reason: null, email: (stash && stash.email) || null, rekey_due_at: null });
      return true;
    }

    if (req.method === 'POST' && path === '/google-connect/cancel') {
      readBody(req, res, (form) => {
        // Dropping the flow object is the whole cancel: every in-flight resume
        // point re-checks identity against the map, so the abandoned run stands
        // down at its next await. The stashed client survives, so the member
        // can press Sign in again without re-dropping the file.
        state.flows.delete(String(form.host || ''));
        json(res, 200, { ok: true });
      });
      return true;
    }

    return false;
  };
}
