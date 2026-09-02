// commons-admin.test.mjs: the rock owner's commons config, roster ledger and
// bundle minting (self-host pivot, 2026-09-01).
//   node --test engine/community/commons-admin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { bundleFromLinkToken, parseBundle } from './commons-lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ADMIN = path.join(HERE, 'commons-admin.mjs');

// A dev box's ambient gh sign-in must never leak into these spawns: tokens are
// blanked by default, and "the box has a token" is staged deliberately via the
// Backup card's own file (readGhToken's fallback).
function rig() {
  const root = tmpDir('commons-admin-');
  const state = path.join(root, 'state');
  const brain = path.join(root, 'brain');
  const run = (cmd, { input, arg, arg2, env } = {}) => spawnSync(process.execPath,
    [ADMIN, state, brain, cmd, ...(arg ? [arg] : []), ...(arg2 ? [arg2] : [])],
    { input: input === undefined ? '' : input, encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', ...(env || {}) } });
  // The API-backed paths need the fake server (below) to ANSWER while the CLI
  // runs, and spawnSync blocks this process's event loop, which deadlocks the
  // pair. Those tests run the CLI asynchronously instead.
  const runAsync = (cmd, { input, arg, arg2, env } = {}) => new Promise((resolve) => {
    const p = spawn(process.execPath,
      [ADMIN, state, brain, cmd, ...(arg ? [arg] : []), ...(arg2 ? [arg2] : [])],
      { env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', ...(env || {}) } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (c) => { stdout += c; });
    p.stderr.on('data', (c) => { stderr += c; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
    p.stdin.end(input === undefined ? '' : input);
  });
  const stageToken = () => {
    mkdirSync(path.join(state, '.kernel'), { recursive: true });
    writeFileSync(path.join(state, '.kernel', 'brain-github-token'), 'ghu_testtoken1\n');
  };
  return { state, brain, run, runAsync, stageToken };
}

// A real loopback GitHub for the spawned CLIs (AIOS_GITHUB_API points at it).
function fakeGithub(routes) {
  const calls = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const key = `${req.method} ${String(req.url).split('?')[0]}`;
      calls.push({ key, body: body ? JSON.parse(body) : undefined, auth: req.headers.authorization });
      const hit = routes[key];
      res.writeHead(hit ? (hit.status || 200) : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(hit ? (hit.body === undefined ? {} : hit.body) : { message: 'Not Found' }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`,
    calls,
    close: () => new Promise((r) => srv.close(r)),
  })));
}
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n';

test('init writes the conf and the optional deploy key at 0600', (t) => {
  const { state, run } = rig();
  const r = run('init', { input: JSON.stringify({ url: 'https://github.com/hg/hg-commons.git', branch: 'main', org: 'harbour-guild', org_display: 'Harbour Guild', key: KEY }) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK: this rock's commons is https:\/\/github.com\/hg\/hg-commons.git \(branch main\), shared as "Harbour Guild" \(harbour-guild\)\. Deploy key saved\./);
  assert.equal(readFileSync(path.join(state, 'commons.conf'), 'utf8'),
    'URL=https://github.com/hg/hg-commons.git\nBRANCH=main\nORG=harbour-guild\nORG_DISPLAY=Harbour Guild\n');
  const keyPath = path.join(state, 'secrets', 'commons_deploy_key');
  assert.equal(readFileSync(keyPath, 'utf8'), KEY);
  assert.equal(statSync(keyPath).mode & 0o777, 0o600, 'key is private to the box user');
});

test('init refuses a bad url, a bad org and a non-key paste, loudly', () => {
  const { state, run } = rig();
  for (const [body, re] of [
    [{ url: 'file:///etc', org: 'hg-x' }, /url must be/],
    [{ url: 'ext::sh -c id', org: 'hg-x' }, /url must be/],
    [{ url: 'https://github.com/a/b', org: 'Bad Org' }, /community name/],
    [{ url: 'https://github.com/a/b', org: 'hg-x', branch: '-e' }, /branch/],
    [{ url: 'https://github.com/a/b', org: 'hg-x', key: 'ssh-ed25519 AAAA not-a-private-key' }, /deploy key/],
  ]) {
    const r = run('init', { input: JSON.stringify(body) });
    assert.equal(r.status, 1, JSON.stringify(body));
    assert.match(r.stdout, re);
  }
  const bad = run('init', { input: 'not json' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /JSON body/);
  assert.ok(!existsSync(path.join(state, 'commons.conf')), 'nothing written by any refusal');
});

test('status: unconfigured is a state, not an error; configured carries the facts', () => {
  const { run } = rig();
  let s = JSON.parse(run('status').stdout.replace(/^COMMONS_STATE /, ''));
  assert.equal(s.configured, false);
  run('init', { input: JSON.stringify({ url: 'https://github.com/hg/c.git', org: 'hg-x', org_display: 'HGX' }) });
  s = JSON.parse(run('status').stdout.replace(/^COMMONS_STATE /, ''));
  assert.equal(s.configured, true);
  assert.equal(s.org, 'hg-x');
  assert.equal(s.org_display, 'HGX');
  assert.equal(s.key_present, false);
  assert.deepEqual(s.roster, { active: 0, revoked: 0 });
  assert.equal(s.last_publish, null);
});

test('grant: records the roster row in the BRAIN (never the commons), mints the bundle AND its join link', () => {
  const { brain, run } = rig();
  run('init', { input: JSON.stringify({ url: 'https://github.com/hg/c.git', branch: 'main', org: 'hg-x', org_display: 'HGX' }) });
  const r = run('grant', { input: JSON.stringify({ label: 'Astrid H', email: 'astrid@example.com', github: 'astrid-h' }) });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /OK: Astrid H is recorded \(g-[a-z0-9]+\)/);
  assert.match(r.stdout, /out of band/);
  // no token on this box: the invitation could not be sent, and that is said
  // along with the manual step, rather than pretending
  assert.match(r.stdout, /could not send astrid-h's invitation itself/);
  assert.match(r.stdout, /invite their GitHub account as a READ collaborator/);
  const bundleLine = r.stdout.split('\n').find((l) => l.startsWith('cradscommons1:'));
  const p = parseBundle(bundleLine);
  assert.equal(p.ok, true, p.error);
  assert.deepEqual(p.community, { org: 'hg-x', org_display: 'HGX', url: 'https://github.com/hg/c.git', urlKind: 'https', urlHost: 'github.com', branch: 'main' });
  const linkLine = r.stdout.split('\n').find((l) => l.startsWith('JOIN_LINK '));
  assert.ok(linkLine, 'the clickable join link rides the grant output');
  const token = linkLine.slice('JOIN_LINK '.length).replace('crads-ai://join-community/', '');
  assert.equal(bundleFromLinkToken(token), bundleLine, 'the link decodes back to exactly this bundle');
  const roster = JSON.parse(readFileSync(path.join(brain, 'registry', 'commons-roster.json'), 'utf8'));
  assert.equal(roster.grants.length, 1);
  assert.equal(roster.grants[0].label, 'Astrid H');
  assert.equal(roster.grants[0].status, 'active');
});

test('grant sends the GitHub invitation itself: invited, already-collaborator, refused', async () => {
  const { run, runAsync, stageToken } = rig();
  run('init', { input: JSON.stringify({ url: 'https://github.com/hg/hg-commons.git', org: 'hg-x' }) });
  stageToken();
  // invited
  let api = await fakeGithub({ 'PUT /repos/hg/hg-commons/collaborators/astrid-h': { status: 201, body: { id: 7 } } });
  let r = await runAsync('grant', { input: JSON.stringify({ label: 'Astrid', github: 'astrid-h' }), env: { AIOS_GITHUB_API: api.url } });
  await api.close();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /GitHub invitation sent to astrid-h \(read access to hg\/hg-commons\)/);
  assert.match(r.stdout, /accept it from GitHub's email/);
  assert.ok(!/invite their GitHub account as a READ collaborator/.test(r.stdout), 'no manual reminder when the box did it');
  assert.equal(api.calls[0].body.permission, 'pull', 'read access, never more');
  assert.equal(api.calls[0].auth, 'Bearer ghu_testtoken1', 'the box token, from the box file');
  // already a collaborator
  api = await fakeGithub({ 'PUT /repos/hg/hg-commons/collaborators/juniper': { status: 204 } });
  r = await runAsync('grant', { input: JSON.stringify({ label: 'Juniper', github: 'juniper' }), env: { AIOS_GITHUB_API: api.url } });
  await api.close();
  assert.match(r.stdout, /juniper already has access to hg\/hg-commons on GitHub; nothing more to send/);
  // refused: the grant still stands and the fallback is spelled out
  api = await fakeGithub({});
  r = await runAsync('grant', { input: JSON.stringify({ label: 'Ghost', github: 'ghost' }), env: { AIOS_GITHUB_API: api.url } });
  await api.close();
  assert.equal(r.status, 0, 'a refused invite never voids the grant');
  assert.match(r.stdout, /GitHub refused the invitation for ghost \(HTTP 404: Not Found\)/);
  assert.match(r.stdout, /Send it by hand: repository Settings, Collaborators/);
  // no username: the manual reminder, unchanged
  r = run('grant', { input: JSON.stringify({ label: 'No Handle' }) });
  assert.match(r.stdout, /invite their GitHub account as a READ collaborator/);
});

test('roster merges the live GitHub lists: accepted, pending, ledger-only, and the unnamed collaborator', async () => {
  const { run, runAsync, stageToken } = rig();
  run('init', { input: JSON.stringify({ url: 'https://github.com/hg/hg-commons.git', org: 'hg-x' }) });
  // ledger without live: no token -> plain ledger, github.live false
  run('grant', { input: JSON.stringify({ label: 'Astrid', github: 'astrid-h' }) });
  run('grant', { input: JSON.stringify({ label: 'Juniper', github: 'juniper' }) });
  run('grant', { input: JSON.stringify({ label: 'Paper Only' }) });
  let s = JSON.parse(run('roster').stdout.replace(/^ROSTER_STATE /, ''));
  assert.equal(s.github.live, false);
  assert.ok(!('live' in s.grants[0]), 'no live claims without GitHub');
  // live: astrid accepted, juniper pending, paper-only untouched, stranger listed
  stageToken();
  const api = await fakeGithub({
    'GET /repos/hg/hg-commons/collaborators': { body: [{ login: 'hg' }, { login: 'Astrid-H' }, { login: 'stranger' }] },
    'GET /repos/hg/hg-commons/invitations': { body: [{ id: 9, invitee: { login: 'juniper' } }] },
  });
  s = JSON.parse((await runAsync('roster', { env: { AIOS_GITHUB_API: api.url } })).stdout.replace(/^ROSTER_STATE /, ''));
  await api.close();
  assert.equal(s.github.live, true);
  assert.equal(s.github.repo, 'hg/hg-commons');
  const by = {}; s.grants.forEach((g) => { by[g.label] = g; });
  assert.equal(by.Astrid.live, 'accepted');
  assert.equal(by.Juniper.live, 'pending');
  assert.ok(!('live' in by['Paper Only']), 'a grant with no username makes no GitHub claim');
  assert.deepEqual(s.github.extra_collaborators, ['stranger'], 'the owner is never "extra"; the stranger is named');
  // GitHub down: the ledger still answers, with the reason attached
  const dead = await fakeGithub({ 'GET /repos/hg/hg-commons/collaborators': { status: 500, body: { message: 'boom' } } });
  s = JSON.parse((await runAsync('roster', { env: { AIOS_GITHUB_API: dead.url } })).stdout.replace(/^ROSTER_STATE /, ''));
  await dead.close();
  assert.equal(s.github.live, false);
  assert.match(String(s.github.error), /HTTP 500/);
  assert.equal(s.grants.length, 3, 'the ledger is never hostage to GitHub');
});

test('revoke and-github removes the collaborator (and a pending invite) from here', async () => {
  const { run, runAsync, stageToken } = rig();
  run('init', { input: JSON.stringify({ url: 'https://github.com/hg/hg-commons.git', org: 'hg-x' }) });
  const id = run('grant', { input: JSON.stringify({ label: 'Astrid', github: 'astrid-h' }) }).stdout.match(/\((g-[a-z0-9]+)\)/)[1];
  stageToken();
  const api = await fakeGithub({
    'DELETE /repos/hg/hg-commons/collaborators/astrid-h': { status: 204 },
    'GET /repos/hg/hg-commons/invitations': { body: [] },
  });
  const r = await runAsync('revoke', { arg: id, arg2: 'and-github', env: { AIOS_GITHUB_API: api.url } });
  await api.close();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /marked revoked/);
  assert.match(r.stdout, /GitHub read access to hg\/hg-commons is removed too/);
  assert.match(r.stdout, /installed stays theirs/);
  // refusal path: honest, names the by-hand fix, never fails the revoke
  const id2 = run('grant', { input: JSON.stringify({ label: 'Juniper', github: 'juniper' }) }).stdout.match(/\((g-[a-z0-9]+)\)/)[1];
  const dead = await fakeGithub({ 'GET /repos/hg/hg-commons/invitations': { body: [] } });
  const r2 = await runAsync('revoke', { arg: id2, arg2: 'and-github', env: { AIOS_GITHUB_API: dead.url } });
  await dead.close();
  assert.equal(r2.status, 0);
  assert.match(r2.stdout, /Could not remove juniper's GitHub access/);
  assert.match(r2.stdout, /Remove it by hand/);
});

test('revoke: marks the ledger, tells the owner to cut host access, and the member keeps installs', () => {
  const { run } = rig();
  run('init', { input: JSON.stringify({ url: 'https://github.com/hg/c.git', org: 'hg-x' }) });
  const g = run('grant', { input: JSON.stringify({ label: 'Juniper' }) });
  const id = g.stdout.match(/\((g-[a-z0-9]+)\)/)[1];
  const r = run('revoke', { arg: id });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /marked revoked/);
  assert.match(r.stdout, /remove their read access on your git host/);
  assert.match(r.stdout, /already installed stays theirs/);
  const s = JSON.parse(run('status').stdout.replace(/^COMMONS_STATE /, ''));
  assert.deepEqual(s.roster, { active: 0, revoked: 1 });
  const again = run('revoke', { arg: id });
  assert.match(again.stdout, /already revoked/);
  assert.equal(run('revoke', { arg: 'g-nope0000' }).status, 1);
});

test('grant refusals: no label, bad email, bad github handle; and grant before init', () => {
  const { run } = rig();
  assert.match(run('grant', { input: JSON.stringify({ label: 'X Y' }) }).stdout, /no commons is configured/);
  run('init', { input: JSON.stringify({ url: 'https://github.com/hg/c.git', org: 'hg-x' }) });
  assert.match(run('grant', { input: JSON.stringify({}) }).stdout, /needs a label/);
  assert.match(run('grant', { input: JSON.stringify({ label: 'A', email: 'nope' }) }).stdout, /email/);
  assert.match(run('grant', { input: JSON.stringify({ label: 'A', github: 'bad handle' }) }).stdout, /GitHub/);
});

test('bundle: reprints the join bundle + link without touching the roster', () => {
  const { brain, run } = rig();
  run('init', { input: JSON.stringify({ url: 'https://github.com/hg/c.git', org: 'hg-x' }) });
  const r = run('bundle');
  assert.equal(r.status, 0);
  assert.ok(parseBundle(r.stdout.split('\n')[0]).ok);
  assert.match(r.stdout, /^JOIN_LINK crads-ai:\/\/join-community\/[A-Za-z0-9_-]+$/m);
  assert.ok(!existsSync(path.join(brain, 'registry', 'commons-roster.json')), 'no roster row from a reprint');
});

// ---- commons-create: "Start a community" as one field (ruling 1) -----------

const CREATE = path.join(HERE, 'commons-create.mjs');
function createRig() {
  const base = rig();
  // async for the same reason runAsync exists: creates talk to the fake GitHub
  const create = (input, env) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CREATE, base.state, base.brain], {
      env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', ...(env || {}) },
    });
    let stdout = '', stderr = '';
    p.stdout.on('data', (c) => { stdout += c; });
    p.stderr.on('data', (c) => { stderr += c; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
    p.stdin.end(input);
  });
  return { ...base, create };
}

test('commons-create: one name in, repo + README + conf out, on the owner account', async () => {
  const { state, create, stageToken } = createRig();
  stageToken();
  const api = await fakeGithub({
    'GET /user': { body: { login: 'sam' } },
    'POST /user/repos': { status: 201, body: { full_name: 'sam/harbour-guild-commons' } },
    'PUT /repos/sam/harbour-guild-commons/contents/README.md': { status: 201, body: {} },
  });
  const r = await create(JSON.stringify({ name: 'Harbour Guild' }), { AIOS_GITHUB_API: api.url });
  await api.close();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK: created sam\/harbour-guild-commons on your GitHub \(private/);
  assert.match(r.stdout, /Harbour Guild shared library \(harbour-guild\)/);
  assert.match(r.stdout, /README naming the community/);
  const post = api.calls.find((c) => c.key === 'POST /user/repos');
  assert.equal(post.body.private, true, 'private by default');
  const readme = Buffer.from(api.calls.find((c) => c.key.startsWith('PUT ')).body.content, 'base64').toString('utf8');
  assert.match(readme, /^# Harbour Guild/);
  assert.equal(readFileSync(path.join(state, 'commons.conf'), 'utf8'),
    'URL=https://github.com/sam/harbour-guild-commons.git\nORG=harbour-guild\nORG_DISPLAY=Harbour Guild\n');
});

test('commons-create: the open-community checkbox makes the repo public', async () => {
  const { create, stageToken } = createRig();
  stageToken();
  const api = await fakeGithub({
    'GET /user': { body: { login: 'sam' } },
    'POST /user/repos': { status: 201, body: { full_name: 'sam/tide-commons' } },
    'PUT /repos/sam/tide-commons/contents/README.md': { status: 201, body: {} },
  });
  const r = await create(JSON.stringify({ name: 'Tide', open: true }), { AIOS_GITHUB_API: api.url });
  await api.close();
  assert.equal(r.status, 0, r.stdout);
  assert.equal(api.calls.find((c) => c.key === 'POST /user/repos').body.private, false);
  assert.match(r.stdout, /open: anyone with the link can pull/);
});

test('commons-create refusals: no sign-in, unusable name, already configured, GitHub says no', async () => {
  const { create, stageToken, run } = createRig();
  // no token anywhere: the fix is named, nothing is created
  let r = await create(JSON.stringify({ name: 'Harbour Guild' }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no GitHub sign-in yet/);
  assert.match(r.stdout, /Backup card|connect-github/);
  // an unusable name refuses in words
  stageToken();
  r = await create(JSON.stringify({ name: '!!!' }));
  assert.match(r.stdout, /does not reduce to a usable community id/);
  r = await create('not json');
  assert.match(r.stdout, /JSON body/);
  r = await create(JSON.stringify({}));
  assert.match(r.stdout, /name the community first/);
  // GitHub refuses the create
  const api = await fakeGithub({ 'GET /user': { body: { login: 'sam' } } });
  r = await create(JSON.stringify({ name: 'Harbour Guild' }), { AIOS_GITHUB_API: api.url });
  await api.close();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /GitHub refused to create harbour-guild-commons/);
  // already configured: points at the Advanced form instead of repointing
  run('init', { input: JSON.stringify({ url: 'https://github.com/hg/c.git', org: 'hg-x', org_display: 'HGX' }) });
  r = await create(JSON.stringify({ name: 'Harbour Guild' }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /already set up/);
  assert.match(r.stdout, /Bring your own repository/);
});

test('commons-create adopts an existing pushable repo instead of failing the re-run', async () => {
  const { state, create, stageToken } = createRig();
  stageToken();
  const api = await fakeGithub({
    'GET /user': { body: { login: 'sam' } },
    'POST /user/repos': { status: 422, body: { message: 'name already exists on this account' } },
    'GET /repos/sam/harbour-guild-commons': { body: { private: true, permissions: { push: true } } },
    'PUT /repos/sam/harbour-guild-commons/contents/README.md': { status: 422, body: { message: 'sha required' } },
  });
  const r = await create(JSON.stringify({ name: 'Harbour Guild' }), { AIOS_GITHUB_API: api.url });
  await api.close();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /already existed on your GitHub, so it is now set up/);
  assert.ok(existsSync(path.join(state, 'commons.conf')));
});
