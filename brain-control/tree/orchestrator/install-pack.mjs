#!/usr/bin/env node
// install-pack.mjs <slug> <pack-id> — install a v2 pack into a member box.
// Spec: ai-os docs/superpowers/specs/2026-08-04-skills-cadence-library-design.md § 8.
//
// A pack is a wrapper: its skills install through the NORMAL push-skill path
// (lint + skills_installed + the same transport gates), so each remains an
// individually versioned, schedulable unit on the box (D49 holds). Supporting
// artefacts ride push-down: context and prompts land in the org inbox and are
// read in place; pages land as dashboard SEEDS the box's org-sync applies with
// the template rule (missing files created, edited pages never overwritten).
// dirs land under `dirs/<packId>/<dirId>/` the same way, with an optional
// `<dirId>.yaml` kind manifest alongside it (ai-os Task 3 resolves the kind).
// The publish switch is catalog/policy.json — there is no status: gate any
// more; running this directly is an org-initiated install, the org's own call.
// Fee: one idempotent ledger row per {slug, pack, version}, plus the member
// row's packs_installed.
//
// DEPRECATED (delivery-model step 7c, Part A). Reconcile (steps 3 and 6) now
// stages every entitled kind, pages included, for every member automatically
// on its own 15-minute cadence, so this file is a strictly worse duplicate of
// a path that runs itself. Sam's ruling: keep it one release as an operator
// escape hatch, then delete it. It prints a deprecation notice before doing
// any work; see main() below.
import { readFile, writeFile, appendFile, mkdir, cp, rm, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageDirs } from './stage-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Re-exported so any existing importer of stageDirs from this file keeps
// working; the helper itself now lives in stage-lib.mjs (see that file's
// header), which is where tests/pack-dirs.test.mjs imports it from.
export { stageDirs };

async function main() {
  const [slug, packId] = process.argv.slice(2);
  if (!slug || !packId) { console.error('usage: install-pack <slug> <pack-id>'); process.exit(2); }

  // Deprecation notice, printed before any work happens.
  console.log('Deprecation notice: the catalogue now stages every entitled item automatically, on its own cadence. Running install-pack is an operator override, and this command will be removed in a future release.');

  const packDir = path.join(repoRoot, 'packs', packId);
  // Shape gate first: a broken bundle never reaches a box.
  execFileSync('node', [path.join(repoRoot, 'tools', 'pack-lint.mjs'), packDir, '--root', repoRoot], { stdio: 'inherit' });

  const manifest = await readFile(path.join(packDir, 'pack.yaml'), 'utf8');
  const mget = (k) => (manifest.match(new RegExp(`^${k}:\\s*"?([^"\n#]*)"?`, 'm')) || [, ''])[1].trim();
  const list = (k) => {
    const m = manifest.match(new RegExp(`^\\s+${k}:\\s*\\[([^\\]]*)\\]`, 'm'));
    return m ? m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : [];
  };
  const ver = mget('version') || '1';
  const fee = Number(mget('fee') || 0);
  const expert = mget('expert');
  const skills = list('skills'), context = list('context'), prompts = list('prompts'), pages = list('pages'), dirs = list('dirs');

  // 1) Skills through the normal door (lint + registry + gates per skill).
  for (const id of skills) {
    execFileSync('node', [path.join(repoRoot, 'orchestrator', 'push-skill.mjs'), slug, id], { stdio: 'inherit' });
  }

  // 2) Supporting artefacts via push-down (same transport gates as everything).
  async function pushFiles(files, destSub, { fromPages = false } = {}) {
    if (!files.length) return;
    const payload = await mkdtemp(path.join(tmpdir(), 'pack-'));
    for (const f of files) {
      const src = fromPages ? path.join(packDir, 'pages', `${f}.html`) : path.join(packDir, f);
      const dst = fromPages ? path.join(payload, `${f}.html`) : path.join(payload, f);
      await mkdir(path.dirname(dst), { recursive: true });
      await cp(src, dst, { recursive: true });
    }
    execFileSync('node', [path.join(repoRoot, 'orchestrator', 'push-down.mjs'), slug, payload, destSub], { stdio: 'inherit' });
    await rm(payload, { recursive: true, force: true });
  }
  await pushFiles(context, `context/${packId}`);
  await pushFiles(prompts, `prompts/${packId}`);
  await pushFiles(pages, `pages/${packId}`, { fromPages: true });

  if (dirs.length) {
    const payload = await mkdtemp(path.join(tmpdir(), 'pack-dirs-'));
    await stageDirs(packDir, dirs, payload);
    execFileSync('node', [path.join(repoRoot, 'orchestrator', 'push-down.mjs'), slug, payload, `dirs/${packId}`], { stdio: 'inherit' });
    await rm(payload, { recursive: true, force: true });
  }

  // 3) Idempotent fee ledger + member-row reflection.
  // Ruling (Sam, taken under recommendation, delivery-model step 7c): under
  // always-pickup reconcile the rock cannot know what a member actually
  // installed, so the fee should move to being per-ENTITLEMENT rather than
  // per-install. That ledger move is NOT built here: this writer is left
  // exactly as it was, so the next reader knows the fee is, for now, only
  // ever written by this deprecated path.
  const ledgerPath = path.join(repoRoot, 'registry', 'pack-installs.jsonl');
  const ledger = await readFile(ledgerPath, 'utf8').catch(() => '');
  const already = ledger.split('\n').some((l) => { try { const o = JSON.parse(l); return o.slug === slug && o.pack_id === packId && String(o.version) === String(ver); } catch { return false; } });
  if (!already) {
    const row = { ts: new Date().toISOString(), slug, pack_id: packId, version: ver, expert, fee };
    await appendFile(ledgerPath, JSON.stringify(row) + '\n');
    const rowPath = path.join(repoRoot, 'registry', 'members', `${slug}.yaml`);
    let y = await readFile(rowPath, 'utf8');
    const item = `  - { pack_id: "${packId}", version: ${ver}, installed: "${row.ts.slice(0, 10)}"${expert ? `, expert: "${expert}"` : ''}, fee: ${fee} }`;
    y = y.replace(/^packs_installed:.*$/m, (m) => (m.trim().endsWith('[]') ? 'packs_installed:\n' + item : m + '\n' + item));
    await writeFile(rowPath, y);
    try { execFileSync('node', [path.join(repoRoot, 'registry', 'build-index.mjs')], { stdio: 'inherit' }); } catch {}
    console.log(`installed pack ${packId}@${ver} to ${slug} (${skills.length} skill(s), ${context.length + prompts.length} file(s), ${pages.length} page(s), ${dirs.length} dir(s))${fee ? `; fee ${fee} logged${expert ? ` for ${expert}` : ''}` : ''}.`);
  } else {
    console.log(`${packId}@${ver} already logged for ${slug}; content re-pushed, no double-count.`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => { console.error(`install-pack: ${e.message}`); process.exit(1); });
}
