// community-join.test.mjs: joining (and leaving, and listing) communities on
// a member box, against real local bare repos (self-host pivot, 2026-09-01).
//   node --test engine/community/community-join.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

// ---- the shared-library view + the last-look stamp (ruling 4) --------------

function bareCommonsWithCatalog() {
  const root = tmpDir('join-cat-');
  const bare = path.join(root, 'commons.git');
  git(['init', '--bare', '-b', 'main', bare]);
  const work = path.join(root, 'work');
  git(['clone', bare, work]);
  mkdirSync(path.join(work, 'skills', 'tide-tables'), { recursive: true });
  writeFileSync(path.join(work, 'skills', 'tide-tables', 'SKILL.md'), '# tides\n');
  writeFileSync(path.join(work, 'skills', 'tide-tables', 'skill.yaml'), 'id: tide-tables\nversion: 2\n');
  mkdirSync(path.join(work, 'catalog'), { recursive: true });
  writeFileSync(path.join(work, 'catalog', 'catalog.json'), JSON.stringify({
    rock: 'HG',
    items: [
      { id: 'tide-tables', kind: 'skill', version: 2, description: 'Tides for the harbour, every morning.' },
      { id: 'welcome', kind: 'page', version: 1, title: 'Welcome to the guild' },
      { id: 'kickoff', kind: 'prompt', version: 1, title: 'Kickoff prompt' },
      { id: 'bad id!', kind: 'skill', version: 1 },
      { id: 'weird', kind: 'widget', version: 1 },
    ],
  }));
  git(['add', '-A'], work);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed'], work);
  git(['push', '-q', 'origin', 'HEAD:main'], work);
  return { bare, work };
}
const listOf = (state) => JSON.parse(
  execFileSync(process.execPath, [path.join(HERE, 'community-list.mjs'), state], { encoding: 'utf8' })
    .replace(/^COMMUNITIES_STATE /, ''));

test('community-list carries the shared library: names, descriptions, fresh flags; seen stamps the look', () => {
  const state = tmpDir('join-state-');
  const { bare, work } = bareCommonsWithCatalog();
  writeCommunity(state, { org: 'hg-guild', org_display: 'HG', url: bare, status: 'joined' });
  execFileSync(process.execPath, [path.join(HERE, 'commons-pull.mjs'), state], { encoding: 'utf8' });

  // day zero: everything is fresh; unusable manifest rows never surface
  let c = listOf(state).communities[0];
  assert.deepEqual(c.items.map((i) => i.id), ['tide-tables', 'welcome', 'kickoff'], 'bad ids and unknown kinds are dropped');
  assert.equal(c.items[0].description, 'Tides for the harbour, every morning.');
  assert.equal(c.items[1].title, 'Welcome to the guild');
  assert.ok(c.items.every((i) => i.fresh), 'never looked: everything is new');
  assert.equal(c.fresh_count, 3);

  // the member looks: community-seen stamps, and the flags clear
  const seen = execFileSync(process.execPath, [path.join(HERE, 'community-seen.mjs'), state, 'hg-guild'], { encoding: 'utf8' });
  assert.match(seen, /OK: caught up with HG \(3 item\(s\) noted\)/);
  c = listOf(state).communities[0];
  assert.equal(c.fresh_count, 0);
  assert.ok(c.items.every((i) => !i.fresh));

  // the owner ships a new version + a new item: only those come back fresh
  writeFileSync(path.join(work, 'catalog', 'catalog.json'), JSON.stringify({
    rock: 'HG',
    items: [
      { id: 'tide-tables', kind: 'skill', version: 3, description: 'Tides, now with swell.' },
      { id: 'welcome', kind: 'page', version: 1, title: 'Welcome to the guild' },
      { id: 'kickoff', kind: 'prompt', version: 1, title: 'Kickoff prompt' },
      { id: 'moon-phases', kind: 'skill', version: 1, description: 'New.' },
    ],
  }));
  git(['add', '-A'], work);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'v3'], work);
  git(['push', '-q', 'origin', 'HEAD:main'], work);
  execFileSync(process.execPath, [path.join(HERE, 'commons-pull.mjs'), state], { encoding: 'utf8' });
  c = listOf(state).communities[0];
  const fresh = c.items.filter((i) => i.fresh).map((i) => i.id).sort();
  assert.deepEqual(fresh, ['moon-phases', 'tide-tables'], 'a bump and an arrival are new; the rest stay quiet');
  assert.equal(c.fresh_count, 2);
});

test('community-seen refuses an unknown community; a checkout with no manifest lists no items', () => {
  const state = tmpDir('join-state-');
  const r = spawnSync(process.execPath, [path.join(HERE, 'community-seen.mjs'), state, 'nope-guild'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not a member/);
  writeCommunity(state, { org: 'aa-guild', org_display: 'A', url: bareCommons(), status: 'joined' });
  execFileSync(process.execPath, [path.join(HERE, 'commons-pull.mjs'), state], { encoding: 'utf8' });
  const c = listOf(state).communities[0];
  assert.deepEqual(c.items, [], 'the old empty-manifest fixture carries no items');
  assert.equal(c.fresh_count, 0);
});

// ---- community-check: the Check again button (ruling 3) --------------------

test('community-check: a readable community answers "syncing"; an unknown one refuses', () => {
  const state = tmpDir('join-state-');
  writeCommunity(state, { org: 'aa-guild', org_display: 'A Guild', url: bareCommons(), status: 'joined' });
  const r = execFileSync(process.execPath, [path.join(HERE, 'community-check.mjs'), state, 'aa-guild'], { encoding: 'utf8' });
  assert.match(r, /OK: A Guild is syncing\. Its shared library appears in your catalogue\./);
  const bad = spawnSync(process.execPath, [path.join(HERE, 'community-check.mjs'), state, 'nope-guild'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /not a member/);
});

test('community-check: access-ended diagnoses and persists the hint; recovery announces itself', () => {
  const state = tmpDir('join-state-');
  const { bare } = bareCommonsWithCatalog();
  writeCommunity(state, { org: 'hg-guild', org_display: 'HG', url: bare, status: 'joined' });
  execFileSync(process.execPath, [path.join(HERE, 'commons-pull.mjs'), state], { encoding: 'utf8' });
  // access ends: the bare repo disappears -> git answers access-shaped
  const parked = bare + '.parked';
  renameSync(bare, parked);
  let r = execFileSync(process.execPath, [path.join(HERE, 'community-check.mjs'), state, 'hg-guild'], { encoding: 'utf8' });
  assert.match(r, /^Not yet: /m);
  assert.match(r, /cannot read HG's shared library/, 'a non-GitHub commons gets the generic honest line');
  assert.equal(readCommunity(state, 'hg-guild').status, 'access-ended');
  // access comes back: Check again says so in one line
  renameSync(parked, bare);
  r = execFileSync(process.execPath, [path.join(HERE, 'community-check.mjs'), state, 'hg-guild'], { encoding: 'utf8' });
  assert.match(r, /OK: HG is readable again and syncing\./);
  assert.equal(readCommunity(state, 'hg-guild').status, 'joined');
});

test('the recovery write clears a stale access hint', () => {
  const state = tmpDir('join-state-');
  writeCommunity(state, {
    org: 'aa-guild', org_display: 'A', url: bareCommons(),
    status: 'access-ended', access_hint: 'pending-invite', invite_from: 'sam', ended_notified: true,
  });
  execFileSync(process.execPath, [path.join(HERE, 'commons-pull.mjs'), state], { encoding: 'utf8' });
  const rec = readCommunity(state, 'aa-guild');
  assert.equal(rec.status, 'joined');
  assert.ok(!('access_hint' in rec) && !('invite_from' in rec), 'a synced community carries no stale advice');
  const c = listOf(state).communities[0];
  assert.ok(!('access_hint' in c));
});
