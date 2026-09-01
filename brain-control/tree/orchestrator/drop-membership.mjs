#!/usr/bin/env node
// drop-membership.mjs <slug> <org> — end ONE community tie, keep the rest.
// The T2.7 residual, unbuilt until now: nothing could remove an entry from a
// row's memberships list. Refuses the anchor (a home ends by re-anchor or by
// leaving, so the seat and the bill move deliberately); refuses a tie that is
// not there, rather than pretending. The write is textual, so no other field
// on the row is touched. Sam's ruling 2026-08-03: this verb is the BOX OWNER's
// alone; a community cannot expel, so the caller must already be the owner side.
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropMembership, readMemberships, anchorOf } from '../registry/membership.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [slug, org] = process.argv.slice(2);
if (!slug || !org) { console.error('usage: drop-membership <slug> <org>'); process.exit(2); }

const p = path.join(repoRoot, 'registry', 'members', `${slug}.yaml`);
const text = await readFile(p, 'utf8').catch(() => '');
if (!text) { console.error(`REFUSED: no registry row for ${slug}`); process.exit(1); }

const before = readMemberships(text);
if (!before.includes(org)) {
  console.log(`nothing to do: ${slug} holds no tie to "${org}" (it has: ${before.join(', ') || 'none'}).`);
  process.exit(0);
}
let after;
try { after = dropMembership(text, org); }
catch (e) { console.error(`REFUSED: ${e.message}`); process.exit(1); }

await writeFile(p, after);
const b = path.join(repoRoot, 'registry', 'build-index.mjs');
if (existsSync(b)) await new Promise((res) => execFile('node', [b], { cwd: repoRoot }, () => res())).catch(() => {});
console.log(`OK: ${slug} left the ${org} community. Its home rock (${anchorOf(text) || 'none'}) is unchanged, and ${readMemberships(after).length} tie(s) remain.`);
