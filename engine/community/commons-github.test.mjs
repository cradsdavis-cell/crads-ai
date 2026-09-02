// commons-github.test.mjs: the box-side GitHub API surface (commons usability
// overhaul, 2026-09-02). Fake GitHub via an injected fetcher, the same
// discipline own-brain uses; every path the UI shows a sentence for is pinned:
// invite-sent, already-collaborator, pending, and API-refusal.
//   node --test engine/community/commons-github.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import {
  createRepo, diagnoseAccess, ensureReadme, ghClient, inviteCollaborator,
  listCollaborators, listRepoInvitations, pendingInvitationForRepo,
  removeCollaboratorAccess, whoami,
} from './commons-github.mjs';
import { bundleFromLinkToken, deriveOrgId, githubRepoFromUrl, linkForBundle, mintBundle, parseBundle, readGhToken } from './commons-lib.mjs';

// A scripted fetcher: [method path] -> {status, body}. Records every call.
function fakeGithub(routes) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body) : undefined, auth: (init.headers || {}).authorization });
    const hit = routes[key];
    if (!hit) return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    const status = hit.status || 200;
    return { ok: status >= 200 && status < 300, status, json: async () => (hit.body === undefined ? null : hit.body) };
  };
  return { fetcher, calls };
}
const gh = (routes) => {
  const f = fakeGithub(routes);
  return { gh: ghClient({ token: 'tok-123', fetcher: f.fetcher, env: {} }), calls: f.calls };
};

test('the client sends the token as a Bearer header and survives a dead network as data', async () => {
  const { gh: c, calls } = gh({ 'GET /user': { body: { login: 'sam' } } });
  const me = await whoami(c);
  assert.deepEqual(me, { ok: true, login: 'sam' });
  assert.equal(calls[0].auth, 'Bearer tok-123');
  const dead = ghClient({ token: 't', fetcher: async () => { throw new Error('ECONNREFUSED'); }, env: {} });
  const r = await whoami(dead);
  assert.equal(r.ok, false);
  assert.match(r.detail, /ECONNREFUSED/);
});

test('createRepo: created, exists-and-pushable (adopt), exists-no-push, refused', async () => {
  let c = gh({ 'POST /user/repos': { status: 201, body: { full_name: 'sam/hg-commons' } } }).gh;
  assert.deepEqual(await createRepo(c, { name: 'hg-commons' }), { ok: true, created: true, fullName: 'sam/hg-commons' });

  c = gh({
    'POST /user/repos': { status: 422, body: { message: 'name already exists on this account' } },
    'GET /user': { body: { login: 'sam' } },
    'GET /repos/sam/hg-commons': { body: { private: true, permissions: { push: true } } },
  }).gh;
  const adopt = await createRepo(c, { name: 'hg-commons' });
  assert.equal(adopt.ok, true);
  assert.equal(adopt.created, false);
  assert.equal(adopt.fullName, 'sam/hg-commons');

  c = gh({
    'POST /user/repos': { status: 422, body: { message: 'name already exists on this account' } },
    'GET /user': { body: { login: 'sam' } },
    'GET /repos/sam/hg-commons': { body: { permissions: { push: false } } },
  }).gh;
  const noPush = await createRepo(c, { name: 'hg-commons' });
  assert.equal(noPush.ok, false);
  assert.match(noPush.reason, /cannot push/);

  c = gh({ 'POST /user/repos': { status: 403, body: { message: 'Resource not accessible' } }, 'GET /user': { body: { login: 'sam' } } }).gh;
  const refused = await createRepo(c, { name: 'hg-commons' });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /HTTP 403: Resource not accessible/);
});

test('ensureReadme writes once and keeps an existing one', async () => {
  const a = gh({ 'PUT /repos/sam/hg-commons/contents/README.md': { status: 201, body: {} } });
  assert.deepEqual(await ensureReadme(a.gh, { owner: 'sam', repo: 'hg-commons', text: '# HG' }), { ok: true, written: true });
  assert.equal(Buffer.from(a.calls[0].body.content, 'base64').toString('utf8'), '# HG');
  const kept = gh({ 'PUT /repos/sam/hg-commons/contents/README.md': { status: 422, body: { message: 'sha' } } }).gh;
  assert.deepEqual(await ensureReadme(kept, { owner: 'sam', repo: 'hg-commons' }), { ok: true, written: false });
});

test('inviteCollaborator: invited, already-collaborator, refused (with GitHub words attached)', async () => {
  const a = gh({ 'PUT /repos/sam/hg-commons/collaborators/astrid-h': { status: 201, body: { id: 77 } } });
  assert.deepEqual(await inviteCollaborator(a.gh, { owner: 'sam', repo: 'hg-commons', username: 'astrid-h' }),
    { state: 'invited', invitationId: 77 });
  assert.equal(a.calls[0].body.permission, 'pull', 'read access, never more');

  const b = gh({ 'PUT /repos/sam/hg-commons/collaborators/astrid-h': { status: 204, body: null } }).gh;
  assert.deepEqual(await inviteCollaborator(b, { owner: 'sam', repo: 'hg-commons', username: 'astrid-h' }), { state: 'already' });

  const c = gh({ 'PUT /repos/sam/hg-commons/collaborators/ghost': { status: 404, body: { message: 'Not Found' } } }).gh;
  const r = await inviteCollaborator(c, { owner: 'sam', repo: 'hg-commons', username: 'ghost' });
  assert.equal(r.state, 'refused');
  assert.match(r.detail, /HTTP 404: Not Found/);
});

test('the live roster reads: collaborators and pending invitations', async () => {
  const c = gh({
    'GET /repos/sam/hg-commons/collaborators': { body: [{ login: 'sam' }, { login: 'astrid-h' }] },
    'GET /repos/sam/hg-commons/invitations': { body: [{ id: 9, invitee: { login: 'juniper' } }, { id: 0, invitee: null }] },
  }).gh;
  assert.deepEqual(await listCollaborators(c, { owner: 'sam', repo: 'hg-commons' }), { ok: true, logins: ['sam', 'astrid-h'] });
  assert.deepEqual(await listRepoInvitations(c, { owner: 'sam', repo: 'hg-commons' }), { ok: true, invitations: [{ id: 9, login: 'juniper' }] });
  const dead = gh({}).gh;
  assert.equal((await listCollaborators(dead, { owner: 'sam', repo: 'hg-commons' })).ok, false);
});

test('removeCollaboratorAccess removes the collaborator and cancels a pending invite', async () => {
  const a = gh({
    'DELETE /repos/sam/hg-commons/collaborators/astrid-h': { status: 204, body: null },
    'GET /repos/sam/hg-commons/invitations': { body: [] },
  });
  assert.deepEqual(await removeCollaboratorAccess(a.gh, { owner: 'sam', repo: 'hg-commons', username: 'astrid-h' }),
    { ok: true, removed: true, cancelled: false });

  const b = gh({
    'DELETE /repos/sam/hg-commons/collaborators/juniper': { status: 404, body: { message: 'Not Found' } },
    'GET /repos/sam/hg-commons/invitations': { body: [{ id: 9, invitee: { login: 'Juniper' } }] },
    'DELETE /repos/sam/hg-commons/invitations/9': { status: 204, body: null },
  });
  const r = await removeCollaboratorAccess(b.gh, { owner: 'sam', repo: 'hg-commons', username: 'juniper' });
  assert.deepEqual(r, { ok: true, removed: false, cancelled: true }, 'a revoke before acceptance still lands');

  const c = gh({ 'GET /repos/sam/hg-commons/invitations': { body: [] } }).gh;
  const no = await removeCollaboratorAccess(c, { owner: 'sam', repo: 'hg-commons', username: 'x' });
  assert.equal(no.ok, false);
});

test('pendingInvitationForRepo finds exactly this repo, case-insensitively', async () => {
  const c = gh({
    'GET /user/repository_invitations': { body: [
      { repository: { full_name: 'Other/Thing' }, inviter: { login: 'x' } },
      { repository: { full_name: 'Sam/HG-Commons' }, inviter: { login: 'sam' } },
    ] },
  }).gh;
  assert.deepEqual(await pendingInvitationForRepo(c, { owner: 'sam', repo: 'hg-commons' }), { ok: true, found: true, from: 'sam' });
  assert.deepEqual(await pendingInvitationForRepo(c, { owner: 'sam', repo: 'nope' }), { ok: true, found: false });
});

test('diagnoseAccess: needs-github, pending-invite, and honest silence', async () => {
  const state = tmpDir('cgh-diag-');
  const rec = { org: 'hg-guild', url: 'https://github.com/sam/hg-commons.git' };
  // the token read is injected: a dev box's ambient gh sign-in must not leak in
  const noGh = () => { throw new Error('gh not installed'); };
  // no token anywhere on this box -> needs-github (no network call is made)
  assert.deepEqual(await diagnoseAccess(state, rec, { fetcher: async () => { throw new Error('never called'); }, env: {}, spawn: noGh }),
    { hint: 'needs-github' });
  // brain token present (the Backup card path) -> the invitation is looked up
  mkdirSync(path.join(state, '.kernel'), { recursive: true });
  writeFileSync(path.join(state, '.kernel', 'brain-github-token'), 'ghu_tok12345\n');
  const pending = fakeGithub({ 'GET /user/repository_invitations': { body: [{ repository: { full_name: 'sam/hg-commons' }, inviter: { login: 'sam' } }] } });
  assert.deepEqual(await diagnoseAccess(state, rec, { fetcher: pending.fetcher, env: {}, spawn: noGh }), { hint: 'pending-invite', from: 'sam' });
  const none = fakeGithub({ 'GET /user/repository_invitations': { body: [] } });
  assert.deepEqual(await diagnoseAccess(state, rec, { fetcher: none.fetcher, env: {}, spawn: noGh }), { hint: '' });
  // a non-github commons never reaches GitHub at all
  assert.deepEqual(await diagnoseAccess(state, { url: 'https://code.example.com/a/b' }, { fetcher: async () => { throw new Error('never'); }, env: {}, spawn: noGh }), { hint: '' });
});

// ---- the lib additions this module leans on --------------------------------

test('readGhToken falls back to the Backup card token file', () => {
  const state = tmpDir('cgh-token-');
  const noGh = () => { throw new Error('gh not installed'); };
  assert.equal(readGhToken(state, { spawn: noGh }), '');
  mkdirSync(path.join(state, '.kernel'), { recursive: true });
  writeFileSync(path.join(state, '.kernel', 'brain-github-token'), 'ghu_abcdef123\n');
  assert.equal(readGhToken(state, { spawn: noGh }), 'ghu_abcdef123');
  // gh still wins when it answers
  assert.equal(readGhToken(state, { spawn: () => 'gho_fromgh999\n' }), 'gho_fromgh999');
  // junk in the file is not a token
  writeFileSync(path.join(state, '.kernel', 'brain-github-token'), 'not a token\n');
  assert.equal(readGhToken(state, { spawn: noGh }), '');
});

test('githubRepoFromUrl names the repo for both shapes and refuses the rest', () => {
  assert.deepEqual(githubRepoFromUrl('https://github.com/sam/hg-commons.git'), { owner: 'sam', repo: 'hg-commons' });
  assert.deepEqual(githubRepoFromUrl('git@github.com:sam/hg-commons.git'), { owner: 'sam', repo: 'hg-commons' });
  assert.deepEqual(githubRepoFromUrl('https://github.com/sam/hg-commons'), { owner: 'sam', repo: 'hg-commons' });
  assert.equal(githubRepoFromUrl('https://code.example.com/a/b'), null);
  assert.equal(githubRepoFromUrl('ext::sh -c id'), null);
  assert.equal(githubRepoFromUrl(''), null);
});

test('deriveOrgId turns human words into a usable community id, or refuses', () => {
  assert.equal(deriveOrgId('Harbour Guild'), 'harbour-guild');
  assert.equal(deriveOrgId('  The  Tide__Collective! '), 'the-tide-collective');
  assert.equal(deriveOrgId('HG'), 'hg');
  assert.equal(deriveOrgId('!!!'), '');
  assert.equal(deriveOrgId(''), '');
  assert.equal(deriveOrgId('a'), '', 'one character is below the id floor');
  const long = deriveOrgId('x'.repeat(80));
  assert.ok(long.length <= 38 && long.length >= 2);
});

test('the join link round-trips the bundle and refuses everything else', () => {
  const bundle = mintBundle({ org: 'hg-guild', org_display: 'Harbour Guild', url: 'https://github.com/hg/c.git', branch: 'main' });
  const link = linkForBundle(bundle);
  assert.match(link, /^crads-ai:\/\/join-community\/[A-Za-z0-9_-]+$/, 'URL-safe by construction');
  const back = bundleFromLinkToken(link.slice('crads-ai://join-community/'.length));
  const p = parseBundle(back);
  assert.equal(p.ok, true, p.error);
  assert.equal(p.community.org, 'hg-guild');
  assert.equal(p.community.url, 'https://github.com/hg/c.git');
  assert.equal(linkForBundle('garbage'), '');
  assert.equal(bundleFromLinkToken('has spaces'), '');
  assert.equal(bundleFromLinkToken('x'.repeat(5000)), '');
  assert.equal(bundleFromLinkToken(''), '');
});
