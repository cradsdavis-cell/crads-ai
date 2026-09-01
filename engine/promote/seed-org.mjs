#!/usr/bin/env node
// seed-org.mjs · give THIS box an org brain, in place. The first half of promote.
//
// Sam's ruling 2026-08-04: promote means the box itself upgrades to a different
// kind, rather than a rock being started beside it. So the org brain has
// to come into existence on a box that is already a running pebble, without
// disturbing the personal brain that is already there.
//
// What it does, all idempotent so a partial run can simply be re-run:
//   1. refuse if this box is already a rock
//   2. create <handle>-brain under the platform account (skip if it exists)
//   3. seed it from brain-template with the org identity FILLED
//      (registry/org-identity.mjs, shared with the cockpit's door path)
//   4. clone it to <state>/brain and keep it out of the personal brain's git
//   5. state the new kind in ownership.json, which is what the app reads
//
// WHAT IT DELIBERATELY DOES NOT DO: touch the personal brain's contents, or
// swap the container image. The image swap is a separate step because it
// restarts the box, and a box should not restart until its brain is ready.
//
// CREDENTIALS: GITHUB ONLY (Sam's ruling, superseding the earlier "stage the
// full platform token set"). A promoted rock never provisions infrastructure,
// so it needs GitHub for its own brain repo and nothing else. No HCLOUD_TOKEN,
// no CF_API_TOKEN: the member is root on their own VM, so anything staged here
// is readable by them, and a Hetzner token is project-scoped across the whole
// fleet. This refuses rather than proceeding if the cloud tokens are present,
// because their presence means someone staged more than promotion needs.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STATE = process.env.AIOS_STATE_DIR || '/state';
const SECRETS = process.env.AIOS_SECRETS || path.join(STATE, 'secrets', 'provisioning.env.local');
const TEMPLATE_REPO = process.env.BRAIN_TEMPLATE_REPO || 'cradsdavis-cell/brain-template';
const API = process.env.GITHUB_API_URL || 'https://api.github.com';

const die = (msg) => { console.error(`REFUSED: ${msg}`); process.exit(1); };
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...opts });

// Read the staged env the way every other on-box consumer does.
function stagedEnv() {
  const raw = existsSync(SECRETS) ? readFileSync(SECRETS, 'utf8') : '';
  const out = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    out[t.slice(0, i).replace(/^export\s+/, '').trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/* The rock this box is anchored to, or '' when it stands alone.

   ownership.json's `anchor` is the ANCHOR RECORD — the uniform anchor rule's
   own store, which every box carries and which the lifecycle verbs maintain.
   It is read first, and MOUNTAIN there means the box is rooted at the platform
   and therefore anchored to no rock at all.

   The other two are evidence, not record, and are consulted only for boxes
   stamped before the anchor field existed. org-contact.json carries the
   anchor's HANDLE, the name a human would use ("certrock"); org-inbox.conf
   carries only the GitHub ACCOUNT ("cradsdavis-cell"), which is not the same
   thing and is not what to tell someone to go and ask, but its presence alone
   proves the box is anchored because org-sync refuses to run without it.

   Reading the contact card FIRST was a live dead end: eviction re-anchors the
   box to the Mountain and deliberately leaves the notice and the old contact
   card on disk so the member can see who ended the tie and why. Promotion then
   refused with "ask certrock to convert your membership" — and certrock is the
   rock that had just ended it, so there was nobody to ask, on exactly the
   promise eviction makes. */
const MOUNTAIN = 'crads-ai';
export function currentAnchor(stateDir = STATE) {
  try {
    const o = JSON.parse(readFileSync(path.join(stateDir, 'ownership.json'), 'utf8'));
    if (o && typeof o.anchor === 'string' && o.anchor.trim()) {
      const a = o.anchor.trim();
      return a === MOUNTAIN ? '' : a;
    }
  } catch { /* pre-anchor-field box: fall through to the evidence */ }
  try {
    const c = JSON.parse(readFileSync(path.join(stateDir, 'org-contact.json'), 'utf8'));
    if (c && typeof c.org === 'string' && c.org.trim()) return c.org.trim();
  } catch { /* fall through to the conf */ }
  try {
    const conf = readFileSync(path.join(stateDir, 'org-inbox.conf'), 'utf8');
    return (conf.match(/^ORG_GH_OWNER=(.*)$/m) || [, ''])[1].trim() || '';
  } catch { return ''; }
}

export function currentTier(stateDir = STATE) {
  try { return JSON.parse(readFileSync(path.join(stateDir, 'ownership.json'), 'utf8')).tier || ''; }
  catch { return ''; }
}

/* The personal brain is a git repo and the org brain lands INSIDE it, so it has
   to be ignored or every commit of the member's own brain would try to swallow
   the rock's. Same pattern org-sync uses for org-inbox/ and ssh/. */
export function ignoreOrgBrain(stateDir = STATE) {
  const p = path.join(stateDir, '.gitignore');
  const cur = existsSync(p) ? readFileSync(p, 'utf8') : '';
  if (/^brain\/$/m.test(cur)) return false;
  appendFileSync(p, (cur && !cur.endsWith('\n') ? '\n' : '') + 'brain/\n');
  return true;
}

async function main() {
  const handle = String(process.argv[2] || '').trim();
  const display = String(process.argv[3] || handle).trim();
  if (!/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/.test(handle)) die(`org handle must be a DNS-safe slug (got "${handle}")`);

  const tier = currentTier();
  if (tier === 'rock') die('this box is already a rock; nothing to seed. (Re-running after a partial promote is safe, but the tier is already flipped.)');

  // ROCKS CANNOT ANCHOR TO ROCKS (Sam's ruling). This box is ANCHORED to its
  // rock, and after promotion it must be self-anchored with the old rock
  // demoted to a community tie: exactly the re-anchor semantics
  // (registry/re-anchor.mjs already demotes a displaced anchor to a membership).
  //
  // The catch is WHERE the row lives: an anchored pebble's registry row sits on
  // its ANCHOR's brain, not its own, so converting it is a cross-box operation
  // this step cannot perform alone. Refusing is the only honest option: the
  // alternative is a box that calls itself a rock while its anchor's registry
  // still lists it as an anchored member, which the model calls illegal and
  // which nothing would ever reconcile.
  const anchor = currentAnchor();
  if (anchor) {
    die(`this box is anchored to "${anchor}", and a rock cannot be anchored to a rock. `
      + `Ask ${anchor} to convert your membership from anchored to community first `
      + '(their console, Retire/re-anchor), then promote. Nothing has been changed here.');
  }

  const env = stagedEnv();
  for (const k of ['HCLOUD_TOKEN', 'CF_API_TOKEN']) {
    if (env[k]) die(`${SECRETS} carries ${k}. A promoted rock provisions nothing and must hold GitHub credentials ONLY `
      + '(ruled 2026-08-04). Remove the cloud tokens from this box, then promote.');
  }
  const token = env.GITHUB_TOKEN || env.ORG_GH_TOKEN || process.env.GITHUB_TOKEN;
  const owner = env.GH_OWNER || env.ORG_GH_OWNER || process.env.GH_OWNER;
  if (!token || !owner) {
    die(`no platform GitHub credentials on this box (looked in ${SECRETS}). Promotion stages them before this step.`);
  }

  const repo = `${handle}-brain`;
  const full = `${owner}/${repo}`;
  const gh = (p, init) => fetch(`${API}${p}`, {
    ...init,
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers || {}) },
  });

  // 1. the repo, idempotently
  const found = await gh(`/repos/${full}`);
  if (found.status === 404) {
    const mk = await gh(`/user/repos`, { method: 'POST', body: JSON.stringify({ name: repo, private: true, auto_init: false, description: `${display} org brain (promoted)` }) });
    if (!mk.ok) die(`could not create ${full}: ${mk.status} ${(await mk.text()).slice(0, 200)}`);
    console.log(`created ${full}`);
  } else if (!found.ok) {
    die(`cannot reach ${full}: ${found.status}`);
  } else {
    console.log(`${full} already exists; reusing it`);
  }

  // 2. seed it from the template, identity FILLED
  const work = mkdtempSync(path.join(tmpdir(), `promote-${handle}-`));
  try {
    const seed = path.join(work, 'seed');
    run('git', ['clone', '--depth', '1', `https://x-access-token:${token}@github.com/${TEMPLATE_REPO}.git`, seed]);
    rmSync(path.join(seed, '.git'), { recursive: true, force: true });

    const { fillOrgIdentity, readOrgIdentity } = await import(path.join(seed, 'registry', 'org-identity.mjs'));
    const pol = path.join(seed, 'org-policy.yaml');
    writeFileSync(pol, fillOrgIdentity(readFileSync(pol, 'utf8'), { handle, display }));
    // Check our own work the way stamp-pebble, broker-register and edges-reflect
    // will read it: a rock that comes up unusable is expensive to notice.
    if (!readOrgIdentity(readFileSync(pol, 'utf8')).name) die('org identity did not take; refusing to seed an unusable rock');

    run('git', ['init', '-q', '-b', 'main'], { cwd: seed });
    run('git', ['config', 'user.email', 'box@crads-ai.com'], { cwd: seed });
    run('git', ['config', 'user.name', 'Crads-AI'], { cwd: seed });
    run('git', ['add', '-A'], { cwd: seed });
    run('git', ['commit', '-q', '-m', `seed ${display} org brain (promoted from a pebble)`], { cwd: seed });
    try {
      run('git', ['push', '-q', `https://x-access-token:${token}@github.com/${full}.git`, 'main:main'], { cwd: seed });
    } catch (e) {
      // A repo that already has a main branch is a re-run, not a failure.
      if (!/rejected|non-fast-forward|fetch first/i.test(String(e.stderr || e.message))) throw e;
      console.log('remote already has a main branch; leaving it as it is');
    }
  } finally { rmSync(work, { recursive: true, force: true }); }

  // 3. put it on the box, outside the personal brain's git
  const brainRoot = path.join(STATE, 'brain');
  if (!existsSync(path.join(brainRoot, '.git'))) {
    mkdirSync(path.dirname(brainRoot), { recursive: true });
    run('git', ['clone', '-q', `https://x-access-token:${token}@github.com/${full}.git`, brainRoot]);
    console.log(`org brain cloned to ${brainRoot}`);
  } else {
    console.log(`${brainRoot} already present; leaving it`);
  }
  if (ignoreOrgBrain()) console.log('added brain/ to the personal brain’s .gitignore');

  // 4. say what this box now is. The app reads exactly this.
  const ownPath = path.join(STATE, 'ownership.json');
  const own = existsSync(ownPath) ? JSON.parse(readFileSync(ownPath, 'utf8')) : {};
  writeFileSync(ownPath, `${JSON.stringify({ ...own, tier: 'rock' }, null, 2)}\n`);
  console.log('ownership.json now says tier "rock"; the app will show both faces on its next connection.');
  console.log(`OK: ${handle} has an org brain. The image swap is a separate step.`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
