// skills.mjs — install the engine's generic skills into an instance so Claude
// Code discovers them as PROJECT skills at <state>/.claude/skills/<name>/SKILL.md.
//
// Engine skills are single files `engine/skills/<name>.md`; Claude Code wants
// `<name>/SKILL.md`. We map them on sync. `.claude/` is gitignored in the
// instance (kernel IGNORE list) — skills are engine-owned + versioned, re-synced
// from the image every run, never committed into the client's wiki repo.
//
// ADOPTED brains (spec 2026-10-17 § Engine changes) bring skills of their own,
// often under the same names (`capture`, `daily`, `followup`, `inbox`, `weekly`
// on the first one), and their .claude/ is tracked. Overwriting those would
// replace the person's work with ours on every drain. So on an adopted brain
// EVERY engine skill installs as `crads-<name>`, with its frontmatter `name:`
// rewritten to match, and the engine writes only into a dir it created (proven
// by the marker file below). Not only the clashing ones: a non-clashing name
// (`propose-change`, `write-page`) landed in the person's tracked .claude/skills
// and was committed into their repo (adopt rehearsal T4, finding 2), while
// `.claude/skills/crads-*/` is on the never-commit list. The one exception is
// ADOPTED_ONLY (/move-in), which keeps its name and has its own ignore line.
// A bare-named copy an earlier engine installed (it carries the marker) is
// retired in favour of its crads- twin; a dir without the marker is never
// touched. Pebbles take the old path unchanged: no markers, no prefix.
import { readdir, readFile, writeFile, mkdir, stat, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { isAdopted } from '../../lib/mineral-identity.mjs';

export const ENGINE_MARKER = '.crads-engine';
// Engine skills that only mean something on an adopted brain (spec 2026-10-17
// § 3): /move-in reshapes a server the person already had. A pebble, a rock or a
// folder on the person's computer never gets it, so it never clutters their
// Skills page.
export const ADOPTED_ONLY = ['move-in'];
export const CLASH_PREFIX = 'crads-';

const exists = (p) => stat(p).then(() => true, () => false);

// Ours if absent (we will create it) or carrying our marker. Anything else is
// the person's, even an empty dir: we never write into it.
async function claimable(dir) {
  if (!(await exists(dir))) return true;
  return exists(path.join(dir, ENGINE_MARKER));
}

// An engine copy installed under the bare name by an earlier engine (before
// every adopted skill moved to crads-<name>). Only a dir carrying our marker is
// ours: we remove the two files we wrote, and the dir only if that empties it.
async function retireBare(dir) {
  if (!(await exists(path.join(dir, ENGINE_MARKER)))) return;
  await rm(path.join(dir, 'SKILL.md'), { force: true });
  await rm(path.join(dir, ENGINE_MARKER), { force: true });
  try { if (!(await readdir(dir)).length) await rmdir(dir); } catch { /* not ours to force */ }
}

const renamed = (src, name) => src.replace(/^(---\r?\n[\s\S]*?^name:\s*)\S+/m, `$1${name}`);

// `only` (2026-10-18): sync just these engine skills. Move-in mode uses it to
// install ADOPTED_ONLY (the /move-in skill the move-in needs) and nothing else.
export async function syncSkills(stateDir, engineSkillsDir, { adopted = isAdopted(stateDir), only = null } = {}) {
  let files;
  try {
    files = (await readdir(engineSkillsDir)).filter((f) => f.endsWith('.md'));
  } catch {
    return 0;
  }
  let n = 0;
  for (const f of files) {
    const name = f.replace(/\.md$/, '');
    if (!adopted && ADOPTED_ONLY.includes(name)) continue;
    if (only && !only.includes(name)) continue;
    const src = await readFile(path.join(engineSkillsDir, f), 'utf8');
    if (!adopted) {
      const dstDir = path.join(stateDir, '.claude', 'skills', name);
      await mkdir(dstDir, { recursive: true });
      await writeFile(path.join(dstDir, 'SKILL.md'), src);
      n++;
      continue;
    }
    let target = ADOPTED_ONLY.includes(name) ? name : CLASH_PREFIX + name;
    if (target !== name) await retireBare(path.join(stateDir, '.claude', 'skills', name));
    if (!(await claimable(path.join(stateDir, '.claude', 'skills', target)))) {
      // An adopted-only name the person already uses: ours goes beside it.
      if (target === name) target = CLASH_PREFIX + name;
      // `crads-<name>` taken by the person too: leave both alone.
      if (!(await claimable(path.join(stateDir, '.claude', 'skills', target)))) continue;
    }
    const body = target === name ? src : renamed(src, target);
    const dstDir = path.join(stateDir, '.claude', 'skills', target);
    await mkdir(dstDir, { recursive: true });
    await writeFile(path.join(dstDir, ENGINE_MARKER), `engine skill ${name}: written by the Crads-AI engine, re-synced on every update\n`);
    await writeFile(path.join(dstDir, 'SKILL.md'), body);
    n++;
  }
  return n;
}
