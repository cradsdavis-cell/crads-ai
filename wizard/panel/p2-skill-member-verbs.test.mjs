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
import { MEMBER_VERBS, VERBS, ORIGIN_HEADER_JS, createPanelServer } from './panel-server.mjs';
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

test('skill-remove: a rock-published skill goes, and the words say the rock still offers it', () => {
  const b = box();
  try {
    b.skill('deep-research', { 'SKILL.md': '# x\n' }, { rock: 'acme', version: 2, installed: '2026-08-01' });
    writeFileSync(path.join(b.state, 'cockpit', 'cadence.json'), JSON.stringify({ 'deep-research': { enabled: true, when: 'daily' }, pulse: { enabled: false } }));
    const r = b.run(MEMBER_VERBS['skill-remove'].build({ id: 'deep-research' }).command);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.out.trim(), 'OK: /deep-research removed. Your rock still offers it, so you can add it again any time.');
    assert.ok(!existsSync(path.join(b.state, '.claude', 'skills', 'deep-research')));
    assert.deepEqual(cadence(b), { pulse: { enabled: false } }, 'the cadence entry went with it, the others stayed');
    assert.deepEqual(readdirSync(path.join(b.state, 'cockpit')), ['cadence.json'], 'atomic rewrite leaves no tmp behind');
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

test('catalog-install writes the origin header into SKILL.md frontmatter', () => {
  const b = box();
  try {
    b.offer('deep-research', OFFER);
    writeFileSync(path.join(b.state, 'org-inbox.conf'), 'ORG_GH_OWNER="acme"\n');
    const r = b.run(MEMBER_VERBS['catalog-install'].build({ id: 'deep-research' }).command);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /OK: \/deep-research installed/);
    const md = readFileSync(path.join(b.state, '.claude', 'skills', 'deep-research', 'SKILL.md'), 'utf8');
    const fm = md.split('\n---\n')[0];
    assert.match(fm, /^origin-rock: "acme"$/m);
    assert.match(fm, /^origin-version: 3$/m);
    assert.match(fm, /^installed: \d{4}-\d{2}-\d{2}$/m);
    assert.match(fm, /^note: "Yours to adapt\. Updates arrive as offers from your rock and never overwrite without your OK\."$/m);
    assert.match(fm, /^title: Deep research$/m, 'the original keys survive');
    assert.match(md, /\n---\n# Deep research\n$/, 'body intact');
    assert.ok(!existsSync(path.join(b.state, '.claude', 'skill-backups', 'deep-research.v0')), 'a first install makes no backup');
  } finally { b.done(); }
});

test('catalog-install on an existing install backs the old dir up under skill-backups/<id>.v<old> and keeps first-installed', () => {
  const b = box();
  try {
    b.skill('deep-research', { 'SKILL.md': '---\ntitle: Deep research\norigin-rock: "acme"\norigin-version: 2\ninstalled: 2026-08-01\nnote: "old"\n---\n# edited locally\n' }, { rock: 'acme', version: 2, installed: '2026-08-01' });
    b.offer('deep-research', OFFER);
    writeFileSync(path.join(b.state, 'org-inbox.conf'), 'ORG_GH_OWNER="acme"\n');
    const cmd = MEMBER_VERBS['catalog-install'].build({ id: 'deep-research' }).command;
    let r = b.run(cmd);
    assert.equal(r.code, 0, r.out);
    const bak = path.join(b.state, '.claude', 'skill-backups', 'deep-research.v2');
    assert.ok(existsSync(bak), 'old dir kept under skill-backups');
    assert.match(readFileSync(path.join(bak, 'SKILL.md'), 'utf8'), /# edited locally/);
    const md = readFileSync(path.join(b.state, '.claude', 'skills', 'deep-research', 'SKILL.md'), 'utf8');
    assert.match(md, /^origin-version: 3$/m);
    assert.match(md, /^installed: 2026-08-01$/m, 'first-installed survives the update');
    assert.equal((md.match(/^origin-rock:/gm) || []).length, 1, 'no duplicate keys on re-install');
    assert.match(readFileSync(path.join(b.state, '.claude', 'skills', 'deep-research', '.origin.json'), 'utf8'), /"version": 3/);
    // install again at the same version: the v3 backup replaces, never stacks
    r = b.run(cmd);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(readdirSync(path.join(b.state, '.claude', 'skills')).sort(), ['deep-research'], 'nothing but real skills where Claude Code looks');
    const baks = readdirSync(path.join(b.state, '.claude', 'skill-backups')).sort();
    assert.deepEqual(baks, ['deep-research.v2', 'deep-research.v3']);
    r = b.run(cmd);
    assert.deepEqual(readdirSync(path.join(b.state, '.claude', 'skill-backups')).sort(), baks, 'a same-version backup is replaced');
  } finally { b.done(); }
});

test('catalog-install keeps the two refusals, verbatim, and writes nothing on them', () => {
  const b = box();
  try {
    b.offer('deep-research', OFFER);
    writeFileSync(path.join(b.state, 'org-inbox.conf'), 'ORG_GH_OWNER="acme"\n');
    b.skill('deep-research', { 'SKILL.md': '# mine\n' });
    const cmd = MEMBER_VERBS['catalog-install'].build({ id: 'deep-research' }).command;
    let r = b.run(cmd);
    assert.equal(r.code, 1);
    assert.match(r.out, /already exists on this mineral and is not a rock-published skill; nothing was changed/);
    assert.equal(readFileSync(path.join(b.state, '.claude', 'skills', 'deep-research', 'SKILL.md'), 'utf8'), '# mine\n');
    writeFileSync(path.join(b.state, '.claude', 'skills', 'deep-research', '.origin.json'), '{ "rock": "other", "version": 1, "installed": "2026-07-01" }\n');
    r = b.run(cmd);
    assert.equal(r.code, 1);
    assert.match(r.out, /already installed from a different rock; nothing was changed/);
    assert.ok(!existsSync(path.join(b.state, '.claude', 'skill-backups', 'deep-research.v1')), 'no backup on a refusal');
  } finally { b.done(); }
});

test('the origin header script handles a SKILL.md with no frontmatter', () => {
  const b = box();
  try {
    const p = path.join(b.root, 's.md');
    writeFileSync(p, '# Plain\nbody\n');
    execFileSync('node', ['-e', ORIGIN_HEADER_JS, p, 'acme', '', '2026-08-23']);
    assert.equal(readFileSync(p, 'utf8'), '---\norigin-rock: "acme"\norigin-version: 0\ninstalled: 2026-08-23\nnote: "Yours to adapt. Updates arrive as offers from your rock and never overwrite without your OK."\n---\n# Plain\nbody\n');
  } finally { b.done(); }
});

// ---- F3 catalog-requests residue ----------------------------------------------------

test('F3: nothing reads or reconciles catalog-requests.json any more', () => {
  assert.ok(!/catalog-requests/.test(MEMBER_VERBS['catalog-list'].build().command), 'catalog-list no longer emits __REQUESTS__');
  assert.ok(!/__REQUESTS__/.test(MEMBER_VERBS['catalog-list'].build().command));
  const r = VERBS['catalog-reconcile-run'].build().command;
  assert.match(r, /catalog-reconcile\.mjs/, 'member views still rebuild');
  assert.ok(!/catalog-requests/.test(r), 'the retired request applier is not called');
  const orgSync = readFileSync(new URL('../../engine/box/org-sync.sh', import.meta.url), 'utf8');
  assert.ok(!/REQ="\$BOX\/cockpit\/catalog-requests\.json"/.test(orgSync), 'org-sync no longer prunes the queue');
  // the verb table itself: no verb builds a command that touches the file
  for (const [name, v] of Object.entries({ ...MEMBER_VERBS, ...VERBS })) {
    let cmd = '';
    try { cmd = v.build({}).command; } catch { continue; }
    assert.ok(!/catalog-requests\.json/.test(cmd), `${name} references catalog-requests.json`);
  }
});

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

test('member-forget is rock-only, admin-only, and refuses unless the row has left', () => {
  assert.ok(VERBS['member-forget'] && !MEMBER_VERBS['member-forget']);
  assert.equal(VERBS['member-forget'].adminOnly, true);
  assert.equal(VERBS['member-forget'].mutating, true);
  assert.throws(() => VERBS['member-forget'].build({ slug: '../x' }));
  const w = rockBrain();
  try {
    w.row('jane', 'active');
    w.row('bob', 'left');
    w.git(['add', '.']); w.git(['commit', '-q', '-m', 'seed']);
    let r = w.run(VERBS['member-forget'].build({ slug: 'jane' }).command);
    assert.equal(r.code, 1);
    assert.match(r.out, /ERROR: jane has not ended \(status: active\)/);
    assert.ok(existsSync(path.join(w.brain, 'registry', 'members', 'jane.yaml')), 'untouched');
    r = w.run(VERBS['member-forget'].build({ slug: 'nobody' }).command);
    assert.equal(r.code, 1);
    assert.match(r.out, /there is no member called 'nobody'/);
  } finally { w.done(); }
});

test('member-forget archives the row as registry/archive/<slug>.<date>.yaml and rebuilds the index', () => {
  const w = rockBrain();
  try {
    w.row('jane', 'active');
    w.row('bob', 'left');
    w.git(['add', '.']); w.git(['commit', '-q', '-m', 'seed']);
    const r = w.run(VERBS['member-forget'].build({ slug: 'bob' }).command);
    assert.equal(r.code, 0, r.out);
    const date = new Date().toISOString().slice(0, 10);
    assert.match(r.out, new RegExp(`OK: bob forgotten\\. The row is archived at registry/archive/bob\\.${date}\\.yaml`));
    assert.ok(!existsSync(path.join(w.brain, 'registry', 'members', 'bob.yaml')));
    assert.equal(readFileSync(path.join(w.brain, 'registry', 'archive', `bob.${date}.yaml`), 'utf8'), 'slug: "bob"\nstatus: "left"\n', 'archived, not deleted');
    assert.deepEqual(JSON.parse(readFileSync(path.join(w.brain, 'registry', 'index.json'), 'utf8')), { members: ['jane'] });
    assert.match(w.git(['log', '--oneline', '-1']), /panel: forget bob/);
  } finally { w.done(); }
});

// ---- R25 skill-scrub in catalog-policy-write ------------------------------------------

test('catalog-policy-write scrubs every offered skill before writing, and writes nothing on a hit', () => {
  assert.ok(VERBS['skill-scrub'] && VERBS['skill-scrub'].adminOnly && !VERBS['skill-scrub'].mutating);
  assert.match(VERBS['skill-scrub'].build({ id: 'x' }).command, /skill-scrub\.mjs "\$BR" x$/);
  assert.throws(() => VERBS['skill-scrub'].build({ id: 'X' }), /kebab-case/);
  const w = rockBrain();
  try {
    const lib = (id, md) => { mkdirSync(path.join(w.brain, 'skills-library', id), { recursive: true }); writeFileSync(path.join(w.brain, 'skills-library', id, 'SKILL.md'), md); };
    lib('clean', '# fine\n');
    lib('leaky', '# leak\nssh root@10.1.2.3\n');
    const engine = new URL('../../engine/ops/skill-scrub.mjs', import.meta.url).pathname;
    const rewrite = (cmd) => cmd.split('/app/engine/ops/skill-scrub.mjs').join(engine);
    const post = (policy) => {
      const spec = VERBS['catalog-policy-write'].build({ content_b64: Buffer.from(JSON.stringify(policy)).toString('base64') });
      let out = '', code = 0;
      try { out = execFileSync('bash', ['-c', rewrite(spec.command)], { encoding: 'utf8', cwd: w.brain, input: spec.stdin, env: { ...process.env, BRAIN_ROOT: w.brain } }); } catch (e) { out = String(e.stdout || ''); code = e.status; }
      return { out, code };
    };
    let r = post({ items: { clean: { audience: 'tied' }, leaky: { audience: 'none' } } });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /OK: \/clean is clean\.\nOK: catalog policy saved\./);
    assert.ok(existsSync(path.join(w.brain, 'catalog', 'policy.json')));
    const before = readFileSync(path.join(w.brain, 'catalog', 'policy.json'), 'utf8');
    r = post({ items: { clean: { audience: 'tied' }, leaky: { audience: ['jane'] } } });
    assert.equal(r.code, 1);
    assert.match(r.out, /ERROR: \/leaky cannot be published:\n  SKILL\.md:2: bare IP address\nERROR: nothing was published\./);
    assert.equal(readFileSync(path.join(w.brain, 'catalog', 'policy.json'), 'utf8'), before, 'the policy on disk did not move');
  } finally { w.done(); }
});

test('an image without the scrubber warns rather than pretending it ran', () => {
  assert.match(VERBS['catalog-policy-write'].build({ content_b64: 'e30=' }).command,
    /if \[ -f \/app\/engine\/ops\/skill-scrub\.mjs \]; then .* else echo "WARN: .*too old to scrub/);
});

// ---- SELF_VERBS --------------------------------------------------------------------

test('both faces carry skill-read; the rock face keeps the self verbs admin-gated where they write', () => {
  const selfList = SRC.split('const SELF_VERBS = [')[1].split('];')[0];
  for (const v of ['skill-remove', 'skill-read', 'catalog-install']) assert.ok(selfList.includes(`'${v}'`), v + ' crosses to the rock face');
});

// ---- R23 POST /rock-tie-downgrade ----------------------------------------------------

const listen = (opts) => new Promise((resolve) => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlPath: HTML_PATH, ...opts });
  s.on('listening', () => resolve(s));
});
const idToken = (email) => 'x.' + Buffer.from(JSON.stringify({ email })).toString('base64url') + '.sig';

test('/rock-tie-downgrade forwards the signed ask, flips the cached edge and rewrites the box ties', async () => {
  const sent = [];
  const boxCmds = [];
  const edges = [
    { org: 'acme', role: 'member', status: 'active', slug: 'pebble-four', rel: 'anchored', box: 'pebble-four.crads-ai.com' },
  ];
  const communityFetcher = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/rock-tie-downgrade')) {
      sent.push({ auth: init.headers.authorization, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, rel: 'joined' }) };
    }
    if (u.includes('/edges')) return { ok: true, status: 200, json: async () => ({ edges }) };
    if (u.includes('/rock-tie-notices')) return { ok: true, status: 200, json: async () => ({ notices: [] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const s = await listen({
    edition: 'member',
    bridge: {
      targets: () => [{ host: 'pebble-four-box', kind: 'member', org: 'pebble-four' }],
      stream: (h, c, o = {}) => { boxCmds.push({ h, c, stdin: o.stdin }); const p = new EventEmitter(); p.kill = () => {}; setImmediate(() => { if (o.onStdout) o.onStdout(/UNANCHOR-OK/.test(c) ? 'UNANCHOR-OK' : ''); p.emit('close', 0); }); return p; },
      tty: () => {},
    },
    directoryUrl: 'https://dir.example',
    communityFetcher,
    communitySignIn: async () => ({ ok: true, idToken: idToken('jane@example.com') }),
  });
  const base = `http://127.0.0.1:${s.address().port}`;
  try {
    await fetch(`${base}/rock-mine/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await new Promise((r) => setTimeout(r, 200));
    const r = await fetch(`${base}/rock-tie-downgrade`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ org: 'acme', host: 'pebble-four-box' }) });
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.deepEqual(b, { ok: true, rel: 'joined', org: 'acme', host: 'pebble-four-box', detach: 'UNANCHOR-OK' }, 'the worker JSON comes back, plus the box-side detach result');
    // R23 box-side half: the old anchor's feed is cut and the Mountain is
    // written into ownership.json, BEFORE the ties rewrite.
    const det = boxCmds.findIndex((x) => /UNANCHOR-OK/.test(x.c) && /by:"downgrade"/.test(x.c));
    assert.ok(det >= 0, 'the downgrade unanchor command ran on the box');
    assert.match(boxCmds[det].c, /j\.anchor="crads-ai"/, 'ownership.json records the Mountain');
    assert.match(boxCmds[det].c, /rm -f \/state\/heartbeat\.conf \/state\/org-inbox\.conf/, 'the old anchor confs go');
    assert.match(boxCmds[det].c, /changed to a join/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].auth, 'Bearer ' + idToken('jane@example.com'));
    assert.deepEqual(sent[0].body, { org: 'acme', box_host: 'pebble-four-box' }, 'names the mineral as the promote leg does');
    assert.equal(s._communityMine.edges[0].rel, 'joined', 'the cached edge flipped');
    const ties = boxCmds.filter((x) => /ties\.json/.test(x.c));
    assert.ok(ties.length >= 1, 'ties.json was rewritten on the box');
    const last = ties[ties.length - 1];
    const rows = JSON.parse(Buffer.from(String(last.stdin).trim(), 'base64').toString('utf8'));
    assert.deepEqual(rows.map((x) => [x.org, x.tie]), [['acme', 'joined']]);
  } finally { s.close(); }
});

test('/rock-tie-downgrade passes the directory’s refusals through, and validates first', async () => {
  const communityFetcher = async (url) => {
    if (String(url).endsWith('/rock-tie-downgrade')) return { ok: false, status: 409, json: async () => ({ error: 'acme owns this mineral, so it stays anchored there' }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const s = await listen({
    edition: 'member',
    bridge: { targets: () => [{ host: 'pebble-four-box', kind: 'member', org: 'pebble-four' }], stream: () => { const p = new EventEmitter(); setImmediate(() => p.emit('close', 0)); return p; }, tty: () => {} },
    directoryUrl: 'https://dir.example',
    communityFetcher,
    communitySignIn: async () => ({ ok: true, idToken: idToken('jane@example.com') }),
  });
  const base = `http://127.0.0.1:${s.address().port}`;
  try {
    let r = await fetch(`${base}/rock-tie-downgrade`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ org: 'acme', host: 'pebble-four-box' }) });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /owns this mineral/);
    r = await fetch(`${base}/rock-tie-downgrade`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ org: 'Not A Handle' }) });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/rock-tie-downgrade`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'nope' });
    assert.equal(r.status, 400);
  } finally { s.close(); }
});

test('/rock-tie-downgrade is a member-face route; an unsigned ask is 401', async () => {
  const s = await listen({
    edition: 'member',
    bridge: { targets: () => [{ host: 'pebble-four-box', kind: 'member', org: 'pebble-four' }], stream: () => { const p = new EventEmitter(); setImmediate(() => p.emit('close', 0)); return p; }, tty: () => {} },
    directoryUrl: 'https://dir.example',
    communityFetcher: async () => { throw new Error('must not be dialled'); },
    communitySignIn: async () => ({ ok: false, reason: 'cancelled' }),
  });
  const base = `http://127.0.0.1:${s.address().port}`;
  try {
    const r = await fetch(`${base}/rock-tie-downgrade`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ org: 'acme' }) });
    assert.equal(r.status, 401);
  } finally { s.close(); }
  assert.match(SRC, /path === '\/rock-tie-downgrade' && edition === 'member'/, 'the rock face does not serve it');
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
