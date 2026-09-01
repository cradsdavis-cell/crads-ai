// p2-library-verb.test.mjs: the box-side Files read (spec 2026-08-25 § 5.4).
//   node --test wizard/panel/p2-library-verb.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MEMBER_VERBS } from './panel-server.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rewrite = (root, cmd) => cmd.replace(/\/state(?=[\/;"' ])/g, root + '/state').split('/app/engine/').join(root + '/app/engine/');

function box({ withEngine = true } = {}) {
  const root = tmpDir('p2lib-');
  mkdirSync(path.join(root, 'state', 'brain', 'library'), { recursive: true });
  if (withEngine) {
    const dst = path.join(root, 'app', 'engine', 'appshell');
    mkdirSync(dst, { recursive: true });
    for (const f of ['library-list.mjs', 'library-path.mjs']) {
      cpSync(path.join(HERE, '..', '..', 'engine', 'appshell', f), path.join(dst, f));
    }
  }
  const w = (rel, body) => {
    const p = path.join(root, 'state', rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
  };
  const run = (cmd) => {
    let out = '', code = 0;
    try { out = execFileSync('bash', ['-c', rewrite(root, cmd)], { encoding: 'utf8', cwd: root, env: { ...process.env, BRAIN_ROOT: '' } }); }
    catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); code = e.status; }
    return { out, code };
  };
  return { root, w, run, done: () => rmSync(root, { recursive: true, force: true }) };
}
const state = (out) => {
  const line = out.split('\n').find((l) => l.startsWith('LIBRARY_STATE '));
  assert.ok(line, `a LIBRARY_STATE line is always emitted, got: ${out}`);
  return JSON.parse(line.slice('LIBRARY_STATE '.length));
};

test('library-list is a read-only member verb', () => {
  const v = MEMBER_VERBS['library-list'];
  assert.ok(v, 'library-list is registered in MEMBER_VERBS');
  assert.notEqual(v.mutating, true, 'reading the library never mutates');
  assert.notEqual(v.adminOnly, true, 'a member reads their own library');
});

test('library-list returns what the engine found', () => {
  const b = box();
  b.w('brain/library/index.json', JSON.stringify({ dirs: [{ id: 'tpl', pack: 'kit', rock: 'acme-gh', installed: '2026-08-25', kind: 'templates' }] }));
  const r = b.run(MEMBER_VERBS['library-list'].build({}).command);
  assert.equal(r.code, 0, r.out);
  const s = state(r.out);
  assert.equal(s.dirs.length, 1);
  assert.equal(s.dirs[0].id, 'tpl');
  b.done();
});

test('an image too old to carry the script reports dormant, never a hard error', () => {
  const b = box({ withEngine: false });
  const r = b.run(MEMBER_VERBS['library-list'].build({}).command);
  assert.equal(r.code, 0, 'the verb still exits clean');
  const s = state(r.out);
  assert.deepEqual(s.dirs, []);
  assert.match(s.dormant || '', /update/i, 'the member is told the box needs an update, not shown an error');
  b.done();
});
