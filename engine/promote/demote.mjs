#!/usr/bin/env node
// demote.mjs · stop being a rock. The inverse of promote, and deliberately fussier.
//
// Sam's ruling 2026-08-04: demote REFUSES while members remain. That is not a
// convenience check, it is the only thing standing between a demotion and a set
// of other people's boxes pointing at a rock that no longer exists.
// The same guard already exists twice elsewhere (the directory refuses to retire
// a handle carrying a live member edge; the panel refuses org teardown), so this
// inherits a rule the product already holds rather than inventing a third one.
//
// ORDER (simplified by the self-host strip, 2026-09-01 — the central directory
// that used to hold the org's public route is deleted, so there is no handle
// to retire any more):
//   1. refuse unless this box is actually a rock
//   2. refuse while any member is not 'left'
//   3. flip the record: the box is a pebble again
//
// NOTHING IS DELETED. The org brain stays on disk, exactly as it is, under the
// project's never-delete-archive rule. A demoted box is a pebble that happens to
// have an old org brain sitting in a directory, and re-promoting reuses it.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const STATE = process.env.AIOS_STATE_DIR || '/state';
const BRAIN = process.env.AIOS_BRAIN_ROOT || path.join(STATE, 'brain');
const die = (msg) => { console.error(`REFUSED: ${msg}`); process.exit(1); };

export function currentTier(stateDir = STATE) {
  try { return JSON.parse(readFileSync(path.join(stateDir, 'ownership.json'), 'utf8')).tier || ''; }
  catch { return ''; }
}

/* Every member this rock still holds. A row that is not 'left' is a live
   membership, whatever else it says: paused counts, because a paused member is
   one resume away from expecting a rock to be there. */
export function liveMembers(brainRoot = BRAIN) {
  const dir = path.join(brainRoot, 'registry', 'members');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.yaml') || f.startsWith('_')) continue;
    const y = readFileSync(path.join(dir, f), 'utf8');
    const status = (y.match(/^status:\s*"?([a-z]+)"?/m) || [, 'active'])[1];
    if (status !== 'left') out.push({ slug: f.replace(/\.yaml$/, ''), status });
  }
  return out;
}

function orgIdentity(brainRoot = BRAIN) {
  const p = path.join(brainRoot, 'org-policy.yaml');
  const y = existsSync(p) ? readFileSync(p, 'utf8') : '';
  return (y.match(/^\s*name:\s*"?([^"\n#]+)"?/m) || [])[1]?.trim() || '';
}

async function main() {
  if (currentTier() !== 'rock') die('this mineral is not a rock; there is nothing to demote.');

  const live = liveMembers();
  if (live.length) {
    die(`this rock still has ${live.length} member(s): `
      + `${live.map((m) => `${m.slug} (${m.status})`).join(', ')}. `
      + 'End every membership first. Demoting now would leave their minerals pointing at a rock that no longer exists.');
  }

  // (Step 3 used to retire the org handle at the central directory. The
  // directory is deleted — self-host strip, 2026-09-01 — so there is no public
  // route left to retire and no split brain a flip could cause. The
  // --leave-handle-registered override is accepted and ignored for old runbooks.)
  const org = orgIdentity();
  if (!org) die('this brain has no org handle in org-policy.yaml; refusing to guess what this rock was.');

  const ownPath = path.join(STATE, 'ownership.json');
  const own = existsSync(ownPath) ? JSON.parse(readFileSync(ownPath, 'utf8')) : {};
  // Reverse what promotion wrote, all of it: tier, owner and owner_slug. Leaving
  // owner:"org" behind pointed a retired rock at a rock that no longer
  // exists, and own-brain gates take-ownership on exactly that field, so the
  // person could never claim a box they owned outright. Anchor and machinery
  // facts are moved by other verbs and stay untouched here.
  const { owner_slug: _retired, ...rest } = own;
  writeFileSync(ownPath, `${JSON.stringify({ ...rest, tier: 'pebble', owner: 'member' }, null, 2)}\n`);

  console.log('OK: this mineral is a pebble again.');
  console.log(`The org brain at ${BRAIN} is untouched; nothing was deleted. Re-promoting would reuse it.`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
