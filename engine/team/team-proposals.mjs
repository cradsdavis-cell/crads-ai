#!/usr/bin/env node
// team-proposals.mjs: changing the company's rules (Crads for teams, stage 2).
//
// Policies, prices, processes, client pages and shared skills live in the company
// brain, which only the company agent can write. Everyone else PROPOSES; the owner
// approves in the desktop app; the agent applies the change. Grill ruling
// 2026-10-10: rule changes are owner-approved, in the app.
//
//   staff box   propose  -> members/<slug>/proposals/<id>.md in the person's OWN
//                           repo, pushed at once (not at the nightly publish)
//   Slack       propose  -> straight into the agent's queue (the agent is the
//                           one listening in Slack)
//   agent       queue    -> proposals/pending/<id>.md in the company brain, with
//                           safety flags; everyone can see what is pending
//   owner       decide   -> approve writes the target and moves the proposal to
//                           proposals/approved/, reject to proposals/rejected/.
//                           One commit each; git history is the audit trail.
//
// A proposal file:
//   ---
//   id: 2026-10-10-jess-3fa2c1
//   target: company/policies.md
//   proposed-by: jess
//   date: 2026-10-10
//   why: "We changed refunds to 30 days at Monday's meeting."
//   ---
//   <the whole new content of the target>
//   source: jess/proposal · 2026-10-10
//
//   node team-proposals.mjs propose <state> <target> <content-file> "<why>"   (staff box)
//   node team-proposals.mjs list    <state>                                  (agent box)
//   node team-proposals.mjs decide  <state> <id> approve|reject ["note"]     (agent box)
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isMain } from '../lib/is-main.mjs';
import { withBrainLock } from './team-lock.mjs';
import { headerProblems } from './team-skills.mjs';
import { now as clockNow, dayIn, boxTz } from '../lib/clock.mjs';

// What a proposal may change. Everything the agent regenerates (members/,
// entities/, digest/, decisions/, .org/) and the proposals area itself are out.
const TARGET_RES = [
  /^company\/[a-z0-9][a-z0-9-]{0,60}\.md$/,
  /^clients\/[a-z0-9][a-z0-9-]{0,60}\.md$/,
  /^processes\/[a-z0-9][a-z0-9-]{0,60}\.md$/,
  /^skills\/[a-z0-9][a-z0-9-]{0,50}\/SKILL\.md$/,
];
export const isAllowedTarget = (t) => typeof t === 'string' && !t.includes('..') && TARGET_RES.some((re) => re.test(t));
const ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,40}-[0-9a-f]{6}$/;
// Every frontmatter field is checked on the way in (teams security review,
// 2026-10-11: a `date` carrying "\nproposed-by: owner" re-rendered as a second,
// winning key). The proposer is a person's slug, "hub", or "slack:<user id>".
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BY_RE = /^([a-z0-9][a-z0-9-]{0,40}|slack:[A-Z0-9]{2,24})$/;
const BASE_RE = /^([0-9a-f]{64}|none)$/;
export const sha = (text) => (text == null ? 'none' : createHash('sha256').update(String(text)).digest('hex'));
const MAX_BYTES = 64 * 1024;

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const gitIn = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=company-agent', '-c', 'user.email=hub@team.local', ...a], { stdio: 'pipe', encoding: 'utf8', timeout: 120000 });

// ---- the file format --------------------------------------------------------

const yq = (s) => JSON.stringify(String(s));   // JSON strings are valid YAML scalars
export function renderProposal(p) {
  if (!ID_RE.test(p.id) || !isAllowedTarget(p.target) || !BY_RE.test(p.by) || !DATE_RE.test(p.date) || !BASE_RE.test(p.base || 'none')) throw new Error('refusing to write a malformed proposal');
  return ['---', `id: ${p.id}`, `target: ${p.target}`, `proposed-by: ${p.by}`, `date: ${p.date}`, `base: ${p.base || 'none'}`, `why: ${yq(String(p.why || '').slice(0, 300))}`, '---',
    String(p.content).replace(/\s+$/, ''), '', `source: ${p.sourceSlug}/proposal · ${p.date}`, ''].join('\n');
}

export function parseProposal(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const k = line.match(/^([a-z-]+):\s*(.*)$/);
    if (!k) return null;                       // nothing but key: value lines
    if (Object.prototype.hasOwnProperty.call(fm, k[1])) return null;   // a repeated key is a forgery attempt
    let v = k[2];
    if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { return null; } }
    if (typeof v !== 'string' || /[\r\n]/.test(v)) return null;
    fm[k[1]] = v;
  }
  if (!DATE_RE.test(fm.date || '') || !BY_RE.test(fm['proposed-by'] || '') || !BASE_RE.test(fm.base || 'none')) return null;
  const body = m[2].replace(/\n*source: [^\n]*\n*$/, '\n').replace(/\s+$/, '') + '\n';
  if (!ID_RE.test(fm.id || '') || !isAllowedTarget(fm.target)) return null;
  return { id: fm.id, target: fm.target, by: fm['proposed-by'], date: fm.date, base: fm.base || 'none', why: fm.why || '', content: body, status: fm.status || null, decidedBy: fm['decided-by'] || null };
}

export function newId(slug, target, content, date) {
  const h = createHash('sha256').update(`${slug}\n${target}\n${content}\n${Date.now()}\n${Math.random()}`).digest('hex').slice(0, 6);
  return `${date}-${String(slug).replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'x'}-${h}`;
}

// ---- safety flags -----------------------------------------------------------
// Deterministic checks shown to the owner beside the diff. They never block on
// their own: the owner decides. A shared skill reaches every assistant on the
// team, so it is the supply-chain surface (malicious SKILL.md files have been
// found in the wild), and an instruction planted in a "fact" page is the
// injection surface (the EchoLeak / Slack AI pattern).
const FLAG_RULES = [
  { id: 'override', re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?)\b/i, say: 'tries to override the assistant\'s instructions' },
  { id: 'fetch', re: /\b(curl|wget|Invoke-WebRequest|nc |netcat|fetch\()|\bhttps?:\/\/(?!github\.com\/[\w.-]+\/[\w.-]+-team-brain)/i, say: 'reaches out to the internet (a link or a download command)' },
  { id: 'secrets', re: /(\.ssh\/|id_ed25519|id_rsa|\.credentials\.json|\.env\b|api[_ -]?key|access[_ -]?token|password|secrets\/)/i, say: 'mentions keys, tokens or passwords' },
  { id: 'send', re: /\b(send|email|forward|post|upload)\b[^.\n]{0,60}\b(to|at)\b[^.\n]{0,40}(@|https?:\/\/)/i, say: 'tells the assistant to send something somewhere' },
  { id: 'blob', re: /[A-Za-z0-9+/=]{200,}/, say: 'contains a long encoded blob' },
  { id: 'hidden', re: /[\p{Cf}\u{E0000}-\u{E007F}\u2066-\u2069]/u, say: 'contains invisible characters (text the owner cannot see but an assistant can read)' },
  { id: 'shell', re: /(\brm -rf|\bchmod\b|\bsudo\b|\bbash -c|\|\s*(ba|z)?sh\b|\beval\s*\(|child_process|\bexec\()/i, say: 'contains shell or code-execution commands' },
];
export function scanProposal(p) {
  const flags = [];
  for (const r of FLAG_RULES) if (r.re.test(p.content)) flags.push({ id: r.id, say: r.say });
  if (Buffer.byteLength(p.content, 'utf8') > MAX_BYTES) flags.push({ id: 'size', say: 'is unusually large' });
  if (p.target.startsWith('skills/')) {
    flags.unshift({ id: 'skill', say: 'is a shared skill: once approved it runs on every assistant on the team' });
    const extra = headerProblems(p.content);
    if (extra.length) flags.push({ id: 'tools', say: `has header lines beyond name and description (${extra.slice(0, 3).join('; ')}); these are removed when it is installed` });
  }
  return flags;
}

// ---- staff box: propose -------------------------------------------------------

export function propose(stateDir, { target, content, why = '', date = dayIn(clockNow(stateDir), boxTz(stateDir)), push = true }) {
  const cfg = readJson(path.join(stateDir, 'org', 'config.json'));
  if (!cfg || !cfg.company) throw new Error('this box is not in a team');
  if (!isAllowedTarget(target)) throw new Error(`cannot propose a change to "${target}": only company/, clients/, processes/ pages and skills/<name>/SKILL.md`);
  if (!String(content).trim()) throw new Error('a proposal needs the whole new content of the page');
  if (Buffer.byteLength(String(content), 'utf8') > MAX_BYTES) throw new Error('that is too large for one proposal');
  // base: which version of the page this proposal was written against, so an
  // approval can refuse a page that has changed since (a lost update otherwise).
  let current = null;
  try { current = readFileSync(path.join(stateDir, 'org', 'brain', target), 'utf8'); } catch { current = null; }
  const p = { target, content: String(content), why, date, by: cfg.slug, sourceSlug: cfg.slug, base: sha(current) };
  p.id = newId(cfg.slug, target, p.content, date);
  if (cfg.role === 'hub') return queue(stateDir, { ...p, by: p.by }, { push });
  const outbox = path.join(stateDir, 'org', 'outbox');
  const dir = path.join(outbox, 'members', cfg.slug, 'proposals');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${p.id}.md`), renderProposal(p));
  gitIn(outbox, 'add', `members/${cfg.slug}/proposals/${p.id}.md`);
  gitIn(outbox, 'commit', '-q', '-m', `propose(${cfg.slug}): ${target}`);
  let pushed = false;
  if (push) { try { gitIn(outbox, 'push', '-q'); pushed = true; } catch { pushed = false; } }
  return { ok: true, id: p.id, pushed, flags: scanProposal(p) };
}

// ---- agent box: queue, list, decide -----------------------------------------

const areas = (brain) => ({
  pending: path.join(brain, 'proposals', 'pending'),
  approved: path.join(brain, 'proposals', 'approved'),
  rejected: path.join(brain, 'proposals', 'rejected'),
});
const known = (brain, id) => Object.values(areas(brain)).some((d) => existsSync(path.join(d, `${id}.md`)));

// Put one proposal in the pending area of the company clone (no commit).
function stage(brain, p) {
  if (known(brain, p.id)) return false;
  const { pending } = areas(brain);
  mkdirSync(pending, { recursive: true });
  writeFileSync(path.join(pending, `${p.id}.md`), renderProposal(p));
  return true;
}

// Called by the nightly hub run (and on demand): every staff proposal the hub
// imported under members/<slug>/proposals/ that is not yet known joins the queue.
// The proposer is taken from the FOLDER it came from, never from the file: a box
// cannot propose in a colleague's name.
export function queueImported(brain) {
  const added = [];
  const membersDir = path.join(brain, 'members');
  let slugs = [];
  try { slugs = readdirSync(membersDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch {}
  for (const slug of slugs) {
    const dir = path.join(membersDir, slug, 'proposals');
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const p = parseProposal(readFileSync(path.join(dir, f), 'utf8'));
      if (!p || `${p.id}.md` !== f) continue;
      if (stage(brain, { ...p, by: slug, sourceSlug: slug })) added.push(p.id);
    }
  }
  return added;
}

// A proposal made on the agent itself (from Slack): queued and committed at once.
export function queue(stateDir, p, { push = true } = {}) {
  const brain = path.join(stateDir, 'org', 'brain');
  return withBrainLock(brain, () => queueLocked(brain, p, { push }));
}
function queueLocked(brain, p, { push }) {
  if (p.base == null) { try { p = { ...p, base: sha(readFileSync(path.join(brain, p.target), 'utf8')) }; } catch { p = { ...p, base: 'none' }; } }
  if (!stage(brain, { ...p, sourceSlug: p.sourceSlug || 'hub' })) return { ok: true, id: p.id, queued: false };
  gitIn(brain, 'add', 'proposals');
  gitIn(brain, 'commit', '-q', '-m', `proposal queued: ${p.target} (from ${p.by})`);
  let pushed = false;
  if (push) { try { gitIn(brain, 'push', '-q', 'origin', 'HEAD'); pushed = true; } catch { pushed = false; } }
  return { ok: true, id: p.id, queued: true, pushed, flags: scanProposal(p) };
}

function readCurrent(brain, target) { try { return readFileSync(path.join(brain, target), 'utf8'); } catch { return null; } }

export function listProposals(stateDir) {
  const brain = path.join(stateDir, 'org', 'brain');
  const { pending } = areas(brain);
  let files = [];
  try { files = readdirSync(pending).filter((f) => f.endsWith('.md')).sort(); } catch {}
  const out = [];
  for (const f of files) {
    const p = parseProposal(readFileSync(path.join(pending, f), 'utf8'));
    if (!p) continue;
    const current = readCurrent(brain, p.target);
    out.push({ ...p, current, stale: p.base !== sha(current), flags: scanProposal(p) });
  }
  return out;
}

export function decide(stateDir, id, verdict, { note = '', by = 'owner', push = true, date = dayIn(clockNow(stateDir), boxTz(stateDir)) } = {}) {
  const cfg = readJson(path.join(stateDir, 'org', 'config.json'));
  if (!cfg || cfg.role !== 'hub') throw new Error('decisions are made on the company agent\'s box');
  if (!ID_RE.test(String(id))) throw new Error('bad proposal id');
  if (verdict !== 'approve' && verdict !== 'reject') throw new Error('verdict must be approve or reject');
  const brain = path.join(stateDir, 'org', 'brain');
  return withBrainLock(brain, () => decideLocked(brain, id, verdict, { note, by, push, date }));
}
function decideLocked(brain, id, verdict, { note, by, push, date }) {
  try { gitIn(brain, 'pull', '-q', '--rebase', '--autostash'); } catch { /* decide on the local copy */ }
  const a = areas(brain);
  const from = path.join(a.pending, `${id}.md`);
  if (!existsSync(from)) throw new Error('that proposal is not pending (already decided, or never queued)');
  const p = parseProposal(readFileSync(from, 'utf8'));
  if (!p) throw new Error('that proposal file is damaged');
  if (verdict === 'approve' && p.base !== sha(readCurrent(brain, p.target))) {
    throw new Error(`${p.target} has changed since this was proposed, so approving it would undo that change. Turn it down and ask for it to be proposed again.`);
  }
  if (verdict === 'approve') {
    const dst = path.join(brain, p.target);
    mkdirSync(path.dirname(dst), { recursive: true });
    writeFileSync(dst, p.content);
  }
  const dir = verdict === 'approve' ? a.approved : a.rejected;
  mkdirSync(dir, { recursive: true });
  const decided = readFileSync(from, 'utf8').replace(/\n---\n/, `\nstatus: ${verdict === 'approve' ? 'approved' : 'rejected'}\ndecided-by: ${by}\ndecided: ${date}${note ? `\nnote: ${JSON.stringify(note)}` : ''}\n---\n`);
  writeFileSync(path.join(dir, `${id}.md`), decided);
  unlinkSync(from);
  gitIn(brain, 'add', '-A', 'proposals', ...(verdict === 'approve' ? [p.target] : []));
  gitIn(brain, 'commit', '-q', '-m', `${verdict === 'approve' ? 'approved' : 'rejected'}: ${p.target} (proposed by ${p.by}, decided by ${by})${note ? ` ${note}` : ''}`);
  let pushed = false;
  if (push) { try { gitIn(brain, 'push', '-q', 'origin', 'HEAD'); pushed = true; } catch { pushed = false; } }
  return { ok: true, id, verdict, target: p.target, pushed };
}

if (isMain(import.meta.url)) {
  const [verb, stateDir, ...rest] = process.argv.slice(2);
  try {
    if (verb === 'propose' && stateDir && rest.length >= 2) {
      const r = propose(stateDir, { target: rest[0], content: readFileSync(rest[1], 'utf8'), why: rest[2] || '' });
      process.stdout.write(`TEAM_PROPOSED ${JSON.stringify(r)}\n`);
    } else if (verb === 'list' && stateDir) {
      process.stdout.write(`TEAM_PROPOSALS ${JSON.stringify(listProposals(stateDir))}\n`);
    } else if (verb === 'decide' && stateDir && rest.length >= 2) {
      // The app sends the owner's note as base64 on stdin ("-"), never argv.
      let note = rest[2] || '';
      if (note === '-') { let raw = ''; for await (const c of process.stdin) raw += c; note = Buffer.from(raw.trim(), 'base64').toString('utf8').slice(0, 500); }
      process.stdout.write(`TEAM_DECIDED ${JSON.stringify(decide(stateDir, rest[0], rest[1], { note }))}\n`);
    } else {
      console.error('usage: team-proposals.mjs propose <state> <target> <content-file> "<why>" | list <state> | decide <state> <id> approve|reject ["note"]');
      process.exit(64);
    }
  } catch (e) {
    console.error(String((e && e.message) || e));
    process.exit(1);
  }
}
