// commons-lib.mjs: the shared vocabulary of the commons-repo model
// (self-host pivot, 2026-09-01; design: docs/self-host-design.md section 3).
//
// A rock is a community hub with no metal. What it shares with its members is
// a COMMONS: a plain git repo, on any host the owner chooses, holding the
// rock's curated skills, packs, prompts, pages and folders in the same layout
// a push-down inbox uses. A member's box pulls that repo read-only into
// /state/org-inbox.d/<org>/, which is exactly where a joined rock's inbox has
// always landed, so every existing pickup surface (catalog-list, prompts-list,
// dir-install, page-install, catalog-install) reads it with no new code.
//
// This module owns three things every side needs to agree on:
//   1. the join bundle: one copyable string, `cradscommons1:` + base64(JSON
//      {org, org_display, url, branch?}), minted by the rock owner and pasted
//      by the member. Parsing REFUSES loudly: a malformed bundle is named,
//      never guessed at.
//   2. git URL validation: https / ssh / scp-style / git URL shapes only.
//      Anything else (file:, ext::, a leading dash, whitespace, control
//      characters) is refused before git ever sees it. Tests may allow local
//      paths with AIOS_COMMONS_ALLOW_FILE=1; a bundle NEVER may.
//   3. the member-side community records (/state/communities.d/<org>.json)
//      and the git environment the puller and publisher run under, which pins
//      GIT_ALLOW_PROTOCOL so even a URL that slipped every check could not
//      reach an exotic transport.
//
// Nothing in here executes commons content. The commons is DATA until the
// member installs an item through the existing sandbox and lint gates.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const BUNDLE_PREFIX = 'cradscommons1:';
export const BUNDLE_MAX = 4096;

// The org id names the inbox directory and the conf file. It must satisfy the
// narrowest consumer: prompts-list's SAFE stem, dir-install's owner regex
// ([A-Za-z0-9][A-Za-z0-9-]{0,38}) and the catalogue merge's conf listing. Two
// to 38 characters, lowercase kebab, no leading or trailing hyphen.
export const ORG_RE = /^[a-z0-9][a-z0-9-]{0,36}[a-z0-9]$/;
export const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,98}$/;
const DISPLAY_MAX = 64;

// ---- git URL validation ----------------------------------------------------
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$/;
const USER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
// path part of a repo URL: no whitespace, no control chars, no leading dash,
// no dot-dot segments (git never needs them and they only ever spell trouble).
const PATH_RE = /^[A-Za-z0-9._~][A-Za-z0-9._~/-]{0,199}$/;
const hasDotDot = (p) => p.split('/').some((seg) => seg === '..');

// Accepts the four shapes a commons may live at and names the transport:
//   https://host/owner/repo(.git)      -> https
//   ssh://user@host(:port)/path       -> ssh
//   user@host:path (scp style)        -> ssh
//   git://host/path                   -> git
// With { allowFile: true } (tests and local fixtures only) an absolute path or
// file:// URL is also accepted as -> file. A bundle never passes allowFile.
export function validGitUrl(url, { allowFile = false } = {}) {
  if (typeof url !== 'string' || !url || url.length > 300) return { ok: false };
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(url)) return { ok: false };
  if (url[0] === '-') return { ok: false };
  let m;
  if ((m = url.match(/^https:\/\/([^/]+)\/(.+)$/))) {
    if (HOST_RE.test(m[1]) && PATH_RE.test(m[2]) && !hasDotDot(m[2])) return { ok: true, kind: 'https', host: m[1].replace(/:\d+$/, '') };
    return { ok: false };
  }
  if ((m = url.match(/^ssh:\/\/(?:([^@/]+)@)?([^/]+)\/(.+)$/))) {
    if ((!m[1] || USER_RE.test(m[1])) && HOST_RE.test(m[2]) && PATH_RE.test(m[3]) && !hasDotDot(m[3])) return { ok: true, kind: 'ssh', host: m[2].replace(/:\d+$/, '') };
    return { ok: false };
  }
  if ((m = url.match(/^git:\/\/([^/]+)\/(.+)$/))) {
    if (HOST_RE.test(m[1]) && PATH_RE.test(m[2]) && !hasDotDot(m[2])) return { ok: true, kind: 'git', host: m[1].replace(/:\d+$/, '') };
    return { ok: false };
  }
  if ((m = url.match(/^([^@:/]+)@([^:/]+):(.+)$/))) {
    if (USER_RE.test(m[1]) && HOST_RE.test(m[2]) && PATH_RE.test(m[3]) && !hasDotDot(m[3])) return { ok: true, kind: 'ssh', host: m[2] };
    return { ok: false };
  }
  if (allowFile) {
    if ((m = url.match(/^file:\/\/(\/.+)$/)) && !hasDotDot(m[1])) return { ok: true, kind: 'file', host: '' };
    if (url.startsWith('/') && !hasDotDot(url)) return { ok: true, kind: 'file', host: '' };
  }
  return { ok: false };
}

export const allowFileFromEnv = (env = process.env) => env.AIOS_COMMONS_ALLOW_FILE === '1';

// ---- the join bundle -------------------------------------------------------
const clean = (s, max) => String(s ?? '')
  // eslint-disable-next-line no-control-regex
  .replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);

export function mintBundle({ org, org_display, url, branch } = {}) {
  if (!ORG_RE.test(String(org || ''))) throw new Error('org must be 2-38 lowercase letters, digits or hyphens');
  if (!validGitUrl(String(url || '')).ok) throw new Error('url must be an https, ssh or git repository URL');
  const payload = { org: String(org), org_display: clean(org_display, DISPLAY_MAX) || String(org), url: String(url) };
  const b = clean(branch, 100);
  if (b) {
    if (!BRANCH_RE.test(b) || hasDotDot(b)) throw new Error('branch must be a plain branch name');
    payload.branch = b;
  }
  return BUNDLE_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

// Loud, specific refusals: the member pastes this by hand, so every failure
// says exactly what is wrong with what they pasted.
export function parseBundle(s) {
  const no = (error) => ({ ok: false, error });
  if (typeof s !== 'string') return no('a community bundle is one line of text');
  const t = s.trim();
  if (!t) return no('the bundle is empty. Copy it whole from the community owner.');
  if (t.length > BUNDLE_MAX) return no('that is too long to be a community bundle. Copy it exactly, nothing around it.');
  if (!t.startsWith(BUNDLE_PREFIX)) return no(`that does not look like a community bundle (it should start with "${BUNDLE_PREFIX}"). Copy it whole from the community owner.`);
  const body = t.slice(BUNDLE_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return no('the bundle is damaged (its encoded part is not base64). Copy it again from the community owner.');
  let b;
  try { b = JSON.parse(Buffer.from(body, 'base64').toString('utf8')); } catch { b = null; }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return no('the bundle is damaged (it does not decode to a community record). Copy it again from the community owner.');
  const org = String(b.org || '');
  if (!ORG_RE.test(org)) return no('the bundle is damaged (its community name is not usable). Ask the owner for a fresh one.');
  const urlCheck = validGitUrl(String(b.url || ''));
  if (!urlCheck.ok) return no('the bundle is damaged (its repository address is not an https, ssh or git URL). Ask the owner for a fresh one.');
  const out = {
    org,
    org_display: clean(b.org_display, DISPLAY_MAX) || org,
    url: String(b.url),
    urlKind: urlCheck.kind,
    urlHost: urlCheck.host,
  };
  if (b.branch !== undefined && b.branch !== null && String(b.branch) !== '') {
    const br = String(b.branch);
    if (!BRANCH_RE.test(br) || hasDotDot(br)) return no('the bundle is damaged (its branch name is not usable). Ask the owner for a fresh one.');
    out.branch = br;
  }
  return { ok: true, community: out };
}

// ---- member-side community records ----------------------------------------
export const communitiesDir = (state) => path.join(state, 'communities.d');
export const communityFile = (state, org) => path.join(communitiesDir(state), `${org}.json`);
export const inboxDirFor = (state, org) => path.join(state, 'org-inbox.d', org);
export const inboxConfFor = (state, org) => path.join(state, 'org-inbox.d', `${org}.conf`);

export function readCommunity(state, org) {
  try {
    const j = JSON.parse(readFileSync(communityFile(state, org), 'utf8'));
    if (j && typeof j === 'object' && ORG_RE.test(String(j.org || ''))) return j;
  } catch { /* absent or damaged: caller decides */ }
  return null;
}

export function listCommunities(state) {
  let names = [];
  try { names = readdirSync(communitiesDir(state)); } catch { return []; }
  const out = [];
  for (const f of names.sort()) {
    if (!f.endsWith('.json')) continue;
    const org = f.slice(0, -5);
    if (!ORG_RE.test(org)) continue;
    const rec = readCommunity(state, org);
    if (rec && rec.org === org) out.push(rec);
  }
  return out;
}

// tmp + rename, the same atomic-write idiom dir-install uses for its index.
export function writeCommunity(state, rec) {
  if (!rec || !ORG_RE.test(String(rec.org || ''))) throw new Error('community record needs a usable org');
  mkdirSync(communitiesDir(state), { recursive: true });
  const f = communityFile(state, rec.org);
  const tmp = `${f}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
  renameSync(tmp, f);
  return f;
}

export function removeCommunity(state, org) {
  if (!ORG_RE.test(String(org || ''))) return;
  rmSync(communityFile(state, org), { force: true });
}

// ---- the git environment ---------------------------------------------------
// The transport allow-list is the backstop behind URL validation: even a URL
// that somehow slipped through cannot make git spawn a helper (ext::), read a
// local path (unless a test said so), or use a transport we never meant.
export function gitEnvFor(community, { keyPath = '', env = process.env } = {}) {
  const out = {
    ...env,
    GIT_ALLOW_PROTOCOL: 'https:ssh:git' + (allowFileFromEnv(env) ? ':file' : ''),
    GIT_TERMINAL_PROMPT: '0',
  };
  const kind = (validGitUrl(String((community && community.url) || ''), { allowFile: allowFileFromEnv(env) }) || {}).kind;
  if (kind === 'ssh') {
    out.GIT_SSH_COMMAND = 'ssh '
      + (keyPath ? `-i ${keyPath} -o IdentitiesOnly=yes ` : '')
      + '-o BatchMode=yes -o StrictHostKeyChecking=accept-new';
  }
  return out;
}

// A GitHub https commons may be private with the member (or the rock owner)
// invited as a collaborator; their box already holds their own GitHub sign-in
// (connect-github / gh-token-refresh, GH_CONFIG_DIR=/state/.kernel/gh). The
// token is attached as an http.extraheader config flag, argv only, never
// shell, and ONLY for github.com: sending a GitHub token to whatever host a
// bundle names would hand the token to that host.
export function tokenArgsFor(url, token) {
  const v = validGitUrl(String(url || ''));
  if (!v.ok || v.kind !== 'https' || !token) return [];
  if (v.host !== 'github.com' && !v.host.endsWith('.github.com')) return [];
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return ['-c', `http.https://github.com/.extraheader=Authorization: Basic ${basic}`];
}

// Best-effort read of the box's own GitHub token. Injectable for tests.
export function readGhToken(state, { spawn = execFileSync } = {}) {
  try {
    const t = spawn('gh', ['auth', 'token'], {
      env: { ...process.env, GH_CONFIG_DIR: path.join(state, '.kernel', 'gh') },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim();
    return /^[A-Za-z0-9._-]{8,255}$/.test(t) ? t : '';
  } catch { return ''; }
}

// ---- the rock's commons conf ----------------------------------------------
// <state>/commons.conf: URL / BRANCH / ORG / ORG_DISPLAY lines, written by
// commons-admin init from validated fields. Read by regex, NEVER sourced.
export function readCommonsConf(state) {
  let raw = '';
  try { raw = readFileSync(path.join(state, 'commons.conf'), 'utf8'); } catch { return null; }
  const val = (key) => (raw.match(new RegExp(`^${key}=(.*)$`, 'm')) || [, ''])[1].trim();
  const url = val('URL');
  if (!url) return null;
  return {
    url,
    branch: val('BRANCH') || '',
    org: val('ORG') || '',
    org_display: val('ORG_DISPLAY') || val('ORG') || '',
  };
}

// ---- misc shared -----------------------------------------------------------
// Directory size in KB, symlinks counted as their link size, never followed.
export function duKb(dir) {
  let bytes = 0;
  const walk = (p) => {
    let entries;
    try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = path.join(p, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(fp);
      else if (e.isFile()) { try { bytes += statSync(fp).size; } catch { /* raced */ } }
    }
  };
  walk(dir);
  return Math.ceil(bytes / 1024);
}

export const maxKbFromEnv = (env = process.env) => {
  const n = parseInt(env.AIOS_COMMONS_MAX_KB || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 204800;   // 200 MB default
};
