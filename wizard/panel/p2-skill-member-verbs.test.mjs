// p2-skill-member-verbs.test.mjs: panel iteration 2 (2026-08-23), the
// box-side verbs for skills and members: R11 skill-remove, skill-read, R12 +
// R26 catalog-install, F3 catalog-requests residue, R6 member-forget, R25
// skill-scrub in catalog-policy-write, R23 POST /rock-tie-downgrade.
//   node --test wizard/panel/p2-skill-member-verbs.test.mjs
//
// Shell verbs are run for real against a fixture tree (a fake /state and a
// fake /app/engine/skills via env + path rewriting), so the contract pinned
// here is what a member would see, not a regex over a command string.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MEMBER_VERBS, ORIGIN_HEADER_JS, createPanelServer } from './panel-server.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const SRC = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');
const HTML_PATH = new URL('./member.html', import.meta.url).pathname;

// A fake box: the verb's absolute paths are rewritten onto a temp root, and
// /app/engine/skills is a directory holding the engine's ids.
function box() {
  const root = tmpDir('p2box-');
  mkdirSync(path.join(root, 'state', '.claude', 'skills'), { recursive: true });
  mkdirSync(path.join(root, 'state', 'cockpit'), { recursive: true });
  mkdirSync(path.join(root, 'app', 'engine', 'skills'), { recursive: true });
  writeFileSync(path.join(root, 'app', 'engine', 'skills', 'daily.md'), '# daily\n');
  const skill = (id, files, origin) => {
    const d = path.join(root, 'state', '.claude', 'skills', id);
    mkdirSync(d, { recursive: true });
    for (const [f, body] of Object.entries(files)) writeFileSync(path.join(d, f), body);
    if (origin) writeFileSync(path.join(d, '.origin.json'), JSON.stringify(origin) + '\n');
  };
  const offer = (id, files) => {
    const d = path.join(root, 'state', 'org-inbox', 'offers', id);
    for (const [f, body] of Object.entries(files)) { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); writeFileSync(path.join(d, f), body); }
  };
  // /state is rewritten wherever it ends a word (a slash, a quote, a `;`), so
  // the brain-root resolver's bare `BR=/state;` fallback lands on the fixture
  // too. `env` lets a test stand up a rock: BRAIN_ROOT=<root>/state/brain.
  const run = (cmd, stdin, env) => {
    const rewritten = cmd.replace(/\/state(?=[\/;"' ])/g, root + '/state').split('/app/engine/').join(root + '/app/engine/');
    let out = '', code = 0;
    try { out = execFileSync('bash', ['-c', rewritten], { encoding: 'utf8', input: stdin || '', cwd: root, env: { ...process.env, BRAIN_ROOT: '', ...(env || {}) } }); } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); code = e.status; }
    return { out, code };
  };
  return { root, skill, offer, run, state: path.join(root, 'state'), done: () => rmSync(root, { recursive: true, force: true }) };
}

const cadence = (b) => JSON.parse(readFileSync(path.join(b.state, 'cockpit', 'cadence.json'), 'utf8'));

// ---- R11 skill-remove -----------------------------------------------------------

test('skill-remove refuses an engine skill by name, even when a dir for it exists', () => {
  const b = box();
  try {
    b.skill('daily', { 'SKILL.md': '# daily\n' });
    const r = b.run(MEMBER_VERBS['skill-remove'].build({ id: 'daily' }).command);
    assert.equal(r.code, 1);
    assert.match(r.out, /ERROR: \/daily is a built-in skill and cannot be removed/);
    assert.ok(existsSync(path.join(b.state, '.claude', 'skills', 'daily')), 'untouched');
  } finally { b.done(); }
});


test('skill-remove: a self-authored skill goes too, and is told it was the only copy', () => {
  const b = box();
  try {
    b.skill('my-notes', { 'SKILL.md': '# mine\n' });
    const r = b.run(MEMBER_VERBS['skill-remove'].build({ id: 'my-notes' }).command);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.out.trim(), 'OK: /my-notes removed. That was the only copy.');
    assert.ok(!existsSync(path.join(b.state, '.claude', 'skills', 'my-notes')));
    assert.ok(!existsSync(path.join(b.state, 'cockpit', 'cadence.json')), 'no cadence file is invented');
  } finally { b.done(); }
});

test('skill-remove: nothing installed says so; ids are validated first', () => {
  const b = box();
  try {
    const r = b.run(MEMBER_VERBS['skill-remove'].build({ id: 'ghost' }).command);
    assert.equal(r.code, 1);
    assert.match(r.out, /is not installed on this mineral/);
    for (const evil of ['../up', 'X Y', '', 'a'.repeat(64), 'semi;colon']) {
      assert.throws(() => MEMBER_VERBS['skill-remove'].build({ id: evil }), /kebab-case/);
    }
    assert.equal(MEMBER_VERBS['skill-remove'].mutating, true);
  } finally { b.done(); }
});

// ---- skill-read -----------------------------------------------------------------

test('skill-read returns SKILL.md, skill.yaml and .origin.json as marked base64 lines', () => {
  const b = box();
  try {
    b.skill('deep-research', { 'SKILL.md': '# Deep\nline two\n', 'skill.yaml': 'version: 2\n' }, { rock: 'acme', version: 2, installed: '2026-08-01' });
    b.skill('daily', { 'SKILL.md': '# daily\n' });
    const r = b.run(MEMBER_VERBS['skill-read'].build({ id: 'deep-research' }).command);
    assert.equal(r.code, 0, r.out);
    const lines = r.out.trim().split('\n');
    const part = (tag) => Buffer.from(lines.find((l) => l.startsWith(tag + ' ')).slice(tag.length + 1), 'base64').toString('utf8');
    assert.equal(part('__SKILL__'), '# Deep\nline two\n');
    assert.equal(part('__META__'), 'version: 2\n');
    assert.deepEqual(JSON.parse(part('__ORIGIN__')), { rock: 'acme', version: 2, installed: '2026-08-01' });
    // engine skill: just the one line, exit 0
    const e = b.run(MEMBER_VERBS['skill-read'].build({ id: 'daily' }).command);
    assert.equal(e.code, 0, e.out);
    assert.deepEqual(e.out.trim().split('\n').map((l) => l.split(' ')[0]), ['__SKILL__']);
    const g = b.run(MEMBER_VERBS['skill-read'].build({ id: 'ghost' }).command);
    assert.equal(g.code, 1);
    assert.match(g.out, /is not installed on this mineral/);
    assert.throws(() => MEMBER_VERBS['skill-read'].build({ id: '../x' }), /kebab-case/);
    assert.ok(!MEMBER_VERBS['skill-read'].mutating, 'read-only');
  } finally { b.done(); }
});

// ---- R12 + R26 catalog-install ----------------------------------------------------

const OFFER = { 'SKILL.md': '---\ntitle: Deep research\ncategory: briefing\n---\n# Deep research\n', 'skill.yaml': 'title: Deep research\nversion: 3\n', 'context/a.md': 'ref\n' };





// ---- F3 catalog-requests residue ----------------------------------------------------


// ---- R6 member-forget ----------------------------------------------------------------

function rockBrain() {
  const root = tmpDir('p2rock-');
  const brain = path.join(root, 'brain');
  mkdirSync(path.join(brain, 'registry', 'members'), { recursive: true });
  writeFileSync(path.join(brain, 'org-policy.yaml'), 'org:\n  name: "acme"\n');
  // a stand-in index builder: the real one lives in brain-template
  writeFileSync(path.join(brain, 'registry', 'build-index.mjs'),
    'import { readdirSync, writeFileSync } from "node:fs"; const here = new URL(".", import.meta.url).pathname;'
    + 'const members = readdirSync(here + "members").filter((f) => f.endsWith(".yaml") && !f.startsWith("_")).map((f) => f.replace(/\\.yaml$/, ""));'
    + 'writeFileSync(here + "index.json", JSON.stringify({ members }) + "\\n");\n');
  const row = (slug, status) => writeFileSync(path.join(brain, 'registry', 'members', slug + '.yaml'), `slug: "${slug}"\nstatus: "${status}"\n`);
  const git = (args) => execFileSync('git', args, { cwd: brain, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git(['init', '-q']);
  const run = (cmd) => {
    let out = '', code = 0;
    try { out = execFileSync('bash', ['-c', cmd], { encoding: 'utf8', cwd: brain, env: { ...process.env, BRAIN_ROOT: brain } }); } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); code = e.status; }
    return { out, code };
  };
  return { brain, row, git, run, done: () => rmSync(root, { recursive: true, force: true }) };
}



// ---- R25 skill-scrub in catalog-policy-write ------------------------------------------



// ---- the one verb table ------------------------------------------------------------

test('the org-face wall is RETIRED (2026-09-01) and so is the catalogue dozen (2026-09-09): one served table', () => {
  // SELF_VERBS was the list that carried member verbs across the org wall so
  // a rock could act on itself. There is no wall and no org face, and since
  // the Catalogue retired there is no CATALOGUE_VERBS either: every mineral
  // serves MEMBER_VERBS, and the skills verbs live there.
  assert.ok(!SRC.includes('SELF_VERBS'), 'the wall-crossing list is gone');
  assert.ok(!SRC.includes('CATALOGUE_VERBS'), 'the catalogue dozen is gone');
  assert.match(SRC, /const verbs = MEMBER_VERBS;/, 'the served table is the member table, nothing merged in');
  for (const v of ['skill-remove', 'skill-read', 'skills-list']) {
    assert.ok(MEMBER_VERBS[v], v + ' is a member verb, served to every mineral');
  }
});

// ---- R23 POST /rock-tie-downgrade ----------------------------------------------------

const listen = (opts) => new Promise((resolve) => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlPath: HTML_PATH, ...opts });
  s.on('listening', () => resolve(s));
});
test('R23 is RETIRED (2026-09-01): the tie-downgrade route and its directory legs stay gone', async () => {
  // Three tests stood here, driving POST /rock-tie-downgrade end to end: the
  // signed ask to the directory worker, the cached-edge flip, the box-side
  // unanchor and the ties rewrite. The worker is deleted and ties with it;
  // there is no anchor left to downgrade, because no mineral hosts another.
  // The live pin is the strongest one available: a real server answers 404,
  // and the source carries neither the route nor the edge machinery.
  const boxCmds = [];
  const s = await listen({
    bridge: {
      targets: () => [{ host: 'pebble-four-box', kind: 'member', org: 'pebble-four' }],
      stream: (h, c, o = {}) => { boxCmds.push(c); const p = new EventEmitter(); p.kill = () => {}; setImmediate(() => p.emit('close', 0)); return p; },
      tty: () => {},
    },
  });
  const base = `http://127.0.0.1:${s.address().port}`;
  try {
    for (const route of ['/rock-tie-downgrade', '/rock-mine/refresh', '/rock-leave', '/handover-ask', '/transfer-consent']) {
      const r = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 404, `${route} answers 404`);
    }
    assert.deepEqual(boxCmds, [], 'and nothing was streamed at the box on the way');
  } finally { s.close(); }
  assert.ok(!SRC.includes("'/rock-tie-downgrade'"), 'the route is out of the source');
  assert.ok(!SRC.includes('refreshCommunityMine'), 'the cached-edge machinery went with it');
  assert.ok(!SRC.includes('syncTiesToBox'), 'and the box-side ties writer');
});

// ---- the skills dir follows the brain root (live finding 2026-08-23) ---------------------
// A non-promoted rock keeps its skills at /state/brain/.claude/skills; every
// verb used to hardcode /state and the rock face showed nothing real.
test('skill-read and skill-remove find a rock skill under the brain root', () => {
  const b = box();
  try {
    const brain = path.join(b.state, 'brain');
    const d = path.join(brain, '.claude', 'skills', 'write-skill');
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'SKILL.md'), '# write a skill\n');
    const env = { BRAIN_ROOT: brain };
    let r = b.run(MEMBER_VERBS['skill-read'].build({ id: 'write-skill' }).command, '', env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^__SKILL__ /m);
    r = b.run(MEMBER_VERBS['skill-remove'].build({ id: 'write-skill' }).command, '', env);
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(d), 'removed from the brain root, not from /state');
    // and without a brain dir the same verb reads /state, as a pebble does
    rmSync(brain, { recursive: true, force: true });
    b.skill('trip', { 'SKILL.md': '# trip\n' });
    r = b.run(MEMBER_VERBS['skill-read'].build({ id: 'trip' }).command);
    assert.equal(r.code, 0, r.out);
  } finally { b.done(); }
});
