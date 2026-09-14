// local-verbs.mjs: the verb table the panel serves to a LOCAL target (the
// no-server face, Sam's ruling 2026-09-11).
//
// Shape-identical to MEMBER_VERBS (panel-server.mjs): { build(args) ->
// { command, stdin? }, mutating? }. What differs is what `command` IS. The
// member table builds shell lines for a box (`node /app/engine/...`, `find`,
// `base64`); this table builds `__local__ {"verb","args"}` markers that
// local-bridge.mjs runs IN-PROCESS through runLocalVerb below. See the
// bridge's header for why (Windows laptops, and an exe that cannot spawn
// node). The one exception is whoami, a plain command on every platform,
// which keeps the bridge's shell path exercised on a real machine.
//
// WHAT IS ABSENT IS THE POINT. cadence-write, skill-run, skill-remove, every
// telegram-*, mcp-*, secrets-*, devices-*, support-*, layout-write, box-
// refresh: none of it is here, so /run answers "unknown verb" (400) the way
// it does for any verb it does not serve. Scheduled jobs, Telegram and
// connections need a server; the page hides those surfaces and says so.
//
// Arguments are validated HERE, in the builder, exactly as the member table
// does: a bad arg is a 400 before anything touches the folder, and the
// handlers below trust nothing they did not validate themselves.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { listSkills } from '../../engine/appshell/skills-list.mjs';
import { deletePage } from '../../engine/appshell/page-delete.mjs';
import { readClaudeCredential } from '../../engine/lib/claude-credential.mjs';
import { seedPages, setBrainName } from './local-scaffold.mjs';

export const LOCAL_MARK = '__local__ ';

// ---------------------------------------------------------------- validation
// The same shapes panel-server enforces for the member table. Copied rather
// than imported: panel-server imports THIS module, and an import cycle
// between a verb table and its server is the kind of thing that works until
// the day bundling order changes.
function bad(msg) { const e = new Error(msg); e.status = 400; throw e; }
const TEXT_EXT = ['md', 'txt', 'csv', 'tsv'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
export const ASSET_EXT = [...TEXT_EXT, ...IMAGE_EXT];
const SEG_RE = /^[a-z0-9_][a-z0-9._-]*$/i;
const extOf = (s) => (s.split('.').pop() || '').toLowerCase();
const relArg = (v, exts, what) => {
  const s = String(v ?? '');
  const segs = s.split('/');
  const ok = s.length <= 200 && segs.length > 0
    && segs.every((seg) => SEG_RE.test(seg) && seg !== '..' && !seg.startsWith('.'))
    && exts.includes(extOf(s));
  if (!ok) bad(`${what} must be a relative path ending .${exts.join(' / .')} (no dotfiles, no traversal)`);
  return s;
};
const textArg = (v) => relArg(v, TEXT_EXT, 'page');
const imageArg = (v) => relArg(v, IMAGE_EXT, 'image');
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const idArg = (v) => { const id = String(v ?? ''); if (!ID_RE.test(id)) bad('id must be a kebab-case skill id'); return id; };
const htmlPageArg = (v) => {
  const p = String(v ?? '');
  if (!/^[a-z0-9][a-z0-9._-]{0,80}\.html$/.test(p) || p.includes('..')) bad('page must be a plain <slug>.html filename');
  return p;
};
const pageIdArg = (v) => {
  const id = String(v ?? '');
  if (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(id) || id.includes('..')) bad('id must be a plain page slug');
  return id;
};
const nameArg = (v) => {
  const name = String(v ?? '').trim();
  if (!name || name.length > 60) bad('a name needs 1 to 60 characters');
  if (/[\x00-\x1f\x7f]/.test(name)) bad('that name has characters we cannot store');
  return name;
};

const mark = (verb, args = {}) => ({ command: LOCAL_MARK + JSON.stringify({ verb, args }) });

// ---------------------------------------------------------------- the table
export const LOCAL_VERBS = {
  // The one plain shell verb: liveness for connect(), and the bridge's shell
  // path proven on the member's own machine.
  whoami: { build: () => ({ command: 'whoami' }) },

  'dashboard-data': { build: (a = {}) => mark('dashboard-data', { fresh: a.fresh ? 1 : 0 }) },
  'brain-list': { build: () => mark('brain-list') },
  'brain-read': { build: (a = {}) => mark('brain-read', { page: textArg(a.page) }) },
  'brain-image': { build: (a = {}) => mark('brain-image', { page: imageArg(a.page) }) },
  'pages-list': { build: () => mark('pages-list') },
  'page-read': { build: (a = {}) => mark('page-read', { page: htmlPageArg(a.page) }) },
  'page-delete': { mutating: true, build: (a = {}) => mark('page-delete', { id: pageIdArg(a.id) }) },
  'skills-list': { build: () => mark('skills-list') },
  // The Skills page reads cadence-list, not skills-list (R6 merged them);
  // served read-only so the page can list what is installed. The cadence and
  // plan segments are honestly empty: nothing schedules here.
  'cadence-list': { build: () => mark('cadence-list') },
  'skill-read': { build: (a = {}) => mark('skill-read', { id: idArg(a.id) }) },
  'member-console-state': { build: () => mark('member-console-state') },
  'open-folder': { build: () => mark('open-folder') },
  'box-version': { build: () => mark('box-version') },
  'box-rename': { mutating: true, build: (a = {}) => mark('box-rename', { name: nameArg(a.name) }) },
};

// ---------------------------------------------------------------- handlers
const rd = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const rdJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const yget = (yaml, key) => { const m = (yaml || '').match(new RegExp(`${key}:\\s*"?([^"\\n]+)"?`)); return m ? m[1].trim() : null; };
const b64 = (p) => readFileSync(p).toString('base64');

// The brain proper is <folder>/wiki, exactly where the member table's
// memberBrainEnter lands (cd /state/wiki).
const wikiDir = (t) => path.join(t.path, 'wiki');

// A safe join: the arg was validated to have no dotfile and no `..` segment,
// and this refuses anything that still resolves outside the root.
function inside(root, rel) {
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) bad('that path is outside the brain');
  return p;
}

function walkAssets(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'cockpit') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (ASSET_EXT.includes(extOf(e.name))) out.push(r);
    }
  };
  walk(root, '');
  return out.sort();
}

// A trimmed, in-process port of engine/cockpit/box-cockpit.mjs for a folder:
// onboarding progress, the brain graph, skills installed, the assistant's
// name. No Telegram, cadence or MCP rows (they need a server, and the page
// hides those surfaces on this face); no Claude sign-in row either, because
// the folder has no sign-in of its own: Claude Code on the member's computer
// is the sign-in, and a row saying "not signed in" would be false.
export function localDashboardData(t) {
  const box = t.path;
  const profile = rd(path.join(box, 'profile.yaml')) || '';
  const onb = rdJSON(path.join(box, 'onboarding-state.json'));
  const steps = Object.entries((onb && (onb.layers || onb.modules)) || {}).map(([name, m]) => ({
    name, status: (m && m.status) || 'not-started', raw: ((m && m.raw) || []).length, synthesized: !!(m && m.synthesized),
  }));
  const covered = steps.filter((m) => m.status === 'covered' || m.status === 'done').length;
  const current = (onb && (onb.current_layer || onb.current_module))
    || (steps.find((m) => m.status === 'in-progress') || {}).name || (steps[0] || {}).name;
  const wiki = wikiDir(t);
  const pages = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (e.name !== '.git') walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name); }
      else if (e.name.endsWith('.md')) pages.push({ rel: rel ? `${rel}/${e.name}` : e.name, file: path.join(dir, e.name) });
    }
  };
  walk(wiki, '');
  const SKELETON = new Set(['daily-brief', 'log', 'priorities']);
  const TYPE_BY_FOLDER = { people: 'person', projects: 'project', _layers: 'layer' };
  for (const p of pages) {
    p.id = p.rel.replace(/\.md$/, '');
    p.slug = p.id.split('/').pop();
    p.folder = p.rel.includes('/') ? p.rel.split('/')[0] : 'core';
    p.body = rd(p.file) || '';
    p.title = (p.body.match(/^#\s+(.+?)\s*$/m) || [])[1] || p.slug.replace(/-/g, ' ');
    p.type = SKELETON.has(p.slug) ? 'scaffold' : (TYPE_BY_FOLDER[p.folder] || (p.folder === 'core' ? 'note' : p.folder.replace(/s$/, '')));
    const fmDesc = (p.body.match(/^description:\s*"?([^"\n]+)"?/m) || [])[1];
    const firstLine = p.body.split('\n').find((l) => l.trim() && !/^(#|---|[a-z-]+:|\s*[-*]\s*$)/.test(l.trim()));
    p.desc = (fmDesc || firstLine || '').trim().slice(0, 160);
  }
  const byKey = new Map();
  for (const p of pages) { const k = p.slug.toLowerCase(); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(p); }
  for (const arr of byKey.values()) arr.sort((a, b) => (a.rel.split('/').length - b.rel.split('/').length) || a.rel.localeCompare(b.rel));
  const byPath = new Map(pages.map((p) => [p.id.toLowerCase(), p]));
  const resolveLink = (raw) => {
    const s = String(raw).trim().replace(/\.md$/i, '');
    if (!s) return null;
    return byPath.get(s.toLowerCase()) || ((byKey.get(s.split('/').pop().toLowerCase()) || [])[0]) || null;
  };
  const linkMap = new Map();
  for (const p of pages) {
    for (const m of p.body.matchAll(/\[\[([^\]|#]+)/g)) {
      const tgt = resolveLink(m[1]);
      if (!tgt || tgt.id === p.id) continue;
      const key = p.id < tgt.id ? `${p.id}\n${tgt.id}` : `${tgt.id}\n${p.id}`;
      const cur = linkMap.get(key);
      if (cur) cur.w++; else linkMap.set(key, { source: p.id, target: tgt.id, w: 1 });
    }
  }
  const links = [...linkMap.values()];
  const deg = new Map();
  for (const l of links) { deg.set(l.source, (deg.get(l.source) || 0) + 1); deg.set(l.target, (deg.get(l.target) || 0) + 1); }
  const nodes = pages.map((p) => ({
    id: p.id, label: p.slug.replace(/-/g, ' '), group: SKELETON.has(p.slug) ? 'skeleton' : (p.folder === 'people' ? 'people' : 'core'),
    title: p.title, type: p.type, path: p.rel, desc: p.desc, deg: deg.get(p.id) || 0,
  }));
  const realPages = pages.filter((p) => !SKELETON.has(p.slug)).length;
  let skillsInstalled = 0;
  try {
    const d = path.join(box, '.claude', 'skills');
    skillsInstalled = readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(path.join(d, e.name, 'SKILL.md'))).length;
  } catch { skillsInstalled = 0; }
  const phase = (onb && onb.phase) || 'interview';
  const name = (rd(path.join(box, 'box-name')) || '').trim().slice(0, 60) || yget(profile, 'assistant_name') || t.name || 'your assistant';
  return {
    pebble: yget(profile, 'user_short') || yget(profile, 'user_name') || path.basename(box),
    assistant: name,
    business: (profile.match(/business:[\s\S]*?customers:\s*"([^"]+)"/) || [])[1] || null,
    tier: 'pebble', hosting: 'local', local: true, path: box,
    provider: null, generated_at: new Date().toISOString(),
    stage: phase === 'done' ? 'live' : `onboarding · ${current || 'getting started'}`, phase,
    onboarding: { phase, covered, total: steps.length || 8, current, modules: steps },
    brain: { pages: realPages, skeleton: pages.length - realPages, people: pages.filter((p) => p.folder === 'people').length, root: wiki, root_missing: !existsSync(wiki) },
    skills: { installed: skillsInstalled },
    health: phase === 'done' ? 'active' : 'onboarding',
    connections: [],
    claude_signin_present: readClaudeCredential(box).present,
    graph: { nodes, links },
  };
}

// skills-list, with the engine's own skills classified as engine. The engine
// module keys that on a /app path this computer does not have, so the
// assets bag (the same skill files the scaffold installed) answers instead.
export function localSkillsState(t, assets) {
  const st = listSkills(t.path);
  const engine = new Set(Object.keys((assets && assets.skills) || {}));
  st.skills = (st.skills || []).map((s) => (engine.has(s.id) ? { ...s, source: 'engine' } : s));
  st.local = true;
  return st;
}

function consoleState(t) {
  const box = t.path;
  const own = rdJSON(path.join(box, 'ownership.json')) || {};
  let backup = { connected: false, repo: '', last: '', org_owned: false, owner_label: '' };
  const cfg = rd(path.join(box, '.git', 'config')) || '';
  const u = (cfg.match(/\[remote "origin"\][\s\S]*?url\s*=\s*(\S+)/) || [])[1] || '';
  if (u) { backup.connected = true; backup.repo = u.replace(/\/\/[^@/]*@/, '//').replace(/\.git$/, ''); }
  const lg = (rd(path.join(box, 'cockpit', 'brain-push.log')) || '').trim().split('\n');
  for (let i = lg.length - 1; i >= 0; i--) { if (/ pushed to /.test(lg[i])) { backup.last = lg[i].split(' ')[0]; break; } }
  const profile = rd(path.join(box, 'profile.yaml')) || '';
  const nm = (rd(path.join(box, 'box-name')) || '').trim().slice(0, 60) || yget(profile, 'assistant_name') || t.name || '';
  return {
    ownership: { owner: 'member', owner_slug: '', managed_by: 'you', tier: 'pebble', machinery_by: 'crads-ai', hosting: 'local' },
    org: { name: '', display: '', admin_email: '' },
    anchored: false, anchor: '', name: nm, backup, custody: [],
    waiting: { transfer_invitation: null, ownership_grant: null, asks: [] },
    lineage: null, local: true, path: box, holder_email: own.holder_email || '',
    generated: new Date().toISOString(),
  };
}

/**
 * Run one local verb against a target row. Returns the exit code. `emit`
 * takes ONE line at a time (the SSE channel is line-based); `emitErr` lands
 * on the same stream the way ssh stderr does.
 */
export async function runLocalVerb(t, verb, args = {}, { emit, emitErr = emit, assets = null } = {}) {
  const root = path.resolve(t.path);
  if (!existsSync(root)) { emitErr(`ERROR: the brain folder is missing: ${root}`); return 1; }
  switch (verb) {
    case 'dashboard-data': {
      const data = localDashboardData(t);
      try { mkdirSync(path.join(root, 'cockpit'), { recursive: true }); writeFileSync(path.join(root, 'cockpit', 'data.json'), JSON.stringify(data, null, 2) + '\n'); } catch { /* the page got its answer either way */ }
      emit('__BUILD__'); emit('__DATA__'); emit(JSON.stringify(data)); emit('__LAYOUT__'); emit('{}');
      return 0;
    }
    case 'brain-list': {
      const w = wikiDir(t);
      if (!existsSync(w)) { emit(`ERROR: no brain at ${w}`); return 1; }
      for (const rel of walkAssets(w)) emit(rel);
      return 0;
    }
    case 'brain-read': {
      const page = textArg(args.page);
      const f = inside(wikiDir(t), page);
      const body = rd(f);
      if (body === null) { emit(`ERROR: no such page: ${page}`); return 1; }
      for (const l of body.split('\n')) emit(l.replace(/\r$/, ''));
      return 0;
    }
    case 'brain-image': {
      const page = imageArg(args.page);
      const f = inside(wikiDir(t), page);
      let sz = -1;
      try { sz = statSync(f).size; } catch { sz = -1; }
      if (sz < 0) { emit(`ERROR: no such image: ${page}`); return 1; }
      const MAX = 6 * 1024 * 1024;
      if (sz > MAX) { emit(`ERROR: this image is too large to preview in the app (${Math.round(sz / 1024)}KB; the limit is ${Math.round(MAX / 1024)}KB). Open it in the folder instead.`); return 1; }
      emit(`__IMAGE__ ${extOf(page)} ${sz}`);
      emit(b64(f));
      return 0;
    }
    case 'pages-list': {
      try { seedPages(root, assets); } catch { /* seeding is best-effort, like the box's `|| true` */ }
      const dash = path.join(root, 'dashboard');
      emit('__MANIFEST__'); emit(rd(path.join(dash, 'pages.json')) || '{}');
      emit('__CARDS__'); emit(rd(path.join(dash, 'cards.json')) || '{}');
      emit('__OWNERSHIP__'); emit(rd(path.join(root, 'ownership.json')) || '{}');
      emit('__ORGCONTACT__'); emit('{}');
      return 0;
    }
    case 'page-read': {
      const p = htmlPageArg(args.page);
      const body = rd(inside(path.join(root, 'dashboard', 'pages'), p));
      if (body === null) { emit(`cat: no such page: ${p}`); return 1; }
      for (const l of body.split('\n')) emit(l.replace(/\r$/, ''));
      return 0;
    }
    case 'page-delete': {
      const r = deletePage(root, pageIdArg(args.id));
      emit(r.msg);
      return r.ok ? 0 : 1;
    }
    case 'skills-list': {
      emit('SKILLS_STATE ' + JSON.stringify(localSkillsState(t, assets)));
      return 0;
    }
    case 'cadence-list': {
      emit('__SKILLS__');
      emit('__CADENCE__'); emit('{}');
      emit('__RUNS__'); emit(rd(path.join(root, 'cockpit', 'skill-runs.json')) || '{}');
      emit('__AUTOUPDATE__'); emit('{}');
      emit('__HEARTBEAT__'); emit('{}');
      emit('__ALLSKILLS__'); emit('SKILLS_STATE ' + JSON.stringify(localSkillsState(t, assets)));
      emit('__PLANJSON__'); emit('{}');
      return 0;
    }
    case 'skill-read': {
      const id = idArg(args.id);
      const d = path.join(root, '.claude', 'skills', id);
      if (!existsSync(path.join(d, 'SKILL.md'))) { emit(`ERROR: /${id} is not installed in this brain.`); return 1; }
      emit(`__SKILL__ ${b64(path.join(d, 'SKILL.md'))}`);
      if (existsSync(path.join(d, 'skill.yaml'))) emit(`__META__ ${b64(path.join(d, 'skill.yaml'))}`);
      if (existsSync(path.join(d, '.origin.json'))) emit(`__ORIGIN__ ${b64(path.join(d, '.origin.json'))}`);
      return 0;
    }
    case 'member-console-state': {
      emit('CONSOLE_STATE ' + JSON.stringify(consoleState(t)));
      return 0;
    }
    case 'open-folder': {
      // The box answers the NAME of the symlink inside /state. A folder is
      // already the thing to open: answer its basename, so the Help page's
      // reader keeps its shape, and the page shows the full path from /targets.
      emit(path.basename(root));
      return 0;
    }
    case 'box-version': {
      emit(JSON.stringify({ host: hostname(), commit: '', up: '', local: true }));
      return 0;
    }
    case 'box-rename': {
      const name = nameArg(args.name);
      setBrainName(root, name);
      emit(`OK: renamed to ${name}`);
      return 0;
    }
    default:
      emitErr(`ERROR: ${String(verb).slice(0, 60)} is not a local verb`);
      return 1;
  }
}
