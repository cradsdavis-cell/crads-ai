// local-targets.test.mjs: the no-server face's registry (2026-09-11).
//   node --test wizard/panel/local-targets.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { listLocalTargets, localTargetFor, registerLocalBrain, unregisterLocalBrain, slugForName, defaultBrainDir, LOCAL_HOST_RE } from './local-targets.mjs';

const reg = () => join(tmpDir('localreg-'), 'local-brains.json');

test('a registered brain lists as a -local target row, and unregister removes it', () => {
  const p = reg();
  assert.deepEqual(listLocalTargets(p), [], 'no file is no brains, not a crash');
  const brain = join(tmpDir('brain-'), 'idris');
  const r = registerLocalBrain('idris', { path: brain, name: 'Idris' }, p);
  assert.deepEqual(r, { ok: true, alias: 'idris-local' });
  assert.deepEqual(listLocalTargets(p), [{ host: 'idris-local', org: 'idris', kind: 'local', path: brain, name: 'Idris' }]);
  assert.equal(localTargetFor('idris-local', p).path, brain);
  assert.equal(localTargetFor('idris-box', p), null, 'a box alias is never a local target');
  assert.deepEqual(unregisterLocalBrain('idris', p), { ok: true, removed: true });
  assert.deepEqual(listLocalTargets(p), []);
  assert.deepEqual(unregisterLocalBrain('idris', p), { ok: true, removed: false }, 'twice is fine');
});

test('the registry refuses what it cannot open with: bad slugs, relative paths', () => {
  const p = reg();
  assert.equal(registerLocalBrain('Idris', { path: '/x' }, p).ok, false, 'uppercase is not a slug');
  assert.equal(registerLocalBrain('idris', { path: 'relative/dir' }, p).ok, false, 'a relative path steers nowhere');
  assert.equal(registerLocalBrain('a', { path: '/x' }, p).ok, false, 'one character is below the slug floor');
  assert.deepEqual(listLocalTargets(p), []);
});

test('a corrupt or hand-edited file is an EMPTY registry, never a crash (mirrors box-kinds.json)', () => {
  const p = reg();
  writeFileSync(p, 'not json {{{');
  assert.deepEqual(listLocalTargets(p), []);
  writeFileSync(p, JSON.stringify({ 'BAD SLUG': { path: '/x' }, ok: { path: 'not-absolute' }, fine: { path: '/tmp/fine', name: 'Fine' }, arr: [1] }));
  assert.deepEqual(listLocalTargets(p).map((t) => t.host), ['fine-local'], 'only well-formed rows survive');
  // and the next write round-trips clean JSON over the garbage
  writeFileSync(p, 'garbage');
  assert.equal(registerLocalBrain('recover', { path: '/tmp/recover' }, p).ok, true);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(p, 'utf8'))), ['recover']);
});

test('slugForName is filesystem-safe and unique against the registry', () => {
  const p = reg();
  assert.equal(slugForName('Idris'), 'idris');
  assert.equal(slugForName('  My  Brain!! '), 'my-brain');
  assert.equal(slugForName(''), 'brain');
  assert.equal(slugForName('X'), 'x-brain', 'one character grows to the slug floor');
  registerLocalBrain('idris', { path: '/tmp/a' }, p);
  const taken = new Set(listLocalTargets(p).map((t) => t.org));
  assert.equal(slugForName('Idris', taken), 'idris-2', 'a taken slug gets a suffix');
  assert.match(defaultBrainDir('idris', '/home/x'), /\/home\/x\/Crads-AI\/idris$/);
  assert.ok(LOCAL_HOST_RE.test('idris-local') && !LOCAL_HOST_RE.test('idris-box'));
});
