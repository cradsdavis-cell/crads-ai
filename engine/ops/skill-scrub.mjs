#!/usr/bin/env node
// skill-scrub.mjs: R25 (panel iteration 2, 2026-08-23): the gate a rock's
// library item passes through before it is offered to anybody. Publishing
// copies <root>/<id>/ (skills-library, then prompts-library / pages-library /
// dirs-library, delivery-model 2026-08-26) into every entitled member's
// inbox, so anything the author left in it (a key pasted while testing, a
// teammate's slug, a box hostname, the rock's own /state/brain path) leaves
// the rock with it.
//
// Scans the payload files for each of the four kinds (see KIND_SPECS below)
// and REFUSES on four categories, naming file:line for every hit. Nothing is
// altered silently: the author fixes the file, then publishes again.
//
//   node skill-scrub.mjs <brain-root> <id> [<id>...]
//   node skill-scrub.mjs <brain-root> --policy <policy.json>
//
// --policy derives the id list from the posted catalog policy: every item whose
// audience is non-empty, plus every library item when defaults.audience is
// non-empty (a default of "tied" offers the whole library). A pack entitles
// its contents too, so an id in the policy that turns out to be a pack (its
// packs/<id>/pack.yaml exists) is expanded: every contents.* entry that names
// a real library item is scrubbed under its own id, and every entry that is
// instead a pack-relative file (contents.context / contents.prompts today,
// but the rule applies to any list) is scrubbed directly, reported under the
// pack's own id with a file label like "kit/prompts/kickoff.md". An entry
// that is neither is reported as unresolvable; an entry containing ".." is
// refused rather than resolved. Nothing named in a pack's contents is ever
// silently skipped. Exit 0 and one "OK: /<id> is clean." line per id when
// nothing is found; exit 1 and "ERROR: /<id> cannot be published:" followed
// by "  <file>:<line>: <reason>" lines otherwise. The panel's
// catalog-policy-write runs this BEFORE it writes.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

// (a) secret material. The first three alternatives are the directory worker's
// looksSecret shape (directory/worker.js); the rest are the token shapes that
// actually turn up in pasted config. The blob rule wants 32+ chars of hex, or
// 32+ of base64 alphabet that carries both letters and digits, so a long
// kebab-case id or an English word never trips it.
const SECRET_RULES = [
  [/BEGIN [A-Z ]*PRIVATE KEY|PRIVATE KEY-----|BEGIN OPENSSH PRIVATE/, 'looks like a private key'],
  [/\b(password|passwd|secret)\s*[=:]\s*\S/i, 'looks like a password or secret assignment'],
  [/\btoken\s*[=:]\s*\S/i, 'looks like a token assignment'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, 'looks like a GitHub token'],
  [/\bsk-[A-Za-z0-9_-]{16,}/, 'looks like an API key'],
  [/\b[0-9a-f]{32,}\b/i, 'long hex blob (a key or hash?)'],
  [/(?=[A-Za-z0-9+/]*[0-9])(?=[A-Za-z0-9+/]*[A-Za-z])[A-Za-z0-9+/]{32,}={0,2}/, 'long base64 blob (a key or token?)'],
];
// (b) addresses that only mean something inside this fleet.
const ADDRESS_RULES = [
  [/\b\d{1,3}(\.\d{1,3}){3}\b/, 'bare IP address'],
  [/\b[a-z0-9-]+\.crads-ai\.com\b/i, 'box hostname'],
  [/\bssh:\/\//i, 'ssh:// address'],
];
// (d) paths that exist only on this rock's own box.
const INTERNAL_PATHS = ['/state/brain', '/state/secrets', '/state/.kernel'];

// The four publishable kinds (delivery-model 2026-08-26, step 1). Each item
// lives at <brainRoot>/<root>/<id>/. `marker` is the file (or, for dirs,
// directory) whose presence makes a directory count as a real item rather
// than a half-written stub; `topFiles` + `walkDir` are the payload a
// publish actually ships and so the payload this scans.
const KIND_SPECS = [
  { kind: 'skill', root: 'skills-library', marker: 'SKILL.md', markerIsDir: false, topFiles: ['SKILL.md', 'skill.yaml'], walkDir: 'context' },
  { kind: 'prompt', root: 'prompts-library', marker: 'PROMPT.md', markerIsDir: false, topFiles: ['PROMPT.md', 'prompt.yaml'], walkDir: null },
  { kind: 'page', root: 'pages-library', marker: 'page.html', markerIsDir: false, topFiles: ['page.html', 'page.yaml'], walkDir: null },
  { kind: 'dir', root: 'dirs-library', marker: 'files', markerIsDir: true, topFiles: ['dir.yaml'], walkDir: 'files' },
];

export function memberSlugs(brainRoot) {
  const dir = path.join(brainRoot, 'registry', 'members');
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.yaml') && !f.startsWith('_')); } catch { return []; }
  const out = new Set();
  for (const f of files) {
    out.add(f.replace(/\.yaml$/, ''));
    const m = readFileSafe(path.join(dir, f)).match(/^slug:\s*"?([a-z0-9-]+)"?/m);
    if (m) out.add(m[1]);
  }
  return [...out].filter((s) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(s));
}

function readFileSafe(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

function walk(dir, rel, out) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names.sort()) {
    const p = path.join(dir, n);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, rel ? `${rel}/${n}` : n, out);
    else out.push({ file: rel ? `${rel}/${n}` : n, path: p });
  }
  return out;
}

// The files a published item of a given kind ships: its top-level manifest
// files (only the ones that actually exist) plus its walked subdirectory, if
// it has one (context/ for a skill, files/ for a dir). Same shape and same
// order skillFiles always returned, generalised across the four kinds.
export function itemFiles(dir, kind) {
  const spec = KIND_SPECS.find((s) => s.kind === kind);
  if (!spec) return [];
  const out = [];
  for (const n of spec.topFiles) {
    const p = path.join(dir, n);
    if (existsSync(p)) out.push({ file: n, path: p });
  }
  if (spec.walkDir) walk(path.join(dir, spec.walkDir), spec.walkDir, out);
  return out;
}

// The files a published skill ships: SKILL.md, skill.yaml, context/**.
// Thin wrapper kept for existing callers; identical behaviour to before.
export function skillFiles(skillDir) {
  return itemFiles(skillDir, 'skill');
}

export function scanText(text, file, { slugs = [] } = {}) {
  const hits = [];
  const slugRes = slugs.map((s) => [new RegExp(`(^|[^a-z0-9-])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`, 'i'), s]);
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    const n = i + 1;
    const push = (reason) => hits.push({ file, line: n, reason });
    for (const [re, why] of SECRET_RULES) { if (re.test(line)) { push(why); break; } }
    for (const [re, why] of ADDRESS_RULES) { if (re.test(line)) push(why); }
    for (const [re, s] of slugRes) { if (re.test(line)) push(`names a member of this rock (${s})`); }
    for (const p of INTERNAL_PATHS) { if (line.includes(p)) push(`rock-internal path (${p})`); }
  });
  return hits;
}

export function scrubSkill(brainRoot, id, opts = {}) {
  const dir = path.join(brainRoot, 'skills-library', id);
  if (!existsSync(path.join(dir, 'SKILL.md'))) return [{ file: 'SKILL.md', line: 0, reason: 'no such skill in the library' }];
  const slugs = opts.slugs || memberSlugs(brainRoot);
  const hits = [];
  for (const f of skillFiles(dir)) hits.push(...scanText(readFileSafe(f.path), f.file, { slugs }));
  return hits;
}

// Every item across all four roots, as { id, kind, dir }. An item counts
// only if its payload marker exists (SKILL.md / PROMPT.md / page.html /
// files/, per KIND_SPECS): a manifest with no payload is a half-written
// stub, not something publishable, mirroring the SKILL.md requirement this
// gate always had for skills.
export function libraryItems(brainRoot) {
  const out = [];
  for (const spec of KIND_SPECS) {
    let names = [];
    try { names = readdirSync(path.join(brainRoot, spec.root)); } catch { continue; }
    for (const d of names) {
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(d)) continue;
      const dir = path.join(brainRoot, spec.root, d);
      const markerPath = path.join(dir, spec.marker);
      let ok = false;
      if (spec.markerIsDir) { try { ok = statSync(markerPath).isDirectory(); } catch { ok = false; } }
      else ok = existsSync(markerPath);
      if (ok) out.push({ id: d, kind: spec.kind, dir });
    }
  }
  return out;
}

// Resolve an id to its item (any of the four kinds) via libraryItems, then
// scan its payload. Generalises scrubSkill; scrubSkill keeps its own
// skills-only path above so its behaviour (including the exact "no such
// skill in the library" wording) stays byte-identical for existing callers.
// Falls back to scrubPackContents when the id is not a library item but is
// a real pack, so a bare pack id (a direct CLI arg, or one of
// entitledPackIds below) scrubs the same way a skill/prompt/page/dir id
// does.
export function scrubItem(brainRoot, id, opts = {}) {
  const item = libraryItems(brainRoot).find((it) => it.id === id);
  if (item) {
    const slugs = opts.slugs || memberSlugs(brainRoot);
    const hits = [];
    for (const f of itemFiles(item.dir, item.kind)) hits.push(...scanText(readFileSafe(f.path), f.file, { slugs }));
    return hits;
  }
  if (existsSync(path.join(brainRoot, 'packs', id, 'pack.yaml'))) return scrubPackContents(brainRoot, id, opts);
  return [{ file: 'library', line: 0, reason: 'no such item in the library' }];
}

// Flow-style list parser lifted verbatim from brain-template's
// tools/pack-lint.mjs (`^\s+<key>:\s*\[([^\]]*)\]`): this is the one and
// only shape pack.yaml's contents lists are allowed to take (pack-lint
// refuses block style), so there is one parser, not a second one that could
// drift from the one that actually gates a pack at publish time.
function packFlowList(yamlText, key) {
  const m = yamlText.match(new RegExp(`^\\s+${key}:\\s*\\[([^\\]]*)\\]`, 'm'));
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

// Every contents.* key a pack manifest can carry. contents.skills/pages/dirs
// are documented as bare ids and contents.context/prompts as pack-relative
// paths, but that convention is not trusted here: packAllEntries below
// pools every entry from every key, and what each entry actually IS (a real
// library id, a pack-local file, or neither) is resolved by asking the
// filesystem, uniformly, regardless of which key it came from. One rule,
// not a per-key table.
const PACK_CONTENT_KEYS = ['skills', 'context', 'prompts', 'pages', 'dirs'];

function packAllEntries(yamlText) {
  return PACK_CONTENT_KEYS.flatMap((key) => packFlowList(yamlText, key));
}

// A pack entitles everything it ships. Every contents.* entry that names a
// real library item (whichever list it sits under) is expanded here so it
// gets scrubbed under its own id, same as a directly entitled skill/prompt/
// page/dir. Entries that are not real ids are pack-relative files, or
// unresolvable; those are scrubbed separately, under the pack's own id, by
// scrubPackContents (via scrubItem's pack fallback).
function packContentIds(brainRoot, packId) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(packId)) return [];
  const y = readFileSafe(path.join(brainRoot, 'packs', packId, 'pack.yaml'));
  if (!y) return [];
  const libIds = libraryIds(brainRoot);
  return packAllEntries(y).filter((entry) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(entry) && libIds.includes(entry));
}

// The hits for a pack's OWN contents, i.e. everything in contents.* that is
// NOT a real library id (those are scrubbed separately, under their own id:
// see packContentIds + publishedIds/entitledPackIds). An entry containing
// ".." is refused outright, never resolved to a path. Anything left is
// either a pack-relative file, scanned directly and reported under a label
// like "kit/prompts/kickoff.md", or, if no such file exists either,
// reported as unresolvable. Nothing here is silently dropped.
export function scrubPackContents(brainRoot, packId, opts = {}) {
  const y = readFileSafe(path.join(brainRoot, 'packs', packId, 'pack.yaml'));
  if (!y) return [{ file: 'pack.yaml', line: 0, reason: 'no such pack in the library' }];
  const slugs = opts.slugs || memberSlugs(brainRoot);
  const libIds = libraryIds(brainRoot);
  const hits = [];
  for (const entry of packAllEntries(y)) {
    const label = `${packId}/${entry}`;
    if (entry.includes('..')) { hits.push({ file: label, line: 0, reason: 'contents entry escapes the pack dir' }); continue; }
    if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(entry) && libIds.includes(entry)) continue; // a real id, scrubbed under its own id
    const filePath = path.join(brainRoot, 'packs', packId, entry);
    let isFile = false;
    try { isFile = statSync(filePath).isFile(); } catch { isFile = false; }
    if (isFile) hits.push(...scanText(readFileSafe(filePath), label, { slugs }));
    else hits.push({ file: label, line: 0, reason: 'not a known library id and no such file in the pack' });
  }
  return hits;
}

// Which ids does a posted policy offer to somebody, before any pack
// expansion? A non-empty audience is "tied"/"all" or a non-empty list;
// "none", "", [] and absent offer nobody. Shared by publishedIds (which
// then expands + filters to real library items) and entitledPackIds (which
// filters to real packs instead).
function rawEntitledIds(policy, libraryIds) {
  const p = policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : {};
  const nonEmpty = (a) => Array.isArray(a) ? a.length > 0 : (typeof a === 'string' && a !== '' && a !== 'none');
  const items = p.items && typeof p.items === 'object' ? p.items : {};
  const ids = new Set();
  if (nonEmpty((p.defaults || {}).audience)) for (const id of libraryIds) ids.add(id);
  for (const [id, it] of Object.entries(items)) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) continue;
    if (it && nonEmpty(it.audience)) ids.add(id);
    else ids.delete(id);
  }
  return ids;
}

// publishedIds: which library item (skill/prompt/page/dir) ids does the
// policy offer to somebody, expanded through any pack it names. When
// brainRoot is given, an entitled id that turns out to be a pack (its
// packs/<id>/pack.yaml exists) has every real-id entry in its contents.*
// lists added too, whichever list it sits under. Omitting brainRoot skips
// pack expansion entirely: existing callers that pass a plain id array keep
// their exact behaviour.
export function publishedIds(policy, libraryIds, brainRoot) {
  const ids = rawEntitledIds(policy, libraryIds);
  if (brainRoot) {
    for (const id of [...ids]) {
      for (const contentId of packContentIds(brainRoot, id)) ids.add(contentId);
    }
  }
  return [...ids].filter((id) => libraryIds.includes(id)).sort();
}

// Which entitled policy ids are actually packs (packs/<id>/pack.yaml
// exists)? A pack never appears in libraryIds (it is not itself a
// skill/prompt/page/dir item), so publishedIds always drops it; this is the
// other half of "never silently skip a real id": a pack's own pack-relative
// contents (today's contents.context/prompts paths, or an unresolvable
// entry) are only ever scrubbed if the pack id itself is scanned, via
// scrubItem's pack fallback.
export function entitledPackIds(brainRoot, policy, libraryIds) {
  const ids = rawEntitledIds(policy, libraryIds);
  return [...ids].filter((id) => existsSync(path.join(brainRoot, 'packs', id, 'pack.yaml'))).sort();
}

// Bare ids across all four roots. Kept as its own export (same signature,
// same meaning as before delivery-model) because publishedIds, the CLI and
// the panel all already call it expecting one flat id list; it is now
// derived from libraryItems so it covers prompts-library / pages-library /
// dirs-library too, but for a skills-only brain it returns exactly what it
// always did.
export function libraryIds(brainRoot) {
  const seen = new Set();
  const out = [];
  for (const it of libraryItems(brainRoot)) {
    if (!seen.has(it.id)) { seen.add(it.id); out.push(it.id); }
  }
  return out;
}

export function report(id, hits) {
  if (!hits.length) return `OK: /${id} is clean.`;
  return [`ERROR: /${id} cannot be published:`, ...hits.map((h) => `  ${h.file}:${h.line}: ${h.reason}`)].join('\n');
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const [brainRoot, ...rest] = process.argv.slice(2);
  if (!brainRoot) { console.error('usage: skill-scrub.mjs <brain-root> <id>... | --policy <file>'); process.exit(2); }
  let ids = rest;
  if (rest[0] === '--policy') {
    let pol = {};
    try { pol = JSON.parse(readFileSync(rest[1], 'utf8')); } catch { pol = {}; }
    const libIds = libraryIds(brainRoot);
    // Every entitled library item, PLUS every entitled pack (scrubbed via
    // scrubItem's pack fallback for its own pack-relative/unresolvable
    // contents) so nothing a policy offers goes unscanned.
    ids = [...new Set([...publishedIds(pol, libIds, brainRoot), ...entitledPackIds(brainRoot, pol, libIds)])].sort();
  }
  let bad = false;
  const slugs = memberSlugs(brainRoot);
  for (const id of ids) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) { console.log(`ERROR: /${id} is not a library id.`); bad = true; continue; }
    const hits = scrubItem(brainRoot, id, { slugs });
    console.log(report(id, hits));
    if (hits.length) bad = true;
  }
  process.exit(bad ? 1 : 0);
}
