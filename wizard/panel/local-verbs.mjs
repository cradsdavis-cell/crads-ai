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
import { spawn } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { listSkills } from '../../engine/appshell/skills-list.mjs';
import { deletePage } from '../../engine/appshell/page-delete.mjs';
import { readClaudeCredential } from '../../engine/lib/claude-credential.mjs';
import { refreshLocalBrain, seedPages, setBrainName } from './local-scaffold.mjs';

export const LOCAL_MARK = '__local__ ';

// folders refreshed this run (refreshLocalBrain); exported for tests
export const REFRESHED = new Set();

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

// A connection's name is its key in .mcp.json and what /mcp lists: kebab-case.
const mcpNameArg = (v) => { const n = String(v ?? ''); if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(n)) bad('a connection name is lower-case letters, digits and dashes'); return n; };
// Remote servers only, over https: a local stdio server is a command line,
// and a command line from a web page is not something this app will write.
const mcpUrlArg = (v) => {
  const u = String(v ?? '').trim();
  let ok = false;
  try { const x = new URL(u); ok = x.protocol === 'https:' && !!x.hostname && !x.username && !x.password; } catch { ok = false; }
  if (!ok || u.length > 300) bad('the address must be a full https:// address for a remote MCP server');
  return u;
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

  // ---- LOCAL-ONLY (2026-09-18): things a folder can do that a box does
  // differently. Connections on this computer are Claude Code's own: the app
  // writes the folder's .mcp.json and Claude Code does the sign-in in the
  // person's browser, so no token ever passes through the app. The terminal
  // is the person's own, opened in the folder. None of these exist on the
  // member table; LOCAL_ONLY_VERBS names them so the subset test stays exact.
  'local-mcp-list': { build: () => mark('local-mcp-list') },
  'local-mcp-add': { mutating: true, build: (a = {}) => mark('local-mcp-add', { name: mcpNameArg(a.name), url: mcpUrlArg(a.url) }) },
  'local-mcp-remove': { mutating: true, build: (a = {}) => mark('local-mcp-remove', { name: mcpNameArg(a.name) }) },
  'local-terminal': { build: (a = {}) => mark('local-terminal', { claude: a.claude ? 1 : 0 }) },
};

export const LOCAL_ONLY_VERBS = ['local-mcp-list', 'local-mcp-add', 'local-mcp-remove', 'local-terminal'];

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

// Claude Code keeps each project's sessions under ~/.claude/projects/<dir>,
// where <dir> is the project path with every non-alphanumeric character
// turned into '-' (/home/you/x -> -home-you-x, C:\\Users\\you\\x ->
// C--Users-you-x). Its presence is the one fact on disk that says "this folder
// has been opened in Claude Code". Matched case-insensitively: Windows paths are.
export function claudeProjectDirName(p) { return String(p).replace(/[^a-zA-Z0-9]/g, '-'); }
export function claudeHasOpened(box, home = homedir()) {
  const want = claudeProjectDirName(path.resolve(box)).toLowerCase();
  try { return readdirSync(path.join(home, '.claude', 'projects')).some((n) => n.toLowerCase() === want); } catch { return false; }
}

// What the Health card can honestly check on a folder: that the pieces the
// assistant needs are there. Box health is the kernel's own verdict; a folder
// has no kernel, so "All good" here means exactly "the folder is intact".
export function localHealthIssues(box, { skillsInstalled = 0, onb = null } = {}) {
  const issues = [];
  if (!existsSync(path.join(box, 'CLAUDE.md'))) issues.push('CLAUDE.md is missing');
  if (!existsSync(path.join(box, 'wiki'))) issues.push('the wiki folder is missing');
  if (!skillsInstalled) issues.push('no skills are installed');
  if (!onb) issues.push('onboarding-state.json is missing or unreadable');
  return issues;
}

// A trimmed, in-process port of engine/cockpit/box-cockpit.mjs for a folder:
// onboarding progress, the brain graph, skills installed, the assistant's
// name. No Telegram, cadence or MCP rows (they need a server, and the page
// hides those surfaces on this face); no Claude sign-in row either, because
// the folder has no sign-in of its own: Claude Code on the member's computer
// is the sign-in, and a row saying "not signed in" would be false.
export function localDashboardData(t, { home = homedir() } = {}) {
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
  // "Has this folder been opened in Claude Code?" The Overview's first rung
  // used to answer null (unknown) until onboarding FINISHED, which the page
  // renders as "Still reading your mineral..." forever. Any of these is proof:
  // Claude Code's own project record, an answer the interview recorded, or a
  // page the assistant wrote.
  const answered = phase !== 'interview' || steps.some((m) => m.raw > 0 || m.status === 'covered' || m.status === 'done');
  const claudeOpened = claudeHasOpened(box, home) || answered || realPages > 0;
  const issues = localHealthIssues(box, { skillsInstalled, onb });
  return {
    // the person's own name once the interview has it; never the folder's
    // name, which read as a second, lower-case name for the assistant
    pebble: yget(profile, 'user_short') || yget(profile, 'user_name') || '',
    assistant: name,
    business: (profile.match(/business:[\s\S]*?customers:\s*"([^"]+)"/) || [])[1] || null,
    tier: 'pebble', hosting: 'local', local: true, path: box,
    provider: null, generated_at: new Date().toISOString(),
    // "3-self" is a file name; the card reads "onboarding · self"
    stage: phase === 'done' ? 'live' : `onboarding · ${String(current || 'getting started').replace(/^\d+-/, '').replace(/-/g, ' ')}`, phase,
    onboarding: { phase, covered, total: steps.length || 8, current, modules: steps },
    brain: { pages: realPages, skeleton: pages.length - realPages, people: pages.filter((p) => p.folder === 'people').length, root: wiki, root_missing: !existsSync(wiki) },
    skills: { installed: skillsInstalled },
    health: issues.length ? `degraded: ${issues.join('; ')}` : (phase === 'done' ? 'active' : 'onboarding'),
    claude_opened: claudeOpened,
    // is the claude command line installed? Decides whether "Open it in
    // Claude Code" can open it in one click or has to point at Help
    claude_cli: !!findClaude({ home }),
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
export async function runLocalVerb(t, verb, args = {}, { emit, emitErr = emit, assets = null, launcher = null } = {}) {
  const root = path.resolve(t.path);
  if (!existsSync(root)) { emitErr(`ERROR: the brain folder is missing: ${root}`); return 1; }
  switch (verb) {
    case 'dashboard-data': {
      // Once per app run per folder: bring an existing brain up to this
      // build's skills, CLAUDE.md notes and onboarding seed (a box gets the
      // same from box-up.sh on every boot). Best-effort: a refresh that fails
      // must never cost the Overview its answer.
      if (assets && !REFRESHED.has(root)) {
        REFRESHED.add(root);
        try { await refreshLocalBrain(root, assets); } catch { /* the page still gets its data */ }
      }
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
    case 'local-mcp-list': {
      emit('LOCAL_MCP ' + JSON.stringify(localMcpState(root)));
      return 0;
    }
    case 'local-mcp-add': {
      const r = localMcpAdd(root, mcpNameArg(args.name), mcpUrlArg(args.url));
      emit(r.ok ? `OK: ${r.msg}` : `ERROR: ${r.msg}`);
      return r.ok ? 0 : 1;
    }
    case 'local-mcp-remove': {
      const r = localMcpRemove(root, mcpNameArg(args.name));
      emit(r.ok ? `OK: ${r.msg}` : `ERROR: ${r.msg}`);
      return r.ok ? 0 : 1;
    }
    case 'local-terminal': {
      const claudePath = findClaude();
      const plan = terminalLaunch({ dir: root, claudePath, runClaude: !!args.claude });
      if (!plan) { emit('ERROR: no terminal program was found on this computer'); return 1; }
      try {
        const child = (launcher || spawn)(plan.exe, plan.args, { cwd: root, detached: true, stdio: 'ignore', windowsHide: true });
        if (child && child.on) child.on('error', () => { /* reported below only when spawn throws synchronously */ });
        if (child && child.unref) child.unref();
      } catch (e) { emit(`ERROR: could not open a terminal: ${String(e && e.message || e).slice(0, 160)}`); return 1; }
      emit('LOCAL_TERMINAL ' + JSON.stringify({ opened: true, claude: !!claudePath, program: plan.label }));
      return 0;
    }
    default:
      emitErr(`ERROR: ${String(verb).slice(0, 60)} is not a local verb`);
      return 1;
  }
}

// ---------------------------------------------------------------- connections
// The folder's own .mcp.json (Claude Code's project scope) plus the approval
// Claude Code would otherwise ask for on first open. The approval goes in
// .claude/settings.local.json, the settings file that is never committed:
// Claude Code honours it once the person trusts the folder, and a committed
// copy would be ignored (docs: a repo cannot approve its own servers). Both
// files are in the brain's .gitignore (.mcp.json, .claude/), so connections
// never ride a GitHub backup. A file we cannot parse is left alone: this
// code refuses rather than clobber something the person wrote by hand.
const mcpFile = (root) => path.join(root, '.mcp.json');
const settingsFile = (root) => path.join(root, '.claude', 'settings.local.json');
function readJsonOr(p, empty) {
  if (!existsSync(p)) return { ok: true, value: empty };
  try { const v = JSON.parse(readFileSync(p, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? { ok: true, value: v } : { ok: false }; } catch { return { ok: false }; }
}
export function localMcpState(root) {
  const m = readJsonOr(mcpFile(root), {});
  const st = readJsonOr(settingsFile(root), {});
  const servers = m.ok ? Object.entries(m.value.mcpServers || {}).map(([name, d]) => ({
    name, type: (d && d.type) || (d && d.command ? 'stdio' : 'http'), url: (d && d.url) || '', command: !!(d && d.command),
  })) : [];
  const approved = st.ok && Array.isArray(st.value.enabledMcpjsonServers) ? st.value.enabledMcpjsonServers.map(String) : [];
  return { ok: m.ok, unreadable: m.ok ? '' : '.mcp.json', servers, approved, all_approved: !!(st.ok && st.value.enableAllProjectMcpServers) };
}
export function localMcpAdd(root, name, url) {
  const m = readJsonOr(mcpFile(root), {});
  if (!m.ok) return { ok: false, msg: '.mcp.json in this folder is not valid JSON, so nothing was changed. Fix or remove it, then try again.' };
  const cfg = m.value;
  cfg.mcpServers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
  const cur = cfg.mcpServers[name];
  if (cur && (cur.url !== url)) return { ok: false, msg: `a connection called ${name} is already set up with a different address. Remove it first.` };
  cfg.mcpServers[name] = { type: /\/sse\/?$/i.test(new URL(url).pathname) ? 'sse' : 'http', url };
  writeFileSync(mcpFile(root), JSON.stringify(cfg, null, 2) + '\n');
  const st = readJsonOr(settingsFile(root), {});
  let approved = false;
  if (st.ok) {
    const list = Array.isArray(st.value.enabledMcpjsonServers) ? st.value.enabledMcpjsonServers.map(String) : [];
    if (!list.includes(name)) list.push(name);
    st.value.enabledMcpjsonServers = list;
    mkdirSync(path.dirname(settingsFile(root)), { recursive: true });
    writeFileSync(settingsFile(root), JSON.stringify(st.value, null, 2) + '\n');
    approved = true;
  }
  return { ok: true, approved, msg: `${name} added${approved ? '' : ' (Claude Code will ask you to approve it)'}` };
}
export function localMcpRemove(root, name) {
  const m = readJsonOr(mcpFile(root), {});
  if (!m.ok) return { ok: false, msg: '.mcp.json in this folder is not valid JSON, so nothing was changed.' };
  const had = !!(m.value.mcpServers && m.value.mcpServers[name]);
  if (had) { delete m.value.mcpServers[name]; writeFileSync(mcpFile(root), JSON.stringify(m.value, null, 2) + '\n'); }
  const st = readJsonOr(settingsFile(root), {});
  if (st.ok && Array.isArray(st.value.enabledMcpjsonServers) && st.value.enabledMcpjsonServers.includes(name)) {
    st.value.enabledMcpjsonServers = st.value.enabledMcpjsonServers.filter((x) => x !== name);
    writeFileSync(settingsFile(root), JSON.stringify(st.value, null, 2) + '\n');
  }
  return { ok: true, msg: had ? `${name} removed` : `${name} was not set up here` };
}

// ---------------------------------------------------------------- terminal
// Where the claude command line lives, if it is installed. A GUI app often
// runs with a thinner PATH than a login shell (macOS especially), so the
// native installer's and npm's usual homes are checked by name too. Absent,
// the terminal still opens in the folder and says how to install it.
export function findClaude({ platform = process.platform, env = process.env, home = homedir(), exists = existsSync } = {}) {
  const win = platform === 'win32';
  const sep = win ? ';' : ':';
  const names = win ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const join = win ? path.win32.join : path.posix.join;
  const dirs = String(env.PATH || env.Path || '').split(sep).filter(Boolean);
  const extra = win
    ? [join(home, '.local', 'bin'), env.APPDATA ? join(env.APPDATA, 'npm') : '']
    : [join(home, '.local', 'bin'), join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const d of [...dirs, ...extra].filter(Boolean)) for (const n of names) { const p = join(d, n); if (exists(p)) return p; }
  return null;
}

const INSTALL_HINT = 'Claude Code is not installed on this computer yet. Install it from https://code.claude.com/docs/en/setup (or use the Claude desktop app: see Help in Crads-AI).';
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const osaq = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/**
 * How to open a terminal window in `dir` on this platform, optionally with
 * Claude Code running in it. Pure: returns { exe, args, label } or null, and
 * the caller spawns it detached. Windows goes through PowerShell's
 * -EncodedCommand so no path (spaces, quotes, &) ever meets cmd.exe's quoting
 * rules on the way in; the window itself is cmd.exe, which stays open (/K).
 */
export function terminalLaunch({ dir, claudePath = null, runClaude = true, platform = process.platform, has = (exe) => !!findOnPath(exe) } = {}) {
  if (platform === 'win32') {
    // cmd groups `a && b & c || d` as (a && b) & (c || d): the hint prints only
  // when claude is missing, never because a session ended with an error.
  const inner = runClaude
      ? (claudePath ? `, '/K', ${psq('"' + claudePath + '"')}` : `, '/K', ${psq('where claude >nul 2>nul && claude & where claude >nul 2>nul || echo ' + INSTALL_HINT)}`)
      : '';
    const ps = `Start-Process -FilePath 'cmd.exe' -WorkingDirectory ${psq(dir)}` + (inner ? ` -ArgumentList ${inner.slice(2)}` : '');
    return { exe: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], label: 'Command Prompt', script: ps };
  }
  // A login shell may find claude where this app could not (macOS GUI apps
  // get a thin PATH), so an undetected claude is still tried by name.
  const sh = !runClaude ? `cd ${shq(dir)}`
    : claudePath ? `cd ${shq(dir)} && ${shq(claudePath)}`
    : `cd ${shq(dir)} && if command -v claude >/dev/null 2>&1; then claude; else echo ${shq(INSTALL_HINT)}; fi`;
  if (platform === 'darwin') {
    return { exe: 'osascript', args: ['-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script ${osaq(sh)}`, '-e', 'end tell'], label: 'Terminal', script: sh };
  }
  const keep = `${sh}; exec bash -l`;
  for (const [exe, pre] of [['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--']], ['konsole', ['-e']], ['xfce4-terminal', ['-x']], ['xterm', ['-e']]]) {
    if (has(exe)) return { exe, args: [...pre, 'bash', '-lc', keep], label: exe, script: keep };
  }
  return null;
}
function findOnPath(exe) {
  for (const d of String(process.env.PATH || '').split(':').filter(Boolean)) { const p = path.join(d, exe); if (existsSync(p)) return p; }
  return null;
}
