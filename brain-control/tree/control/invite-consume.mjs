#!/usr/bin/env node
// invite-consume.mjs <slug> — after a device is approved in the panel, clear that member's
// staged redeem at the central broker (D51 Phase 2) so it stops showing as pending. The
// staged entry would auto-evict on its 10-minute TTL anyway; this just makes the panel's
// pending list honest immediately. Also prunes the local pending-devices.json mirror.
//
// Fail-silent like invite-reconcile.mjs: the broker is optional, exit 0 no matter what.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = process.argv[2];
if (!slug || !/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(slug)) { console.log('invite-consume: no valid slug; skipping.'); process.exit(0); }

const env = Object.fromEntries((await readFile(path.join(repoRoot, '.env'), 'utf8').catch(() => ''))
  .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

// Prune the local mirror first so the panel list is honest even if the broker call fails.
const out = path.join(repoRoot, 'control', 'pending-devices.json');
try {
  const list = JSON.parse(await readFile(out, 'utf8'));
  if (Array.isArray(list)) await writeFile(out, JSON.stringify(list.filter((d) => d && d.slug !== slug), null, 2));
} catch { /* no mirror yet */ }

// SELF-HOST STRIP (2026-09-01): the broker POST is gone — the central
// directory is deleted, so there is nothing staged centrally to clear. The
// local prune above is the whole job now. Authored upstream in brain-template;
// keep the two copies identical.
console.log(`invite-consume: pruned ${slug} from the local pending list.`);
