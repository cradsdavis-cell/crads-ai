// brain-shape.test.mjs — the member app's Files tab and brain graph work on any
// brain shape, not only one with wiki/. Run: node --test wizard/panel/brain-shape.test.mjs
//
// Why this file exists (2026-10-18, spec 2026-10-17-adopt-existing-server, last row
// of "Engine changes for adopted brains"). The member verbs did `cd /state/wiki`
// and the pebble graph walked <box>/wiki, so a brain laid out as notes/ +
// decisions/ (Sam's own, the first one "adopt" takes over) answered "no brain at
// /state/wiki" next to an empty graph. Both now list from the brain root with one
// rule (engine/lib/brain-files.mjs). These tests run the REAL commands the panel
// sends, against real folders, and the real graph builder:
//
//   1. a wiki/-only pebble shows the same pages, edges and types as before
//      (now addressed as wiki/<rel>, which is where they are from /state);
//   2. a notes/ + decisions/ brain lists, its graph links resolve, and every
//      graph node opens through brain-read;
//   3. what the brain's own .gitignore keeps out is never listed, never a node,
//      and brain-read refuses it; machinery folders it TRACKS stay out too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMBER_VERBS } from './panel-server.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILDER = join(HERE, '..', '..', 'engine', 'cockpit', 'box-cockpit.mjs');

const put = (root, files) => {
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
};
const git = (root, ...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitInit = (root, { commit = true } = {}) => {
  git(root, 'init', '-q');
  if (commit) { git(root, 'add', '-A'); git(root, 'commit', '-qm', 'brain'); }
};

// The command the panel would send, re-pointed from /state at the fixture. The
// enter is the only /state reference in a brain verb, so this runs exactly what a
// box runs.
const run = (root, verb, args = {}) => {
  const { command } = MEMBER_VERBS[verb].build(args);
  assert.ok(command.startsWith('cd /state 2>/dev/null'), `${verb} enters the brain root: ${command.slice(0, 40)}`);
  const cmd = command.replace('cd /state 2>/dev/null', 'cd "$BRAIN" 2>/dev/null');
  try {
    return execFileSync('sh', ['-c', cmd], { encoding: 'utf8', env: { ...process.env, BRAIN: root } });
  } catch (e) { return String(e.stdout || ''); }
};
const list = (root) => run(root, 'brain-list').split('\n').filter(Boolean);
const graphOf = (root) => {
  execFileSync(process.execPath, [BUILDER, root], { encoding: 'utf8' });
  const data = JSON.parse(readFileSync(join(root, 'cockpit', 'data.json'), 'utf8'));
  const edge = (a, b) => data.graph.links.find((l) =>
    (l.source === a && l.target === b) || (l.source === b && l.target === a));
  return { data, nodes: data.graph.nodes, links: data.graph.links, edge, byId: new Map(data.graph.nodes.map((n) => [n.id, n])) };
};

// ------------------------------------------------------------ 1. wiki/-only pebble

// The pebble shape box-up.sh scaffolds: pages under wiki/, machinery beside it.
const PEBBLE = {
  'wiki/priorities.md': '# Priorities\n\n[[harriet]] and [[people/mel]]\n',
  'wiki/people/harriet.md': '# Harriet\n\n- works-with :: [[retreat]]\n',
  'wiki/people/mel.md': '# Mel\n',
  'wiki/projects/retreat.md': '# Retreat\n',
  'wiki/_layers/1-north-star.md': '# North star\n\n[[priorities]]\n',
  'wiki/notes/photo.png': 'png',
  'wiki/notes/budget.csv': 'a,b\n',
  'profile.yaml': 'name: Test\n',
  'onboarding-state.json': '{"phase":"done"}\n',
  'cockpit/layout.json': '{}\n',
  '.claude/skills/daily/SKILL.md': '# daily\n',
  '.gitignore': 'secrets/\n.kernel\n.claude/\ncockpit/\n',
  'secrets/token.txt': 'sekrit\n',
};

// What the app listed before 2026-10-18: this exact find, run inside /state/wiki.
const OLD_LIST = "find . \\( -name '*.md' -o -name '*.txt' -o -name '*.csv' -o -name '*.tsv' -o -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.gif' -o -name '*.webp' \\) -not -path './.git/*' -not -path './cockpit/*' | sed 's|^\\./||' | sort";

for (const withGit of [true, false]) {
  test(`a wiki/-only pebble lists the same files as before, now from the root (${withGit ? 'git repo' : 'no repo'})`, () => {
    const root = tmpDir('shape-pebble-');
    put(root, PEBBLE);
    if (withGit) gitInit(root);
    const before = execFileSync('sh', ['-c', OLD_LIST], { cwd: join(root, 'wiki'), encoding: 'utf8' })
      .split('\n').filter(Boolean).map((r) => 'wiki/' + r);
    assert.deepEqual([...list(root)].sort(), before.sort(), 'every file the old wiki listing found, and nothing else');
    for (const p of before) {
      if (!p.endsWith('.md')) continue;
      assert.doesNotMatch(run(root, 'brain-read', { page: p }), /^ERROR/, `${p} still opens`);
    }
  });
}

test('a wiki/-only pebble draws the same graph as before: nodes, edges, types, people', () => {
  const root = tmpDir('shape-pebble-g-');
  put(root, PEBBLE);
  gitInit(root);
  const { nodes, links, edge, byId, data } = graphOf(root);
  // the old builder's answer for this wiki, wiki-relative; now prefixed wiki/
  assert.deepEqual(nodes.map((n) => n.id).sort(),
    ['_layers/1-north-star', 'people/harriet', 'people/mel', 'priorities', 'projects/retreat'].map((r) => 'wiki/' + r).sort());
  assert.equal(links.length, 4);
  assert.ok(edge('wiki/priorities', 'wiki/people/harriet'), 'a bare link resolves');
  assert.ok(edge('wiki/priorities', 'wiki/people/mel'), 'a qualified [[people/mel]] still resolves under the wiki/ prefix');
  assert.equal(edge('wiki/people/harriet', 'wiki/projects/retreat').rel, 'works-with');
  assert.ok(edge('wiki/_layers/1-north-star', 'wiki/priorities'));
  // the folder still reads past the box's own wiki/, so types and groups did not move
  assert.equal(byId.get('wiki/people/harriet').type, 'person');
  assert.equal(byId.get('wiki/people/harriet').group, 'people');
  assert.equal(byId.get('wiki/projects/retreat').type, 'project');
  assert.equal(byId.get('wiki/_layers/1-north-star').type, 'layer');
  assert.equal(byId.get('wiki/priorities').group, 'skeleton', 'the scaffold page is still dimmed');
  assert.equal(data.brain.people, 2);
  for (const n of nodes) assert.equal(n.path, n.id + '.md');
});

// ------------------------------------------------------- 2. notes/ + decisions/ brain

const ORACLE_SHAPE = {
  'CLAUDE.md': '# My brain\n\nSee [[notes/index]].\n',
  'notes/index.md': '# Index\n\n[[harriet]] [[people/sam]] [[log]] [[2026-10-01-move]]\n',
  'notes/people/harriet.md': '# Harriet\n\n[[sam]]\n',
  'notes/people/sam.md': '# Sam\n',
  'notes/_layers/6-goals.md': '# Goals\n\n[[index]]\n',
  'notes/diagram.png': 'png',
  'decisions/log.md': '# Decision log\n',
  'decisions/2026-10-01-move.md': '# Move\n',
  'ops/system/cron.log': 'x\n',
  'ops/daily/brief.md': '# Brief\n',
  'archives/old-page.md': '# Old\n',
  // tracked machinery that is not pages, the way Oracle tracks .claude/ and cockpit/
  '.claude/skills/capture/SKILL.md': '# capture\n',
  'cockpit/README.md': '# cockpit\n',
  'tools/node_modules/pkg/README.md': '# pkg\n',
  '.gitignore': 'references/email/\nprivate/\nsecret-plan.md\n*.secret.md\n',
};

test('a notes/ + decisions/ brain with no wiki/ lists its pages instead of "no brain"', () => {
  const root = tmpDir('shape-oracle-');
  put(root, ORACLE_SHAPE);
  gitInit(root);
  const got = list(root);
  assert.deepEqual(got, [
    'CLAUDE.md',
    'decisions/2026-10-01-move.md',
    'decisions/log.md',
    'notes/_layers/6-goals.md',
    'notes/diagram.png',
    'notes/index.md',
    'notes/people/harriet.md',
    'notes/people/sam.md',
    'ops/daily/brief.md',
  ]);
  assert.doesNotMatch(run(root, 'brain-list'), /no brain/);
});

test('a notes/ + decisions/ brain draws a graph whose links resolve and whose every node opens', () => {
  const root = tmpDir('shape-oracle-g-');
  put(root, ORACLE_SHAPE);
  gitInit(root);
  const { nodes, edge, byId, data } = graphOf(root);
  assert.ok(nodes.length >= 8, `pages became nodes: ${nodes.map((n) => n.id).join(', ')}`);
  assert.ok(edge('CLAUDE', 'notes/index'), 'a fully qualified link resolves');
  assert.ok(edge('notes/index', 'notes/people/harriet'), 'a bare link resolves');
  assert.ok(edge('notes/index', 'notes/people/sam'), 'a qualified [[people/sam]] resolves to notes/people/sam');
  assert.ok(edge('notes/index', 'decisions/log'), 'a bare link reaches decisions/');
  assert.ok(edge('notes/index', 'decisions/2026-10-01-move'));
  assert.ok(edge('notes/people/harriet', 'notes/people/sam'));
  assert.ok(edge('notes/_layers/6-goals', 'notes/index'));
  assert.equal(byId.get('notes/people/harriet').type, 'person', 'people under notes/people/ are still people');
  assert.equal(byId.get('notes/_layers/6-goals').type, 'layer');
  assert.equal(byId.get('decisions/log').type, 'decision');
  assert.equal(data.brain.people, 2);
  // Finding 107: a graph click hands node.path to brain-read from the brain root.
  // Every node must open, and every node must be a row the Files tree lists.
  const rows = new Set(list(root));
  for (const n of nodes) {
    assert.ok(rows.has(n.path), `${n.path} is in the Files tree`);
    const body = run(root, 'brain-read', { page: n.path });
    assert.doesNotMatch(body, /^ERROR/, `${n.path} opens`);
    assert.equal(body, readFileSync(join(root, n.path), 'utf8'), `${n.path} opens to its own bytes`);
  }
  // and the tree and the graph agree on the pages, both ways
  assert.deepEqual([...rows].filter((r) => r.endsWith('.md')).sort(), nodes.map((n) => n.path).sort());
});

test('an image in a brain with no wiki/ opens through brain-image from the root', () => {
  const root = tmpDir('shape-oracle-img-');
  put(root, ORACLE_SHAPE);
  gitInit(root);
  assert.match(run(root, 'brain-image', { page: 'notes/diagram.png' }), /^__IMAGE__ png 3\n/);
});

// ------------------------------------------------------------- 3. what stays out

test('files the brain\'s own .gitignore keeps out are never listed, never nodes, never read', () => {
  const root = tmpDir('shape-private-');
  put(root, ORACLE_SHAPE);
  gitInit(root);
  // written AFTER the commit, so they are untracked: only .gitignore stands between
  // them and the Files tab
  put(root, {
    'references/email/2026/10/thread.md': '# a real email\n',
    'private/diary.md': '# diary\n',
    'secret-plan.md': '# plan\n',
    'notes/salary.secret.md': '# salary\n',
    'notes/fresh-untracked.md': '# fresh\n\n[[diary]] [[secret-plan]]\n',
  });
  const rows = list(root);
  for (const p of ['references/email/2026/10/thread.md', 'private/diary.md', 'secret-plan.md', 'notes/salary.secret.md']) {
    assert.ok(!rows.includes(p), `${p} is gitignored and must not be listed`);
    assert.match(run(root, 'brain-read', { page: p }), /^ERROR: .*private/, `${p} is refused by brain-read`);
  }
  assert.ok(rows.includes('notes/fresh-untracked.md'), 'an untracked page that is NOT ignored is listed');
  const { nodes, links } = graphOf(root);
  const ids = nodes.map((n) => n.id);
  for (const id of ['private/diary', 'secret-plan', 'references/email/2026/10/thread', 'notes/salary.secret']) {
    assert.ok(!ids.includes(id), `${id} is not a graph node`);
  }
  assert.ok(ids.includes('notes/fresh-untracked'));
  assert.ok(!links.some((l) => l.source === 'notes/fresh-untracked' || l.target === 'notes/fresh-untracked'),
    'a link to an ignored page draws no edge to it');
});

test('tracked machinery stays out: dot folders, cockpit/, archives/, node_modules/', () => {
  const root = tmpDir('shape-machinery-');
  put(root, ORACLE_SHAPE);
  gitInit(root);
  const tracked = git(root, 'ls-files').split('\n');
  assert.ok(tracked.includes('.claude/skills/capture/SKILL.md') && tracked.includes('cockpit/README.md'),
    'the fixture really tracks them, like Oracle does');
  const rows = list(root);
  for (const p of ['.claude/skills/capture/SKILL.md', 'cockpit/README.md', 'archives/old-page.md', 'tools/node_modules/pkg/README.md']) {
    assert.ok(!rows.includes(p), `${p} must not be listed`);
  }
  assert.match(run(root, 'brain-read', { page: 'cockpit/README.md' }), /^ERROR/, 'and brain-read will not open what the list will not offer');
});

test('with no git repo the fallback prunes the same machinery and still lists the pages', () => {
  const root = tmpDir('shape-nogit-');
  put(root, ORACLE_SHAPE);
  const rows = list(root);
  for (const p of ['.claude/skills/capture/SKILL.md', 'cockpit/README.md', 'archives/old-page.md', 'tools/node_modules/pkg/README.md']) {
    assert.ok(!rows.includes(p), `${p} must not be listed`);
  }
  assert.ok(rows.includes('notes/index.md') && rows.includes('decisions/log.md') && rows.includes('CLAUDE.md'));
  const { nodes } = graphOf(root);
  assert.deepEqual(nodes.map((n) => n.path).sort(), rows.filter((r) => r.endsWith('.md')).sort(),
    'the graph and the tree agree without git too');
});

test('a tracked file deleted from the working tree is not a row that refuses to open', () => {
  const root = tmpDir('shape-deleted-');
  put(root, ORACLE_SHAPE);
  gitInit(root);
  execFileSync('rm', [join(root, 'decisions', 'log.md')]);
  assert.ok(!list(root).includes('decisions/log.md'));
});

test('every credential folder in brain-ignore\'s required block stays out, even with no .gitignore to ask', () => {
  // The find fallback has no .gitignore. engine/lib/brain-ignore.txt's required
  // block is the credential floor brain-push refuses to push without; every
  // folder in it must be out of the Files tab by the fixed rule alone.
  const txt = readFileSync(join(HERE, '..', '..', 'engine', 'lib', 'brain-ignore.txt'), 'utf8');
  const required = txt.split('# --- repaired')[0].split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.endsWith('/'));
  assert.ok(required.includes('secrets/') && required.includes('ssh/'), `parsed the required block: ${required.join(' ')}`);
  const root = tmpDir('shape-creds-');
  const files = { 'notes/ok.md': '# ok\n' };
  for (const d of required) { files[`${d}token.txt`] = 'x\n'; files[`${d}notes.md`] = '# x\n'; }
  put(root, files);
  const rows = list(root);
  assert.deepEqual(rows, ['notes/ok.md'], `only the page is listed (got: ${rows.join(', ')})`);
  for (const d of required) {
    assert.match(run(root, 'brain-read', { page: `${d}notes.md`.replace(/^\./, 'x') }), /^ERROR/);
  }
});

test('the reader resolves an in-page [[folder/page]] link as the end of a path, like the graph does', () => {
  // Listing from the root moved a pebble's people/harriet.md to wiki/people/harriet.md,
  // so the reader's exact-path match stopped finding [[people/harriet]] and fell to the
  // basename. Driven in the harness on ?brain=adopted; pinned here by structure.
  const html = readFileSync(join(HERE, 'member.html'), 'utf8');
  const i = html.indexOf("var want = slug + '.md', tail = '/' + want;");
  assert.ok(i > 0, 'the reader link handler builds a path tail');
  const block = html.slice(i, i + 600);
  assert.ok(block.indexOf('x === want') < block.indexOf('slice(-tail.length) === tail')
    && block.indexOf('slice(-tail.length) === tail') < block.indexOf("split('/').pop() === want"),
    'exact path first, then the path tail, then the basename');
});
