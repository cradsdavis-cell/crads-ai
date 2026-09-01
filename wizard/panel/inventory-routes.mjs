// inventory-routes.mjs — the two inventory routes, mounted by BOTH servers.
//
// Spec: docs/superpowers/specs/2026-08-13-mineral-inventory.md, ruling 8
// ("build the model once, mount it twice"). The door renders this list as the
// app's start screen; the dashboard renders the same list as its header picker.
// One implementation so the two surfaces cannot drift into disagreeing.
//
//   GET /inventory       what THIS MACHINE can open, read off the ssh config.
//                        No network. Answers instantly, offline-proof.
//   GET /inventory/full  historically the same list with the ACCOUNT layer
//                        merged in from the directory. The account system was
//                        retired 2026-09-01 (self-host pivot: identity is the
//                        SSH key; the directory is gone), so this now answers
//                        the same local truth with stage 'full' and
//                        account 'local-only'. The route SURVIVES because both
//                        pages fetch it by name; the layer it merged does not.
//                        A fresh machine knows nothing until a mineral is built
//                        on it or brought in via device-add, the same way a
//                        fresh laptop does not know your servers exist.
import { collapseLocal, mergeInventory, orderInventory } from './inventory.mjs';

/**
 * @param {object} p
 *   targets()        () => listPanelTargets() output for this machine
 *   probeFaces       optional (aliases) => Promise — ask those boxes what they
 *                    are, registering any rock face found. Wired by the door.
 * @returns {(req,res,path)=>boolean} true when it handled the request
 */
export function inventoryRoutes({ targets, probeFaces } = {}) {
  const local = () => {
    let t = [];
    try { t = targets() || []; } catch { t = []; }
    return collapseLocal(t);
  };
  // Probe-at-draw (tier-honesty, 2026-08-19): serving a list with an unsure row
  // kicks the face probe in the background so the row settles instead of
  // reading "Checking…" forever. Fail-open: no answer leaves the guess standing.
  const probedDone = new Set();
  let probing = null;
  const maybeProbe = (rows) => {
    if (!probeFaces || probing) return;
    const unsure = rows.filter((r) => !r.sure && !probedDone.has(r.alias)).map((r) => r.alias);
    if (!unsure.length) return;
    let flight;
    try { flight = Promise.resolve(probeFaces(unsure)); }
    catch { flight = Promise.resolve(); }
    probing = flight
      .catch(() => { /* fail-open: the guess stands */ })
      .then(() => { for (const a of unsure) probedDone.add(a); probing = null; });
  };
  const send = (res, obj) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  // `account: null` into the merge means "no account knowledge", which flags
  // nothing — exactly right forever now, not just on a plane.
  const answer = (res, stage, account) => {
    const rows = local();
    maybeProbe(rows);
    send(res, { stage, account, email: '',
      rows: orderInventory(mergeInventory({ local: rows, account: null, probed: [...probedDone] })) });
  };

  return function handle(req, res, path) {
    if (req.method !== 'GET') return false;
    if (path === '/inventory') { answer(res, 'local', 'local-only'); return true; }
    if (path === '/inventory/full') { answer(res, 'full', 'local-only'); return true; }
    return false;
  };
}
