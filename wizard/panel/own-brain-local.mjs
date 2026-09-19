// own-brain-local.mjs: make a LOCAL brain folder's repo the member's own
// (2026-09-11). The GitHub half of own-brain.mjs (D58 P3: prove the token,
// create the private <slug>-brain repo under THEIR account, tolerate
// already-exists), with local git in place of bridge(boxAlias, ...). The
// token lands at <folder>/.kernel/brain-github-token (0600, gitignored), the
// same place a box keeps it, so the credential helper is byte-for-byte the
// box's. github-device-flow.mjs is reused unchanged by the route that calls
// this; nothing here ever sees a browser.
//
// The org-owned receive gate and the heartbeat receipt of own-brain.mjs do
// not apply: a folder on your own disk has no rock above it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const API = 'https://api.github.com';
const IGNORES = ['.env', '.env.*', 'secrets/', '*.key', '*.pem', '.ssh/', 'ssh/', '.claude-auth/', '.claude-auth*', '.opencode-auth/', 'node_modules/', '.kernel/', '.mcp.json', '.claude/', 'cockpit/'];
const UNTRACK = ['.env', '.mcp.json', '.claude', '.claude-auth', '.opencode-auth', '.kernel', 'cockpit', 'secrets', 'ssh', '.ssh'];
export const TOKEN_FILE = path.join('.kernel', 'brain-github-token');

const runGit = (cwd, args, opts = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: opts.timeout || 60000, stdio: ['ignore', 'pipe', 'pipe'] });

export function ensureIgnores(box) {
  const p = path.join(box, '.gitignore');
  let text = ''; try { text = readFileSync(p, 'utf8'); } catch { text = ''; }
  const have = new Set(text.split('\n').map((l) => l.trim()));
  const add = IGNORES.filter((l) => !have.has(l));
  if (add.length) writeFileSync(p, text + (text && !text.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n');
  return add.length;
}

// The credential helper is a shell one-liner; git runs helpers through its
// own sh on every platform (Git for Windows ships one), so this is portable
// wherever git itself is.
const helperFor = (tokenPath) => `!f() { echo username=x-access-token; echo "password=$(cat ${JSON.stringify(tokenPath).slice(1, -1)})"; }; f`;

/**
 * Stage, untrack the credential paths, commit, push. Shared by the connect
 * flow and the app-open push. Returns { ok, detail }.
 */
export function commitAndPush(box, { slug = 'brain', git = runGit } = {}) {
  ensureIgnores(box);
  const init = git(box, ['init', '-q']);
  if (init.error) return { ok: false, detail: 'git is not installed on this computer' };
  git(box, ['add', '-A']);
  git(box, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', ...UNTRACK]);
  git(box, ['-c', `user.name=${slug}`, '-c', `user.email=${slug}@brain.local`, 'commit', '-q', '-m', 'own-brain: snapshot']);
  const push = git(box, ['push', '-q', '-u', 'origin', 'HEAD'], { timeout: Number(process.env.AIOS_OWN_BRAIN_PUSH_MS || 600000) });
  if (push.status !== 0) return { ok: false, detail: String(push.stderr || push.stdout || push.error || '').trim() };
  return { ok: true, detail: '' };
}

export async function ownBrainLocal({ slug, path: box, token, fetcher = fetch, log = () => {}, git = runGit, api = API } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(String(slug || ''))) return { ok: false, reason: 'bad slug' };
  if (!box || !token) return { ok: false, reason: 'missing path or token' };
  if (!existsSync(box)) return { ok: false, reason: `the brain folder is missing: ${box}` };
  const gh = async (p, init = {}) => {
    const r = await fetcher(api + p, { ...init, headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) } });
    let body = null; try { body = await r.json(); } catch { body = null; }
    return { ok: r.ok, status: r.status, body };
  };
  const me = await gh('/user');
  if (!me.ok || !me.body?.login) return { ok: false, reason: `GitHub sign-in not accepted (HTTP ${me.status})` };
  const login = me.body.login;
  const repoName = `${slug}-brain`;
  const repoPath = `${login}/${repoName}`;
  log(`signed in as ${login}`);
  const create = await gh('/user/repos', { method: 'POST', body: JSON.stringify({ name: repoName, private: true, description: `${slug}'s brain, owned by ${login}` }) });
  if (create.ok) log(`created private repo ${repoPath}`);
  else {
    const check = await gh(`/repos/${repoPath}`);
    if (!check.ok) return { ok: false, reason: `could not create ${repoPath} (HTTP ${create.status}) and it is not readable either` };
    if (check.body?.permissions && check.body.permissions.push === false) return { ok: false, reason: `${repoPath} exists but this account has no push access to it` };
    log(`repo ${repoPath} already exists; continuing`);
  }
  // the token: on this computer, in the folder, gitignored, 0600
  const tokenPath = path.join(box, TOKEN_FILE);
  try {
    mkdirSync(path.dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, token, { mode: 0o600 });
  } catch (e) { return { ok: false, reason: `could not store the brain credential in the folder: ${e.message || e}` }; }
  log('brain credential stored in the folder (yours, revocable from GitHub settings)');
  ensureIgnores(box);
  const init = git(box, ['init', '-q']);
  if (init.error) return { ok: false, reason: 'git is not installed on this computer, so nothing can be pushed. Install Git, then press Connect again.' };
  const url = `https://github.com/${repoPath}.git`;
  if (git(box, ['remote', 'get-url', 'origin']).status === 0) git(box, ['remote', 'set-url', 'origin', url]);
  else git(box, ['remote', 'add', 'origin', url]);
  git(box, ['config', 'credential.helper', helperFor(tokenPath)]);
  const r = commitAndPush(box, { slug, git });
  if (!r.ok) return { ok: false, reason: `brain push failed: ${r.detail}` };
  log(`brain pushed to ${repoPath}`);
  return { ok: true, repo: repoPath, pushed: true };
}

/**
 * brain-push.mjs's twin for local targets: on app open, push every local
 * brain that has an origin. Best-effort and fail-silent; a folder never
 * connected is simply not our business.
 */
export async function pushLocalBrains({ targets = [], log = () => {}, git = runGit } = {}) {
  const pushed = [], failed = [];
  for (const t of targets) {
    if (!t || t.kind !== 'local' || !t.path) continue;
    try {
      const probe = git(t.path, ['remote', 'get-url', 'origin']);
      if (probe.error || probe.status !== 0 || !String(probe.stdout || '').trim()) continue;
      const r = commitAndPush(t.path, { slug: t.org, git });
      if (r.ok) { pushed.push(t.host); log(`brain synced: ${t.host}`); }
      else { failed.push({ host: t.host, reason: r.detail }); log(`brain sync skipped (${t.host}): ${r.detail}`); }
    } catch (e) { failed.push({ host: t.host, reason: String(e && e.message || e) }); }
  }
  return { pushed, failed };
}
