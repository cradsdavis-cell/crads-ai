// library-list.test.mjs: what the app is told about installed directories.
//   node --test engine/appshell/library-list.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'library-list.mjs');

function brain(indexBody) {
  const root = tmpDir('liblist-');
  mkdirSync(join(root, 'library'), { recursive: true });
  if (indexBody !== undefined) writeFileSync(join(root, 'library', 'index.json'), indexBody);
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}
const read = (root) => {
  const out = execFileSync('node', [CLI, root], { encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.startsWith('LIBRARY_STATE '));
  assert.ok(line, `a LIBRARY_STATE line is always emitted, got: ${out}`);
  return JSON.parse(line.slice('LIBRARY_STATE '.length));
};

test('a box with no library reports an empty list and no error', () => {
  const b = brain();
  const s = read(b.root);
  assert.deepEqual(s.dirs, []);
  assert.equal(s.error, undefined);
  b.done();
});

test('installed directories are reported with every field the app renders', () => {
  const b = brain(JSON.stringify({ dirs: [
    { id: 'coaching-templates', pack: 'kit', rock: 'acme-gh', installed: '2026-08-25', kind: 'templates' },
  ] }));
  const s = read(b.root);
  assert.equal(s.dirs.length, 1);
  assert.deepEqual(s.dirs[0], { id: 'coaching-templates', pack: 'kit', rock: 'acme-gh', installed: '2026-08-25', kind: 'templates' });
  b.done();
});

test('a missing kind is reported as an empty string, never undefined', () => {
  const b = brain(JSON.stringify({ dirs: [{ id: 'tpl', pack: 'kit', rock: 'acme', installed: '2026-08-25' }] }));
  const s = read(b.root);
  assert.equal(s.dirs[0].kind, '');
  b.done();
});

test('an unparseable index reports an error rather than an empty library', () => {
  const b = brain('{ this is not json');
  const s = read(b.root);
  assert.deepEqual(s.dirs, []);
  assert.ok(typeof s.error === 'string' && s.error.length, 'the app is told the index is unreadable, not that the library is empty');
  b.done();
});

test('entries with unsafe or missing ids are dropped, the rest survive', () => {
  const b = brain(JSON.stringify({ dirs: [
    { id: '../escape', pack: 'kit', rock: 'a', installed: '2026-08-25' },
    { id: '', pack: 'kit', rock: 'a', installed: '2026-08-25' },
    null,
    { id: 'good', pack: 'kit', rock: 'a', installed: '2026-08-25' },
  ] }));
  const s = read(b.root);
  assert.deepEqual(s.dirs.map((d) => d.id), ['good']);
  b.done();
});

test('sorted by pack then id, so the section has a stable order', () => {
  const b = brain(JSON.stringify({ dirs: [
    { id: 'z', pack: 'kit', rock: 'a', installed: '2026-08-25' },
    { id: 'a', pack: 'kit', rock: 'a', installed: '2026-08-25' },
    { id: 'm', pack: 'apack', rock: 'a', installed: '2026-08-25' },
  ] }));
  const s = read(b.root);
  assert.deepEqual(s.dirs.map((d) => d.pack + '/' + d.id), ['apack/m', 'kit/a', 'kit/z']);
  b.done();
});

test('a 10,000-character rock value is capped at 200 characters', () => {
  const big = 'x'.repeat(10000);
  const b = brain(JSON.stringify({ dirs: [
    { id: 'good', pack: 'kit', rock: big, installed: '2026-08-25' },
  ] }));
  const s = read(b.root);
  assert.equal(s.dirs[0].rock.length, 200);
  assert.equal(s.dirs[0].rock, big.slice(0, 200));
  b.done();
});

test('an object-valued kind is reported as an empty string, never [object Object]', () => {
  const b = brain(JSON.stringify({ dirs: [
    { id: 'good', pack: 'kit', rock: 'a', installed: '2026-08-25', kind: { nested: 'junk' } },
  ] }));
  const s = read(b.root);
  assert.equal(s.dirs[0].kind, '');
  b.done();
});
