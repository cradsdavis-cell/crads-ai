// p2-dirs-verbs.test.mjs: the box-side dirs verbs (spec 2026-08-25 § 5.3).
//   node --test wizard/panel/p2-dirs-verbs.test.mjs
// Shell verbs run for real against a fixture tree, like p2-prompts-verb.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MEMBER_VERBS } from './panel-server.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rewrite = (root, cmd) => cmd.replace(/\/state(?=[\/;"' ])/g, root + '/state').split('/app/engine/').join(root + '/app/engine/');

function box({ withEngine = true } = {}) {
  const root = tmpDir('p2dirs-');
  mkdirSync(path.join(root, 'state', 'brain'), { recursive: true });
  if (withEngine) {
    const dst = path.join(root, 'app', 'engine', 'appshell');
    mkdirSync(dst, { recursive: true });
    for (const f of ['dir-install.mjs', 'dir-remove.mjs', 'library-path.mjs']) {
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
  return { root, w, run, brain: path.join(root, 'state', 'brain'), done: () => rmSync(root, { recursive: true, force: true }) };
}

test('dir-remove is a mutating, non-admin member verb; catalog-install accepts kind', () => {
  assert.ok(MEMBER_VERBS['dir-remove'], 'dir-remove is registered');
  assert.equal(MEMBER_VERBS['dir-remove'].mutating, true, 'removal mutates');
  assert.notEqual(MEMBER_VERBS['dir-remove'].adminOnly, true, 'a member removes from their own library');
  assert.doesNotThrow(() => MEMBER_VERBS['catalog-install'].build({ id: 'x', kind: 'dir' }));
  // step 5b: pages ride the same kind switch, alongside dir.
  assert.doesNotThrow(() => MEMBER_VERBS['catalog-install'].build({ id: 'x', kind: 'page' }));
  assert.throws(() => MEMBER_VERBS['catalog-install'].build({ id: 'x', kind: 'nonsense' }), /kind/);
});

test('catalog-install kind dir installs an anchor dirs offer end to end', () => {
  const b = box();
  b.w('org-inbox/dirs/kit/tpl/a.md', 'content');
  b.w('org-inbox.conf', 'ORG_GH_OWNER=acme-gh\nSLUG=jane01\n');
  const r = b.run(MEMBER_VERBS['catalog-install'].build({ id: 'tpl', kind: 'dir' }).command);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /OK: tpl installed/);
  assert.equal(readFileSync(path.join(b.brain, 'library', 'kit', 'tpl', 'a.md'), 'utf8'), 'content');
  b.done();
});

test('dir-remove removes what catalog-install installed', () => {
  const b = box();
  b.w('org-inbox/dirs/kit/tpl/a.md', 'content');
  assert.equal(b.run(MEMBER_VERBS['catalog-install'].build({ id: 'tpl', kind: 'dir' }).command).code, 0);
  const r = b.run(MEMBER_VERBS['dir-remove'].build({ id: 'tpl' }).command);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /OK: tpl removed/);
  assert.ok(!existsSync(path.join(b.brain, 'library', 'kit', 'tpl')));
  b.done();
});

test('kind dir on an old image reports the named too-old sentence, not a stack trace', () => {
  const b = box({ withEngine: false });
  const r = b.run(MEMBER_VERBS['catalog-install'].build({ id: 'tpl', kind: 'dir' }).command);
  assert.equal(r.code, 1);
  assert.match(r.out, /too old/i);
  assert.ok(!r.out.includes('Cannot find module'), 'no raw node error reaches the member');
  b.done();
});

test('omitting kind keeps the skill path byte-identical', () => {
  const withKind = MEMBER_VERBS['catalog-install'].build({ id: 'x' }).command;
  const legacy = MEMBER_VERBS['catalog-install'].build({ id: 'x', kind: 'skill' }).command;
  assert.equal(withKind, legacy, 'kind: skill is the default and changes nothing');
  assert.match(withKind, /SKILL\.md/, 'the skill path is still the skill path');
  // step 5b: adding a THIRD branch (page) alongside dir must not perturb the
  // default (skill) path either, and must itself take a visibly different one.
  const page = MEMBER_VERBS['catalog-install'].build({ id: 'x', kind: 'page' }).command;
  assert.notEqual(page, withKind, 'kind: page takes a different path from the default skill path');
  assert.match(page, /page-install\.mjs/, 'kind: page calls the page-install engine script');
});
