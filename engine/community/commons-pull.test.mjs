// commons-pull.test.mjs: the member-side commons transport against REAL local
// bare git repos (self-host pivot, 2026-09-01). git init --bare in a scratch
// dir stands in for the host; AIOS_COMMONS_ALLOW_FILE=1 admits the file
// transport for exactly this purpose (a bundle can never carry one).
//   node --test engine/community/commons-pull.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { pullOne } from './commons-pull.mjs';
import { readCommunity, writeCommunity } from './commons-lib.mjs';

before(() => { process.env.AIOS_COMMONS_ALLOW_FILE = '1'; });
after(() => { delete process.env.AIOS_COMMONS_ALLOW_FILE; });

const git = (args, cwd) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0' },
});

// A bare repo plus a helper that commits files into it through a work clone.
function bareCommons(name, files) {
  const root = tmpDir('commons-fixture-');
  const bare = path.join(root, `${name}.git`);
  git(['init', '--bare', '-b', 'main', bare]);
  const work = path.join(root, 'work');
  git(['clone', bare, work]);
  const commit = (fs2, msg) => {
    for (const [rel, content] of Object.entries(fs2)) {
      const p = path.join(work, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    git(['add', '-A'], work);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg || 'update'], work);
    git(['push', '-q', 'origin', 'HEAD:main'], work);
  };
  commit(files, 'seed');
  return { bare, work, commit };
}

const COMMONS_FILES = {
  'catalog/catalog.json': JSON.stringify({ rock: 'Harbour Guild', items: [{ id: 'tide-tables', kind: 'skill', version: 1, category: 'briefing', description: 'tides' }] }),
  'skills/tide-tables/SKILL.md': '# tide tables\n',
  'skills/tide-tables/skill.yaml': 'id: tide-tables\nversion: 1\ncategory: briefing\n',
  'prompts/library/kickoff.md': '---\ntitle: "Kickoff"\n---\nStart my week.\n',
};

function joinedState(bare, org = 'harbour-guild') {
  const state = tmpDir('commons-state-');
  const rec = { org, org_display: 'Harbour Guild', url: bare, joined: '2026-09-01', status: 'joined' };
  writeCommunity(state, rec);
  return { state, rec };
}

test('first pull lands the commons where a joined inbox lands, with the conf shim', () => {
  const { bare } = bareCommons('hg-commons', COMMONS_FILES);
  const { state, rec } = joinedState(bare);
  const r = pullOne(state, rec);
  assert.equal(r.status, 'ok', JSON.stringify(r));
  const inbox = path.join(state, 'org-inbox.d', 'harbour-guild');
  assert.ok(existsSync(path.join(inbox, 'skills', 'tide-tables', 'SKILL.md')), 'skill staged in the inbox');
  assert.ok(existsSync(path.join(inbox, 'catalog', 'catalog.json')), 'catalogue manifest present');
  assert.equal(readFileSync(path.join(state, 'org-inbox.d', 'harbour-guild.conf'), 'utf8'), 'COMMONS=1\nORG=harbour-guild\n');
  assert.match(readFileSync(path.join(state, '.gitignore'), 'utf8'), /org-inbox\.d\//, 'inboxes stay out of the committed brain');
  const after1 = readCommunity(state, 'harbour-guild');
  assert.equal(after1.status, 'joined');
  assert.ok(after1.last_ok && after1.last_sha, 'record carries the sync stamp');
});

test('a later publish flows down on the next pull (update path)', () => {
  const { bare, commit } = bareCommons('hg-commons', COMMONS_FILES);
  const { state, rec } = joinedState(bare);
  assert.equal(pullOne(state, rec).status, 'ok');
  commit({ 'prompts/library/eod.md': '---\ntitle: "End of day"\n---\nWrap up.\n' }, 'add a prompt');
  const r2 = pullOne(state, readCommunity(state, 'harbour-guild'));
  assert.equal(r2.status, 'ok');
  assert.ok(existsSync(path.join(state, 'org-inbox.d', 'harbour-guild', 'prompts', 'library', 'eod.md')), 'new item arrived as inbox staging (pickup, never auto-install)');
});

test('pulling NEVER executes commons content and installs nothing', () => {
  const { bare } = bareCommons('evil-commons', {
    ...COMMONS_FILES,
    'evict/notice.json': '{"evil":true}',
    'heartbeat/conf': 'ORG_GH_OWNER=evil\nSLUG=evil\n',
    'heartbeat/deploy_key': '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n',
    'keys/member.authorized_keys': 'ssh-ed25519 AAAA evil@evil\n',
    'install.sh': 'touch /tmp/pwned\n',
  });
  const { state, rec } = joinedState(bare, 'evil-guild');
  const r = pullOne(state, rec);
  assert.equal(r.status, 'ok');
  // content arrives as data in the inbox, and ONLY there
  assert.ok(existsSync(path.join(state, 'org-inbox.d', 'evil-guild', 'install.sh')), 'files are data in the inbox');
  assert.ok(!existsSync(path.join(state, 'heartbeat.d')), 'no heartbeat pipe from a commons');
  assert.ok(!existsSync(path.join(state, 'secrets')), 'no key material installed from a commons');
  assert.ok(!existsSync(path.join(state, 'ssh')), 'no door keys from a commons');
  assert.ok(!existsSync(path.join(state, '.claude')), 'nothing installed into skills');
  assert.ok(!existsSync(path.join(state, 'dashboard')), 'nothing seeded into pages');
});

test('revoked access surfaces once, honestly, then goes quiet; content stays', () => {
  const { bare } = bareCommons('hg-commons', COMMONS_FILES);
  const { state, rec } = joinedState(bare);
  assert.equal(pullOne(state, rec).status, 'ok');
  // revoke: the bare repo vanishes (GitHub answers a revoked private repo
  // with "not found", which is the same read)
  execFileSync('mv', [bare, bare + '.gone']);
  const r1 = pullOne(state, readCommunity(state, 'harbour-guild'));
  assert.equal(r1.status, 'access-ended');
  assert.match(r1.line, /your access to the Harbour Guild commons has ended/);
  assert.match(r1.line, /already installed stays yours/);
  const r2 = pullOne(state, readCommunity(state, 'harbour-guild'));
  assert.equal(r2.status, 'access-ended');
  assert.equal(r2.line, '', 'said once, not repeated as error noise');
  assert.ok(existsSync(path.join(state, 'org-inbox.d', 'harbour-guild', 'skills', 'tide-tables', 'SKILL.md')),
    'already-pulled content is never deleted on revocation');
  // access restored: the next pull recovers and the record says joined again
  execFileSync('mv', [bare + '.gone', bare]);
  const r3 = pullOne(state, readCommunity(state, 'harbour-guild'));
  assert.equal(r3.status, 'ok');
  assert.equal(readCommunity(state, 'harbour-guild').status, 'joined');
});

test('multiple communities pull independently; one failing never stops the rest', () => {
  const a = bareCommons('a-commons', COMMONS_FILES);
  const b = bareCommons('b-commons', { 'catalog/catalog.json': '{"rock":"B","items":[]}', 'prompts/library/hi.md': '---\ntitle: "Hi"\n---\nhello\n' });
  const state = tmpDir('commons-state-');
  writeCommunity(state, { org: 'aa-guild', org_display: 'A', url: a.bare, status: 'joined' });
  writeCommunity(state, { org: 'bb-guild', org_display: 'B', url: b.bare, status: 'joined' });
  execFileSync('mv', [a.bare, a.bare + '.gone']);   // A is revoked, B must still sync
  const out = execFileSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), 'commons-pull.mjs'), state], { encoding: 'utf8', env: { ...process.env } });
  assert.match(out, /aa-guild: your access to the A commons has ended/);
  assert.match(out, /bb-guild: synced/);
  assert.match(out, /1\/2 communities synced/);
  assert.ok(existsSync(path.join(state, 'org-inbox.d', 'bb-guild', 'prompts', 'library', 'hi.md')));
});

test('a commons over the size cap is removed and said once', () => {
  const big = 'x'.repeat(64 * 1024);
  const { bare } = bareCommons('big-commons', { ...COMMONS_FILES, 'dirs/library/huge/blob.bin': big });
  const { state, rec } = joinedState(bare, 'big-guild');
  const prev = process.env.AIOS_COMMONS_MAX_KB;
  process.env.AIOS_COMMONS_MAX_KB = '32';
  try {
    const r = pullOne(state, rec);
    assert.equal(r.status, 'oversized');
    assert.match(r.line, /larger than this box accepts/);
    assert.ok(!existsSync(path.join(state, 'org-inbox.d', 'big-guild')), 'the oversized checkout is not kept');
    const r2 = pullOne(state, readCommunity(state, 'big-guild'));
    assert.equal(r2.line, '', 'the cap is said once, not repeated');
  } finally {
    if (prev === undefined) delete process.env.AIOS_COMMONS_MAX_KB;
    else process.env.AIOS_COMMONS_MAX_KB = prev;
  }
});

test('a record whose URL fails validation is refused before git ever runs', () => {
  const state = tmpDir('commons-state-');
  const rec = { org: 'sly-guild', org_display: 'Sly', url: 'ext::sh -c id', status: 'joined' };
  writeCommunity(state, rec);
  const r = pullOne(state, rec);
  assert.equal(r.status, 'error');
  assert.match(r.line, /not usable/);
  assert.ok(!existsSync(path.join(state, 'org-inbox.d', 'sly-guild', '.git')), 'no clone attempted');
});

test('the CLI with no communities is a clean no-op on every existing box', () => {
  const state = tmpDir('commons-state-');
  const out = execFileSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), 'commons-pull.mjs'), state], { encoding: 'utf8' });
  assert.equal(out, '', 'nothing to say, nothing said');
  assert.ok(!existsSync(path.join(state, 'org-inbox.d')), 'nothing created');
});
