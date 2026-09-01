// own-brain-routes.mjs — the three routes that drive "put my brain on my own GitHub":
// precheck (may this box hand custody over?), start (begin the GitHub device flow),
// status (progress until done). Lifted out of member-connect.mjs on 2026-08-05 so the
// MEMBER'S OWN SEAT can serve them too.
//
// Why it moved. The flow was built as step 4 of the claim wizard, so it lived on the
// member-connect server and nowhere else. When the seat grew a Backup card it linked
// ACROSS to that wizard, which meant pressing a button inside your own app threw you
// out to a page headed "Connect to your box" whose other cards are all about acquiring
// one you already have. Landing there reads as a wrong turn because it is one. Mounting
// the same routes on the panel lets the seat run the flow in place, and the wizard keeps
// its copy unchanged for the member who genuinely is mid-claim.
//
// State is per-mount and in memory: the GitHub token exists for the duration of one flow
// and is never written to disk, never echoed in a response, never logged.
//
// Injectable throughout (tests): deviceFlow, ownBrain, precheckBridge, ownBrainBridge.

export const OWN_BRAIN_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

// A box alias is the slug plus the suffix the wizard installs. The seat knows the real
// alias and sends it; older callers send nothing and we rebuild the historical guess.
export const boxAliasFor = (slug) => `${slug}-box`;
export const slugFromAlias = (alias) => String(alias || '').replace(/-box$/, '');

/**
 * @param {object} o
 * @param {() => (string|null)} o.defaultHost      the box to precheck when none is named
 * @param {(want: string) => (string|null)} o.resolveHost  validate a caller-supplied alias;
 *        MUST return null for anything the server does not already manage, because this
 *        value becomes an ssh destination.
 * @param {object} o.state    holder for the in-flight flow ({} is fine; one per mount)
 * @param {object} o.opts     the server's options bag (deviceFlow / ownBrain / bridges)
 * @returns {(req, res, path) => boolean} true when the request was handled
 */
export function createOwnBrainRoutes({ defaultHost = () => null, resolveHost = () => null, state = {}, opts = {} } = {}) {
  return function handleOwnBrainRoute(req, res, path) {
    // D60 O6: cheap pre-flight so the UI can gate the card BEFORE the member burns a
    // GitHub device-flow round trip. TWO SEPARATE bridge probes (never a combined read:
    // the O5a __SEP__ injection review). Fail-open to member on unparseable/absent
    // ownership, matching own-brain.mjs's own gate.
    if (req.method === 'GET' && path === '/own-brain/precheck') {
      (async () => {
        const bridge = opts.precheckBridge || (await import('./ssh-bridge.mjs')).runSsh;
        let orgOwned = false, granted = false;
        // The seat names the box it is showing (it can be one of several); the wizard
        // names none and gets the machine's member box, as before.
        const want = new URL(req.url, 'http://x').searchParams.get('box');
        const host = (want && resolveHost(want)) || defaultHost();
        if (host) {
          try {
            const own = await bridge(host, 'cat /state/ownership.json 2>/dev/null');
            try { orgOwned = JSON.parse(String(own.stdout || '')).owner === 'org'; } catch { orgOwned = false; }
            if (orgOwned) {
              const g = await bridge(host, 'cat /state/org-inbox/transfer/to-member.json 2>/dev/null');
              try { granted = !!JSON.parse(String(g.stdout || '')).granted; } catch { granted = false; }
            }
          } catch { /* unreachable box: fail-open to the unchanged card */ }
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        // The seat needs a slug to offer without asking; the wizard ignores it.
        res.end(JSON.stringify({ orgOwned, granted, box: host || '', slug: host ? slugFromAlias(host) : '' }));
      })();
      return true;
    }

    if (req.method === 'GET' && path === '/own-brain/status') {
      const st = state.flow || { stage: 'idle', steps: [] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ stage: st.stage, steps: st.steps, userCode: st.userCode,
        verificationUri: st.verificationUri, result: st.result, reason: st.reason }));
      return true;
    }

    if (req.method === 'POST' && path === '/own-brain/start') {
      // A cross-origin page can fire a no-preflight "simple" POST at this loopback port;
      // requiring the JSON content-type forces a preflight no hostile page passes.
      if (!/application\/json/i.test(String(req.headers['content-type'] || ''))) {
        res.writeHead(415, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'json only' })); return true;
      }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        let form;
        try { form = JSON.parse(body); } catch { json(400, { error: 'bad json' }); return; }
        const slug = String(form.slug || '');
        if (!OWN_BRAIN_SLUG_RE.test(slug)) { json(400, { error: 'that short username does not look right' }); return; }
        // The seat sends the box it is actually looking at. Anything the server does not
        // already manage is refused rather than dialled: this value is an ssh destination.
        let boxAlias = boxAliasFor(slug);
        if (form.box !== undefined && form.box !== null && String(form.box) !== '') {
          const ok = resolveHost(String(form.box));
          if (!ok) { json(400, { error: 'that box is not one this app is connected to' }); return; }
          boxAlias = ok;
        }
        (async () => {
          try {
            const df = opts.deviceFlow || (await import('./github-device-flow.mjs')).startDeviceFlow;
            const flow = await df({});
            const st = { stage: 'waiting', steps: [], userCode: flow.userCode, verificationUri: flow.verificationUri };
            state.flow = st;
            json(200, { userCode: flow.userCode, verificationUri: flow.verificationUri });
            // background: wait for the grant, then run the orchestration
            const polled = await flow.poll();
            if (state.flow !== st) return;   // superseded by a newer flow: stand down
            if (!polled.ok) { st.stage = 'failed'; st.reason = polled.reason; return; }
            st.stage = 'working';
            const ob = opts.ownBrain || (await import('./own-brain.mjs')).ownBrain;
            const result = await ob({ slug, boxAlias, token: polled.token,
              bridge: opts.ownBrainBridge || (await import('./ssh-bridge.mjs')).runSsh,
              log: (l) => st.steps.push(String(l)) });
            if (state.flow !== st) return;   // superseded mid-run: newest flow owns the state
            if (result && result.ok) { st.stage = 'done'; st.result = { repo: result.repo, pushed: result.pushed }; }
            else { st.stage = 'failed'; st.reason = (result && result.reason) || 'did not complete'; }
          } catch (e) {
            if (!res.writableEnded) json(500, { error: String(e.message || e) });
            state.flow = { stage: 'failed', steps: [], reason: String(e.message || e) };
          }
        })();
      });
      return true;
    }

    return false;
  };
}
