#!/usr/bin/env node
// legal.mjs - the legal version lock.
//
//   node docs/product/pipeline/legal.mjs --update   # re-stamp the lock
//
// Legal artefacts are representations, not documentation: a privacy policy whose
// text changed while its version did not is a document nobody can cite. The lock
// records, per legal page, the version and a hash of the body. The gate then
// refuses exactly one combination: body changed, version unchanged.
//
// This is why `mode: legal` also refuses to validate without `version:` and
// `effective:` (source.mjs). Together they make a silent edit to a legal page
// impossible: either the version moves, or the build fails.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTree } from './source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LOCK_PATH = path.join(HERE, 'legal-lock.json');
const PAGES = path.join(HERE, '..', 'pages');

// THE LOCK PROTECTS THE WORDS, NOT THE MARKUP. Hashing the raw body meant that
// adding a hyperlink to an existing sentence demanded a version bump, and a bump
// tells every reader the document CHANGED. Linking "privacy policy" to the
// privacy policy is navigation; the promise is identical. So the hash is taken
// over the prose with link syntax reduced to its text: `[terms](/docs/terms)`
// and `terms` hash the same, while changing a single word still moves it.
//
// This is deliberately the only thing normalised. Whitespace is NOT collapsed:
// a re-wrapped paragraph reads differently in a legal document and someone
// should look at it.
export const legalProse = (body) => String(body)
  .replace(/\r\n/g, '\n')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .trim();

export const bodyHash = (body) =>
  createHash('sha256').update(legalProse(body)).digest('hex').slice(0, 16);

export const readLock = () =>
  (existsSync(LOCK_PATH) ? JSON.parse(readFileSync(LOCK_PATH, 'utf8')) : { pages: {} });

export function legalPages() {
  if (!existsSync(PAGES)) return [];
  return loadTree(PAGES).filter((p) => p.mode === 'legal');
}

// The one refusal: body moved, version did not.
export function auditLock(pages = legalPages(), lock = readLock()) {
  const problems = [];
  const unlocked = [];
  for (const p of pages) {
    const rec = lock.pages[p.slug];
    const hash = bodyHash(p.body);
    if (!rec) { unlocked.push(p.slug); continue; }
    if (rec.hash !== hash && rec.version === p.version) {
      problems.push(`${p.slug}: body changed but version is still ${p.version}. `
        + 'Bump version: and effective:, then run: node docs/product/pipeline/legal.mjs --update');
    }
  }
  return { problems, unlocked };
}

if (process.argv[1] && process.argv[1].endsWith('legal.mjs')) {
  const pages = legalPages();
  const lock = { pages: {} };
  for (const p of pages) lock.pages[p.slug] = { version: p.version, effective: p.effective, hash: bodyHash(p.body) };
  if (process.argv.includes('--update')) {
    writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`locked ${pages.length} legal page(s)`);
  } else {
    const { problems, unlocked } = auditLock(pages);
    for (const pr of problems) console.error(`  FAIL ${pr}`);
    for (const u of unlocked) console.log(`  unlocked ${u} (run --update)`);
    console.log(`${pages.length} legal page(s) audited`);
    if (problems.length) process.exit(1);
  }
}
