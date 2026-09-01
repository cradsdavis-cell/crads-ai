// p2-pages-verb.test.mjs: the box-side pages verb, kind: 'page' (spec
// 2026-08-26-delivery-model § 5b). Modeled tightly on p2-dirs-verbs.test.mjs,
// which solved this exact shape for kind: 'dir' first. The "skill path stays
// byte-identical" assertion lives there and is EXTENDED, not duplicated here
// (per the step brief); this file covers what is genuinely new to this step:
// the page branch itself, end to end against a fixture inbox.
//   node --test wizard/panel/p2-pages-verb.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MEMBER_VERBS } from './panel-server.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rewrite = (root, cmd) => cmd.replace(/\/state(?=[\/;"' ])/g, root + '/state').split('/app/engine/').join(root + '/app/engine/');

// Same shape as p2-dirs-verbs.test.mjs's box(), copying page-install.mjs's
// own dependency chain (install-page.mjs -> page-lint.mjs, and
// library-path.mjs for the legacy pages/<pack>/<id> search) instead of just
// the one file, since page-install.mjs imports both.
function box({ withEngine = true } = {}) {
  const root = tmpDir('p2pages-');
  mkdirSync(path.join(root, 'state', 'brain'), { recursive: true });
  if (withEngine) {
    const dst = path.join(root, 'app', 'engine', 'appshell');
    mkdirSync(dst, { recursive: true });
    for (const f of ['page-install.mjs', 'install-page.mjs', 'library-path.mjs', 'page-lint.mjs']) {
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
  const pageFile = (id) => path.join(root, 'state', 'dashboard', 'pages', `${id}.html`);
  return { root, w, run, pageFile, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('catalog-install kind page installs an offers-pages offer end to end', () => {
  const b = box();
  b.w('org-inbox/offers-pages/wins.html', '<h1>Wins</h1>');
  b.w('org-inbox/offers-pages/wins.json', JSON.stringify({ title: 'My wins' }));
  b.w('org-inbox.conf', 'ORG_GH_OWNER=acme-gh\nSLUG=jane01\n');
  const r = b.run(MEMBER_VERBS['catalog-install'].build({ id: 'wins', kind: 'page' }).command);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /OK: wins installed/);
  assert.equal(readFileSync(b.pageFile('wins'), 'utf8'), '<h1>Wins</h1>');
  b.done();
});

test('kind page with no offer refuses by page-install.mjs\'s own not-in-your-inbox sentence', () => {
  const b = box();
  b.w('org-inbox.conf', 'ORG_GH_OWNER=acme-gh\nSLUG=jane01\n');
  const r = b.run(MEMBER_VERBS['catalog-install'].build({ id: 'ghost', kind: 'page' }).command);
  assert.equal(r.code, 1);
  assert.match(r.out, /not in your inbox/);
  b.done();
});

test('kind page on an old image reports the named too-old sentence, not a stack trace', () => {
  const b = box({ withEngine: false });
  const r = b.run(MEMBER_VERBS['catalog-install'].build({ id: 'wins', kind: 'page' }).command);
  assert.equal(r.code, 1);
  assert.match(r.out, /too old/i);
  assert.ok(!r.out.includes('Cannot find module'), 'no raw node error reaches the member');
  b.done();
});

test('kind page passes id and rock straight through to page-install.mjs, same shape as dir', () => {
  const cmd = MEMBER_VERBS['catalog-install'].build({ id: 'wins', kind: 'page', rock: 'acme-gh' }).command;
  assert.match(cmd, /node \/app\/engine\/appshell\/page-install\.mjs \/state "\$BR" wins acme-gh$/);
});

test('kind page omits the trailing rock argument when none is given', () => {
  const cmd = MEMBER_VERBS['catalog-install'].build({ id: 'wins', kind: 'page' }).command;
  assert.match(cmd, /node \/app\/engine\/appshell\/page-install\.mjs \/state "\$BR" wins$/);
});
