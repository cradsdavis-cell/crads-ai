#!/usr/bin/env node
// pack-content.mjs <brain-root>: one JSON snapshot of what each pack in
// packs/ ships, versus what actually sits on disk in its prompts/ and
// pages/ subdirectories, for the panel's pack-authoring surface (Phase 5,
// task 1). An operator who edits a prompt or page not named in pack.yaml's
// contents: has written a file that ships nowhere; this is how the app
// knows, so the editor can show it rather than let the pack quietly grow
// orphans.
//
// Read-only, same prefix-line idiom as library-list.mjs and prompts-list.mjs:
// one line, PACKS_STATE plus JSON, exit 0, an error field rather than a
// throw.
//
// This brain is the org's own, authored by the rock operator (less hostile
// than a member's inbox), but the walk still refuses symlinks at every
// level and pins safe checks before any path.join, per prompts-list.mjs's
// discipline: an operator can make a mistake, and a symlink or an odd name
// should skip cleanly rather than throw.
//
// contents: lists are flow-style only ([a, b]) -- pack-lint.mjs refuses a
// block-style list at publish time, so a pack on disk should never carry
// one. This parses pack.yaml the same way pack-lint.mjs and
// catalog-reconcile.mjs do (copied, not shared: a brain-repo tool cannot
// import from ai-os, and ai-os cannot import from a brain repo). If a
// block-style list somehow reaches this box anyway, the regex simply finds
// no match and the key reads as an empty shipped list -- the files on disk
// still appear, just all reported unshipped, rather than the process
// throwing.
//
// contents.prompts and contents.pages are NOT the same rule on the
// pack-lint side, and this file must not pretend they are (a review round
// caught an earlier draft doing exactly that):
//   - contents.pages entries are bare ids, gated by a plain-name shape
//     regex (pack-lint.mjs: `/^[a-z0-9][a-z0-9._-]{0,80}$/`) before the
//     `pages/<id>.html` existence check. PAGE_ID_RE below mirrors that
//     regex on purpose, because pack-lint genuinely enforces that shape.
//   - contents.prompts (and contents.context, which this file does not
//     otherwise touch) entries get NO shape regex at all. pack-lint.mjs
//     only checks `f.includes('..')` (traversal refusal) and then
//     `existsSync(path.join(dir, f))`. So `prompts/Kickoff.md`, with a
//     capital letter and no kebab-case shape, is a perfectly valid shipped
//     prompt as far as pack-lint is concerned. Gating prompt files through
//     a page-shaped regex would make this listing drop files pack-lint
//     ships cleanly -- reporting a pack as shipping nothing when it
//     ships fine, which is the exact failure mode this listing exists to
//     prevent, just inverted. safePromptFile() below applies pack-lint's
//     actual rule: traversal refusal, no path separators, a length cap,
//     plus the symlink refusal every file in this walk gets regardless of
//     shape. It deliberately allows uppercase, spaces, and other legal
//     filename characters through.
//
// "shipped" is NOT just "does pack-lint accept it" (final review, 2026-08-26,
// finding F1). pack-lint.mjs is the PUBLISH-time gate; prompts-list.mjs is
// the DELIVERY path a member's app actually reads (spec
// docs/superpowers/specs/2026-08-25-pack-content-types-design.md § 5.2), and
// it is STRICTER than pack-lint for prompts: only a ".md" file whose stem
// matches its own SAFE shape (case-insensitively kebab-ish) is ever offered
// to a member. A file like `prompts/Bad Name.md` or an extension-less
// `prompts/kickoff` can be named in contents.prompts, sit safely on disk,
// and pass pack-lint at publish time, and STILL never reach anyone. The
// first cut of this file conflated the two gates and reported such files
// shipped:true, which member.html then read as "this ships fine" -- provably
// false. `shipped` below is true only when BOTH gates agree: named in
// contents.prompts AND deliverable per prompts-list.mjs's own rule, imported
// directly from that file (see isDeliverablePromptFile there) rather than
// re-derived here a third time, so the two cannot independently drift again.
// A prompt named in contents.prompts but not deliverable gets `manifestOnly:
// true` instead of shipped:true -- a distinct problem from "not shipped"
// (not named at all), because the fix is different: renaming the file, not
// touching the manifest, which is already correct.
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { isDeliverablePromptFile } from './prompts-list.mjs';

const root = path.resolve(process.argv[2] || '/state');
const emit = (o) => { process.stdout.write(`PACKS_STATE ${JSON.stringify(o)}\n`); process.exit(0); };

// Pack ids are directory names: same kebab-case shape used for skill and
// dir ids everywhere else in this tree.
const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
// Page ids: the plain-name shape pack-lint.mjs genuinely enforces for
// contents.pages, applied here to the file stem before `.html`.
const PAGE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/;
// Prompt file names have no pack-lint shape rule (see the header note), so
// this is a length cap only, not a character class.
const PROMPT_NAME_MAX = 80;
// Per-pack cap on how many prompt or page entries this listing reports,
// matching the PROMPT_CAP prompts-list.mjs already applies to its own
// (larger, cross-pack) listing. A pack over the cap is not an error: the
// listing silently reports the first FILE_CAP entries in sorted order and
// drops the rest, the same "still ships, just not fully enumerated here"
// shape as prompts-list.mjs's own cap.
const FILE_CAP = 200;
const TITLE_CAP = 200;

// Same flow-style-only list parser as pack-lint.mjs and catalog-reconcile.mjs.
function flowList(yaml, key) {
  const m = yaml.match(new RegExp(`^\\s+${key}:\\s*\\[([^\\]]*)\\]`, 'm'));
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

// Same top-level scalar getter pack-lint.mjs uses for id/version/category.
function yget(yaml, key) {
  const m = yaml.match(new RegExp(`^${key}:\\s*"?([^"\\n#]*)"?`, 'm'));
  return m ? m[1].trim() : '';
}

const cap = (s, n) => (s.length > n ? s.slice(0, n) : s);

// A path that exists, is a directory, and is not a symlink at that final
// segment. (Containment against a symlinked ancestor is not a concern here:
// every path we build is one segment below a root we already resolved this
// same way, never from attacker-supplied path components.)
function safeDir(p) {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}
function safeFile(p) {
  try {
    const st = lstatSync(p);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

// pack-lint's actual rule for a contents.prompts entry, applied to the
// on-disk filename: traversal refusal (its `f.includes('..')` check,
// substring-based, not path-segment-aware -- matched here on purpose so a
// name like "v2..final.md" is refused the same way on both sides) plus a
// path-separator refusal and a length cap, both belt-and-braces since a
// bare filename from readdirSync should never legitimately contain either.
// No character-shape regex: pack-lint applies none, so this must not either.
function safePromptFile(file) {
  if (!file) return false;
  if (file.includes('..')) return false;
  if (file.includes('/') || file.includes('\\')) return false;
  if (file.length > PROMPT_NAME_MAX) return false;
  return true;
}

// Cheap agreement check (review ask, F1): not a fuzz proof, just a fast
// sanity check that the imported delivery rule and this file's own
// traversal/separator/length guard have not silently diverged in a way that
// would corrupt the "listed AND deliverable" intersection above. A
// deliverable prompt file must always also pass this file's own guard --
// the delivery rule is strictly narrower (an extension plus a shape regex),
// never wider, so a mismatch here means one of the two files changed
// underneath the other.
if (!(isDeliverablePromptFile('kickoff.md') && safePromptFile('kickoff.md'))) {
  throw new Error('pack-content.mjs: prompts-list.mjs delivery rule and safePromptFile() disagree on a baseline case');
}

// Resolves a contents.prompts manifest entry the same way pack-lint.mjs
// does -- `path.join(dir, f)`, called only for its normalizing side effect
// (a leading "./", a doubled slash, and similar all collapse) -- then
// re-expresses the result relative to packDir in posix form, so it can be
// compared by PATH IDENTITY against the "prompts/<file>" name this listing
// builds for files it finds on disk, rather than by string identity. A
// manifest entry of "./prompts/kickoff.md" and one of "prompts/kickoff.md"
// name the same file to pack-lint's existsSync check; they must name the
// same file here too, or a pack that ships cleanly gets reported as not
// shipping the file at all.
function resolveShippedPromptName(packDir, entry) {
  const abs = path.join(packDir, entry);
  return path.relative(packDir, abs).split(path.sep).join('/');
}

function listPrompts(packDir, shippedEntries) {
  const dir = path.join(packDir, 'prompts');
  if (!safeDir(dir)) return [];
  let files;
  try { files = readdirSync(dir); } catch { return []; }
  const shippedNames = shippedEntries.map((entry) => resolveShippedPromptName(packDir, entry));
  const out = [];
  for (const file of files) {
    if (!safePromptFile(file)) continue;
    if (!safeFile(path.join(dir, file))) continue;
    const name = `prompts/${file}`;
    const listed = shippedNames.includes(name);
    // shipped requires BOTH gates (see the file header): named in the
    // manifest AND actually deliverable per prompts-list.mjs's own rule.
    const entry = { name, shipped: listed && isDeliverablePromptFile(file) };
    // Named in the manifest, exists safely on disk, but will not reach a
    // member: a distinct problem from "not shipped" (not named at all), with
    // a different fix (rename the file, not the manifest). Only set when
    // true, so a normal shipped or plain-unshipped row is unchanged.
    if (listed && !entry.shipped) entry.manifestOnly = true;
    out.push(entry);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out.length > FILE_CAP ? out.slice(0, FILE_CAP) : out;
}

function listPages(packDir, shippedIds) {
  const dir = path.join(packDir, 'pages');
  if (!safeDir(dir)) return [];
  let files;
  try { files = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const file of files) {
    if (!file.endsWith('.html')) continue;
    const id = file.slice(0, -'.html'.length);
    if (!PAGE_ID_RE.test(id)) continue;
    if (!safeFile(path.join(dir, file))) continue;
    out.push({ id, shipped: shippedIds.includes(id) });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out.length > FILE_CAP ? out.slice(0, FILE_CAP) : out;
}

const packs = [];
let error;
try {
  const packsRoot = path.join(root, 'packs');
  let ids = [];
  if (safeDir(packsRoot)) {
    try { ids = readdirSync(packsRoot); } catch { ids = []; }
  }
  for (const id of ids) {
    if (!PACK_ID_RE.test(id)) continue; // an unsafe pack id: skip the whole pack
    const packDir = path.join(packsRoot, id);
    try {
      if (!safeDir(packDir)) continue;
      const yPath = path.join(packDir, 'pack.yaml');
      if (!safeFile(yPath)) continue; // no manifest, or not a plain readable file: skip
      let yaml;
      try { yaml = readFileSync(yPath, 'utf8'); } catch { continue; }
      const title = cap(yget(yaml, 'title') || id, TITLE_CAP);
      const shippedPrompts = flowList(yaml, 'prompts');
      const shippedPages = flowList(yaml, 'pages');
      packs.push({
        id,
        title,
        prompts: listPrompts(packDir, shippedPrompts),
        pages: listPages(packDir, shippedPages),
      });
    } catch {
      // this pack only: a bad neighbour must not sink the rest of the walk
      continue;
    }
  }
} catch (e) {
  // Last-resort backstop, same shape as prompts-list.mjs: whatever was
  // collected before the failure still ships, and the client's error branch
  // is reachable instead of a silent process crash.
  error = (e && e.message) || String(e);
}

packs.sort((a, b) => a.id.localeCompare(b.id));
const result = { packs };
if (error) result.error = error;
emit(result);
