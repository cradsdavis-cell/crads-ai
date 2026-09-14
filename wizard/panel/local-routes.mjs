// local-routes.mjs: the door's "On this computer" flow (the no-server face,
// 2026-09-11). Mounted by door-server the way provision-routes is.
//
//   POST /local/create        {name, path?}  -> {ok, alias, slug, path, created, git}
//   GET  /local/status                       -> {brains:[{alias, slug, name, path, state}]}
//   GET  /local/setup-steps?box=<alias>      -> {reachable, github:{connected, repo}, claude:null, path}
//
// The local twin of setup-steps.mjs (the box probe, lines 31-38) reads the
// same two facts off the folder: the origin remote in .git/config, and the
// credential file. The Claude fact is answered null on purpose: a folder has
// no sign-in of its own (Claude Code on this computer is the sign-in), so the
// door's local checklist carries an "open it in Claude Code" step, never a
// chip that could read "not yet" forever.
//
// Custody: nothing here takes a token. GitHub rides the door's existing
// /own-brain routes, whose ownBrain call is dispatched to own-brain-local for
// a -local alias (ownBrainDispatch below).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { LOCAL_HOST_RE, defaultBrainDir, listLocalTargets, localAliasFor, registerLocalBrain, slugForName } from './local-targets.mjs';
import { dirState, scaffoldLocalBrain } from './local-scaffold.mjs';
import { ownBrainLocal } from './own-brain-local.mjs';
import { stripRepoUrl } from './setup-steps.mjs';

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

// Expand a leading ~ (the door offers "~/Crads-AI/<name>" as the default in
// words, and a person may type it back); everything else must be absolute.
export function resolveBrainPath(input, home = homedir()) {
  let p = String(input || '').trim();
  if (!p) return '';
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(home, p.slice(2));
  if (!path.isAbsolute(p)) return '';
  return path.resolve(p);
}

/**
 * @param {object} o
 *   assets      the engine assets bag (required for create)
 *   targets     () => listLocalTargets() (injectable)
 *   register    (slug, {path,name}) => {ok}  (injectable)
 *   scaffold    (box, {name, assets}) => Promise<{created, git}> (injectable)
 *   home        home dir for the default path (tests)
 */
export function localRoutes({ assets = null, targets = listLocalTargets, register = registerLocalBrain, scaffold = scaffoldLocalBrain, home = homedir() } = {}) {
  let busy = false;
  return function handleLocal(req, res, p) {
    if (req.method === 'GET' && p === '/local/status') {
      const brains = (targets() || []).map((t) => ({ alias: t.host, slug: t.org, name: t.name, path: t.path, state: dirState(t.path) }));
      json(res, 200, { brains });
      return true;
    }
    if (req.method === 'GET' && p === '/local/setup-steps') {
      const want = new URL(req.url, 'http://x').searchParams.get('box') || '';
      const t = LOCAL_HOST_RE.test(want) ? (targets() || []).find((x) => x.host === want) : null;
      if (!t) { json(res, 400, { error: 'that brain is not one this app knows' }); return true; }
      if (!existsSync(t.path)) { json(res, 200, { reachable: false, github: null, claude: null, path: t.path }); return true; }
      let cfg = ''; try { cfg = readFileSync(path.join(t.path, '.git', 'config'), 'utf8'); } catch { cfg = ''; }
      const url = ((cfg.match(/\[remote "origin"\][\s\S]*?url\s*=\s*(\S+)/) || [])[1] || '').trim();
      json(res, 200, { reachable: true, github: { connected: !!url, repo: url ? stripRepoUrl(url) : '' }, claude: null, path: t.path });
      return true;
    }
    if (req.method === 'POST' && p === '/local/create') {
      if (!/application\/json/i.test(String(req.headers['content-type'] || ''))) { json(res, 415, { error: 'json only' }); return true; }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
      req.on('end', () => {
        let form;
        try { form = JSON.parse(body || '{}'); } catch { json(res, 400, { error: 'bad json' }); return; }
        const name = String(form.name || '').trim().slice(0, 60);
        if (!name || /[\x00-\x1f\x7f]/.test(name)) { json(res, 400, { error: 'give your assistant a name (1 to 60 characters)' }); return; }
        const slug = slugForName(name, new Set((targets() || []).map((t) => t.org)));
        const box = form.path ? resolveBrainPath(form.path, home) : defaultBrainDir(slug, home);
        if (!box) { json(res, 400, { error: 'the folder must be a full path (or start with ~/)' }); return; }
        const state = dirState(box);
        if (state === 'occupied') { json(res, 400, { error: `${box} already has other files in it. Pick an empty folder, a folder that is already a brain, or leave the field blank for the default.` }); return; }
        if (!assets) { json(res, 500, { error: 'this build has no engine files to scaffold with' }); return; }
        if (busy) { json(res, 409, { error: 'another brain is still being made; wait for it' }); return; }
        busy = true;
        (async () => {
          try {
            const r = await scaffold(box, { name, assets });
            // an adopted brain keeps the name it already had; the registry
            // records that one, so the door and the panel agree with the folder
            const finalName = r.name || name;
            const reg = register(slug, { path: box, name: finalName });
            if (!reg.ok) { json(res, 500, { error: `the brain was made but could not be registered: ${reg.reason}` }); return; }
            json(res, 200, { ok: true, alias: localAliasFor(slug), slug, name: finalName, path: box, existed: state === 'brain', created: r.created, git: r.git });
          } catch (e) {
            json(res, 500, { error: `could not make the brain folder: ${String(e && e.message || e).slice(0, 200)}` });
          } finally { busy = false; }
        })();
      });
      return true;
    }
    return false;
  };
}

/**
 * The own-brain call, routed by alias: a -local alias runs the local flow on
 * the folder, anything else runs the box flow (own-brain.mjs) unchanged.
 * Both the door and the panel mount createOwnBrainRoutes with this as
 * opts.ownBrain, so "Connect GitHub" is one button on every face.
 */
export function ownBrainDispatch({ targets = listLocalTargets, box = null, local = ownBrainLocal } = {}) {
  return async function ownBrainByAlias({ slug, boxAlias, token, bridge, fetcher, log } = {}) {
    if (LOCAL_HOST_RE.test(String(boxAlias || ''))) {
      const t = (targets() || []).find((x) => x.host === boxAlias);
      if (!t) return { ok: false, reason: 'that brain is not one this app knows' };
      return local({ slug: t.org, path: t.path, token, ...(fetcher ? { fetcher } : {}), log });
    }
    const ob = box || (await import('./own-brain.mjs')).ownBrain;
    return ob({ slug, boxAlias, token, bridge, ...(fetcher ? { fetcher } : {}), log });
  };
}

/** The precheck probe, routed the same way: a folder is never org-owned. */
export function precheckDispatch({ targets = listLocalTargets, ssh = null } = {}) {
  return async function precheckByAlias(host, cmd) {
    if (LOCAL_HOST_RE.test(String(host || '')) && (targets() || []).some((t) => t.host === host)) return { code: 0, stdout: '', stderr: '' };
    const run = ssh || (await import('./ssh-bridge.mjs')).runSsh;
    return run(host, cmd);
  };
}
