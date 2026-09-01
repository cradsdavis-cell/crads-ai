// vendor-packaging.test.mjs: every /vendor/ asset the panel IMPORTS must be
// packaged into the exe.  node --test wizard/panel/vendor-packaging.test.mjs
//
// THE FAILURE THIS PINS (2026-08-23). The connector marks landed as 61 files
// under wizard/panel/vendor/marks/ and were added to NEITHER the SEA asset map
// (.github/workflows/wizard-app.yml) NOR the runtime vendor list (wizard/app.mjs).
// The packaged exe has no disk files, so /vendor/marks/index.mjs 404ed, the
// `import { markFor }` in member.html failed, and EVERY connector fell back to
// its initial disc. It looked perfect in a dev checkout the whole time, because
// server-lib.mjs's /vendor/ route falls back to reading disk.
//
// So the contract is: if a panel page fetches /vendor/<name>, that <name> is in
// both lists. Asserted from the SOURCE of each list rather than a copy, so this
// cannot drift the way a pinned string does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// What the panel actually asks the /vendor/ route for, harvested from the pages.
function vendorRefsInPages() {
  const refs = new Set();
  for (const f of readdirSync(HERE).filter((n) => n.endsWith('.html'))) {
    const html = readFileSync(join(HERE, f), 'utf8');
    for (const m of html.matchAll(/["'`]\/vendor\/([A-Za-z0-9._\/-]+)["'`]/g)) refs.add(m[1]);
  }
  return refs;
}

test('every /vendor asset the panel requests is in the SEA map and the runtime list', () => {
  const workflow = read('.github/workflows/wizard-app.yml');
  const app = read('wizard/app.mjs');
  // The runtime list is the array literal app.mjs loops over to pull names out
  // of the SEA blob; a name missing here is unreachable even if it IS embedded.
  const listBlock = app.slice(app.indexOf("for (const name of ['xterm.js'"), app.indexOf("try { vendor[name] ="));

  const missing = [];
  for (const ref of vendorRefsInPages()) {
    // The SEA map key is the path relative to wizard/panel/vendor/.
    if (!workflow.includes(`"${ref}": "wizard/panel/vendor/${ref}"`)) missing.push(`${ref} (not in the SEA asset map)`);
    if (!listBlock.includes(`'${ref}'`)) missing.push(`${ref} (not in app.mjs's vendor list)`);
  }
  assert.deepEqual(missing, [],
    `these are fetched from /vendor/ but would 404 in the packaged exe: ${missing.join('; ')}`);
});

test('the marks module exports what member.html imports', () => {
  const marks = read('wizard/panel/vendor/marks/index.mjs');
  // member.html does `import { markFor } from '/vendor/marks/index.mjs'`, so a
  // rename of this export breaks the page even when the file serves fine.
  assert.match(marks, /export function markFor\b/, 'markFor is the symbol member.html imports');
  assert.match(read('wizard/panel/member.html'), /import \{ markFor \} from '\/vendor\/marks\/index\.mjs'/);
});

test('the marks module is self-contained, so shipping it alone is enough', () => {
  const marks = read('wizard/panel/vendor/marks/index.mjs');
  // The marks are inlined as data URIs; if the module ever referenced its sibling
  // .svg/.png files at runtime, those files would need packaging too and this
  // one-file fix would be a half fix.
  assert.doesNotMatch(marks, /["'`]\.\/[a-z0-9-]+\.(svg|png)["'`]/,
    'the module references sibling image files, which are NOT packaged into the exe');
  assert.match(marks, /data:image\//, 'marks are expected to be inlined as data URIs');
});
