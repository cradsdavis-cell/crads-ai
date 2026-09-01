// commons-sync-leg.test.mjs: org-sync.sh carries the commons cadence
// (self-host pivot, 2026-09-01). Runs the REAL org-sync.sh in bash against a
// temp state dir (the org-sync-page-seed-log.test.mjs pattern) with a real
// local bare commons, and pins the three properties that make the leg safe:
// it runs with no anchor, it feeds the community inboxes, and the joined-rock
// loop never touches a COMMONS=1 conf.
//   node --test engine/community/commons-sync-leg.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { writeCommunity } from './commons-lib.mjs';

before(() => { process.env.AIOS_COMMONS_ALLOW_FILE = '1'; });
after(() => { delete process.env.AIOS_COMMONS_ALLOW_FILE; });

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..', '..');
const SYNC = path.join(REPO, 'engine', 'box', 'org-sync.sh');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function bareCommons(root) {
  const bare = path.join(root, 'commons.git');
  git(['init', '--bare', '-b', 'main', bare]);
  const work = path.join(root, 'work');
  git(['clone', bare, work]);
  mkdirSync(path.join(work, 'prompts', 'library'), { recursive: true });
  writeFileSync(path.join(work, 'prompts', 'library', 'hi.md'), '---\ntitle: "Hi"\n---\nhello\n');
  git(['add', '-A'], work);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed'], work);
  git(['push', '-q', 'origin', 'HEAD:main'], work);
  return bare;
}

test('org-sync runs the commons leg with NO anchor, and the joined loop skips COMMONS confs', () => {
  const root = tmpDir('sync-leg-');
  const state = path.join(root, 'state');
  mkdirSync(state, { recursive: true });
  writeCommunity(state, { org: 'hg-guild', org_display: 'HG', url: bareCommons(root), status: 'joined' });
  const out = execFileSync('bash', [SYNC], {
    encoding: 'utf8',
    env: { ...process.env, STATE_DIR: state, AIOS_DIR: REPO },
  });
  // the commons synced, through the real script, on a box with no org-inbox.conf
  assert.match(out, /\[commons\] hg-guild: synced/);
  assert.match(out, /no org-inbox.conf; not an org-managed box/);
  assert.ok(existsSync(path.join(state, 'org-inbox.d', 'hg-guild', 'prompts', 'library', 'hi.md')));
  // the conf shim exists and the joined-rock loop said NOTHING about it (no
  // "no usable SLUG", no "no read key": it never entered the loop)
  assert.equal(readFileSync(path.join(state, 'org-inbox.d', 'hg-guild.conf'), 'utf8'), 'COMMONS=1\nORG=hg-guild\n');
  assert.ok(!/hg-guild.*SLUG/.test(out), 'joined loop skipped the commons conf');
  assert.ok(!/no read key for hg-guild/.test(out), 'joined loop skipped the commons conf');
});

test('a real joined-rock conf still goes through the joined loop unchanged', () => {
  const root = tmpDir('sync-leg-');
  const state = path.join(root, 'state');
  mkdirSync(path.join(state, 'org-inbox.d'), { recursive: true });
  writeFileSync(path.join(state, 'org-inbox.d', 'acme.conf'), 'SLUG=acme\nORG=acme\n');
  const out = execFileSync('bash', [SYNC], {
    encoding: 'utf8',
    env: { ...process.env, STATE_DIR: state, AIOS_DIR: REPO },
  });
  assert.match(out, /no read key for acme; cannot sync that inbox yet/, 'the pre-pivot path is untouched');
});

test('a broken commons leg never stops the rest of org-sync (fail-soft)', () => {
  const root = tmpDir('sync-leg-');
  const state = path.join(root, 'state');
  mkdirSync(path.join(state, 'communities.d'), { recursive: true });
  // a damaged record: commons-pull skips it; org-sync must still finish 0
  writeFileSync(path.join(state, 'communities.d', 'zz-guild.json'), 'not json');
  const out = execFileSync('bash', [SYNC], {
    encoding: 'utf8',
    env: { ...process.env, STATE_DIR: state, AIOS_DIR: REPO },
  });
  assert.match(out, /no org-inbox.conf/, 'org-sync reached its own end');
});
