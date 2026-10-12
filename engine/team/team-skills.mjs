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

// A company skill's header keeps ONLY these keys, each as a plain one-line
// "key: value". Everything else is dropped: tool grants, hooks, model, agent,
// context and anything not on the list (second security review, 2026-10-12: a
// deny-list missed CRLF headers, "--- " openings, quoted and indented keys and
// flow mappings, all of which Claude Code still reads).
export const HEADER_KEYS = ['name', 'title', 'description', 'category', 'when_to_use', 'argument-hint'];
// Claude Code's own header pattern, CR-tolerant: /^---\s*\n([\s\S]*?)---\s*\n?/
const HEADER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(\r?\n|$)/;

export function headerProblems(md) {
  const text = String(md).replace(/^\uFEFF/, '');
  const m = text.match(HEADER_RE);
  if (!m) return /^\s*---/.test(text) ? ['a header the installer cannot read'] : [];
  const out = [];
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^#/.test(line)) continue;
    const k = line.match(/^([a-z_-]+):[ \t](.*)$/);
    if (!k || !HEADER_KEYS.includes(k[1]) || /^[[{|>&*!%@`]/.test(k[2].trim())) out.push(line.trim().slice(0, 60));
  }
  return out;
}

export function stripPowers(md) {
  const text = String(md).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = text.match(/^---[ \t]*\n([\s\S]*?)\n?---[ \t]*(\n|$)/);
  if (!m) return /^\s*---/.test(text) ? `---\nname: company-skill\n---\n${text.replace(/^\s*---[\s\S]*?\n---[^\n]*\n?/, '')}` : text;
  const kept = [];
  for (const line of m[1].split('\n')) {
    const k = line.match(/^([a-z_-]+):[ \t](.*)$/);
    if (k && HEADER_KEYS.includes(k[1]) && !/^[[{|>&*!%@`]/.test(k[2].trim())) kept.push(`${k[1]}: ${k[2].trim()}`);
  }
  return `---\n${kept.length ? `${kept.join('\n')}\n` : ''}---\n` + text.slice(m[0].length);
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
