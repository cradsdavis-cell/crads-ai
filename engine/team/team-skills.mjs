#!/usr/bin/env node
// team-skills.mjs: install the company's shared skills on this box (Crads for teams).
//
// The company brain holds skills/<name>/SKILL.md. Only the hub can write there, and
// a change to a shared skill is an owner-approved rule change (stage 2), so a box
// only ever receives skills the company agent committed. Each lands as
// .claude/skills/company-<name>/ with an .origin.json saying where it came from.
// A company skill removed from the brain is removed here too; skills this box made
// itself are never touched (only directories carrying origin "company" are pruned).
//
//   node team-skills.mjs <state-dir>      (run after every hourly org-pull)
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { isMain } from '../lib/is-main.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,50}$/;
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

export function stripPowers(md) {
  const m = String(md).match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return md;
  const kept = [];
  let dropping = false;
  for (const line of m[1].split('\n')) {
    if (/^(allowed-tools|disallowed-tools|hooks|model|permission-mode)\s*:/i.test(line)) { dropping = true; continue; }
    if (dropping && /^\s/.test(line)) continue;      // the dropped key's indented children
    dropping = false;
    kept.push(line);
  }
  return `---\n${kept.join('\n')}\n---\n` + String(md).slice(m[0].length);
}

export function syncCompanySkills(stateDir) {
  const cfg = readJson(path.join(stateDir, 'org', 'config.json'));
  if (!cfg || !cfg.company) return { installed: [], removed: [], skipped: 'team not configured' };
  const src = path.join(stateDir, 'org', 'brain', 'skills');
  const dstRoot = path.join(stateDir, '.claude', 'skills');
  const wanted = new Set();
  const installed = [];
  let names = [];
  try { names = readdirSync(src, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch {}
  for (const name of names) {
    if (!NAME_RE.test(name)) continue;
    const skillMd = path.join(src, name, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const id = `company-${name}`.slice(0, 63);
    wanted.add(id);
    const dst = path.join(dstRoot, id);
    mkdirSync(dst, { recursive: true });
    // A company skill never widens what an assistant may do: header lines that
    // grant tools or hooks are removed on install (teams security review,
    // 2026-10-11: "allowed-tools: Bash(*)" would have handed shell to turns that
    // are deliberately shell-less, on every box).
    writeFileSync(path.join(dst, 'SKILL.md'), stripPowers(readFileSync(skillMd, 'utf8')));
    writeFileSync(path.join(dst, '.origin.json'), JSON.stringify({ origin: 'company', company: cfg.company, path: `skills/${name}/SKILL.md` }) + '\n');
    installed.push(id);
  }
  const removed = [];
  let have = [];
  try { have = readdirSync(dstRoot); } catch {}
  for (const id of have) {
    if (!id.startsWith('company-') || wanted.has(id)) continue;
    const o = readJson(path.join(dstRoot, id, '.origin.json'));
    if (o && o.origin === 'company') { rmSync(path.join(dstRoot, id), { recursive: true, force: true }); removed.push(id); }
  }
  return { installed, removed };
}

if (isMain(import.meta.url)) {
  const stateDir = process.argv[2];
  if (!stateDir) { console.error('usage: team-skills.mjs <state-dir>'); process.exit(64); }
  const r = syncCompanySkills(stateDir);
  console.log(`company skills: ${r.installed.length} installed, ${r.removed.length} removed${r.skipped ? ` (${r.skipped})` : ''}`);
}
