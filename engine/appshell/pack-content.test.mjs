// pack-content.test.mjs: what the panel's authoring surface is told about
// what a pack ships versus what sits on disk in its prompts/ and pages/
// subdirectories (Phase 5 pack authoring, task 1).
//   node --test engine/appshell/pack-content.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'pack-content.mjs');

function brainRoot() {
  const root = tmpDir('packcontent-');
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

// Writes packs/<id>/pack.yaml plus whatever prompts/pages files are asked
// for. `yaml` overrides the whole manifest body when a test needs a shape
// pack-lint would reject (block-style lists, a missing manifest, and so on).
function mkPack(root, id, { title = 'T', prompts = [], pages = [], promptFiles = [], pageFiles = [], yaml, noManifest = false } = {}) {
  const dir = join(root, 'packs', id);
  mkdirSync(dir, { recursive: true });
  for (const f of promptFiles) {
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    writeFileSync(join(dir, 'prompts', f), '# a prompt\n');
  }
  for (const f of pageFiles) {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', f), '<div>page</div>');
  }
  if (noManifest) return dir;
  const body = yaml ?? (
    `id: ${id}\nversion: 2\ntitle: "${title}"\nsummary: "s"\ncategory: "org"\ncontents:\n`
    + `  skills: []\n  context: []\n  prompts: [${prompts.join(', ')}]\n  pages: [${pages.join(', ')}]\n`
  );
  writeFileSync(join(dir, 'pack.yaml'), body);
  return dir;
}

function read(root) {
  const out = execFileSync('node', [CLI, root], { encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.startsWith('PACKS_STATE '));
  assert.ok(line, `a PACKS_STATE line is always emitted, got: ${out}`);
  return JSON.parse(line.slice('PACKS_STATE '.length));
}

test('an empty brain reports no packs and no error', () => {
  const b = brainRoot();
  const s = read(b.root);
  assert.deepEqual(s.packs, []);
  assert.equal(s.error, undefined);
  b.done();
});

test('a brain with a packs dir but nothing in it also reports no packs and no error', () => {
  const b = brainRoot();
  mkdirSync(join(b.root, 'packs'), { recursive: true });
  const s = read(b.root);
  assert.deepEqual(s.packs, []);
  assert.equal(s.error, undefined);
  b.done();
});

test('a shipped prompt and a shipped page both report shipped true', () => {
  const b = brainRoot();
  mkPack(b.root, 'starter-pack', {
    prompts: ['prompts/kickoff.md'],
    pages: ['pipeline'],
    promptFiles: ['kickoff.md'],
    pageFiles: ['pipeline.html'],
  });
  const s = read(b.root);
  assert.equal(s.packs.length, 1);
  const p = s.packs[0];
  assert.equal(p.id, 'starter-pack');
  assert.equal(p.title, 'T');
  assert.deepEqual(p.prompts, [{ name: 'prompts/kickoff.md', shipped: true }]);
  assert.deepEqual(p.pages, [{ id: 'pipeline', shipped: true }]);
  b.done();
});

test('a file on disk not listed in contents reports shipped false, it still appears', () => {
  const b = brainRoot();
  mkPack(b.root, 'orphan-pack', {
    prompts: [],
    pages: [],
    promptFiles: ['orphaned.md'],
    pageFiles: ['orphaned.html'],
  });
  const s = read(b.root);
  const p = s.packs[0];
  assert.deepEqual(p.prompts, [{ name: 'prompts/orphaned.md', shipped: false }]);
  assert.deepEqual(p.pages, [{ id: 'orphaned', shipped: false }]);
  b.done();
});

test('a contents entry whose file is missing on disk does not appear: the listing describes disk, not the manifest', () => {
  const b = brainRoot();
  mkPack(b.root, 'wishful-pack', {
    prompts: ['prompts/ghost.md'],
    pages: ['ghost'],
    promptFiles: [],
    pageFiles: [],
  });
  const s = read(b.root);
  const p = s.packs[0];
  assert.deepEqual(p.prompts, []);
  assert.deepEqual(p.pages, []);
  b.done();
});

test('pack ids failing the safe-name regex are skipped entirely', () => {
  const b = brainRoot();
  mkPack(b.root, 'good-pack', { prompts: [], pages: [] });
  // Directory name with an underscore and uppercase: not kebab-case.
  mkPack(b.root, 'Bad_Pack', { prompts: [], pages: [] });
  const s = read(b.root);
  assert.deepEqual(s.packs.map((p) => p.id), ['good-pack']);
  b.done();
});

// Corrected post-review: this test originally asserted 'Bad Name.md' (a
// space and a capital letter, no ".." or separator) was dropped from the
// prompts list, on the assumption that prompt files were gated by the same
// shape regex as page ids. That assumption was the F1 defect: pack-lint
// applies no shape regex to contents.prompts, only traversal refusal, so a
// prompt file like this ships cleanly and must appear (unshipped, since it
// is not in contents.prompts here, but present). The page-id assertion is
// unchanged: pack-lint genuinely does gate contents.pages by this shape.
test('page ids failing the safe-name regex are skipped; prompt file names are not shape-restricted, only path-unsafe ones are', () => {
  const b = brainRoot();
  mkPack(b.root, 'mixed-pack', {
    prompts: [],
    pages: [],
    promptFiles: ['Bad Name.md', 'good-name.md'],
    pageFiles: ['Bad Page.html', 'good-page.html'],
  });
  const s = read(b.root);
  const p = s.packs[0];
  assert.deepEqual(p.prompts.map((x) => x.name).sort(), ['prompts/Bad Name.md', 'prompts/good-name.md']);
  assert.ok(p.prompts.every((x) => x.shipped === false));
  assert.deepEqual(p.pages.map((x) => x.id), ['good-page']);
  b.done();
});

test('a pack directory with no pack.yaml is skipped', () => {
  const b = brainRoot();
  mkPack(b.root, 'no-manifest', { noManifest: true, promptFiles: ['x.md'] });
  mkPack(b.root, 'good-pack', { prompts: [], pages: [] });
  const s = read(b.root);
  assert.deepEqual(s.packs.map((p) => p.id), ['good-pack']);
  b.done();
});

test('a pack whose pack.yaml cannot be read as a file is skipped without taking the others down', () => {
  const b = brainRoot();
  // pack.yaml as a directory instead of a file: unreadable as a manifest,
  // deterministically, without depending on the test runner's uid/gid.
  const dir = join(b.root, 'packs', 'broken-pack');
  mkdirSync(join(dir, 'pack.yaml'), { recursive: true });
  mkPack(b.root, 'fine-pack', { prompts: ['prompts/a.md'], pages: [], promptFiles: ['a.md'] });
  const s = read(b.root);
  assert.deepEqual(s.packs.map((p) => p.id), ['fine-pack']);
  b.done();
});

test('a block-style contents list (which pack-lint refuses) is read as empty here, not thrown on', () => {
  const b = brainRoot();
  const dir = join(b.root, 'packs', 'block-pack');
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'a.md'), '# a prompt\n');
  writeFileSync(join(dir, 'pack.yaml'),
    'id: block-pack\nversion: 2\ntitle: "Block"\nsummary: "s"\ncategory: "org"\ncontents:\n'
    + '  skills: []\n  context: []\n  prompts:\n    - prompts/a.md\n  pages: []\n');
  const s = read(b.root);
  const p = s.packs[0];
  assert.equal(p.id, 'block-pack');
  // The flow-style parser finds no `prompts: [...]` line, so it reads as an
  // empty shipped list; the file on disk still appears, just as unshipped.
  assert.deepEqual(p.prompts, [{ name: 'prompts/a.md', shipped: false }]);
  b.done();
});

test('packs sort by id and files within a pack sort by name', () => {
  const b = brainRoot();
  mkPack(b.root, 'zeta-pack', {
    prompts: [],
    pages: [],
    promptFiles: ['b.md', 'a.md'],
    pageFiles: ['y.html', 'x.html'],
  });
  mkPack(b.root, 'alpha-pack', { prompts: [], pages: [] });
  const s = read(b.root);
  assert.deepEqual(s.packs.map((p) => p.id), ['alpha-pack', 'zeta-pack']);
  const zeta = s.packs.find((p) => p.id === 'zeta-pack');
  assert.deepEqual(zeta.prompts.map((x) => x.name), ['prompts/a.md', 'prompts/b.md']);
  assert.deepEqual(zeta.pages.map((x) => x.id), ['x', 'y']);
  b.done();
});

test('a missing title falls back to the pack id', () => {
  const b = brainRoot();
  const dir = join(b.root, 'packs', 'untitled-pack');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.yaml'),
    'id: untitled-pack\nversion: 2\nsummary: "s"\ncategory: "org"\ncontents:\n'
    + '  skills: []\n  context: []\n  prompts: []\n  pages: []\n');
  const s = read(b.root);
  assert.equal(s.packs[0].title, 'untitled-pack');
  b.done();
});

// --- Post-review fixes (F1, F2, and the two minors) -----------------------
//
// pack-lint.mjs applies NO character-shape regex to contents.prompts (or
// contents.context) entries -- only `f.includes('..')` plus an existsSync
// check (pack-lint.mjs:48-52). Only contents.pages gets a plain-name shape
// regex. A prompt file with a capital letter, or a manifest entry with a
// leading "./", both ship cleanly through pack-lint and must not be
// dropped or mis-reported here.

test('F1: an uppercase prompt filename is not a pack-lint violation, so it appears with shipped true', () => {
  const b = brainRoot();
  mkPack(b.root, 'case-pack', {
    prompts: ['prompts/Kickoff.md'],
    pages: [],
    promptFiles: ['Kickoff.md'],
  });
  const s = read(b.root);
  const p = s.packs[0];
  assert.deepEqual(p.prompts, [{ name: 'prompts/Kickoff.md', shipped: true }]);
  b.done();
});

test('F2: a "./"-prefixed manifest entry names the same file pack-lint\'s path.join resolves it to, so it matches', () => {
  const b = brainRoot();
  mkPack(b.root, 'dotslash-pack', {
    prompts: ['./prompts/kickoff.md'],
    pages: [],
    promptFiles: ['kickoff.md'],
  });
  const s = read(b.root);
  const p = s.packs[0];
  assert.deepEqual(p.prompts, [{ name: 'prompts/kickoff.md', shipped: true }]);
  b.done();
});

test('a prompt filename containing ".." is refused (pack-lint\'s own traversal rule), and does not appear at all', () => {
  const b = brainRoot();
  mkPack(b.root, 'traversal-pack', {
    prompts: [],
    pages: [],
    promptFiles: ['weird..name.md', 'safe.md'],
  });
  const s = read(b.root);
  const p = s.packs[0];
  assert.deepEqual(p.prompts.map((x) => x.name), ['prompts/safe.md']);
  b.done();
});

test('a pack with more prompt files than the cap reports only the first FILE_CAP, sorted', () => {
  const b = brainRoot();
  const dir = join(b.root, 'packs', 'huge-pack');
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  const total = 205;
  for (let i = 0; i < total; i++) {
    writeFileSync(join(dir, 'prompts', `f${String(i).padStart(3, '0')}.md`), '# p\n');
  }
  writeFileSync(join(dir, 'pack.yaml'),
    'id: huge-pack\nversion: 2\ntitle: "Huge"\nsummary: "s"\ncategory: "org"\ncontents:\n'
    + '  skills: []\n  context: []\n  prompts: []\n  pages: []\n');
  const s = read(b.root);
  const p = s.packs[0];
  assert.equal(p.prompts.length, 200);
  assert.equal(p.prompts[0].name, 'prompts/f000.md');
  assert.equal(p.prompts[199].name, 'prompts/f199.md');
  b.done();
});

test('a title longer than TITLE_CAP is truncated, not shipped whole', () => {
  const b = brainRoot();
  const dir = join(b.root, 'packs', 'long-title-pack');
  mkdirSync(dir, { recursive: true });
  const longTitle = 'x'.repeat(250);
  writeFileSync(join(dir, 'pack.yaml'),
    `id: long-title-pack\nversion: 2\ntitle: "${longTitle}"\nsummary: "s"\ncategory: "org"\ncontents:\n`
    + '  skills: []\n  context: []\n  prompts: []\n  pages: []\n');
  const s = read(b.root);
  assert.equal(s.packs[0].title.length, 200);
  assert.equal(s.packs[0].title, 'x'.repeat(200));
  b.done();
});

// --- Final review fixes (F1) -----------------------------------------------
//
// pack-lint's rule (traversal refusal only, tested above via F1/F2) is the
// MANIFEST gate. prompts-list.mjs's rule (".md" extension, SAFE-shaped stem,
// spec docs/superpowers/specs/2026-08-25-pack-content-types-design.md § 5.2)
// is the DELIVERY gate a member's app actually reads. They are not the same
// rule, and pack-lint accepting a name says nothing about whether a member
// ever sees it.

test('final review F1: a manifest-listed prompt with a space in its name passes pack-lint but is never delivered, so it reports shipped false and manifestOnly true', () => {
  const b = brainRoot();
  mkPack(b.root, 'space-pack', {
    prompts: ['prompts/Bad Name.md'],
    pages: [],
    promptFiles: ['Bad Name.md'],
  });
  const s = read(b.root);
  const p = s.packs[0];
  assert.deepEqual(p.prompts, [{ name: 'prompts/Bad Name.md', shipped: false, manifestOnly: true }]);
  b.done();
});

test('final review F1: a manifest-listed prompt with the wrong extension passes pack-lint but is never delivered', () => {
  const b = brainRoot();
  mkPack(b.root, 'ext-pack', {
    prompts: ['prompts/notes.txt'],
    pages: [],
    promptFiles: ['notes.txt'],
  });
  const s = read(b.root);
  const p = s.packs[0];
  assert.deepEqual(p.prompts, [{ name: 'prompts/notes.txt', shipped: false, manifestOnly: true }]);
  b.done();
});

test('final review F1: a manifest-listed prompt with no extension at all passes pack-lint but is never delivered (the F2 collision case)', () => {
  const b = brainRoot();
  mkPack(b.root, 'noext-pack', {
    prompts: ['prompts/kickoff'],
    pages: [],
    promptFiles: ['kickoff'],
  });
  const s = read(b.root);
  const p = s.packs[0];
  assert.deepEqual(p.prompts, [{ name: 'prompts/kickoff', shipped: false, manifestOnly: true }]);
  b.done();
});

test('final review F1: an uppercase prompt filename is still genuinely delivered (case-insensitive), so it stays shipped true with no manifestOnly flag', () => {
  const b = brainRoot();
  mkPack(b.root, 'case-pack-2', {
    prompts: ['prompts/Kickoff.md'],
    pages: [],
    promptFiles: ['Kickoff.md'],
  });
  const s = read(b.root);
  const p = s.packs[0];
  // Deep-equal on purpose: manifestOnly must be ABSENT here, not false, so a
  // genuinely-shipping row's shape never grows an extra key.
  assert.deepEqual(p.prompts, [{ name: 'prompts/Kickoff.md', shipped: true }]);
  b.done();
});

test('final review F1: a not-deliverable prompt file that is also not manifest-listed is plain not-shipped, no manifestOnly flag (that fix would not help either)', () => {
  const b = brainRoot();
  mkPack(b.root, 'orphan-space-pack', {
    prompts: [],
    pages: [],
    promptFiles: ['Bad Name.md'],
  });
  const s = read(b.root);
  const p = s.packs[0];
  assert.deepEqual(p.prompts, [{ name: 'prompts/Bad Name.md', shipped: false }]);
  b.done();
});
