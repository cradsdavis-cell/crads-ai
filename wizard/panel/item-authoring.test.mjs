// item-authoring.test.mjs: the Catalogue can SEE and AUTHOR the three item
// kinds that shipped this week (step 7, spec 2026-08-26-delivery-model).
//   node --test wizard/panel/item-authoring.test.mjs
//
// Until this step the Catalogue built its rows from skill-list + pack-list
// alone, and no verb read prompts-library, pages-library or dirs-library at
// all. So a rock could publish a prompt only by hand-editing
// catalog/policy.json, and could author one only by hand-creating two files.
// Delivery worked; the surface a rock actually touches did not. What this
// file guards:
//   1. item-list walks the three roots, and refuses the same items readKind
//      refuses, so the page never offers a publish that stages nothing
//   2. prompt-write / page-write write the standalone library shape, and
//      never clobber a manifest the operator has since edited
//   3. an operator-supplied title cannot forge a YAML field or reach the shell
//   4. category is checked at authoring, against the same six the publish path
//      refuses by, so nothing is authored dead
//   5. the pack path is byte-for-byte what it was
//   6. member.html renders zones by kind, keeps a fallback zone for kinds it
//      has no name for, and offers STANDALONE folders, not only pack-nested
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { VERBS } from './panel-server.mjs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// Runs a verb's real command with $BR pointed at a scratch brain. BRAIN_ROOT
// is the documented fallback inside BRAIN_ROOT_SH, so this exercises the
// shipped command string rather than a re-implementation of it.
function runVerb(name, args, brain) {
  const spec = VERBS[name].build(args);
  try {
    return { ok: true, out: execFileSync('sh', ['-c', spec.command],
      { input: spec.stdin ?? '', encoding: 'utf8', env: { ...process.env, BRAIN_ROOT: brain } }) };
  } catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') }; }
}

function seedBrain() {
  const brain = tmpDir('itemauth-');
  const put = (rel, body) => {
    mkdirSync(path.join(brain, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(brain, rel), body);
  };
  put('prompts-library/weekly-review/prompt.yaml', 'id: weekly-review\nversion: 2\ntitle: Weekly review\ncategory: briefing\n');
  put('prompts-library/weekly-review/PROMPT.md', 'body\n');
  put('prompts-library/_draft/prompt.yaml', 'id: _draft\nversion: 1\n');       // underscore: skipped
  put('prompts-library/_draft/PROMPT.md', 'x\n');
  put('prompts-library/no-body/prompt.yaml', 'id: no-body\nversion: 1\n');     // no marker: skipped
  put('pages-library/house-rules/page.yaml', 'id: house-rules\nversion: 1\ntitle: House rules\n');
  put('pages-library/house-rules/page.html', '<p>hi</p>\n');
  put('dirs-library/letters/dir.yaml', 'id: letters\nversion: 3\ntitle: Letters\nkind: docs\n');
  put('dirs-library/letters/files/a.txt', 'a\n');
  put('dirs-library/no-files/dir.yaml', 'id: no-files\nversion: 1\n');          // no files/: skipped
  return brain;
}

test('item-list walks the three roots and refuses what readKind refuses', () => {
  const out = runVerb('item-list', {}, seedBrain()).out;
  assert.match(out, /^=== prompt\/weekly-review$/m);
  assert.match(out, /^=== page\/house-rules$/m);
  assert.match(out, /^=== dir\/letters$/m);
  // an item with no payload marker is not catalogable on the rock, so listing
  // it here would offer a publish that reconcile silently stages nothing for
  assert.doesNotMatch(out, /no-body/, 'a prompt with no PROMPT.md must not be listed');
  assert.doesNotMatch(out, /no-files/, 'a folder with no files\\/ must not be listed');
  assert.doesNotMatch(out, /_draft/, 'an underscore-prefixed item must not be listed');
  // the header carries kind AND id: three roots share one stream, and an id is
  // unique only within its own root
  assert.equal((out.match(/^=== /gm) || []).length, 3);
});

test('item-list skips by basename, so an underscore in the brain path hides nothing', () => {
  const brain = tmpDir('item_auth_under-');       // underscore in the path itself
  mkdirSync(path.join(brain, 'prompts-library/kept'), { recursive: true });
  writeFileSync(path.join(brain, 'prompts-library/kept/prompt.yaml'), 'id: kept\nversion: 1\n');
  writeFileSync(path.join(brain, 'prompts-library/kept/PROMPT.md'), 'x\n');
  assert.match(runVerb('item-list', {}, brain).out, /^=== prompt\/kept$/m);
});

test('prompt-write target:library writes the standalone shape with a full manifest', () => {
  const brain = tmpDir('itemauth-');
  const r = runVerb('prompt-write', { target: 'library', name: 'weekly-review', title: 'Weekly review',
    description: 'Run your week', category: 'briefing', content_b64: b64('# Weekly review\n') }, brain);
  assert.ok(r.ok, r.out);
  assert.match(r.out, /OK: prompt weekly-review saved to your library\./);
  assert.equal(readFileSync(path.join(brain, 'prompts-library/weekly-review/PROMPT.md'), 'utf8'), '# Weekly review\n');
  const man = readFileSync(path.join(brain, 'prompts-library/weekly-review/prompt.yaml'), 'utf8');
  assert.match(man, /^id: weekly-review$/m);
  assert.match(man, /^version: 1$/m);
  assert.match(man, /^title: "Weekly review"$/m);
  assert.match(man, /^category: "briefing"$/m);
});

test('re-saving a body never clobbers a manifest the operator has since edited', () => {
  const brain = tmpDir('itemauth-');
  runVerb('prompt-write', { target: 'library', name: 'p', category: 'other', content_b64: b64('v1\n') }, brain);
  const man = path.join(brain, 'prompts-library/p/prompt.yaml');
  writeFileSync(man, 'id: p\nversion: 9\ntitle: "Edited by hand"\ncategory: "org"\n');
  const r = runVerb('prompt-write', { target: 'library', name: 'p', overwrite: true, category: 'other', content_b64: b64('v2\n') }, brain);
  assert.ok(r.ok, r.out);
  assert.equal(readFileSync(path.join(brain, 'prompts-library/p/PROMPT.md'), 'utf8'), 'v2\n', 'the body should update');
  assert.match(readFileSync(man, 'utf8'), /Edited by hand/, 'the manifest must survive');
});

test('category is checked at authoring, against the same six the publish path refuses by', () => {
  // brain-template control/catalog-lib.mjs CATEGORIES. enforceCategories()
  // refuses anything else BY NAME with no default, so an item authored with a
  // category outside this list could never reach a member.
  for (const c of ['briefing', 'capture', 'comms', 'box', 'org', 'other']) {
    assert.doesNotThrow(() => VERBS['prompt-write'].build(
      { target: 'library', name: 'p', category: c, content_b64: b64('x') }), c);
  }
  assert.throws(() => VERBS['prompt-write'].build(
    { target: 'library', name: 'p', category: 'nonsense', content_b64: b64('x') }),
  /category must be one of: briefing, capture, comms, box, org, other/);
  assert.throws(() => VERBS['page-write'].build(
    { target: 'library', id: 'p', category: 'skills', content_b64: b64('x') }), /category must be one of/);
});

test('an operator title cannot forge a manifest field or reach the shell', () => {
  const brain = tmpDir('itemauth-');
  const r = runVerb('prompt-write', { target: 'library', name: 'evil', category: 'other',
    title: 'Bad"\ncategory: box\n#x', content_b64: b64('body') }, brain);
  assert.ok(r.ok, r.out);
  const man = readFileSync(path.join(brain, 'prompts-library/evil/prompt.yaml'), 'utf8');
  assert.match(man, /^category: "other"$/m, 'the real category must survive');
  assert.equal((man.match(/^category:/gm) || []).length, 1, 'no second category line may be forged');
  assert.equal((man.match(/^title:/gm) || []).length, 1);
  assert.match(man, /^title: "Bad category: box x"$/m,
    'the newline, the quote and the # must all be neutralised into one scalar');
  assert.equal(man.split('\n').length, 6, 'the manifest must not gain a line');
});

test('page-write target:library writes page.html beside page.yaml', () => {
  const brain = tmpDir('itemauth-');
  const r = runVerb('page-write', { target: 'library', id: 'house-rules', title: 'House rules',
    category: 'org', content_b64: b64('<!doctype html><p>hi</p>') }, brain);
  assert.ok(r.ok, r.out);
  assert.ok(existsSync(path.join(brain, 'pages-library/house-rules/page.html')));
  assert.match(readFileSync(path.join(brain, 'pages-library/house-rules/page.yaml'), 'utf8'), /^title: "House rules"$/m);
});

test('the pack path is unchanged: no pack, no write', () => {
  const brain = tmpDir('itemauth-');
  const r = runVerb('prompt-write', { pack: 'ghost', name: 'p', content_b64: b64('x') }, brain);
  assert.ok(!r.ok);
  assert.match(r.out, /ERROR: no pack named ghost on this mineral\./);
  assert.ok(!existsSync(path.join(brain, 'packs')), 'nothing may be created for a pack that does not exist');
  // and a pack write must not inherit the library path's category refusal for
  // an argument it never reads
  assert.doesNotThrow(() => VERBS['prompt-write'].build({ pack: 'p', name: 'n', category: 'nonsense', content_b64: b64('x') }));
});

test('the Catalogue reads item-list and takes the kind from its header', () => {
  assert.match(html, /run\('item-list', \{\}\)/, 'the Catalogue must read the item libraries');
  const load = html.slice(html.indexOf('CAT.loading = Promise.all'), html.indexOf('CAT.loaded = true'));
  assert.match(load, /head\.indexOf\('\/'\)/, 'the "<kind>/<id>" header must be split');
  assert.match(load, /iit\.kind = ikind/, 'the kind must come from the header');
  assert.doesNotMatch(load, /yamlScalar\(iy, 'kind'\)/,
    "dir.yaml's own kind: is a content label, never the catalogue kind");
});

test('the Catalogue renders a zone per kind, and keeps one for kinds it cannot name', () => {
  for (const label of ['Skills', 'Prompts', 'Pages', 'Folders', 'Packs']) {
    assert.match(html, new RegExp(`'${label}'`), `the ${label} zone is missing`);
  }
  const render = html.slice(html.indexOf('function renderCatalogue()'), html.indexOf('function renderCatState'));
  assert.match(render, /zone\('Other'/,
    'an unknown kind must still render: filtering to a known list would hide a newer rock\'s items from the only screen that can publish them');
});

test('the member Files zone offers standalone folders, not only pack-nested ones', () => {
  const fn = html.slice(html.indexOf('function renderFilesOffered()'), html.indexOf('empty.style.display = ((state.filesDirs'));
  assert.match(fn, /it\.kind === 'dir'/,
    'a standalone folder stages into offers-dirs/ and would otherwise be entitled, delivered and invisible');
  assert.match(fn, /o\.pack \? 'Part of '/, 'a standalone folder has no pack to name');
});
