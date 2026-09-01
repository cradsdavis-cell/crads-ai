#!/usr/bin/env node
// commons-pull.mjs: the member-side transport of the commons-repo model
// (self-host pivot, 2026-09-01; docs/self-host-design.md section 3).
//
//   node commons-pull.mjs <state-dir> [org]
//
// For every community recorded under <state>/communities.d/ (or just [org]),
// pull its commons repo READ-ONLY into <state>/org-inbox.d/<org>/, which is
// the exact place a joined rock's inbox lands, so everything downstream
// (catalog-list's merge, prompts-list, dir-install, page-install,
// catalog-install) reads the commons with no new code. A conf shim
// (<state>/org-inbox.d/<org>.conf with COMMONS=1 + ORG=<org>) makes the
// catalogue merge and the installers resolve the community by handle;
// org-sync.sh skips COMMONS=1 confs because this script owns their sync.
//
// SECURITY POSTURE, stated plainly:
//   - Pulling NEVER executes commons content. This script runs git and writes
//     a conf shim from validated fields; nothing from the repo is sourced,
//     spawned, or evaluated. Installation stays the member's explicit act
//     through the existing verbs and their lint/sandbox gates.
//   - Unlike org-sync's anchor leg, there is deliberately NO heartbeat leg,
//     NO device-key leg, NO evict/re-anchor leg here: a commons is content
//     only, and a hostile commons gets no lever beyond its files sitting in
//     an inbox directory.
//   - The URL is re-validated on every run (defence in depth behind the
//     bundle parse), git runs with GIT_ALLOW_PROTOCOL pinned, and a size cap
//     (AIOS_COMMONS_MAX_KB, default 200 MB) removes a checkout that tries to
//     fill the disk.
//   - A pull that starts failing with an access error (revoked collaborator,
//     repo made private, repo deleted) surfaces ONCE as "your access to <org>
//     commons has ended", honestly, then goes quiet; existing pulled content
//     and everything installed stays, per the standing revocation ruling.
import { existsSync, mkdirSync, renameSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  ORG_RE, allowFileFromEnv, duKb, gitEnvFor, inboxConfFor, inboxDirFor,
  listCommunities, maxKbFromEnv, readCommunity, readGhToken, tokenArgsFor,
  validGitUrl, writeCommunity,
} from './commons-lib.mjs';

const log = (s) => console.log(`[commons] ${s}`);

// GitHub answers a revoked or deleted private repo with "Repository not
// found" on purpose (existence is itself private), so not-found reads as
// access-ended too. A plain network failure stays transient and quiet.
const ACCESS_RE = /permission denied|authentication failed|access denied|could not read Username|could not read Password|invalid credentials|not found|does not exist|not appear to be a git repository|HTTP 40[13]/i;

function ensureGitignore(state) {
  const gi = path.join(state, '.gitignore');
  let txt = '';
  try { txt = readFileSync(gi, 'utf8'); } catch { /* absent */ }
  const need = ['org-inbox.d/'];
  const missing = need.filter((l) => !txt.split('\n').includes(l));
  if (missing.length) appendFileSync(gi, (txt && !txt.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
}

function ensureConfShim(state, org) {
  const conf = inboxConfFor(state, org);
  const want = `COMMONS=1\nORG=${org}\n`;
  let have = '';
  try { have = readFileSync(conf, 'utf8'); } catch { /* absent */ }
  if (have !== want) {
    mkdirSync(path.dirname(conf), { recursive: true });
    writeFileSync(`${conf}.tmp`, want);
    renameSync(`${conf}.tmp`, conf);
  }
}

// One community, one honest outcome. Exported so community-join can run the
// first pull inline and report it in the same words.
export function pullOne(state, rec, { spawn = execFileSync, ghToken } = {}) {
  const org = String(rec.org || '');
  if (!ORG_RE.test(org)) return { org, status: 'error', line: 'unusable community record (bad org), skipped' };
  const allowFile = allowFileFromEnv();
  const v = validGitUrl(String(rec.url || ''), { allowFile });
  if (!v.ok) return { org, status: 'error', line: `${org}: its recorded repository address is not usable; leave and re-join with a fresh bundle` };

  ensureGitignore(state);
  ensureConfShim(state, org);

  const dest = inboxDirFor(state, org);
  const keyPath = path.join(state, 'secrets', `commons_key.${org}`);
  const env = gitEnvFor(rec, { keyPath: existsSync(keyPath) ? keyPath : '' });
  // The gh sign-in is only consulted for a github.com https commons; any other
  // host never sees the token, and no other transport needs it.
  const wantsToken = v.kind === 'https' && (v.host === 'github.com' || (v.host || '').endsWith('.github.com'));
  const token = ghToken !== undefined ? ghToken : (wantsToken ? readGhToken(state, { spawn }) : '');
  const tokenArgs = tokenArgsFor(rec.url, token);
  const branch = rec.branch ? [String(rec.branch)] : [];

  const runGit = (args, cwd) => spawn('git', [...tokenArgs, ...args], {
    cwd, env, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
  });

  let failed = '';
  try {
    if (existsSync(path.join(dest, '.git'))) {
      runGit(['-C', dest, 'fetch', '--depth', '1', 'origin', ...branch]);
      runGit(['-C', dest, 'reset', '--hard', 'FETCH_HEAD']);
      runGit(['-C', dest, 'clean', '-fdq']);
    } else {
      mkdirSync(path.dirname(dest), { recursive: true });
      runGit(['clone', '--depth', '1', '--single-branch',
        ...(rec.branch ? ['-b', String(rec.branch)] : []), '--', String(rec.url), dest]);
    }
  } catch (e) {
    failed = String((e && (e.stderr || e.message)) || e).trim();
  }

  const now = new Date().toISOString();
  if (failed) {
    if (ACCESS_RE.test(failed)) {
      const first = rec.status !== 'access-ended' || !rec.ended_notified;
      writeCommunity(state, { ...rec, status: 'access-ended', ended_at: rec.ended_at || now, ended_notified: true, last_error: failed.slice(0, 300) });
      if (first) {
        const line = `your access to the ${rec.org_display || org} commons has ended. What you already installed stays yours; new content will no longer arrive. If this is unexpected, ask the community owner.`;
        log(`${org}: ${line}`);
        return { org, status: 'access-ended', line };
      }
      return { org, status: 'access-ended', line: '' };   // already said once; stay quiet
    }
    writeCommunity(state, { ...rec, last_error: failed.slice(0, 300) });
    log(`${org}: pull did not complete (network or host trouble); keeping what is already here.`);
    return { org, status: 'transient', line: failed.slice(0, 200) };
  }

  // Size cap: a commons that tries to fill the disk is removed, said once.
  const kb = duKb(dest);
  if (kb > maxKbFromEnv()) {
    rmSync(dest, { recursive: true, force: true });
    const first = rec.status !== 'oversized';
    writeCommunity(state, { ...rec, status: 'oversized', last_error: `checkout is ${kb} KB, over the ${maxKbFromEnv()} KB cap`, ended_notified: false });
    const line = `the ${rec.org_display || org} commons is larger than this box accepts (${Math.max(1, Math.round(kb / 1024))} MB); its content was not kept. Ask the community owner to slim it down.`;
    if (first) log(`${org}: ${line}`);
    return { org, status: 'oversized', line: first ? line : '' };
  }

  let sha = '';
  try { sha = runGit(['-C', dest, 'rev-parse', '--short', 'HEAD']).trim(); } catch { /* fine */ }
  const recovered = rec.status === 'access-ended';
  writeCommunity(state, {
    ...rec, status: 'joined', last_ok: now, last_sha: sha,
    last_error: undefined, ended_notified: undefined, ended_at: undefined,
  });
  if (recovered) log(`${org}: access is back; the commons is syncing again.`);
  return { org, status: 'ok', sha };
}

// CLI entry point only (same guard idiom as prompts-list.mjs).
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const [state, onlyOrg] = process.argv.slice(2).map((s) => String(s || ''));
  if (!state) { console.log('usage: commons-pull <state-dir> [org]'); process.exit(1); }
  const recs = onlyOrg
    ? [readCommunity(state, onlyOrg)].filter(Boolean)
    : listCommunities(state);
  if (!recs.length) process.exit(0);   // no communities: clean no-op on every existing box
  let synced = 0;
  for (const rec of recs) {
    const r = pullOne(state, rec);
    if (r.status === 'ok') { synced++; log(`${r.org}: synced${r.sha ? ` (${r.sha})` : ''}.`); }
  }
  log(`${synced}/${recs.length} communities synced.`);
}
