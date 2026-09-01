#!/usr/bin/env node
// commons-share.mjs: the member-side share-back helper (self-host pivot,
// 2026-09-01; docs/self-host-design.md section 3).
//
//   node commons-share.mjs <state-dir> <brain-root> <org> <kind> <id>
//
// Share-back rides the git host's OWN review flow, never custom machinery: a
// member proposes content to a commons as a branch or a pull request there,
// and the rock owner reviews it with the host's ordinary tools. This helper
// does the mechanical half on the box: it copies the member's item into a
// clean staging tree at <state>/commons-share/<org>/, laid out exactly as the
// commons expects it, and prints the steps (and, when the commons lives on
// GitHub, the fork and compare URLs). It never pushes anything itself: the
// member's read access cannot push, and that is the point of the model.
//
// Kinds and sources (the member's own material, never inbox content):
//   skill  -> <brain>/.claude/skills/<id>/          -> skills/<id>/
//   page   -> <brain>/dashboard/pages/<id>.html     -> offers-pages/<id>.html
//   dir    -> <brain>/library/<pack>/<id>/          -> dirs/library/<id>/
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ORG_RE, readCommunity, validGitUrl } from './commons-lib.mjs';

const [state, brain, org, kind, id] = process.argv.slice(2).map((s) => String(s || ''));
const die = (msg) => { console.log(`ERROR: ${msg}`); process.exit(1); };
if (!state || !brain || !org || !kind || !id) die('usage: commons-share <state-dir> <brain-root> <org> <kind> <id>');
if (!ORG_RE.test(org)) die('org must be the community name shown on the Communities page');
if (!['skill', 'page', 'dir'].includes(kind)) die('kind must be skill, page or dir');
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) die('id must be a kebab-case name');

const rec = readCommunity(state, org);
if (!rec) die(`this box is not a member of a community named ${org}.`);

const realDir = (p) => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };
const realFile = (p) => { try { const s = lstatSync(p); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } };

const stage = path.join(state, 'commons-share', org);
rmSync(stage, { recursive: true, force: true });

let staged = '';
if (kind === 'skill') {
  const src = path.join(brain, '.claude', 'skills', id);
  if (!realDir(src)) die(`no skill named ${id} is installed on this box.`);
  staged = path.join('skills', id);
  cpSync(src, path.join(stage, staged), { recursive: true, dereference: false, filter: (s) => !lstatSync(s).isSymbolicLink() });
} else if (kind === 'page') {
  const src = path.join(brain, 'dashboard', 'pages', `${id}.html`);
  if (!realFile(src)) die(`no page named ${id} is on this box.`);
  staged = path.join('offers-pages', `${id}.html`);
  mkdirSync(path.join(stage, 'offers-pages'), { recursive: true });
  cpSync(src, path.join(stage, staged), { dereference: false });
} else {
  // a library folder: the pack is discovered, the copy proposes it standalone
  const libRoot = path.join(brain, 'library');
  let src = '';
  try {
    for (const pack of readdirSync(libRoot).sort()) {
      const p = path.join(libRoot, pack, id);
      if (realDir(p)) { src = p; break; }
    }
  } catch { /* no library */ }
  if (!src) die(`no folder named ${id} is installed in this box's library.`);
  staged = path.join('dirs', 'library', id);
  cpSync(src, path.join(stage, staged), { recursive: true, dereference: false, filter: (s) => !lstatSync(s).isSymbolicLink() });
}
if (!existsSync(path.join(stage, staged))) die('nothing was staged (the source changed while copying). Try again.');

const v = validGitUrl(rec.url);
const gh = v.ok && (v.host === 'github.com' || (v.host || '').endsWith('.github.com'))
  ? String(rec.url).replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '')
  : '';

console.log(`OK: staged ${staged} for ${rec.org_display || org} at ${path.join('commons-share', org, staged)} (under this box's state directory).`);
console.log('');
console.log('To propose it to the community, use the git host\'s own review flow:');
if (gh) {
  console.log(`  1. Fork the commons on GitHub: ${gh}/fork`);
  console.log(`  2. In your fork, add the staged file(s) at the same path (${staged}).`);
  console.log(`  3. Open a pull request: ${gh}/compare`);
  console.log('  4. The community owner reviews and merges it there. Nothing lands in the commons without their say.');
} else {
  console.log(`  1. Clone the commons somewhere you can write (${rec.url} is read-only to members).`);
  console.log(`  2. Copy the staged file(s) in at the same path (${staged}), commit on a branch, and push the branch wherever the owner can see it.`);
  console.log('  3. Ask the community owner to review and merge. Nothing lands in the commons without their say.');
}
