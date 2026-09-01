// open-folder.mjs: the folder Claude Code opens, named after the mineral (R18,
// panel iteration 2, 2026-08-23).
//
// Both faces now land in /state (enter-aios drops `-w /state/brain` on rocks),
// so the Claude Code folder picker shows the same thing on a pebble and on a
// rock: the box root. Inside it, ONE entry is named after the mineral and
// points at the brain root:
//
//   pebble            /state/<name> -> .        (the brain IS /state)
//   rock              /state/<name> -> brain    (relative, survives a volume move)
//   promoted rock     /state/<name> -> .        (its brain is the box root too)
//
// The chosen name is written to /state/open-folder (one line) so the app and
// the Help copy can read it without recomputing. Idempotent on every boot: a
// stale link is replaced, a real directory of that name is NEVER clobbered
// (logged and skipped, next candidate tried), and when no candidate can be
// linked the file says `state`, which the app maps to plain /state.
//
// Name order: the slug the directory knows this box by (secrets/box_reg_host
// first label, or AIOS_BOX_HOST), then the rock-wired slug (org-inbox.conf),
// then for rocks the deployment name / org-policy name / ownership owner_slug.
// ownership.json owner_slug is NOT used on a pebble: there it names the owning
// ROCK, not the pebble (seed-pages.mjs writes the anchor org into it).
// Fallback: control-centre.
//
//   node engine/lib/open-folder.mjs <stateDir> [brainRoot]
import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrainRoot } from './brain-root.mjs';

export const FALLBACK_NAME = 'control-centre';
export const NO_LINK_NAME = 'state';
export const OPEN_FOLDER_FILE = 'open-folder';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// A filesystem-safe form: lowercase, [a-z0-9-], runs collapsed, 40 chars.
export function safeName(raw) {
  const s = String(raw || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return NAME_RE.test(s) ? s : '';
}

const rd = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const yamlField = (text, field) => {
  const m = String(text).match(new RegExp(`^\\s*${field}:\\s*"?([^"\\n#]*)"?`, 'm'));
  return m ? m[1].trim() : '';
};

/** Candidate names in preference order (already sanitised, deduplicated, non-empty). */
export function nameCandidates(stateDir, { brainRoot, env = process.env } = {}) {
  const at = (...p) => path.join(stateDir, ...p);
  const own = (() => { try { return JSON.parse(rd(at('ownership.json'))); } catch { return null; } })();
  const firstLabel = (host) => String(host || '').trim().toLowerCase().split('.')[0];
  const out = [];
  out.push(firstLabel(rd(at('secrets', 'box_reg_host'))));
  out.push(firstLabel(env.AIOS_BOX_HOST));
  out.push((rd(at('org-inbox.conf')).match(/^SLUG=(.*)$/m) || [])[1]);
  if (own && own.tier === 'rock') {
    out.push(yamlField(rd(at('deployment.yaml')), 'deployment_name'));
    out.push(yamlField(rd(path.join(brainRoot || stateDir, 'org-policy.yaml')), 'name'));
    out.push(own.owner_slug);
  }
  out.push(FALLBACK_NAME);
  const seen = new Set();
  return out.map(safeName).filter((n) => n && !seen.has(n) && seen.add(n));
}

/** The link target, relative to stateDir: '.' when the brain IS the box root. */
export function linkTarget(stateDir, brainRoot) {
  const rel = path.relative(path.resolve(stateDir), path.resolve(brainRoot));
  return rel === '' ? '.' : rel;
}

/**
 * Ensure /state/<name> -> <brain root>, write /state/open-folder.
 * Returns { name, link, target, action } where action is one of
 * created | kept | replaced | none (no candidate could be linked) and
 * skipped[] lists real entries that were left alone.
 */
export function ensureOpenFolder(stateDir, { brainRoot, env = process.env, log = () => {} } = {}) {
  const root = brainRoot || resolveBrainRoot(stateDir, { env });
  const target = linkTarget(stateDir, root);
  const skipped = [];
  let result = null;
  for (const name of nameCandidates(stateDir, { brainRoot: root, env })) {
    const link = path.join(stateDir, name);
    let st = null;
    try { st = lstatSync(link); } catch { /* absent */ }
    if (st && !st.isSymbolicLink()) {
      log(`open-folder: ${link} is a real ${st.isDirectory() ? 'directory' : 'file'}, left alone`);
      skipped.push(name);
      continue;
    }
    if (st && st.isSymbolicLink()) {
      let cur = '';
      try { cur = readlinkSync(link); } catch { /* unreadable link: replace it */ }
      if (cur === target) { result = { name, link, target, action: 'kept' }; break; }
      unlinkSync(link);
      symlinkSync(target, link);
      result = { name, link, target, action: 'replaced' };
      break;
    }
    mkdirSync(stateDir, { recursive: true });
    symlinkSync(target, link);
    result = { name, link, target, action: 'created' };
    break;
  }
  if (!result) result = { name: NO_LINK_NAME, link: null, target, action: 'none' };

  // A previous boot may have linked a different name (slug changed, fallback
  // no longer needed): retire that link if it is ours, so /state carries one
  // mineral-named entry, not a trail of old ones.
  const file = path.join(stateDir, OPEN_FOLDER_FILE);
  const prev = safeName(rd(file).split('\n')[0]);
  if (prev && prev !== result.name && prev !== NO_LINK_NAME) {
    const old = path.join(stateDir, prev);
    try {
      const ost = lstatSync(old);
      if (ost.isSymbolicLink() && readlinkSync(old) === target) unlinkSync(old);
    } catch { /* nothing to retire */ }
  }
  if (rd(file) !== result.name + '\n') writeFileSync(file, result.name + '\n');
  return { ...result, skipped };
}

// CLI form, used by engine/box-up.sh and provisioning/rock/boot-rock.sh.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stateDir = process.argv[2];
  if (!stateDir) { console.error('usage: open-folder.mjs <stateDir> [brainRoot]'); process.exit(2); }
  try {
    const r = ensureOpenFolder(stateDir, { brainRoot: process.argv[3] || undefined, log: (m) => console.error(m) });
    console.log(`open-folder: ${r.name} (${r.action}${r.link ? `, ${r.link} -> ${r.target}` : ''})`);
  } catch (e) {
    console.error(`open-folder: ${e && e.message || e}`);
    process.exit(1);
  }
}
