// skills.mjs — install the engine's generic skills into an instance so Claude
// Code discovers them as PROJECT skills at <state>/.claude/skills/<name>/SKILL.md.
//
// Engine skills are single files `engine/skills/<name>.md`; Claude Code wants
// `<name>/SKILL.md`. We map them on sync. `.claude/` is gitignored in the
// instance (kernel IGNORE list) — skills are engine-owned + versioned, re-synced
// from the image every run, never committed into the client's wiki repo.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function syncSkills(stateDir, engineSkillsDir) {
  let files;
  try {
    files = (await readdir(engineSkillsDir)).filter((f) => f.endsWith('.md'));
  } catch {
    return 0;
  }
  let n = 0;
  for (const f of files) {
    const name = f.replace(/\.md$/, '');
    const src = await readFile(path.join(engineSkillsDir, f), 'utf8');
    const dstDir = path.join(stateDir, '.claude', 'skills', name);
    await mkdir(dstDir, { recursive: true });
    await writeFile(path.join(dstDir, 'SKILL.md'), src);
    n++;
  }
  return n;
}
