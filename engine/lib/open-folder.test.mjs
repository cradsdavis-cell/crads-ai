// open-folder.test.mjs: the mineral-named folder Claude Code opens (R18).
//   node --test engine/lib/open-folder.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readlinkSync, lstatSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureOpenFolder, nameCandidates, safeName, linkTarget, FALLBACK_NAME, NO_LINK_NAME } from './open-folder.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const tmp = () => tmpDir('open-folder-');
const env = {};   // never the developer's own AIOS_BOX_HOST

function pebble(slug) {
  const d = tmp();
  mkdirSync(join(d, 'secrets'), { recursive: true });
  if (slug) writeFileSync(join(d, 'secrets', 'box_reg_host'), `${slug}.example.com`);
  writeFileSync(join(d, 'ownership.json'), JSON.stringify({ owner: 'org', owner_slug: 'the-rock', tier: 'pebble' }));
  return d;
}
function rock(name) {
  const d = tmp();
  mkdirSync(join(d, 'brain'), { recursive: true });
  writeFileSync(join(d, 'deployment.yaml'), `deployment_name: ${name}\nbrain_root: ${join(d, 'brain')}\n`);
  writeFileSync(join(d, 'ownership.json'), JSON.stringify({ owner: 'org', owner_slug: name, tier: 'rock' }));
  return d;
}

test('safeName: filesystem-safe, lowercase, bounded', () => {
  assert.equal(safeName("Harriet's Rock"), 'harriet-s-rock');
  assert.equal(safeName('  QA Harbour Labs '), 'qa-harbour-labs');
  assert.equal(safeName('---'), '');
  assert.equal(safeName(''), '');
  assert.equal(safeName('x'.repeat(80)).length, 40);
  assert.equal(safeName('../etc'), 'etc');
});

test('pebble: /state/<slug> -> . and open-folder names it', () => {
  const d = pebble('jane01');
  const r = ensureOpenFolder(d, { env });
  assert.equal(r.name, 'jane01');
  assert.equal(r.action, 'created');
  assert.equal(readlinkSync(join(d, 'jane01')), '.');
  assert.equal(readFileSync(join(d, 'open-folder'), 'utf8'), 'jane01\n');
  // idempotent
  assert.equal(ensureOpenFolder(d, { env }).action, 'kept');
});

test('pebble never takes its ROCK\'s slug from ownership.json owner_slug', () => {
  const d = pebble('');
  assert.ok(!nameCandidates(d, { env }).includes('the-rock'));
  const r = ensureOpenFolder(d, { env });
  assert.equal(r.name, FALLBACK_NAME, 'no slug on disk: control-centre');
  assert.equal(readlinkSync(join(d, FALLBACK_NAME)), '.');
});

test('rock: /state/<name> -> brain (relative), resolved from deployment.yaml', () => {
  const d = rock('acme');
  const r = ensureOpenFolder(d, { env });
  assert.equal(r.name, 'acme');
  assert.equal(readlinkSync(join(d, 'acme')), 'brain');
  writeFileSync(join(d, 'brain', 'x.txt'), 'hi');
  assert.equal(readFileSync(join(d, 'acme', 'x.txt'), 'utf8'), 'hi', 'the link reaches the brain');
  // an explicit brain root wins (boot-rock passes $BRAIN_ROOT)
  const r2 = ensureOpenFolder(d, { env, brainRoot: join(d, 'brain') });
  assert.equal(r2.action, 'kept');
});

test('promoted rock (brain at the box root) behaves like a pebble', () => {
  const d = tmp();
  writeFileSync(join(d, 'ownership.json'), JSON.stringify({ owner: 'org', owner_slug: 'ingrid', tier: 'rock' }));
  writeFileSync(join(d, 'deployment.yaml'), '');
  const r = ensureOpenFolder(d, { env });
  assert.equal(r.name, 'ingrid');
  assert.equal(r.target, '.');
});

test('a stale link is replaced; a real directory of that name is never clobbered', () => {
  const d = rock('acme');
  symlinkSync('somewhere-else', join(d, 'acme'));
  assert.equal(ensureOpenFolder(d, { env }).action, 'replaced');
  assert.equal(readlinkSync(join(d, 'acme')), 'brain');

  const e = rock('brain');   // the slug collides with the brain directory itself
  const logs = [];
  const r = ensureOpenFolder(e, { env, log: (m) => logs.push(m) });
  assert.ok(existsSync(join(e, 'brain')) && !lstatSync(join(e, 'brain')).isSymbolicLink(), 'the real brain dir stands');
  assert.deepEqual(r.skipped, ['brain']);
  assert.equal(r.name, FALLBACK_NAME);
  assert.match(logs[0], /real directory, left alone/);
  assert.equal(readFileSync(join(e, 'open-folder'), 'utf8'), `${FALLBACK_NAME}\n`);
});

test('no linkable candidate at all: open-folder says state, nothing is removed', () => {
  const d = pebble('');
  mkdirSync(join(d, FALLBACK_NAME));
  const r = ensureOpenFolder(d, { env });
  assert.equal(r.action, 'none');
  assert.equal(r.name, NO_LINK_NAME);
  assert.equal(readFileSync(join(d, 'open-folder'), 'utf8'), `${NO_LINK_NAME}\n`);
  assert.ok(lstatSync(join(d, FALLBACK_NAME)).isDirectory());
});

test('a renamed slug retires the old link this module made, and only that', () => {
  const d = pebble('old-name');
  ensureOpenFolder(d, { env });
  writeFileSync(join(d, 'secrets', 'box_reg_host'), 'new-name.example.com');
  mkdirSync(join(d, 'unrelated'));
  const r = ensureOpenFolder(d, { env });
  assert.equal(r.name, 'new-name');
  assert.ok(!existsSync(join(d, 'old-name')), 'the previous link is gone');
  assert.ok(lstatSync(join(d, 'unrelated')).isDirectory());
});

test('linkTarget is relative and "." for the root', () => {
  assert.equal(linkTarget('/state', '/state'), '.');
  assert.equal(linkTarget('/state', '/state/brain'), 'brain');
});

test('CLI form (what box-up.sh and boot-rock.sh call) works and reports', () => {
  const d = rock('cli-org');
  const out = execFileSync(process.execPath, [join(HERE, 'open-folder.mjs'), d, join(d, 'brain')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.match(out, /open-folder: cli-org \(created/);
  assert.equal(readlinkSync(join(d, 'cli-org')), 'brain');
});

test('both entrypoints call it every boot', () => {
  const up = readFileSync(join(HERE, '..', 'box-up.sh'), 'utf8');
  assert.match(up, /lib\/open-folder\.mjs" "\$BOX"/, 'box-up.sh ensures the folder');
  const boot = readFileSync(join(HERE, '..', '..', 'provisioning', 'rock', 'boot-rock.sh'), 'utf8');
  assert.match(boot, /engine\/lib\/open-folder\.mjs" "\$STATE_DIR" "\$BRAIN_ROOT"/, 'boot-rock.sh ensures the folder at the brain root it resolved');
});
