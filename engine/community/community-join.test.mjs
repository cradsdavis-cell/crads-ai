// community-join.test.mjs: joining (and leaving, and listing) communities on
// a member box, against real local bare repos (self-host pivot, 2026-09-01).
//   node --test engine/community/community-join.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { mintBundle, readCommunity, writeCommunity } from './commons-lib.mjs';

before(() => { process.env.AIOS_COMMONS_ALLOW_FILE = '1'; });
after(() => { delete process.env.AIOS_COMMONS_ALLOW_FILE; });

const HERE = path.dirname(new URL(import.meta.url).pathname);
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function bareCommons() {
  const root = tmpDir('join-fixture-');
  const bare = path.join(root, 'commons.git');
  git(['init', '--bare', '-b', 'main', bare]);
  const work = path.join(root, 'work');
  git(['clone', bare, work]);
  mkdirSync(path.join(work, 'skills', 'hello', ), { recursive: true });
  writeFileSync(path.join(work, 'skills', 'hello', 'SKILL.md'), '# hello\n');
  writeFileSync(path.join(work, 'skills', 'hello', 'skill.yaml'), 'id: hello\nversion: 1\n');
  mkdirSync(path.join(work, 'catalog'), { recursive: true });
  writeFileSync(path.join(work, 'catalog', 'catalog.json'), '{"rock":"HG","items":[]}');
  git(['add', '-A'], work);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed'], work);
  git(['push', '-q', 'origin', 'HEAD:main'], work);
  return bare;
}

// mintBundle refuses a file path (bundles are strict), so fixture bundles are
// hand-assembled the way a hostile one would be; the JOIN script re-validates
// through parseBundle, whose URL check is env-widened for the puller only.
// To keep parseBundle strict AND test the join flow against local repos, the
// fixture bundle carries the file path and the test asserts join's own
// refusal of it WITHOUT the env override off. See the two cases below.
const rawBundle = (payload) => 'cradscommons1:' + Buffer.from(JSON.stringify(payload)).toString('base64');

function join(state, bundle) {
  return spawnSync(process.execPath, [path.join(HERE, 'community-join.mjs'), state], {
    input: bundle, encoding: 'utf8', env: { ...process.env },
  });
}

test('a real https-shaped bundle joins; the file-path fixture is refused by parse strictness', () => {
  // parseBundle never admits a file path, override or not: joining a local
  // fixture repo therefore goes through writeCommunity + pullOne directly in
  // the puller tests, and THIS test pins that the join door holds the line.
  const state = tmpDir('join-state-');
  const r = join(state, rawBundle({ org: 'hg-guild', url: bareCommons() }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ERROR: .*repository address/);
  assert.equal(readCommunity(state, 'hg-guild'), null, 'nothing recorded');
});

test('joining with an unreachable https url records the community and reports the sync honestly', () => {
  const state = tmpDir('join-state-');
  // a valid https URL that resolves nowhere fast: git fails as transient or
  // access-shaped, and either way join must say "joined, but" honestly.
  const bundle = mintBundle({ org: 'far-guild', org_display: 'Far Guild', url: 'https://127.0.0.1:1/far/commons.git' });
  const r = join(state, bundle);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK: joined Far Guild, but/);
  const rec = readCommunity(state, 'far-guild');
  assert.ok(rec, 'the membership is recorded; the cadence keeps trying');
  assert.equal(rec.url, 'https://127.0.0.1:1/far/commons.git');
});

test('malformed bundles are refused loudly and record nothing', () => {
  const state = tmpDir('join-state-');
  for (const bad of ['', 'garbage', 'cradscommons1:%%%', rawBundle({ org: 'X X', url: 'https://github.com/a/b' })]) {
    const r = join(state, bad);
    assert.equal(r.status, 1, `refused: ${bad.slice(0, 30)}`);
    assert.match(r.stdout, /^ERROR: /);
  }
  assert.ok(!existsSync(path.join(state, 'communities.d')), 'no record from any refusal');
});

test('joining twice is refused by name; a different repo under the same name too', () => {
  const state = tmpDir('join-state-');
  writeCommunity(state, { org: 'hg-guild', org_display: 'HG', url: 'https://github.com/hg/commons.git', status: 'joined' });
  const again = join(state, rawBundle({ org: 'hg-guild', url: 'https://github.com/hg/commons.git' }));
  assert.equal(again.status, 1);
  assert.match(again.stdout, /already a member/);
  const other = join(state, rawBundle({ org: 'hg-guild', url: 'https://github.com/other/commons.git' }));
  assert.equal(other.status, 1);
  assert.match(other.stdout, /different repository/);
});

test('a name already taken by a real joined-rock inbox is never adopted', () => {
  const state = tmpDir('join-state-');
  mkdirSync(path.join(state, 'org-inbox.d'), { recursive: true });
  writeFileSync(path.join(state, 'org-inbox.d', 'acme.conf'), 'SLUG=acme\nORG=acme\n');
  const r = join(state, rawBundle({ org: 'acme', url: 'https://github.com/a/c.git' }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /earlier tie/);
  assert.equal(readCommunity(state, 'acme'), null);
});

test('multiple communities: join several, list shows each with its own state', () => {
  const state = tmpDir('join-state-');
  // records via the same door the verbs use, pulls via the puller (file
  // fixtures cannot pass the bundle gate, by design)
  writeCommunity(state, { org: 'aa-guild', org_display: 'A', url: bareCommons(), status: 'joined' });
  writeCommunity(state, { org: 'bb-guild', org_display: 'B', url: bareCommons(), status: 'joined' });
  execFileSync(process.execPath, [path.join(HERE, 'commons-pull.mjs'), state], { encoding: 'utf8' });
  const out = execFileSync(process.execPath, [path.join(HERE, 'community-list.mjs'), state], { encoding: 'utf8' });
  assert.match(out, /^COMMUNITIES_STATE /);
  const j = JSON.parse(out.replace(/^COMMUNITIES_STATE /, ''));
  assert.equal(j.error, null);
  assert.deepEqual(j.communities.map((c) => c.org), ['aa-guild', 'bb-guild']);
  for (const c of j.communities) {
    assert.equal(c.status, 'joined');
    assert.equal(c.counts.skills, 1);
    assert.ok(c.last_sha, 'list carries the sync stamp');
  }
});

test('leave: stops the sync, keeps what was installed, and is honest about it', () => {
  const state = tmpDir('join-state-');
  writeCommunity(state, { org: 'aa-guild', org_display: 'A Guild', url: bareCommons(), status: 'joined' });
  execFileSync(process.execPath, [path.join(HERE, 'commons-pull.mjs'), state], { encoding: 'utf8' });
  // something the member installed out of it
  mkdirSync(path.join(state, '.claude', 'skills', 'hello'), { recursive: true });
  writeFileSync(path.join(state, '.claude', 'skills', 'hello', 'SKILL.md'), '# hello\n');
  const r = execFileSync(process.execPath, [path.join(HERE, 'community-leave.mjs'), state, 'aa-guild'], { encoding: 'utf8' });
  assert.match(r, /OK: left A Guild/);
  assert.match(r, /installed from it stays yours/i);
  assert.equal(readCommunity(state, 'aa-guild'), null, 'record gone: the cadence pull stops');
  assert.ok(!existsSync(path.join(state, 'org-inbox.d', 'aa-guild')), 'staging checkout removed');
  assert.ok(!existsSync(path.join(state, 'org-inbox.d', 'aa-guild.conf')), 'conf shim removed');
  assert.ok(existsSync(path.join(state, '.claude', 'skills', 'hello', 'SKILL.md')), 'installed items remain');
});

test('leave refuses an unknown community and never touches a real rock tie', () => {
  const state = tmpDir('join-state-');
  mkdirSync(path.join(state, 'org-inbox.d', 'acme'), { recursive: true });
  writeFileSync(path.join(state, 'org-inbox.d', 'acme.conf'), 'SLUG=acme\nORG=acme\n');
  const r = spawnSync(process.execPath, [path.join(HERE, 'community-leave.mjs'), state, 'acme'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not a member/);
  assert.ok(existsSync(path.join(state, 'org-inbox.d', 'acme.conf')), 'the rock tie is untouched');
});

test('community-list with nothing joined is a clean empty state', () => {
  const state = tmpDir('join-state-');
  const out = execFileSync(process.execPath, [path.join(HERE, 'community-list.mjs'), state], { encoding: 'utf8' });
  const j = JSON.parse(out.replace(/^COMMUNITIES_STATE /, ''));
  assert.deepEqual(j, { communities: [], error: null });
});
