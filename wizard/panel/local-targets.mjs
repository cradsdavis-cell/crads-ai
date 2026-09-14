// local-targets.mjs: the no-server face's registry (Sam's ruling 2026-09-11).
//
// A "local" target is a brain FOLDER on this computer, not a box. The app
// opens against it, the panel verbs run on the folder in-process, and Claude
// Code opens the folder directly. Nothing about it lives in ~/.ssh/config, so
// listPanelTargets (ssh-bridge.mjs) can never see one; this module is the
// second source app.mjs merges in.
//
// The registry is ~/.crads-ai/local-brains.json, beside box-kinds.json and
// last-used.json, in the same shape and with the same rules as the promoted
// registry (ssh-bridge.mjs:184): AIOS_LOCAL_BRAINS_PATH overrides for tests,
// resolved at call time; a corrupt or unreadable file is an EMPTY registry,
// never a crash; every write is a whole-file rewrite.
//
//   { "<slug>": { "path": "/abs/path", "name": "Idris" } }
//
// A target row is { host: '<slug>-local', org: slug, kind: 'local', path,
// name }. `host` keeps the alias shape every gate in panel-server, last-used
// and inventory already switches on, so a local brain flows through the one
// face with a third suffix rather than a second code path.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const LOCAL_SUFFIX = '-local';
export const LOCAL_HOST_RE = /^[a-z0-9][a-z0-9-]{0,62}-local$/;
export const LOCAL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

export const localBrainsPath = () => process.env.AIOS_LOCAL_BRAINS_PATH || join(homedir(), '.crads-ai', 'local-brains.json');

export const localAliasFor = (slug) => `${slug}${LOCAL_SUFFIX}`;
export const slugFromLocalAlias = (alias) => String(alias || '').replace(/-local$/, '');

// Read the whole registry. Read on EVERY call rather than cached: a test
// points the path at a temp file mid-process, and the door registers a brain
// the panel must see on its next /targets without a restart.
function readRegistry(path = localBrainsPath()) {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return {};
    const out = {};
    for (const [slug, rec] of Object.entries(j)) {
      if (!LOCAL_SLUG_RE.test(slug) || !rec || typeof rec !== 'object') continue;
      const p = String(rec.path || '');
      if (!p || !isAbsolute(p)) continue;
      out[slug] = { path: p, name: String(rec.name || '').slice(0, 60) };
    }
    return out;
  } catch { return {}; }
}

function writeRegistry(map, path = localBrainsPath()) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(map, null, 2) + '\n');
    return true;
  } catch { return false; }
}

/** Every local brain this computer knows, as panel target rows. */
export function listLocalTargets(path = localBrainsPath()) {
  return Object.entries(readRegistry(path)).map(([slug, rec]) => ({
    host: localAliasFor(slug), org: slug, kind: 'local', path: rec.path, name: rec.name || slug,
  }));
}

/** The row for one alias, or null. */
export function localTargetFor(host, path = localBrainsPath()) {
  return listLocalTargets(path).find((t) => t.host === String(host || '')) || null;
}

export function registerLocalBrain(slug, { path: brainPath, name = '' } = {}, registryPath = localBrainsPath()) {
  if (!LOCAL_SLUG_RE.test(String(slug || ''))) return { ok: false, reason: 'bad slug' };
  const p = String(brainPath || '');
  if (!p || !isAbsolute(p)) return { ok: false, reason: 'path must be absolute' };
  const map = readRegistry(registryPath);
  map[slug] = { path: resolve(p), name: String(name || '').slice(0, 60) };
  return writeRegistry(map, registryPath)
    ? { ok: true, alias: localAliasFor(slug) }
    : { ok: false, reason: 'could not write the registry' };
}

export function unregisterLocalBrain(slug, registryPath = localBrainsPath()) {
  const map = readRegistry(registryPath);
  if (!(slug in map)) return { ok: true, removed: false };
  delete map[slug];
  return { ok: writeRegistry(map, registryPath), removed: true };
}

// A slug from a display name: lowercase, [a-z0-9-], runs collapsed, 32 chars,
// then made unique against the registry (idris, idris-2, ...). Same shape as
// engine/lib/open-folder.mjs safeName, bounded to the panel's SLUG_RE.
// `taken` is the set of slugs already in use (the caller's registry read,
// so a test's injected registry and the app's real one behave alike).
export function slugForName(name, taken = new Set()) {
  let s = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
  if (s.length < 2) s = s ? `${s}-brain` : 'brain';
  taken = new Set(taken instanceof Set ? [...taken] : (taken || []));
  if (!taken.has(s)) return s;
  for (let n = 2; n < 100; n++) { const c = `${s}-${n}`; if (!taken.has(c)) return c; }
  return `${s}-${Date.now().toString(36)}`;
}

export const defaultBrainDir = (slug, home = homedir()) => join(home, 'Crads-AI', slug);

export const registryExists = (path = localBrainsPath()) => existsSync(path);
