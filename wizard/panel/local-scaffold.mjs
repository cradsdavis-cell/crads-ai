// local-scaffold.mjs: bring a brain FOLDER to life on this computer (the
// no-server face, 2026-09-11). A JS port of the first-run scaffold in
// engine/box-up.sh (lines 14-20, 64, 136-158, 166), because that script is
// bash and runs inside a box image; a member's laptop has neither.
//
// Idempotent, like the original: only what is MISSING is created, so running
// it on an existing brain touches nothing of the person's.
//
// Where the engine's files come from is the one thing this module cannot
// assume. In a dev checkout they are on disk beside this file; in the packaged
// exe there is no disk tree at all, only node:sea assets keyed by the same
// repo-relative paths (LOCAL_ASSET_FILES below; .github/workflows/wizard-app.yml
// carries the map). loadEngineAssets() reads whichever exists into one bag
// and everything below takes the bag, never a path.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncSkills } from '../../engine/kernel/lib/skills.mjs';
import { initialLayersState, isUntouchedLegacySeed } from '../../engine/onboarding/layers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

// The engine skills a local brain is born with: every engine/skills/*.md.
// Enumerated by name because the packaged exe cannot list a directory of
// assets; local-assets.test.mjs pins this list against the directory so a
// new skill cannot be forgotten.
export const LOCAL_SKILL_IDS = ['capture', 'connect', 'daily', 'dashboard', 'explain', 'followup', 'inbox', 'onboard', 'plan-week', 'weekly', 'write-page'];
export const LOCAL_TEMPLATE_PAGES = ['ask-me.html', 'my-people.html', 'welcome.html'];
export const LOCAL_ASSET_FILES = [
  'engine/onboarding/interview-spec.yaml',
  'config/profile.schema.yaml',
  'engine/lib/brain-ignore.txt',
  'engine/lib/local-claude-md.md',
  'engine/appshell/templates/pages.json',
  'engine/appshell/templates/cards.json',
  ...LOCAL_TEMPLATE_PAGES.map((f) => `engine/appshell/templates/pages/${f}`),
  ...LOCAL_SKILL_IDS.map((id) => `engine/skills/${id}.md`),
];

/**
 * @param {object} o
 *   read(key, fsPath) -> Buffer|string   app.mjs's asset() (SEA first, disk second).
 *                                        Default: the disk under REPO_ROOT.
 */
export function loadEngineAssets({ read, root = REPO_ROOT } = {}) {
  const get = (key) => {
    const fsPath = path.join(root, key);
    const v = read ? read(key, fsPath) : readFileSync(fsPath);
    return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
  };
  const skills = {};
  for (const id of LOCAL_SKILL_IDS) { try { skills[id] = get(`engine/skills/${id}.md`); } catch { /* a skill missing from the bag is a test's business */ } }
  const pages = {};
  for (const f of LOCAL_TEMPLATE_PAGES) { try { pages[f] = get(`engine/appshell/templates/pages/${f}`); } catch { /* same */ } }
  const opt = (key) => { try { return get(key); } catch { return ''; } };
  // a dev checkout can hand syncSkills the real directory, packaged cannot
  const skillsDir = !read && existsSync(path.join(root, 'engine', 'skills')) ? path.join(root, 'engine', 'skills') : '';
  return {
    skills, skillsDir,
    interviewSpec: opt('engine/onboarding/interview-spec.yaml'),
    profileSchema: opt('config/profile.schema.yaml'),
    brainIgnore: opt('engine/lib/brain-ignore.txt'),
    claudeMd: opt('engine/lib/local-claude-md.md'),
    templates: { pagesJson: opt('engine/appshell/templates/pages.json'), cardsJson: opt('engine/appshell/templates/cards.json'), pages },
  };
}

// ---------------------------------------------------------------- pieces
const rd = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const writeIfMissing = (p, text) => { if (existsSync(p)) return false; mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text); return true; };

/**
 * engine/onboarding/init-state.mjs, as a function: the 8 layers /onboard
 * reads and writes (layers.mjs). The argument is ignored and kept only so an
 * older caller passing the spec text still works; the 11-module spec stopped
 * deciding the seed on 2026-09-18.
 */
export function initialOnboardingState() {
  return initialLayersState({ scope: 'person' });
}

/** engine/box/name-set.mjs, as a function: box-name + profile.yaml, both. */
export function setBrainName(box, rawName) {
  const name = String(rawName || '').replace(/"/g, '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60);
  if (!name) return false;
  writeFileSync(path.join(box, 'box-name'), name);
  const p = path.join(box, 'profile.yaml');
  let t = rd(p) || '';
  const line = `assistant_name: "${name}"`;
  if (/assistant_name:/.test(t)) t = t.replace(/assistant_name:[^\n]*/, line);
  else if (/^identity:/m.test(t)) t = t.replace(/^identity:.*$/m, (m) => m + '\n  ' + line);
  else t += (t && !t.endsWith('\n') ? '\n' : '') + 'identity:\n  ' + line + '\n';
  writeFileSync(p, t);
  return true;
}

/** engine/appshell/seed-pages.mjs, as a function over the assets bag. Never overwrites. */
export function seedPages(box, assets) {
  const tpl = (assets && assets.templates) || {};
  const dash = path.join(box, 'dashboard');
  mkdirSync(path.join(dash, 'pages'), { recursive: true });
  let tomb = new Set();
  try { const t = JSON.parse(readFileSync(path.join(dash, 'pages.deleted.json'), 'utf8')); tomb = new Set(Array.isArray(t) ? t.map(String) : []); } catch { tomb = new Set(); }
  let created = 0;
  const manifestSeeded = tpl.pagesJson ? writeIfMissing(path.join(dash, 'pages.json'), tpl.pagesJson) : false;
  if (manifestSeeded) {
    created++;
    try {
      const mf = path.join(dash, 'pages.json');
      const fresh = JSON.parse(readFileSync(mf, 'utf8'));
      if (Array.isArray(fresh.pages)) { fresh.pages = fresh.pages.map((p) => (p && p.id ? { ...p, seed: true } : p)); writeFileSync(mf, JSON.stringify(fresh, null, 2) + '\n'); }
    } catch { /* not ours to fix */ }
  }
  if (tpl.cardsJson && writeIfMissing(path.join(dash, 'cards.json'), tpl.cardsJson)) created++;
  const newPageFiles = [];
  for (const [f, html] of Object.entries(tpl.pages || {})) {
    if (tomb.has(f.replace(/\.html$/, ''))) continue;
    if (writeIfMissing(path.join(dash, 'pages', f), html)) { created++; newPageFiles.push(f); }
  }
  if (newPageFiles.length && !manifestSeeded) {
    try {
      const tplManifest = JSON.parse(tpl.pagesJson || '{}');
      const mf = path.join(dash, 'pages.json');
      const mine = JSON.parse(readFileSync(mf, 'utf8'));
      if (Array.isArray(mine.pages)) {
        const have = new Set(mine.pages.map((p) => p && p.id));
        let added = 0;
        for (const p of tplManifest.pages || []) {
          if (p && p.id && !have.has(p.id) && newPageFiles.includes(p.id + '.html')) { mine.pages.push({ ...p, seed: true }); added++; }
        }
        if (added) writeFileSync(mf, JSON.stringify(mine, null, 2) + '\n');
      }
    } catch { /* a manifest we cannot parse is the member's business */ }
  }
  let tplVersion = 1;
  try { tplVersion = JSON.parse(tpl.pagesJson || '{}').template_version || 1; } catch { tplVersion = 1; }
  writeFileSync(path.join(dash, '.template-version'), String(tplVersion) + '\n');
  // L2 ownership record: a local brain is the person's own, held on their
  // own disk. Same vocabulary as seed-pages.mjs (owner 'member', anchor
  // 'crads-ai') plus the one fact that is new: where it is hosted.
  if (writeIfMissing(path.join(box, 'ownership.json'), JSON.stringify({
    owner: 'member', managed_by: 'member', machinery_by: 'crads-ai', tier: 'pebble', anchor: 'crads-ai',
    hosting: 'local', holder_email: '', grants: [],
  }, null, 2) + '\n')) created++;
  return created;
}

/** box-up.sh's ignore seeding: APPEND from the never-commit list, never overwrite. */
export function seedGitignore(box, brainIgnore) {
  const p = path.join(box, '.gitignore');
  let text = rd(p) || '';
  const lines = new Set(text.split('\n').map((l) => l.trim()));
  const add = [];
  const pats = String(brainIgnore || '').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  const floor = ['.env', '.env.*', 'secrets/', '*.key', '*.pem', '.ssh/', 'ssh/', '.claude-auth/', '.kernel/', '.mcp.json'];
  for (const pat of (pats.length ? pats : floor)) if (!lines.has(pat)) { add.push(pat); lines.add(pat); }
  if (!/never version these/.test(text)) add.unshift('# credentials + machine state: never version these (the brain repo may be pushed to a remote)');
  if (!add.length) return 0;
  text = text + (text && !text.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n';
  writeFileSync(p, text);
  return add.length;
}

// What sits at a path, in the four words the create route switches on.
export function dirState(p) {
  if (!existsSync(p)) return 'missing';
  let entries;
  try { entries = readdirSync(p); } catch { return 'occupied'; }
  if (!entries.length) return 'empty';
  if (existsSync(path.join(p, 'profile.yaml')) || existsSync(path.join(p, 'wiki'))) return 'brain';
  return 'occupied';
}

const git = (box, args) => spawnSync('git', args, { cwd: box, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * The scaffold. Returns { created: [what was made], git: 'initialised'|'kept'|'unavailable' }.
 * `name` is the assistant's one name (box-up.sh's AIOS_BOX_NAME leg);
 * absent, an existing name is kept and a fresh brain gets none.
 */
export async function scaffoldLocalBrain(box, { name = '', assets, git: wantGit = true } = {}) {
  if (!assets) throw new Error('scaffoldLocalBrain needs the engine assets bag');
  const created = [];
  mkdirSync(box, { recursive: true });
  for (const d of ['wiki/people', 'secrets', '.claude-auth', '.kernel', 'cockpit']) {
    const p = path.join(box, d);
    if (!existsSync(p)) { mkdirSync(p, { recursive: true }); created.push(d + '/'); }
  }
  if (assets.profileSchema && writeIfMissing(path.join(box, 'profile.yaml'), assets.profileSchema)) created.push('profile.yaml');
  const st = initialOnboardingState(assets.interviewSpec);
  if (st && writeIfMissing(path.join(box, 'onboarding-state.json'), JSON.stringify(st, null, 2) + '\n')) created.push('onboarding-state.json');
  if (writeIfMissing(path.join(box, 'wiki', 'priorities.md'), '# Priorities: what matters now\n_(populated by /onboard)_\n')) created.push('wiki/priorities.md');
  if (seedPages(box, assets)) created.push('dashboard/');
  // Born named (box-up.sh's AIOS_BOX_NAME leg): only when the folder has no
  // name yet in EITHER file, so adopting an existing brain never renames it.
  const hadName = (rd(path.join(box, 'box-name')) || '').trim()
    || ((rd(path.join(box, 'profile.yaml')) || '').match(/assistant_name:\s*"([^"\n]+)"/) || [])[1] || '';
  if (name && !hadName) { setBrainName(box, name); created.push('box-name'); }
  const effectiveName = (hadName || name || '').trim().slice(0, 60);
  await installEngineSkills(box, assets);
  if (Object.keys(assets.skills || {}).length || assets.skillsDir) created.push('.claude/skills/');
  if (seedGitignore(box, assets.brainIgnore)) created.push('.gitignore');
  if (assets.claudeMd && writeIfMissing(path.join(box, 'CLAUDE.md'), assets.claudeMd)) created.push('CLAUDE.md');
  else if (assets.claudeMd && ensureEngineNotes(box, assets.claudeMd)) created.push('CLAUDE.md (notes)');
  let gitState = 'skipped';
  if (wantGit) {
    const top = git(box, ['rev-parse', '--show-toplevel']);
    if (top.error) gitState = 'unavailable';
    else if (top.status === 0 && path.resolve(top.stdout.trim()) === path.resolve(box)) gitState = 'kept';
    else {
      const init = git(box, ['init', '-q']);
      if (init.status !== 0) gitState = 'unavailable';
      else {
        git(box, ['add', '-A']);
        git(box, ['-c', 'user.name=Crads-AI', '-c', 'user.email=brain@local', 'commit', '-q', '-m', 'init: brain scaffold']);
        gitState = 'initialised';
      }
    }
  }
  return { created, git: gitState, name: effectiveName };
}

// Skills: the real syncSkills when a directory exists (dev checkout), else the
// same mapping from the bag (packaged). Both write <name>/SKILL.md, and both
// overwrite an engine skill, exactly as box-up.sh's syncSkills does on every
// boot: an engine skill is the app's, a member's own skill is never touched.
export async function installEngineSkills(box, assets) {
  if (assets && assets.skillsDir) return syncSkills(box, assets.skillsDir);
  let n = 0;
  for (const [id, text] of Object.entries((assets && assets.skills) || {})) {
    const d = path.join(box, '.claude', 'skills', id);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'SKILL.md'), text);
    n++;
  }
  return n;
}

// The one block of CLAUDE.md the app owns (engine/lib/local-claude-md.md, between
// the engine-notes markers): the paths and connections notes the shared skills
// need on a folder. CLAUDE.md is otherwise the member's, so this never rewrites
// it wholesale. Block present: replaced with the current one. Block absent (a
// folder made before 2026-09-18): appended. Returns true when it wrote.
const NOTES_RE = /<!-- crads-ai:engine-notes start[\s\S]*?<!-- crads-ai:engine-notes end -->/;
export function ensureEngineNotes(box, claudeMdTemplate) {
  const block = (String(claudeMdTemplate || '').match(NOTES_RE) || [])[0];
  if (!block) return false;
  const p = path.join(box, 'CLAUDE.md');
  const cur = rd(p);
  if (cur === null) { writeFileSync(p, claudeMdTemplate); return true; }
  const next = NOTES_RE.test(cur) ? cur.replace(NOTES_RE, () => block) : cur + (cur.endsWith('\n') ? '\n' : '\n\n') + block + '\n';
  if (next === cur) return false;
  writeFileSync(p, next);
  return true;
}

/**
 * Bring an EXISTING local brain up to what this build of the app ships, once
 * per app run (the caller memoises): engine skills re-synced, the CLAUDE.md
 * notes block current, and an untouched legacy 11-module onboarding seed
 * replaced with the 8 layers. A box gets the same from box-up.sh on every
 * boot; a folder had no equivalent, so a brain kept the skills and notes it
 * was born with forever. Never touches the member's wiki, profile or pages.
 */
export async function refreshLocalBrain(box, assets) {
  const done = [];
  if (!assets || !existsSync(box)) return done;
  if (await installEngineSkills(box, assets)) done.push('skills');
  if (assets.claudeMd && ensureEngineNotes(box, assets.claudeMd)) done.push('CLAUDE.md');
  const sp = path.join(box, 'onboarding-state.json');
  let st = null;
  try { st = JSON.parse(readFileSync(sp, 'utf8')); } catch { st = null; }
  if (isUntouchedLegacySeed(st)) {
    writeFileSync(sp, JSON.stringify(initialLayersState({ scope: 'person' }), null, 2) + '\n');
    done.push('onboarding-state.json');
  }
  return done;
}
