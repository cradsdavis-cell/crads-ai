// commons-github.mjs: the box-side GitHub API surface of the commons model
// (commons usability overhaul, 2026-09-02).
//
// Every call here runs ON THE BOX with the box's own stored token (gh sign-in
// or the Backup card's /state/.kernel/brain-github-token — readGhToken checks
// both), mirroring own-brain.mjs exactly: the token never leaves the box, the
// laptop never sees it, and revoking it on GitHub is the off-switch. Endpoints
// used, all under the token's `repo` scope:
//
//   GET  /user                                    whose account is this (proves the token)
//   POST /user/repos                              create the commons repo (owner's account)
//   PUT  /repos/{o}/{r}/contents/README.md        seed the README on create
//   PUT  /repos/{o}/{r}/collaborators/{username}  send the read (pull) collaborator invite
//   GET  /repos/{o}/{r}/collaborators             the live accepted list (roster merge)
//   GET  /repos/{o}/{r}/invitations               the live pending list (roster merge)
//   DELETE /repos/{o}/{r}/collaborators/{username} + /invitations/{id}   revoke
//   GET  /user/repository_invitations             member side: is my invite still pending?
//
// Injectable fetcher throughout (tests fake GitHub with a plain function);
// AIOS_GITHUB_API overrides the base URL so spawned-CLI tests can point the
// scripts at a local fixture server. Refusals come back as data with GitHub's
// own message attached, never thrown, so every caller can put the honest
// sentence on screen.
import { githubRepoFromUrl, readGhToken } from './commons-lib.mjs';

export const apiBase = (env = process.env) => String(env.AIOS_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');

const detailOf = (r) => {
  const msg = r && r.body && typeof r.body.message === 'string' ? r.body.message : '';
  return msg ? `HTTP ${r.status}: ${msg.slice(0, 160)}` : `HTTP ${r ? r.status : 0}${r && r.error ? `: ${String(r.error).slice(0, 160)}` : ''}`;
};

export function ghClient({ token, fetcher = fetch, env = process.env } = {}) {
  const base = apiBase(env);
  return async function gh(method, path, body) {
    let r;
    try {
      r = await fetcher(base + path, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'crads-ai-box',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      return { ok: false, status: 0, body: null, error: String((e && e.message) || e) };
    }
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    return { ok: r.ok, status: r.status, body: j };
  };
}

export async function whoami(gh) {
  const r = await gh('GET', '/user');
  if (!r.ok || !r.body || !r.body.login) return { ok: false, detail: detailOf(r) };
  return { ok: true, login: String(r.body.login) };
}

// Create the commons repo under the signed-in account. Tolerates an existing
// repo of the same name exactly the way own-brain does: adopt it when this
// account can push to it, refuse in words otherwise.
export async function createRepo(gh, { name, isPrivate = true, description = '' } = {}) {
  const create = await gh('POST', '/user/repos', { name, private: !!isPrivate, description, auto_init: false });
  if (create.ok) return { ok: true, created: true, fullName: String((create.body || {}).full_name || '') };
  const me = await whoami(gh);
  if (!me.ok) return { ok: false, reason: `GitHub sign-in not accepted (${me.detail})` };
  const check = await gh('GET', `/repos/${me.login}/${name}`);
  if (!check.ok) return { ok: false, reason: `GitHub refused to create ${name} (${detailOf(create)})` };
  if (check.body && check.body.permissions && check.body.permissions.push === false) {
    return { ok: false, reason: `${me.login}/${name} already exists and this account cannot push to it` };
  }
  return { ok: true, created: false, fullName: `${me.login}/${name}`, isPrivate: !!(check.body && check.body.private) };
}

// Seed the README on a fresh repo. A repo that already carries one keeps it
// (the contents API refuses a sha-less PUT over an existing file, which is
// exactly the behaviour we want).
export async function ensureReadme(gh, { owner, repo, text } = {}) {
  const r = await gh('PUT', `/repos/${owner}/${repo}/contents/README.md`, {
    message: 'commons: name the community',
    content: Buffer.from(String(text || ''), 'utf8').toString('base64'),
  });
  if (r.ok) return { ok: true, written: true };
  if (r.status === 422) return { ok: true, written: false };   // already has one: kept
  return { ok: false, detail: detailOf(r) };
}

// The owner's half of ruling 2: the box sends the read invite itself.
//   'invited'  — GitHub created (or re-issued) a pending invitation
//   'already'  — the account is a collaborator now; nothing more to do
//   'refused'  — GitHub said no; detail carries its words for the screen
export async function inviteCollaborator(gh, { owner, repo, username } = {}) {
  const r = await gh('PUT', `/repos/${owner}/${repo}/collaborators/${username}`, { permission: 'pull' });
  if (r.status === 204) return { state: 'already' };
  if (r.ok && r.body && r.body.id) return { state: 'invited', invitationId: r.body.id };
  if (r.ok) return { state: 'invited' };
  return { state: 'refused', detail: detailOf(r) };
}

export async function listCollaborators(gh, { owner, repo } = {}) {
  const r = await gh('GET', `/repos/${owner}/${repo}/collaborators?per_page=100`);
  if (!r.ok || !Array.isArray(r.body)) return { ok: false, detail: detailOf(r) };
  return { ok: true, logins: r.body.map((c) => String((c && c.login) || '')).filter(Boolean) };
}

export async function listRepoInvitations(gh, { owner, repo } = {}) {
  const r = await gh('GET', `/repos/${owner}/${repo}/invitations?per_page=100`);
  if (!r.ok || !Array.isArray(r.body)) return { ok: false, detail: detailOf(r) };
  return {
    ok: true,
    invitations: r.body
      .map((i) => ({ id: i && i.id, login: String((i && i.invitee && i.invitee.login) || '') }))
      .filter((i) => i.id && i.login),
  };
}

// Revoke's GitHub half: remove the collaborator AND cancel any still-pending
// invitation, so a revoke before the invite was accepted also lands.
export async function removeCollaboratorAccess(gh, { owner, repo, username } = {}) {
  const del = await gh('DELETE', `/repos/${owner}/${repo}/collaborators/${username}`);
  let removed = del.status === 204;
  let cancelled = false;
  const inv = await listRepoInvitations(gh, { owner, repo });
  if (inv.ok) {
    const mine = inv.invitations.find((i) => i.login.toLowerCase() === String(username).toLowerCase());
    if (mine) {
      const d2 = await gh('DELETE', `/repos/${owner}/${repo}/invitations/${mine.id}`);
      cancelled = d2.status === 204;
    }
  }
  if (removed || cancelled) return { ok: true, removed, cancelled };
  return { ok: false, detail: detailOf(del) };
}

// The member's half of ruling 3: when a private commons cannot be read, ask
// GitHub whether an invitation for exactly that repo is sitting unaccepted.
export async function pendingInvitationForRepo(gh, { owner, repo } = {}) {
  const r = await gh('GET', '/user/repository_invitations?per_page=100');
  if (!r.ok || !Array.isArray(r.body)) return { ok: false, detail: detailOf(r) };
  const want = `${owner}/${repo}`.toLowerCase();
  const hit = r.body.find((i) => String((i && i.repository && i.repository.full_name) || '').toLowerCase() === want);
  if (!hit) return { ok: true, found: false };
  return { ok: true, found: true, from: String((hit.inviter && hit.inviter.login) || owner) };
}

// One honest word about WHY a github-shaped commons cannot be read:
//   'needs-github'   this box has no GitHub sign-in at all
//   'pending-invite' the owner's invitation is sitting unaccepted (from = who sent it)
//   ''               neither provable: plain access-ended (never invited, or revoked)
// The one sentence the member should read for each diagnosis, shared by
// community-join and community-check so the two doors cannot drift apart.
// Empty string = no specific advice; the caller keeps its generic copy.
export function accessAdvice(d) {
  if (d && d.hint === 'pending-invite') {
    return `GitHub sent you an invitation email from ${d.from || 'the community owner'} that has not been accepted yet. Accept it on github.com (the email lands wherever your GitHub account gets mail), then press Check again.`;
  }
  if (d && d.hint === 'needs-github') {
    return 'this shared library is private and this mineral has no GitHub sign-in to read it with. Connect GitHub on Your mineral (the Backup card), then press Check again.';
  }
  return '';
}

export async function diagnoseAccess(state, rec, { fetcher = fetch, env = process.env, spawn } = {}) {
  const at = githubRepoFromUrl(rec && rec.url);
  if (!at) return { hint: '' };
  const token = readGhToken(state, spawn ? { spawn } : {});
  if (!token) return { hint: 'needs-github' };
  const gh = ghClient({ token, fetcher, env });
  const p = await pendingInvitationForRepo(gh, at);
  if (p.ok && p.found) return { hint: 'pending-invite', from: p.from };
  return { hint: '' };
}
