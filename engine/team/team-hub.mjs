#!/usr/bin/env node
// team-hub.mjs: the company agent's nightly merge (Crads for teams, stage 1).
//
// Runs ONLY on the hub box (org/config.json role "hub"). Three steps:
//   1. IMPORT  each person's repo (org/members/<slug>, read-only key) and copy ONLY
//              its members/<slug>/ tree into the company clone. Anything else that
//              box pushed is ignored and reported, never copied. A person whose
//              extracts fail the provenance check is skipped whole for this run.
//   2. SYNTHESIZE the hub-owned views from members/*/ (restored from the July org
//              brain hub, deleted 2026-09-09 at 983cad1): entities/, decisions/log.md,
//              digest/<date>.md, .org/manifest.yaml. Deterministic, no model.
//   3. COMMIT + PUSH the company repo. The hub's key is the only write key it has.
//
//   node team-hub.mjs <state-dir>
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, unlinkSync, rmSync, cpSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { isMain } from '../lib/is-main.mjs';
import { PROVENANCE_RE } from '../lib/org-publish.mjs';
import { queueImported } from './team-proposals.mjs';
import { withBrainLock } from './team-lock.mjs';

const STALE_MS = 36 * 60 * 60 * 1000;   // flag a person silent for more than 36h

const gitIn = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=company-agent', '-c', 'user.email=hub@team.local', ...args], { stdio: 'pipe', encoding: 'utf8' });

// Limits on what one person can push at the agent in one merge (teams security
// review, 2026-10-11): one repo must never be able to stall the merge for everyone.
export const LIMITS = { files: 2000, fileBytes: 512 * 1024, totalBytes: 20 * 1024 * 1024 };
// File and folder names a person may publish. Nothing hidden (no dot-folders, so
// no .claude/ or .git tricks), and none of the names an assistant treats as
// INSTRUCTIONS when it reads a folder (CLAUDE.md, AGENTS.md, ...): a person's
// facts must never become everyone's orders.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,100}$/;
const INSTRUCTION_FILES = /^(claude|claude\.local|agents|gemini|skill|readme\.ai)\.md$/i;

// Walk a person's published tree. Returns the files the hub may copy and the
// reasons any were refused. Symlinks are refused outright at EVERY level,
// including the person's folder itself: a link must never become a read of
// something on the hub (a symlinked members/<slug> once copied hub files out).
export function inspectMemberTree(dir, slug = null) {
  const files = []; const refused = [];
  let total = 0;
  const own = slug ? new RegExp(`^source: ${slug.replace(/[-]/g, '\\-')}/`, 'm') : null;
  const walk = (d, rel) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
      if (files.length + refused.length >= LIMITS.files) { refused.push(`${r} (more than ${LIMITS.files} files)`); return; }
      let st; try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) { refused.push(`${r} (symlink)`); continue; }
      // the publish heartbeat, at the top of the person's folder only, a tiny timestamp
      if (e.name === '.stamp' && !rel && st.isFile() && st.size < 100) { files.push(r); continue; }
      if (!SAFE_NAME.test(e.name)) { refused.push(`${r} (name not allowed)`); continue; }
      if (st.isDirectory()) { walk(p, r); continue; }
      if (!st.isFile()) { refused.push(`${r} (not a file)`); continue; }
      if (!e.name.endsWith('.md')) { refused.push(`${r} (not markdown)`); continue; }
      if (INSTRUCTION_FILES.test(e.name)) { refused.push(`${r} (an instructions file)`); continue; }
      if (st.size > LIMITS.fileBytes) { refused.push(`${r} (too large)`); continue; }
      total += st.size;
      if (total > LIMITS.totalBytes) { refused.push(`${r} (over the ${LIMITS.totalBytes / 1048576} MB total)`); continue; }
      const text = readFileSync(p, 'utf8');
      if (!PROVENANCE_RE.test(text)) { refused.push(`${r} (no source line)`); continue; }
      // Every source line must name THIS person: Jess cannot publish "source: tom/...".
      if (own && text.split('\n').some((l) => l.startsWith('source: ') && !own.test(l))) { refused.push(`${r} (a source line names someone else)`); continue; }
      files.push(r);
    }
  };
  walk(dir, '');
  return { files, refused };
}

// Everything at the top of a person's repo other than members/<slug>/ and the
// repo's own housekeeping is reported as ignored. Never throws: a "members" that
// is a file, a link or unreadable is itself the stray.
function strays(repoDir, slug) {
  const out = [];
  let top = [];
  try { top = readdirSync(repoDir); } catch { return out; }
  for (const name of top) {
    if (name === '.git' || name === 'README.md' || name === '.gitignore') continue;
    if (name !== 'members') { out.push(name); continue; }
    let st; try { st = lstatSync(path.join(repoDir, 'members')); } catch { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) { out.push('members (not a folder)'); continue; }
    let subs = [];
    try { subs = readdirSync(path.join(repoDir, 'members')); } catch { continue; }
    for (const sub of subs) if (sub !== slug) out.push(`members/${sub}`);
  }
  return out;
}

export function importMembers(companyDir, members, { membersRoot, pull = true } = {}) {
  const report = [];
  for (const m of members) {
    try { report.push(importOne(companyDir, m, { membersRoot, pull })); }
    catch (e) { report.push({ slug: m.slug, imported: 0, refused: [`could not read their repo (${String((e && e.message) || e).slice(0, 120)})`], ignored: [], pulled: false, skipped: 'error, kept last good copy' }); }
  }
  return report;
}

function importOne(companyDir, m, { membersRoot, pull }) {
  const report = { push: (row) => { report.row = row; } };
  {
    const repo = path.join(membersRoot, m.slug);
    const row = { slug: m.slug, imported: 0, refused: [], ignored: [], pulled: true, skipped: null };
    if (pull) { try { gitIn(repo, 'pull', '-q', '--ff-only'); } catch { row.pulled = false; } }
    const src = path.join(repo, 'members', m.slug);
    row.ignored = strays(repo, m.slug);
    // The folder itself, and members/ above it, must be real folders, not links.
    const realDir = (p) => { try { const st = lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } };
    if (!existsSync(src)) { row.skipped = 'nothing published yet'; report.push(row); return report.row; }
    if (!realDir(path.join(repo, 'members')) || !realDir(src)) {
      row.refused = ['their folder is a link or not a folder']; row.skipped = 'refused files, kept last good copy'; report.push(row); return report.row;
    }
    const { files, refused } = inspectMemberTree(src, m.slug);
    row.refused = refused;
    if (refused.length) {
      // Fail closed per person: a half-imported tree would mix tonight's good pages
      // with last night's, so the whole person waits for a clean publish.
      row.skipped = 'refused files, kept last good copy';
      report.push(row); return report.row;
    }
    const dst = path.join(companyDir, 'members', m.slug);
    rmSync(dst, { recursive: true, force: true });
    for (const f of files) {
      mkdirSync(path.dirname(path.join(dst, f)), { recursive: true });
      cpSync(path.join(src, f), path.join(dst, f));
    }
    row.imported = files.length;
    report.push(row);
  }
  return report.row;
}

function pendingProposals(cloneDir) {
  const dir = path.join(cloneDir, 'proposals', 'pending');
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
  return files.map((f) => {
    const t = readFileSync(path.join(dir, f), 'utf8');
    return { id: f.replace(/\.md$/, ''), target: (t.match(/^target: (.*)$/m) || [])[1] || '?', by: (t.match(/^proposed-by: (.*)$/m) || [])[1] || '?' };
  });
}

export function synthesize(cloneDir, { now = new Date(), importReport = [] } = {}) {
  const membersDir = path.join(cloneDir, 'members');
  const members = existsSync(membersDir)
    ? readdirSync(membersDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  const byEntity = new Map();
  for (const slug of members) {
    const edir = path.join(membersDir, slug, 'entities');
    if (!existsSync(edir)) continue;
    for (const f of readdirSync(edir).filter((f) => f.endsWith('.md'))) {
      if (!byEntity.has(f)) byEntity.set(f, []);
      // A body line shaped like the hub's own "## from <person>" heading would be
      // read as a section by someone else (and counted as theirs in the week
      // page): quote it so only the hub writes that heading.
      const body = readFileSync(path.join(edir, f), 'utf8').trim().replace(/^(#{1,6}\s+from\s)/gim, '> $1');
      byEntity.get(f).push({ slug, body });
    }
  }
  const entDir = path.join(cloneDir, 'entities');
  mkdirSync(entDir, { recursive: true });
  for (const f of readdirSync(entDir)) {
    if (f.endsWith('.md') && !byEntity.has(f)) { try { unlinkSync(path.join(entDir, f)); } catch {} }
  }
  const shared = [];
  for (const [file, sections] of byEntity) {
    const name = file.replace(/\.md$/, '');
    const head = sections.length > 1
      ? `_${sections.length} people have published on this. Their sections are side by side below; where they disagree, the disagreement is real and unresolved. Check with them._`
      : `_Only ${sections[0].slug} has published on this._`;
    if (sections.length > 1) shared.push({ name, slugs: sections.map((s) => s.slug) });
    const out = [`# ${name}`, '', head, '']
      .concat(sections.map((s) => `## from ${s.slug}\n\n${s.body}\n`)).join('\n');
    writeFileSync(path.join(entDir, file), out);
  }
  const lines = [];
  for (const slug of members) {
    const p = path.join(membersDir, slug, 'decisions.md');
    if (!existsSync(p)) continue;
    for (const l of readFileSync(p, 'utf8').split('\n')) {
      const t = l.trim();
      if (t.startsWith('-')) lines.push(`${t} (${slug})`);
    }
  }
  mkdirSync(path.join(cloneDir, 'decisions'), { recursive: true });
  writeFileSync(path.join(cloneDir, 'decisions', 'log.md'),
    `# Company decisions (merged, attributed)\n\n${[...new Set(lines)].join('\n')}\n`);

  const date = now.toISOString().slice(0, 10);
  const stale = []; const stamps = {};
  const digest = [`# Company digest, ${date}`, ''];
  for (const slug of members) {
    let stamp = null;
    try { stamp = readFileSync(path.join(membersDir, slug, '.stamp'), 'utf8').trim(); } catch {}
    if (stamp && !/^\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:\d{2})$/.test(stamp)) stamp = null;   // only a timestamp reaches the manifest
    stamps[slug] = stamp;
    const t = stamp ? Date.parse(stamp) : NaN;
    if (Number.isNaN(t) || now - t > STALE_MS) stale.push(slug);
    let latest = '(nothing published yet)';
    try {
      const u = readFileSync(path.join(membersDir, slug, 'updates.md'), 'utf8');
      const m = u.match(/^## .*$([\s\S]*?)(?=^## |\n*$(?![\s\S]))/m);
      latest = m ? m[0].split('\n').slice(0, 12).join('\n') : latest;
    } catch {}
    digest.push(`## ${slug}`, '', latest, '');
  }
  digest.push('## More than one source', '',
    shared.length ? shared.map((s) => `- ${s.name}: ${s.slugs.join(', ')} (compare in entities/${s.name}.md)`).join('\n') : '- nothing yet', '');
  digest.push('## Who is quiet', '',
    stale.length ? stale.map((s) => `- ${s}: last publish ${stamps[s] || 'never'}`).join('\n') : '- everyone published in the last 36 hours', '');
  const pending = pendingProposals(cloneDir);
  digest.push('## Waiting for the owner', '',
    pending.length ? pending.map((x) => `- ${x.target}, proposed by ${x.by} (${x.id})`).join('\n') : '- no proposed changes', '');
  const problems = importReport.filter((r) => r.refused.length || r.ignored.length || !r.pulled);
  if (problems.length) {
    digest.push('## Held back tonight', '');
    for (const r of problems) {
      if (!r.pulled) digest.push(`- ${r.slug}: could not fetch their repo, used the last copy`);
      if (r.refused.length) digest.push(`- ${r.slug}: not imported, ${r.refused.join('; ')}`);
      if (r.ignored.length) digest.push(`- ${r.slug}: ignored files outside their folder: ${r.ignored.join(', ')}`);
    }
    digest.push('');
  }
  mkdirSync(path.join(cloneDir, 'digest'), { recursive: true });
  const digestPath = path.join(cloneDir, 'digest', `${date}.md`);
  writeFileSync(digestPath, digest.join('\n'));
  mkdirSync(path.join(cloneDir, '.org'), { recursive: true });
  writeFileSync(path.join(cloneDir, '.org', 'manifest.yaml'),
    `# generated by team-hub: people and their last publish\nmembers:\n` +
    members.map((s) => `  ${s}: ${stamps[s] ? `"${stamps[s]}"` : 'null'}`).join('\n') + '\n');
  return { entities: byEntity.size, members, stale, shared, digestPath };
}

// ---- the week so far (stage 3) ------------------------------------------------
// digest/week-YYYY-Www.md, rewritten on every hub run, so it is always the week so
// far and the last run of a week leaves the full week behind. Deterministic, like
// everything else the hub writes. Monday is the first day (ISO weeks).
export function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}
export function weekStart(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() || 7) - 1));
  return t.toISOString().slice(0, 10);
}

export function weekReport(cloneDir, { now = new Date(), decisionsAdded = [], stale = [] } = {}) {
  const from = weekStart(now);
  const to = now.toISOString().slice(0, 10);
  const inWeek = (d) => d >= from && d <= to;
  const membersDir = path.join(cloneDir, 'members');
  const members = existsSync(membersDir) ? readdirSync(membersDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
  const out = [`# The week so far, ${isoWeek(now)} (${from} to ${to})`, '',
    '_Written by the company agent every hour. Facts only; every line traces to a page in this brain._', '', '## Who published', ''];
  for (const slug of members) {
    let days = [];
    try { days = [...readFileSync(path.join(membersDir, slug, 'updates.md'), 'utf8').matchAll(/^## (\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]).filter(inWeek); } catch {}
    out.push(`- ${slug}: ${days.length ? `${new Set(days).size} day(s) (${[...new Set(days)].sort().join(', ')})` : 'nothing this week'}`);
  }
  if (!members.length) out.push('- nobody yet');
  out.push('', '## Decisions logged', '', decisionsAdded.length ? decisionsAdded.join('\n') : '- none this week', '');
  const decided = [];
  for (const [dir, word] of [['approved', 'approved'], ['rejected', 'turned down']]) {
    let files = [];
    try { files = readdirSync(path.join(cloneDir, 'proposals', dir)).filter((f) => f.endsWith('.md')); } catch {}
    for (const f of files) {
      const t = readFileSync(path.join(cloneDir, 'proposals', dir, f), 'utf8');
      const when = (t.match(/^decided: (\S+)/m) || [])[1] || '';
      if (!inWeek(when)) continue;
      decided.push(`- ${word}: ${(t.match(/^target: (.*)$/m) || [])[1]} (proposed by ${(t.match(/^proposed-by: (.*)$/m) || [])[1]}, ${when})`);
    }
  }
  out.push('## Rule changes', '', decided.length ? decided.sort().join('\n') : '- none decided this week');
  const pending = pendingProposals(cloneDir);
  out.push('', `Waiting for the owner: ${pending.length ? pending.map((x) => `${x.target} (from ${x.by})`).join(', ') : 'nothing'}.`, '');
  const entDir = path.join(cloneDir, 'entities');
  const shared = [];
  try {
    for (const f of readdirSync(entDir).filter((x) => x.endsWith('.md'))) {
      const who = [...readFileSync(path.join(entDir, f), 'utf8').matchAll(/^## from (\S+)/gm)].map((m) => m[1]);
      if (who.length > 1) shared.push(`- ${f.replace(/\.md$/, '')}: ${who.join(', ')}. Compare their sections; they may disagree.`);
    }
  } catch {}
  out.push('## More than one source', '', shared.length ? shared.join('\n') : '- nothing yet', '');
  out.push('## Who is quiet', '', stale.length ? stale.map((x) => `- ${x}`).join('\n') : '- everyone published in the last 36 hours', '');
  mkdirSync(path.join(cloneDir, 'digest'), { recursive: true });
  const file = path.join(cloneDir, 'digest', `week-${isoWeek(now)}.md`);
  writeFileSync(file, out.join('\n'));
  return file;
}

export function runHub(stateDir, { now = new Date(), pull = true, push = true } = {}) {
  let cfg;
  try { cfg = JSON.parse(readFileSync(path.join(stateDir, 'org', 'config.json'), 'utf8')); }
  catch { return { ok: true, output: 'team not configured: no-op' }; }
  if (cfg.role !== 'hub') return { ok: true, output: 'not the hub box: no-op' };
  const company = path.join(stateDir, 'org', 'brain');
  return withBrainLock(company, () => runHubLocked(stateDir, cfg, company, { now, pull, push }));
}

function runHubLocked(stateDir, cfg, company, { now, pull, push }) {
  // --autostash: the shared-inbox skill writes digest/inbox-*.md into this clone
  // between merges, and a plain --rebase refuses to run over it.
  if (pull) { try { gitIn(company, 'pull', '-q', '--rebase', '--autostash'); } catch { /* merge from the local copy */ } }
  const importReport = importMembers(company, cfg.members || [], { membersRoot: path.join(stateDir, 'org', 'members'), pull });
  const queued = queueImported(company);   // staff proposals join the owner's queue (stage 2)
  const r = synthesize(company, { now, importReport });
  let decisionsAdded = [];
  try {
    decisionsAdded = gitIn(company, 'log', `--since=${weekStart(now)}T00:00:00Z`, '-p', '--format=', '--', 'decisions/log.md')
      .split('\n').filter((l) => l.startsWith('+-')).map((l) => l.slice(1));
  } catch { /* first run, or no history yet */ }
  // this run's own decisions/log.md is not committed yet: count today's new lines too
  try {
    const diff = gitIn(company, 'diff', '--', 'decisions/log.md').split('\n').filter((l) => l.startsWith('+-')).map((l) => l.slice(1));
    decisionsAdded = [...new Set(decisionsAdded.concat(diff))];
  } catch {}
  weekReport(company, { now, decisionsAdded, stale: r.stale });
  gitIn(company, 'add', '-A');
  const st = gitIn(company, 'status', '--porcelain');
  if (!st.trim()) return { ok: true, output: 'hub: no changes', report: importReport, queued, ...r };
  gitIn(company, 'commit', '-q', '-m', `hub: ${now.toISOString().slice(0, 10)} (${r.members.length} people, ${r.entities} entities${r.stale.length ? `, quiet: ${r.stale.join(',')}` : ''})`);
  let pushed = false;
  if (push) { try { gitIn(company, 'push', '-q', 'origin', 'HEAD'); pushed = true; } catch { pushed = false; } }
  return { ok: true, output: `hub: merged ${r.members.length} people, ${r.entities} entities${queued.length ? `, ${queued.length} proposal(s) queued` : ''}, ${pushed ? 'pushed' : 'committed (push queued)'}`, report: importReport, queued, ...r };
}

if (isMain(import.meta.url)) {
  const stateDir = process.argv[2];
  if (!stateDir) { console.error('usage: team-hub.mjs <state-dir>'); process.exit(64); }
  try { const r = runHub(stateDir); console.log(r.output); }
  catch (e) { console.error(String((e && e.message) || e)); process.exit(1); }
}
