// org-github.mjs · the ONE place the org's GitHub identity is resolved.
//
// WHY THIS FILE EXISTS. Fourteen scripts in this brain each carried their own
// copy of the same fallback chain, written by hand:
//
//   process.env.ORG_GH_TOKEN || env.ORG_GH_TOKEN || process.env.IC_ORG_TOKEN || ...
//
// They had already drifted (control/heartbeat-pull.mjs read two names where the
// rest read six, so it failed where they worked), and every one of them stopped
// at the credentials the OPERATOR provisioning path stages. A rock born through
// the door stages none of those on purpose: the 2026-08-09 ownership ruling says
// the platform's account must never be the default home for an organisation's
// artefacts, so provision-rock.sh blanks GH_OWNER in template mode and stages
// no token at all unless the rock is the platform's own metal.
//
// The consequence, found 2026-08-10 on test-org-4: a door-born rock could never
// stamp a pebble. Its first New Pebble died at a raw shell guard,
// "ORG_GH_OWNER + ORG_GH_TOKEN required (repo .env)", and nothing anywhere told
// the owner what to do about it. Meanwhile the credential the rock actually
// needs was sitting on the box: `connect-github` authorises the account the ORG
// owns and persists it at GH_CONFIG_DIR, which is exactly the identity that
// should own inbox-<slug>, heartbeat-<slug> and (for a rock-owned pebble)
// <slug>-brain.
//
// So there is one resolver, it knows about the connected account, and it refuses
// in words a rock owner can act on.
//
// Resolution order:
//   1. ORG_GH_OWNER / ORG_GH_TOKEN     explicit: process env, then the brain's .env
//   2. IC_ORG / IC_ORG_TOKEN           legacy names from the first deployment
//   3. GH_OWNER / GITHUB_TOKEN         staged by the operator provisioning path
//   4. the box's own connected GitHub  `gh auth token` + the brain remote's owner
//
// Rungs 1 to 3 must produce BOTH fields to win. A half-resolved pair (a staged
// platform token with no owner, which is what template mode actually produces
// when the platform stages its own tokens) is not a usable identity, and pairing
// its token with an owner read off the connected account would push the
// PLATFORM's credential at the ORG's repos. Coherence beats salvage: if rungs
// 1 to 3 leave either field empty, the connected account supplies both or the
// resolution fails.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONNECT_STEP = 'connect-github';

// Ordered (owner, token) name pairs for the staged and explicit rungs.
const NAME_RUNGS = [
  { owner: 'ORG_GH_OWNER', token: 'ORG_GH_TOKEN', from: 'ORG_GH_OWNER + ORG_GH_TOKEN' },
  { owner: 'IC_ORG', token: 'IC_ORG_TOKEN', from: 'the legacy IC_ORG names' },
  { owner: 'GH_OWNER', token: 'GITHUB_TOKEN', from: 'the staged provisioning env' },
];

const first = (...vals) => vals.map((v) => String(v ?? '').trim()).find(Boolean) || '';

/**
 * Pure decision core: no fs, no network, no subprocess. Everything the
 * resolution depends on arrives as an argument so the order is testable.
 *
 * @param {object}  env       process environment
 * @param {object}  dotenv    parsed brain-root .env
 * @param {?object} connected { owner, token } from the box's connected GitHub, or null
 * @returns {{owner:string, token:string, from:string, ok:boolean}}
 */
export function pickOrgGitHub({ env = {}, dotenv = {}, connected = null } = {}) {
  for (const rung of NAME_RUNGS) {
    const owner = first(env[rung.owner], dotenv[rung.owner]);
    const token = first(env[rung.token], dotenv[rung.token]);
    // Both, or neither. See the coherence note at the top of this file.
    if (owner && token) return { owner, token, from: rung.from, ok: true };
  }
  const owner = first(connected && connected.owner);
  const token = first(connected && connected.token);
  if (owner && token) return { owner, token, from: 'the GitHub account connected to this box', ok: true };
  return { owner: '', token: '', from: '', ok: false };
}

/** Parse a KEY=value .env the way the shell `. ./.env` would, minus expansion. */
export function parseDotenv(text = '') {
  const out = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

export function readDotenv(root) {
  try {
    const p = join(root, '.env');
    return existsSync(p) ? parseDotenv(readFileSync(p, 'utf8')) : {};
  } catch { return {}; }
}

/** owner out of either git@github.com:o/r.git or https://github.com/o/r.git */
export function ownerFromRemote(url = '') {
  const m = String(url).trim().match(/github\.com[:/]+([^/\s]+)\/[^/\s]+?(?:\.git)?\s*$/);
  return m ? m[1] : '';
}

/**
 * The box's connected GitHub, or null. Reads `gh`, which holds the account the
 * owner authorised with `connect-github`.
 *
 * The OWNER is taken from the brain's own origin remote first and only then from
 * the authenticated login, because the remote is the account the owner actually
 * chose for this box (it may be an organisation they belong to rather than their
 * personal login, and their personal login would be the wrong home).
 */
export function readConnected({ env = process.env, brainRoot = '' } = {}) {
  const ghDir = first(env.GH_CONFIG_DIR, '/state/.kernel/gh');
  const run = (args) => {
    try {
      return execFileSync('gh', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15000,
        env: { ...env, GH_CONFIG_DIR: ghDir },
      }).trim();
    } catch { return ''; }
  };
  const token = run(['auth', 'token']);
  if (!token) return null;
  let owner = '';
  if (brainRoot) {
    try {
      owner = ownerFromRemote(execFileSync('git', ['-C', brainRoot, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000,
      }));
    } catch { owner = ''; }
  }
  if (!owner) owner = run(['api', 'user', '-q', '.login']);
  return owner ? { owner, token } : null;
}

/**
 * The TOKEN alone, for a caller that already knows the remote it is pushing to
 * (auto-approve reads `git remote get-url origin`). The pair rule above exists
 * to stop the stamp path pairing one identity's token with another's owner;
 * where there is no owner to pair, it would only disarm a working fallback.
 * Order is the same, ending at the connected account.
 */
export function resolveOrgToken({ env = process.env, brainRoot = '' } = {}) {
  const dotenv = brainRoot ? readDotenv(brainRoot) : {};
  const named = first(...NAME_RUNGS.flatMap((r) => [env[r.token], dotenv[r.token]]));
  if (named) return named;
  const c = readConnected({ env, brainRoot });
  return (c && c.token) || '';
}

/** The full resolution, IO included. brainRoot is the brain that owns the .env. */
export function resolveOrgGitHub({ env = process.env, brainRoot = '' } = {}) {
  const dotenv = brainRoot ? readDotenv(brainRoot) : {};
  const staged = pickOrgGitHub({ env, dotenv, connected: null });
  // Only reach for `gh` when the cheap rungs have not already answered: the
  // subprocess costs ~50ms and every orchestrator script calls this on startup.
  if (staged.ok) return staged;
  return pickOrgGitHub({ env, dotenv, connected: readConnected({ env, brainRoot }) });
}

/**
 * What a person should be told when nothing resolves. Product copy: it names the
 * one action that fixes it, states that nothing was created, and keeps the
 * variable names for whoever is reading a log.
 */
export function refusal({ what = 'do this' } = {}) {
  return `This rock has no GitHub account connected, so it cannot ${what}.

A pebble needs three private repositories that your organisation owns: its update
inbox, its heartbeat, and (when the rock owns the pebble) its brain. Crads-AI never
holds those for you, so the rock has to push them to an account you own.

To connect one, once: open this rock's Terminal and run

    ${CONNECT_STEP}

then try again. Nothing has been created and no member has been changed.

(technical: ORG_GH_OWNER + ORG_GH_TOKEN unresolved. Checked, in order: the process
environment, the brain's .env, the legacy IC_ORG names, the staged provisioning env,
and gh auth in GH_CONFIG_DIR.)`;
}

/**
 * Does this token actually speak for this owner? Turns a mid-stamp 403, landed
 * after repos and a VM already exist, into an upfront refusal.
 * Returns { ok, reason }. A network failure is NOT a refusal: we cannot prove a
 * negative from a timeout, and blocking a stamp on GitHub being reachable from
 * this box would be a worse failure than the one it prevents.
 */
export function verifyOwner({ owner, token, env = process.env } = {}) {
  const api = (path) => {
    try {
      return execFileSync('gh', ['api', path], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000,
        env: { ...env, GH_TOKEN: token, GITHUB_TOKEN: token },
      });
    } catch { return null; }
  };
  const me = api('user');
  if (me === null) return { ok: true, reason: 'unverified: GitHub was not reachable from this box' };
  let login = '';
  try { login = JSON.parse(me).login || ''; } catch { return { ok: true, reason: 'unverified: unreadable response' }; }
  if (login.toLowerCase() === String(owner).toLowerCase()) return { ok: true, reason: `signed in as ${login}` };
  const orgs = api('user/orgs');
  let names = [];
  try { names = JSON.parse(orgs || '[]').map((o) => String(o.login || '').toLowerCase()); } catch { names = []; }
  if (names.includes(String(owner).toLowerCase())) return { ok: true, reason: `signed in as ${login}, a member of ${owner}` };
  return {
    ok: false,
    reason: `the connected GitHub account (${login}) cannot create repositories under "${owner}". `
      + `Connect an account that owns "${owner}", or set ORG_GH_OWNER to ${login}.`,
  };
}

// ---------------------------------------------------------------------------
// CLI. Two shapes, because both shells and node scripts consume this:
//   --export : shell assignments on stdout, refusal on stderr, exit 3 when unresolved
//   --json   : status for the app. NEVER prints the token, only whether it is set.
if (process.argv[1] && process.argv[1].endsWith('org-github.mjs')) {
  const mode = process.argv[2] || '--export';
  const brainRoot = process.env.AIOS_BRAIN_ROOT || process.env.BR || process.cwd();
  const r = resolveOrgGitHub({ brainRoot });
  if (mode === '--json') {
    process.stdout.write(JSON.stringify({
      connected: r.ok, owner: r.owner, source: r.from, token_set: Boolean(r.token),
    }) + '\n');
    process.exit(0);
  }
  if (!r.ok) { process.stderr.write(refusal({ what: 'create a member box' }) + '\n'); process.exit(3); }
  // Single-quoted with the standard '"'"' escape so a token containing quotes
  // cannot break out of the assignment when this is eval'd.
  const q = (s) => "'" + String(s).replace(/'/g, `'"'"'`) + "'";
  process.stdout.write(`export ORG_GH_OWNER=${q(r.owner)}\nexport ORG_GH_TOKEN=${q(r.token)}\nexport GH_TOKEN=${q(r.token)}\n`);
}

// ---------------------------------------------------------------- git + token
//
// A TOKEN MUST NOT BE IN A URL. Eleven scripts here built
// `https://x-access-token:${TOKEN}@github.com/...` and handed it to git as an
// ARGV element. Two consequences, both realised on 2026-08-10 when
// push-member-key hit a missing repo in front of Sam:
//
//   1. argv is world-readable on the box (`ps`), for as long as git runs.
//   2. execFileSync's Error message quotes the failing command VERBATIM, so the
//      live token was printed to the console, into a screenshot, and would have
//      gone into any log or bug report made from it.
//
// git's answer is a credential helper. The helper TEXT is in argv; the secret is
// not, it arrives through the pebble's environment. Errors are re-thrown with the
// token scrubbed, so a future failure cannot reprint it either.

const CRED_HELPER = '!f(){ echo username=x-access-token; echo "password=$AIOS_GH_PW"; };f';

/** The remote, with no credential in it. Safe to log, safe to store. */
export function plainRemote(owner, repo) {
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Run git with a token that never appears in argv.
 * @param {string[]} args   git arguments
 * @param {object}   o      { cwd, token, env }
 */
export function runGit(args, { cwd, token, env = process.env } = {}) {
  const full = ['-c', `credential.helper=${CRED_HELPER}`, ...args];
  try {
    return execFileSync('git', full, {
      cwd,
      stdio: 'pipe',
      env: { ...env, AIOS_GH_PW: token || '', GIT_TERMINAL_PROMPT: '0' },
    }).toString();
  } catch (e) {
    // Scrub before anything can print it: the message carries the whole command
    // and both output buffers.
    const scrub = (s) => (token ? String(s ?? '').split(token).join('<token>') : String(s ?? ''));
    const err = new Error(scrub(e.message));
    err.status = e.status;
    err.stdout = scrub(e.stdout);
    err.stderr = scrub(e.stderr);
    throw err;
  }
}
