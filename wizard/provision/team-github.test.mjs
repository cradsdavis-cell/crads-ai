// team-github.test.mjs: the GitHub calls behind "Set up a team", against a fake API.
//   node --test wizard/provision/team-github.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubClient, companySkeleton } from './team-github.mjs';

// routes: { 'METHOD /path': (body) => [status, json] }
function fakeFetch(routes, log = []) {
  return async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${url.replace('https://api.github.com', '')}`;
    log.push([key, init.body ? JSON.parse(init.body) : null]);
    const h = routes[key];
    const [status, body] = h ? h(init.body ? JSON.parse(init.body) : null) : [404, { message: 'Not Found' }];
    return { ok: status < 300, status, json: async () => body };
  };
}

test('ensureRepo creates a PRIVATE, initialised repo', async () => {
  const log = [];
  const gh = githubClient('t', { fetcher: fakeFetch({ 'POST /user/repos': () => [201, {}] }, log) });
  assert.deepEqual(await gh.ensureRepo('owner', 'acme-team-brain', 'd'), { created: true, fullName: 'owner/acme-team-brain' });
  assert.equal(log[0][1].private, true);
  assert.equal(log[0][1].auto_init, true);
});

test('ensureRepo reuses an existing private repo but refuses a public one', async () => {
  const exists = (priv) => githubClient('t', { fetcher: fakeFetch({
    'POST /user/repos': () => [422, {}],
    'GET /repos/owner/acme-team-brain': () => [200, { private: priv, permissions: { push: true } }],
  }) });
  assert.equal((await exists(true).ensureRepo('owner', 'acme-team-brain')).created, false);
  await assert.rejects(() => exists(false).ensureRepo('owner', 'acme-team-brain'), /PUBLIC/);
});

test('ensureFile never overwrites a page the owner already filled in', async () => {
  const log = [];
  const gh = githubClient('t', { fetcher: fakeFetch({ 'GET /repos/owner/r/contents/company/policies.md': () => [200, { sha: 'x' }] }, log) });
  assert.deepEqual(await gh.ensureFile('owner/r', 'company/policies.md', 'new', 'm'), { created: false });
  assert.ok(!log.some(([k]) => k.startsWith('PUT')));
});

test('ensureDeployKey: added, already here (done), here with the wrong access (refused), used elsewhere (refused)', async () => {
  const key = 'ssh-ed25519 AAAAKEY team-brain';
  const mk = (list) => githubClient('t', { fetcher: fakeFetch({
    'POST /repos/owner/r/keys': () => [list ? 422 : 201, {}],
    'GET /repos/owner/r/keys?per_page=100': () => [200, list || []],
  }) });
  assert.deepEqual(await mk(null).ensureDeployKey('owner/r', 't', key, true), { added: true });
  assert.deepEqual(await mk([{ key: 'ssh-ed25519 AAAAKEY', read_only: true }]).ensureDeployKey('owner/r', 't', key, true), { added: false });
  await assert.rejects(() => mk([{ key: 'ssh-ed25519 AAAAKEY', read_only: false }]).ensureDeployKey('owner/r', 't', key, true), /wrong access/);
  await assert.rejects(() => mk([{ key: 'ssh-ed25519 OTHER', read_only: true }]).ensureDeployKey('owner/r', 't', key, true), /another repository/);
});

test('the company skeleton has the pages every assistant is told to read first', () => {
  const s = companySkeleton('acme');
  for (const p of ['company/about.md', 'company/voice.md', 'company/policies.md', 'company/prices.md', 'skills/README.md']) assert.ok(s[p], p);
  assert.ok(!Object.values(s).join('').includes('\u2014'), 'no em dashes in product copy');
});

test('removeDeployKeys takes off only the leaving box\'s keys; archiveRepo archives', async () => {
  const log = [];
  const gh = githubClient('t', { fetcher: fakeFetch({
    'GET /repos/owner/acme-team-brain/keys?per_page=100': () => [200, [
      { id: 1, title: 'acme-jess (brain)' }, { id: 2, title: 'acme-jessica (brain)' }, { id: 3, title: 'acme-agent (brain)' }]],
    'DELETE /repos/owner/acme-team-brain/keys/1': () => [204, null],
    'PATCH /repos/owner/acme-from-jess': () => [200, { archived: true }],
  }, log) });
  assert.deepEqual(await gh.removeDeployKeys('owner/acme-team-brain', 'acme-jess'), { removed: 1 });
  assert.ok(!log.some(([k]) => /keys\/(2|3)$/.test(k)), 'acme-jessica and the agent keep their keys');
  assert.deepEqual(await gh.archiveRepo('owner/acme-from-jess'), { archived: true });
  assert.equal(log.find(([k]) => k.startsWith('PATCH'))[1].archived, true);
});
