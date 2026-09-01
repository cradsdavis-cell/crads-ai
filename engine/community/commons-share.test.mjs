// commons-share.test.mjs: the member-side share-back helper (self-host
// pivot, 2026-09-01). Share-back is the git host's own PR flow; this helper
// only stages files and prints the steps, and these tests pin exactly that.
//   node --test engine/community/commons-share.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { writeCommunity } from './commons-lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SHARE = path.join(HERE, 'commons-share.mjs');
const w = (p, c) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, c); };

function rig() {
  const root = tmpDir('share-');
  const state = path.join(root, 'state');
  const brain = state;   // a pebble: the brain root IS /state
  writeCommunity(state, { org: 'hg-guild', org_display: 'Harbour Guild', url: 'https://github.com/hg/hg-commons.git', status: 'joined' });
  w(path.join(brain, '.claude', 'skills', 'my-skill', 'SKILL.md'), '# mine\n');
  w(path.join(brain, 'dashboard', 'pages', 'my-page.html'), '<h2>mine</h2>');
  w(path.join(brain, 'library', 'starter-kit', 'my-folder', 'a.md'), 'a\n');
  const run = (...args) => spawnSync(process.execPath, [SHARE, state, brain, ...args], { encoding: 'utf8' });
  return { state, brain, run };
}

test('staging a skill lays it out commons-shaped and prints the GitHub PR steps', () => {
  const { state, run } = rig();
  const r = run('hg-guild', 'skill', 'my-skill');
  assert.equal(r.status, 0, r.stdout);
  assert.ok(existsSync(path.join(state, 'commons-share', 'hg-guild', 'skills', 'my-skill', 'SKILL.md')));
  assert.match(r.stdout, /OK: staged skills\/my-skill/);
  assert.match(r.stdout, /https:\/\/github.com\/hg\/hg-commons\/fork/);
  assert.match(r.stdout, /https:\/\/github.com\/hg\/hg-commons\/compare/);
  assert.match(r.stdout, /Nothing lands in the commons without their say/);
});

test('pages and folders stage at the paths the commons expects', () => {
  const { state, run } = rig();
  assert.equal(run('hg-guild', 'page', 'my-page').status, 0);
  assert.ok(existsSync(path.join(state, 'commons-share', 'hg-guild', 'offers-pages', 'my-page.html')));
  assert.equal(run('hg-guild', 'dir', 'my-folder').status, 0);
  assert.ok(existsSync(path.join(state, 'commons-share', 'hg-guild', 'dirs', 'library', 'my-folder', 'a.md')));
});

test('a non-GitHub commons gets generic branch-and-push instructions instead', () => {
  const { state, run } = rig();
  writeCommunity(state, { org: 'gl-guild', org_display: 'GL', url: 'git@gitlab.example.com:gl/commons.git', status: 'joined' });
  const r = run('gl-guild', 'skill', 'my-skill');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Clone the commons somewhere you can write/);
  assert.ok(!/\/fork/.test(r.stdout));
});

test('refusals: unknown community, unknown kind, missing item, bad id; symlinks never staged', () => {
  const { brain, state, run } = rig();
  assert.match(run('nope-guild', 'skill', 'my-skill').stdout, /not a member/);
  assert.match(run('hg-guild', 'widget', 'my-skill').stdout, /kind must be/);
  assert.match(run('hg-guild', 'skill', 'not-there').stdout, /no skill named/);
  assert.match(run('hg-guild', 'skill', '../up').stdout, /kebab-case/);
  w(path.join(brain, 'secret.txt'), 'shh\n');
  symlinkSync(path.join(brain, 'secret.txt'), path.join(brain, '.claude', 'skills', 'my-skill', 'leak.txt'));
  assert.equal(run('hg-guild', 'skill', 'my-skill').status, 0);
  assert.ok(!existsSync(path.join(state, 'commons-share', 'hg-guild', 'skills', 'my-skill', 'leak.txt')));
});
