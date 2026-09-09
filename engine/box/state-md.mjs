#!/usr/bin/env node
// state-md.mjs <state-dir> — write <brain-root>/STATE.md: what this mineral is,
// who it belongs to, and what it can do, in one short page the assistant reads
// before answering questions about itself (R24, panel iteration 2, 2026-08-23).
//
// WHY A FILE. The assistant's picture of its own box used to come from two
// stale places: a CLAUDE.md template written at stamp time and the reference
// section of /explain, both describing a two-layer box that no longer exists.
// Neither knew the tier, the anchor, who holds the grants, which skills came
// from which rock, or whether a connection had died. Every one of those facts
// is already on disk in machine form; this file is the human-readable join,
// rewritten by the heartbeat so it can never be older than the last run.
//
// WHAT IT NEVER CONTAINS. No secret VALUES, ever. This module reads nothing
// under secrets/, .claude-auth/ or .kernel/ beyond whether a file exists, and
// the only thing it takes from .mcp.json is each server's name and whether an
// authorization header is configured (the header's value is never touched).
// The file is committed with the brain, so the bar is "fine in a private repo
// the member owns", and a secret is never fine there.
//
// Shape: readSkillOrigins() is shared with the heartbeat (the install receipts
// on the always-on floor, R2); buildStateMd() is pure over a state dir;
// writeStateMd() is the one writer. Sections are structural: tests assert the
// headings and the facts under them, never copied sentences.
import { readFileSync, writeFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { resolveBrainRoot, isOrgBox, readOwnership } from '../lib/brain-root.mjs';
import { mineralNames } from '../lib/mineral-identity.mjs';
import { listSkills } from '../appshell/skills-list.mjs';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const rdj = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const rd = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const yamlField = (text, field) => {
  const m = text.match(new RegExp(`^\\s*${field}:\\s*"?([^"\\n#]*)"?`, 'm'));
  return m ? m[1].trim() : '';
};

// ---- the install receipts (R2) ---------------------------------------------
// One row per /state/.claude/skills/<id>/.origin.json, written by catalog-install
// as { rock, version, installed }. Metadata only: which rock-published skills
// this box holds and at which version, never what they did. Always on the
// heartbeat floor, so a rock's "installed" chip is a fact rather than a guess.
export function readSkillOrigins(stateDir) {
  const base = path.join(resolveBrainRoot(stateDir), '.claude', 'skills');
  let ids = [];
  try { ids = readdirSync(base).filter((d) => ID_RE.test(d)).sort(); } catch { return []; }
  const out = [];
  for (const id of ids) {
    const o = rdj(path.join(base, id, '.origin.json'));
    if (!o || typeof o !== 'object' || !o.rock) continue;
    out.push({ id, rock: String(o.rock), version: Number(o.version) || 0 });
  }
  return out;
}

// ---- the facts, one reader per section -------------------------------------
function devices(stateDir) {
  const dir = path.join(stateDir, 'devices');
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.yaml') && !f.startsWith('_')).sort(); } catch { return []; }
  const out = [];
  for (const f of files) {
    const t = rd(path.join(dir, f));
    if (yamlField(t, 'status') !== 'active') continue;
    out.push({ label: yamlField(t, 'label') || f.replace(/\.yaml$/, ''), last_seen: yamlField(t, 'last_seen') });
  }
  return out;
}

// Names and a state word per connection. The state vocabulary follows
// engine/comms/mcp-connect.mjs (on / needs-auth / account), but that tool reads
// the credential store to tell "on" from "needs-auth", which this file may not,
// so an OAuth server is reported as configured and the page is named for the
// live answer. Account connectors come from the cockpit's cached probe, and only
// while it is fresh, exactly as mcp-connect treats it.
function connections(stateDir, now) {
  const servers = (rdj(path.join(stateDir, '.mcp.json')) || {}).mcpServers || {};
  const rows = [];
  for (const [name, def] of Object.entries(servers)) {
    const token = !!(def && def.headers && Object.keys(def.headers).some((h) => /^authorization$/i.test(h)));
    rows.push({ name, state: token ? 'on' : 'configured',
      note: token ? 'works, including in scheduled jobs'
        : 'signs in with OAuth; the Connections page says whether the sign-in is live' });
  }
  const cc = rdj(path.join(stateDir, 'cockpit', 'connectors.json'));
  // Freshness runs on the CALLER'S clock, the same `now` every other line of
  // this file stamps and ages by. It read Date.now() until 2026-08-25, which
  // made the one time-sensitive judgement in a deliberately clock-injected
  // builder unpinnable: the suite's fixed-NOW fixture aged out in real time
  // and failed 24 hours after it was written. Trap 61.
  const fresh = cc && Array.isArray(cc.names) && (now.getTime() - (cc.at || 0)) < 24 * 3600e3;
  for (const raw of fresh ? cc.names : []) {
    const label = String(raw).replace(/^claude\.ai\s+/i, '').trim();
    if (!label || rows.some((r) => r.name.toLowerCase() === label.toLowerCase())) continue;
    rows.push({ name: label, state: 'account', note: 'connected to the Claude account, chats only, never scheduled jobs' });
  }
  return rows;
}

function custody(stateDir, n = 5) {
  const lines = rd(path.join(stateDir, 'custody-log.jsonl')).split('\n').filter(Boolean);
  return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function members(brainRoot) {
  const dir = path.join(brainRoot, 'registry', 'members');
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.yaml') && !f.startsWith('_')).sort(); } catch { return []; }
  return files.map((f) => {
    const t = rd(path.join(dir, f));
    const slug = yamlField(t, 'slug') || f.replace(/\.yaml$/, '');
    const hb = rdj(path.join(brainRoot, 'heartbeats', `${slug}.json`));
    return { slug, display_name: yamlField(t, 'display_name'), status: yamlField(t, 'status') || 'active',
      heartbeat_at: hb && hb.generated_at ? String(hb.generated_at) : '' };
  });
}

export function softwareVersion() {
  try { return execFileSync('git', ['-C', '/app', 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim() || ''; }
  catch { return ''; }
}

// ---- rendering ------------------------------------------------------------
function age(iso, now) {
  const t = Date.parse(iso);
  if (!iso || Number.isNaN(t)) return 'never';
  const m = Math.max(0, Math.round((now.getTime() - t) / 60000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
const originWord = (s) => {
  if (s.source === 'engine') return 'built in';
  if (s.source === 'seed') return 'starter';
  return 'yours';
};

export function buildStateMd(stateDir, { now = new Date(), version = softwareVersion() } = {}) {
  const brainRoot = resolveBrainRoot(stateDir);
  const isRock = isOrgBox(stateDir);
  const tier = isRock ? 'rock' : 'pebble';
  const own = readOwnership(stateDir) || {};
  const names = mineralNames(stateDir);
  const anchorRaw = String(own.anchor || '').trim();
  const anchor = !anchorRaw || anchorRaw === 'crads-ai' ? 'Crads AI, the Mountain' : anchorRaw;
  const skills = listSkills(stateDir).skills;
  const grants = Array.isArray(own.grants) ? own.grants : [];
  const L = [];
  const push = (...xs) => L.push(...xs);

  push(`Generated by the heartbeat at ${now.toISOString()}. Do not edit; it is rewritten every run. Read this before answering questions about what this mineral is, who it belongs to, or what it can do.`, '');
  push(`# ${names.label || names.host || 'This mineral'}`, '');
  push('## What this is', '');
  push(`- Tier: ${tier}`);
  push(`- Name: ${names.label || '(not named yet)'}`);
  push(`- Host: ${names.host}`);
  push(`- Anchor: ${anchor}`);
  push(`- Owner: ${own.owner || 'member'}${own.owner_slug ? ` (${own.owner_slug})` : ''}`);
  push(`- Managed by: ${own.managed_by || 'unknown'}`);
  push(`- Machinery by: ${own.machinery_by || 'crads-ai'}`);
  push(`- Brain root: ${brainRoot}`, '');

  push('## Grants', '');
  if (!grants.length) push('- None. Only the holder can open this mineral.');
  for (const g of grants) push(`- ${g.email || '(no address)'}: ${g.role || 'user'}, ${g.status || 'pending'}`);
  push('');

  push('## Devices that can sign in', '');
  const devs = devices(stateDir);
  if (!devs.length) push('- None enrolled yet.');
  for (const d of devs) push(`- ${d.label}: last seen ${d.last_seen || 'never'}`);
  push('');

  push('## Connections', '');
  const conns = connections(stateDir, now);
  if (!conns.length) push('- None connected yet.');
  for (const c of conns) push(`- ${c.name}: ${c.state}, ${c.note}`);
  push('');

  push('## Skills installed', '');
  if (!skills.length) push('- None yet.');
  for (const s of skills) push(`- /${s.id}${s.title ? ` (${s.title})` : ''}: ${originWord(s)}`);
  push('');

  push('## Custody, last 5 events', '');
  const ev = custody(stateDir);
  if (!ev.length) push('- No custody events recorded yet.');
  for (const e of ev) push(`- ${e.at || '?'}: ${e.event || '?'}`);
  push('');

  push('## Software', '');
  push(`- Version: ${version || 'not recorded (no git in the image)'}`, '');

  if (isRock) {
    push('## Members', '');
    const ms = members(brainRoot);
    if (!ms.length) push('- No members yet.');
    for (const m of ms) push(`- ${m.slug}${m.display_name ? ` (${m.display_name})` : ''}: ${m.status}, last heartbeat ${age(m.heartbeat_at, now)}`);
    push('');
  }
  return L.join('\n');
}

export function writeStateMd(stateDir, opts = {}) {
  const brainRoot = resolveBrainRoot(stateDir);
  const text = buildStateMd(stateDir, opts);
  const out = path.join(brainRoot, 'STATE.md');
  const tmp = out + '.tmp';
  writeFileSync(tmp, text + '\n');
  // rename is atomic on the same filesystem; a reader never sees a half file
  renameSync(tmp, out);
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const stateDir = path.resolve(process.argv[2] || process.env.STATE_DIR || '/state');
  const out = writeStateMd(stateDir);
  console.log(`state-md: wrote ${out} (${statSync(out).size} bytes)`);
}
