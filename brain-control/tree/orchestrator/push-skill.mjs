#!/usr/bin/env node
// push-skill.mjs <member-slug> <skill-id> [--version X]  — distribute one library
// skill to one member (D49). Wraps the generic, membership-gated push-down.mjs
// (no read-back), then records skills_installed@version in the member's registry
// row. No pillar, no architect, no fee (D21/D49). The dashboard Skills tab calls
// this; it is also runnable by hand on the rock box.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const slug = args[0];
const skillId = args[1];
const version = args.includes('--version') ? args[args.indexOf('--version') + 1] : null;
if (!slug || !skillId) { console.error('usage: push-skill <member-slug> <skill-id> [--version X]'); process.exit(2); }
if (!/^[a-z0-9][a-z0-9-]*$/.test(skillId)) { console.error('skill-id must be kebab-case'); process.exit(2); }

const skillDir = path.join(repoRoot, 'skills-library', skillId);
const manifest = await readFile(path.join(skillDir, 'skill.yaml'), 'utf8')
  .catch(() => { console.error(`no skill "${skillId}" in skills-library/`); process.exit(1); });
const mget = (k) => (manifest.match(new RegExp(`^${k}:\\s*"?([^"\\n#]*)"?`, 'm')) || [, ''])[1].trim();
const ver = version || mget('version') || '1';

// Lint before pushing — a malformed skill never leaves the rock.
try { execFileSync('node', [path.join(repoRoot, 'tools', 'skill-lint.mjs'), skillDir], { stdio: 'inherit' }); }
catch { console.error(`REFUSED: ${skillId} failed skill-lint (fix it, then re-push).`); process.exit(1); }

// Deliver via push-down: enforces the membership gate + no read-back path.
// Lands in the member inbox under skills/<id>/; org-sync installs it box-side.
//
// A consent refusal is an ANSWER, not a crash. push-down prints its own
// "REFUSED: ..." line (stdio is inherited) and exits 1; without this catch,
// execFileSync threw on top of it and the operator got fifteen lines of Node
// stack trace burying the one sentence that explained why. The console shows
// this stderr verbatim, so a member exercising their own consent read as a
// broken system. Exit with the pebble's status and add nothing: the pebble has
// already said the useful thing. Found live, pushing to a box whose owner had
// withheld infra_push_consent.
try {
  execFileSync('node', [path.join(repoRoot, 'orchestrator', 'push-down.mjs'), slug, skillDir, `skills/${skillId}`], { stdio: 'inherit' });
} catch (e) {
  process.exit(typeof e?.status === 'number' ? e.status : 1);
}

// Record skills_installed@version in the member row (idempotent per skill id:
// replace the existing line for this id, else append).
const rowPath = path.join(repoRoot, 'registry', 'members', `${slug}.yaml`);
let yrow = await readFile(rowPath, 'utf8').catch(() => { console.error(`no registry row for ${slug}`); process.exit(1); });
const today = new Date().toISOString().slice(0, 10);
const item = `  - { skill_id: "${skillId}", version: "${ver}", installed: "${today}" }`;
const idRe = new RegExp(`^\\s*-\\s*\\{\\s*skill_id:\\s*"${skillId}".*$`, 'm');
if (idRe.test(yrow)) {
  yrow = yrow.replace(idRe, item);
} else {
  yrow = yrow.replace(/^skills_installed:.*$/m, (m) => (m.trim().endsWith('[]') ? 'skills_installed:\n' + item : m + '\n' + item));
}
await writeFile(rowPath, yrow);
try { execFileSync('node', [path.join(repoRoot, 'registry', 'build-index.mjs')], { stdio: 'inherit' }); } catch { /* index optional */ }
console.log(`pushed ${skillId}@${ver} -> ${slug} (recorded in skills_installed).`);
