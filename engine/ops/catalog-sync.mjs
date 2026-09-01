#!/usr/bin/env node
// catalog-sync.mjs (D57): pull the vendor skill catalog granted to THIS deployment
// into the rock's skills-library, so granted packages show up in the panel's
// Skills tab and are pushable to members via the existing skill-push pipeline.
//
// The channel is the ic-inbox pattern one tier up: the vendor (Crads-AI) pushes
// packages into a private per-deployment repo (crads-catalog-<deployment>); this
// box pulls it with a READ-ONLY deploy key. The key IS the entitlement: grant =
// vendor pushes a package + the box holds the key; revoke = revoke the key.
// Pull-only, one-way: the vendor never reads anything out of this box.
//
// STAGED, NOT BAKED: nothing here names a deployment. Config arrives at runtime:
//   /state/deployment.yaml  catalog_repo: git@github.com:<vendor>/crads-catalog-<name>.git
//   /state/secrets/catalog_deploy_key   (read-only deploy key for that repo)
// Both absent -> clean no-op, so every existing deployment is unaffected.
//
// Granted-repo layout (see docs/vendor-catalog-channel.md):
//   packages/<package-id>/package.yaml
//   packages/<package-id>/skills/<skill-id>/SKILL.md   (required)
//   packages/<package-id>/skills/<skill-id>/skill.yaml (required, must carry `source: crads-ai`)
//
// Install rules:
//   - each skill dir is copied to $BRAIN_ROOT/skills-library/<skill-id>/
//   - a skill WITHOUT `source: crads-ai` in its skill.yaml is refused (the vendor
//     marks its own material; the marker is also the collision guard below)
//   - an existing library skill whose skill.yaml lacks the marker is ORG-AUTHORED:
//     never clobbered, we warn and skip (vendor packages cannot overwrite org work)
//   - the library change is committed to the brain repo (best-effort push)
//
//   node catalog-sync.mjs            (env: STATE_DIR=/state, BRAIN_ROOT=/state/brain)
//   exit 0 always unless the pull itself errors (a granted repo that fails to
//   sync is worth failing loud in a cron; an unconfigured box is not).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const STATE_DIR = process.env.STATE_DIR || '/state';
const BRAIN_ROOT = process.env.BRAIN_ROOT || path.join(STATE_DIR, 'brain');
const DEPLOY_FILE = process.env.DEPLOY_FILE || path.join(STATE_DIR, 'deployment.yaml');
const KEY_FILE = process.env.CATALOG_KEY || path.join(STATE_DIR, 'secrets', 'catalog_deploy_key');
const CHECKOUT = process.env.CATALOG_DIR || path.join(STATE_DIR, '.rock', 'catalog');
const LIBRARY = path.join(BRAIN_ROOT, 'skills-library');
const MARKER = /^source:\s*["']?crads-ai["']?\s*$/m;

const log = (s) => console.log(s);

// Tiny flat-YAML scalar reader (same shape as boot-rock.sh / build-index.mjs).
function scalar(raw, key) {
  const m = raw.match(new RegExp('^' + key + ':\\s*"?([^"\\n#]*)"?', 'm'));
  return m ? m[1].trim() : '';
}

let repo = '';
try { repo = scalar(readFileSync(DEPLOY_FILE, 'utf8'), 'catalog_repo'); } catch {}
if (!repo) { log('catalog: no catalog_repo in deployment.yaml, nothing granted (no-op)'); process.exit(0); }
if (!existsSync(KEY_FILE)) { log(`catalog: catalog_repo is set but no deploy key at ${KEY_FILE} (no-op)`); process.exit(0); }
if (!existsSync(BRAIN_ROOT)) { log(`catalog: brain not staged at ${BRAIN_ROOT} (no-op)`); process.exit(0); }

const GIT_ENV = {
  ...process.env,
  GIT_SSH_COMMAND: `ssh -i ${KEY_FILE} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
};
const git = (args, opts = {}) =>
  execFileSync('git', args, { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });

// ---- pull (clone once, fetch+reset after: the vendor repo is authoritative) ----
try {
  if (existsSync(path.join(CHECKOUT, '.git'))) {
    git(['-C', CHECKOUT, 'fetch', '--depth', '1', 'origin']);
    try { git(['-C', CHECKOUT, 'reset', '--hard', 'origin/HEAD']); }
    catch { git(['-C', CHECKOUT, 'reset', '--hard', 'FETCH_HEAD']); }
  } else {
    mkdirSync(path.dirname(CHECKOUT), { recursive: true });
    git(['clone', '--depth', '1', repo, CHECKOUT]);
  }
} catch (e) {
  console.error(`catalog: pull failed for ${repo}: ${String(e.stderr || e.message).trim()}`);
  process.exit(1);
}

// ---- install granted skills into the brain's skills-library ----
const pkgRoot = path.join(CHECKOUT, 'packages');
const dirs = (p) => { try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };
let installed = 0, skipped = 0;
for (const pkg of dirs(pkgRoot)) {
  for (const id of dirs(path.join(pkgRoot, pkg, 'skills'))) {
    const src = path.join(pkgRoot, pkg, 'skills', id);
    const meta = path.join(src, 'skill.yaml');
    if (!existsSync(path.join(src, 'SKILL.md')) || !existsSync(meta)) {
      log(`catalog: SKIP ${pkg}/${id} (needs both SKILL.md and skill.yaml)`); skipped++; continue;
    }
    if (!MARKER.test(readFileSync(meta, 'utf8'))) {
      log(`catalog: SKIP ${pkg}/${id} (skill.yaml lacks "source: crads-ai")`); skipped++; continue;
    }
    const dst = path.join(LIBRARY, id);
    const dstMeta = path.join(dst, 'skill.yaml');
    if (existsSync(dstMeta) && !MARKER.test(readFileSync(dstMeta, 'utf8'))) {
      log(`catalog: SKIP ${pkg}/${id} (an ORG-AUTHORED skill with this id exists; not clobbering it)`); skipped++; continue;
    }
    mkdirSync(dst, { recursive: true });
    cpSync(src, dst, { recursive: true });
    log(`catalog: installed ${id} (package ${pkg})`);
    installed++;
  }
}
log(`catalog: ${installed} installed, ${skipped} skipped`);

// ---- record the change in the brain repo (best-effort; the panel/org cron pushes) ----
if (installed > 0 && existsSync(path.join(BRAIN_ROOT, '.git'))) {
  try {
    git(['-C', BRAIN_ROOT, 'add', 'skills-library']);
    try { git(['-C', BRAIN_ROOT, 'diff', '--cached', '--quiet']); }
    catch {
      git(['-C', BRAIN_ROOT, '-c', 'user.name=AI OS catalog', '-c', 'user.email=catalog@ai-os.local',
        'commit', '-q', '-m', `catalog: sync ${installed} vendor skill(s)`]);
      try { git(['-C', BRAIN_ROOT, 'push']); } catch { log('catalog: commit recorded, push deferred'); }
    }
  } catch { log('catalog: library updated (no brain commit made)'); }
}
