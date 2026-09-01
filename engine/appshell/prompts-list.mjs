#!/usr/bin/env node
// prompts-list.mjs <state-dir>: one JSON snapshot of every PROMPT offered to
// this box, for the app's Prompts tab. Spec:
// docs/superpowers/specs/2026-08-25-pack-content-types-design.md § 5.2.
//
// Prompts are inert text. They are NEVER installed and never copied out of the
// inbox: this reads them where org-sync left them and the app renders a copy
// button. Read-only, same prefix-line idiom as skills-list.mjs.
//
// Walks every inbox the box holds, exactly as org-sync.sh's seed_pages does:
// the anchor's /state/org-inbox and each joined rock's /state/org-inbox.d/<owner>/.
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import path from 'node:path';

const state = path.resolve(process.argv[2] || '/state');
const BODY_CAP = 8000;
const TITLE_CAP = 200;
const PROMPT_CAP = 200;
const SAFE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

// Exported so pack-content.mjs (Phase 5's pack-authoring listing) can ask
// THIS file whether a given on-disk name would ever be delivered, instead of
// re-deriving a second copy of the rule that could drift from what this file
// actually enforces (final review, 2026-08-26, finding F1). pack-lint.mjs's
// rule (contents.prompts: traversal refusal only, no shape or extension
// check) governs the MANIFEST; this SAFE regex plus the ".md" extension
// check below is the DELIVERY rule, and only the delivery rule decides
// whether a member ever sees the prompt. The two are not the same rule, and
// a file can pass pack-lint while this file skips it outright: no ".md"
// extension, or a stem outside SAFE's shape (case-insensitively kebab-ish:
// letters, digits, dots, underscores, hyphens).
export function isDeliverablePromptFile(file) {
  return typeof file === 'string' && file.endsWith('.md') && SAFE.test(file.slice(0, -3));
}

// Every inbox on this box, as [rockLabel, promptsDir]. Failure-proof: a
// broken org-inbox.d (unreadable, or existing as a plain file instead of a
// directory) must not stop the anchor inbox from being offered.
function inboxes() {
  const out = [];
  const anchor = path.join(state, 'org-inbox', 'prompts');
  try {
    const stat = lstatSync(anchor);
    if (stat.isDirectory() && !stat.isSymbolicLink()) out.push(['anchor', anchor]);
  } catch { /* no anchor inbox */ }
  const joinedRoot = path.join(state, 'org-inbox.d');
  try {
    if (existsSync(joinedRoot)) {
      for (const owner of readdirSync(joinedRoot)) {
        if (!SAFE.test(owner)) continue;               // a conf file, or something we will not resolve
        const ownerPath = path.join(joinedRoot, owner);
        try {
          const ownerStat = lstatSync(ownerPath);
          if (ownerStat.isSymbolicLink()) continue;     // refuse symlinked owner dirs
          const dir = path.join(ownerPath, 'prompts');
          const dirStat = lstatSync(dir);
          if (dirStat.isDirectory() && !dirStat.isSymbolicLink()) out.push([owner, dir]);
        } catch { /* not a joined inbox */ }
      }
    }
  } catch { /* org-inbox.d unreadable, or not a directory at all */ }
  return out;
}

// title from `title:` in frontmatter, body is everything after the block.
// Frontmatter delimiters and the title line both accept \r\n (CRLF-authored
// files), not just \n.
function parse(src, stem) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  let title = stem, body = src;
  if (m) {
    const t = (m[1].match(/^title:\s*"?([^"\r\n#]*)"?\s*$/m) || [, ''])[1].replace(/\r$/, '').trim();
    if (t) title = t;
    body = src.slice(m[0].length);
  }
  if (title.length > TITLE_CAP) title = title.slice(0, TITLE_CAP);
  body = body.trim();
  const truncated = body.length > BODY_CAP;
  return { title, body: truncated ? body.slice(0, BODY_CAP) : body, truncated };
}

// CLI entry point only: guarded so pack-content.mjs (or any other importer)
// can pull in isDeliverablePromptFile above without this script's own read
// of /state and its stdout write firing as a side effect of the import.
// Same guard idiom as skills-list.mjs and page-delete.mjs.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
const prompts = [];
let error;
try {
  outer:
  for (const [rock, dir] of inboxes()) {
    let packs;
    try {
      packs = readdirSync(dir);
    } catch (e) {
      continue; // this inbox only; continue processing others
    }
    for (const pack of packs) {
      if (!SAFE.test(pack)) continue;
      const packDir = path.join(dir, pack);
      try {
        const packStat = lstatSync(packDir);
        if (!packStat.isDirectory() || packStat.isSymbolicLink()) continue;
        for (const file of readdirSync(packDir)) {
          if (!file.endsWith('.md')) continue;
          const stem = file.slice(0, -3);
          if (!SAFE.test(stem)) continue;
          const full = path.join(packDir, file);
          let src = '';
          try {
            const fileStat = lstatSync(full);
            if (!fileStat.isFile() || fileStat.isSymbolicLink()) continue;
            src = readFileSync(full, 'utf8');
          } catch { continue; }
          const { title, body, truncated } = parse(src, stem);
          prompts.push({ id: `${rock}/${pack}/${stem}`, title, body, truncated, pack, rock, path: full });
          if (prompts.length >= PROMPT_CAP) break outer;
        }
      } catch (e) {
        // this pack only; continue processing remaining packs in this inbox
        continue;
      }
    }
  }
} catch (e) {
  // Last-resort backstop: whatever collected so far still ships, and the
  // client's s.error branch (never the same wording as "nothing offered")
  // is reachable instead of a silent process crash.
  error = (e && e.message) || String(e);
}

const by = (a, b) => a.rock.localeCompare(b.rock) || a.pack.localeCompare(b.pack) || a.title.localeCompare(b.title);
prompts.sort(by);
const result = { prompts };
if (error) result.error = error;
process.stdout.write(`PROMPTS_STATE ${JSON.stringify(result)}\n`);
}
