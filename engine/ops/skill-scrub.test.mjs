// skill-scrub.test.mjs: R25 (panel iteration 2, 2026-08-23): a rock's skill
// is scrubbed before it is offered. A clean skill passes; each of the four
// categories refuses and names the file and line.
//   node --test engine/ops/skill-scrub.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scrubSkill, scrubItem, scanText, publishedIds, libraryIds, memberSlugs, report } from './skill-scrub.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const SCRIPT = new URL('./skill-scrub.mjs', import.meta.url).pathname;

function brain() {
  const root = tmpDir('scrub-');
  mkdirSync(path.join(root, 'registry', 'members'), { recursive: true });
  writeFileSync(path.join(root, 'registry', 'members', '_TEMPLATE.yaml'), 'slug: ""\nstatus: "active"\n');
  writeFileSync(path.join(root, 'registry', 'members', 'brendan.yaml'), 'slug: "brendan"\ndisplay_name: "Brendan"\nstatus: "active"\n');
  writeFileSync(path.join(root, 'registry', 'members', 'alice-w.yaml'), 'slug: alice-w\nstatus: "left"\n');
  const skill = (id, files) => {
    const d = path.join(root, 'skills-library', id);
    mkdirSync(path.join(d, 'context'), { recursive: true });
    for (const [f, body] of Object.entries(files)) writeFileSync(path.join(d, f), body);
  };
  const writeInto = (libRoot, id, files) => {
    const d = path.join(root, libRoot, id);
    mkdirSync(d, { recursive: true });
    for (const [f, body] of Object.entries(files)) {
      const p = path.join(d, f);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
    return d;
  };
  const prompt = (id, files) => writeInto('prompts-library', id, files);
  const page = (id, files) => writeInto('pages-library', id, files);
  const dir = (id, files) => writeInto('dirs-library', id, files);
  const pack = (id, yaml) => {
    const d = path.join(root, 'packs', id);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'pack.yaml'), yaml);
  };
  return { root, skill, prompt, page, dir, pack, done: () => rmSync(root, { recursive: true, force: true }) };
}

const CLEAN_MD = '---\ntitle: Weekly review\ncategory: briefing\n---\n# Weekly review\n\nRead the week, write three lines. Dates like 2026-08-23 are fine.\nSo is a long kebab-id-that-runs-on-and-on-for-forty-characters.\n';

test('member slugs come from the rows, template and schema excluded', () => {
  const b = brain();
  try {
    assert.deepEqual(memberSlugs(b.root).sort(), ['alice-w', 'brendan']);
  } finally { b.done(); }
});

test('a clean skill passes, and says so', () => {
  const b = brain();
  try {
    b.skill('weekly-review', { 'SKILL.md': CLEAN_MD, 'skill.yaml': 'title: Weekly review\nversion: 2\n', 'context/notes.md': 'Ask for the numbers, then the story.\n' });
    const hits = scrubSkill(b.root, 'weekly-review');
    assert.deepEqual(hits, []);
    assert.equal(report('weekly-review', hits), 'OK: /weekly-review is clean.');
  } finally { b.done(); }
});

test('(a) secret patterns refuse, naming file:line', () => {
  const b = brain();
  try {
    b.skill('leaky', {
      'SKILL.md': CLEAN_MD,
      'skill.yaml': 'title: Leaky\nversion: 1\n',
      'context/setup.md': [
        'Use this key:',
        '-----BEGIN OPENSSH PRIVATE KEY-----',
        'password=hunter2',
        'export TOKEN=abc',
        'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        'sk-abcdefghijklmnopqrstuvwxyz',
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        'QWxhZGRpbjpvcGVuIHNlc2FtZTAxMjM0NTY3ODkw==',
      ].join('\n'),
    });
    const hits = scrubSkill(b.root, 'leaky');
    const at = (n) => hits.filter((h) => h.file === 'context/setup.md' && h.line === n).map((h) => h.reason);
    assert.match(at(2)[0], /private key/);
    assert.match(at(3)[0], /password/);
    assert.match(at(4)[0], /token/);
    assert.match(at(5)[0], /GitHub token/);
    assert.match(at(6)[0], /API key/);
    assert.match(at(7)[0], /hex blob/);
    assert.match(at(8)[0], /base64 blob/);
    assert.equal(at(1).length, 0, 'the prose line is not a hit');
    const text = report('leaky', hits);
    assert.match(text, /^ERROR: \/leaky cannot be published:\n  context\/setup\.md:2: /);
  } finally { b.done(); }
});

test('(b) bare hostnames and IPs refuse', () => {
  const hits = scanText('ssh to 10.0.0.12 or acme-rock.crads-ai.com\nor ssh://git@github.com/x/y\nfine line', 'SKILL.md');
  assert.deepEqual(hits.map((h) => [h.line, h.reason]), [
    [1, 'bare IP address'], [1, 'box hostname'], [2, 'ssh:// address'],
  ]);
});

test('(c) this rock’s member slugs refuse, whole-word only', () => {
  const b = brain();
  try {
    b.skill('gossip', { 'SKILL.md': '---\ntitle: Gossip\n---\nAsk Brendan first.\nalice-w owes a reply.\nbrendanite minerals are fine.\n' });
    const hits = scrubSkill(b.root, 'gossip');
    assert.deepEqual(hits.map((h) => [h.file, h.line, h.reason]), [
      ['SKILL.md', 4, 'names a member of this rock (brendan)'],
      ['SKILL.md', 5, 'names a member of this rock (alice-w)'],
    ]);
  } finally { b.done(); }
});

test('(d) rock-internal paths refuse', () => {
  const hits = scanText('cat /state/brain/org-policy.yaml\nls /state/secrets\ncat /state/.kernel/gh\n/state/wiki is fine', 'context/a.md');
  assert.deepEqual(hits.map((h) => h.line), [1, 2, 3]);
  assert.match(hits[0].reason, /\/state\/brain/);
});

test('a skill that is not in the library is a hit, not a pass', () => {
  const b = brain();
  try {
    assert.equal(scrubSkill(b.root, 'nope')[0].reason, 'no such skill in the library');
  } finally { b.done(); }
});

test('--policy scrubs exactly the ids the policy offers to somebody', () => {
  const lib = ['a', 'b', 'c'];
  assert.deepEqual(publishedIds({ items: { a: { audience: 'tied' }, b: { audience: ['x'] }, c: { audience: 'none' } } }, lib), ['a', 'b']);
  assert.deepEqual(publishedIds({ items: { a: { audience: 'all' }, b: { audience: [] } } }, lib), ['a']);
  assert.deepEqual(publishedIds({ defaults: { audience: 'tied' }, items: { c: { audience: 'none' } } }, lib), ['a', 'b']);
  assert.deepEqual(publishedIds({}, lib), []);
  assert.deepEqual(publishedIds({ items: { zzz: { audience: 'tied' } } }, lib), [], 'ids not in the library are not scrubbed');
});

test('a secret in a prompts-library item is caught, named by file and line', () => {
  const b = brain();
  try {
    b.prompt('daily-nudge', { 'PROMPT.md': 'Say hi.\ntoken=abc123\n', 'prompt.yaml': 'title: Daily nudge\nversion: 1\n' });
    const hits = scrubItem(b.root, 'daily-nudge');
    assert.deepEqual(hits.map((h) => [h.file, h.line, h.reason]), [['PROMPT.md', 2, 'looks like a token assignment']]);
  } finally { b.done(); }
});

test('a secret in a pages-library item is caught, named by file and line', () => {
  const b = brain();
  try {
    b.page('status-card', { 'page.html': '<div>hi</div>\ntoken=abc123\n', 'page.yaml': 'title: Status card\nversion: 1\n' });
    const hits = scrubItem(b.root, 'status-card');
    assert.deepEqual(hits.map((h) => [h.file, h.line, h.reason]), [['page.html', 2, 'looks like a token assignment']]);
  } finally { b.done(); }
});

test('a secret in a dirs-library item, including a file nested under files/, is caught, named by file and line', () => {
  const b = brain();
  try {
    b.dir('starter-kit', {
      'dir.yaml': 'title: Starter kit\nversion: 1\n',
      'files/readme.md': 'Welcome.\n',
      'files/sub/notes.md': 'token=abc123\n',
    });
    const hits = scrubItem(b.root, 'starter-kit');
    assert.deepEqual(hits.map((h) => [h.file, h.line, h.reason]), [['files/sub/notes.md', 1, 'looks like a token assignment']]);
  } finally { b.done(); }
});

test('libraryIds returns ids from all four roots', () => {
  const b = brain();
  try {
    b.skill('weekly-review', { 'SKILL.md': CLEAN_MD });
    b.prompt('daily-nudge', { 'PROMPT.md': 'Say hi.\n' });
    b.page('status-card', { 'page.html': '<div>hi</div>\n' });
    b.dir('starter-kit', { 'dir.yaml': 'title: x\nversion: 1\n', 'files/readme.md': 'Welcome.\n' });
    assert.deepEqual(libraryIds(b.root).sort(), ['daily-nudge', 'starter-kit', 'status-card', 'weekly-review']);
  } finally { b.done(); }
});

test('an item whose payload marker is missing is not a library item', () => {
  const b = brain();
  try {
    // a prompt with a manifest but no PROMPT.md, and a dir with a manifest but no files/
    b.prompt('half-built', { 'prompt.yaml': 'title: Half built\nversion: 1\n' });
    b.dir('empty-shell', { 'dir.yaml': 'title: Empty shell\nversion: 1\n' });
    assert.deepEqual(libraryIds(b.root), []);
    assert.equal(scrubItem(b.root, 'half-built')[0].reason, 'no such item in the library');
    assert.equal(scrubItem(b.root, 'empty-shell')[0].reason, 'no such item in the library');
  } finally { b.done(); }
});

test('publishedIds expands a pack: entitling a pack returns its content ids', () => {
  const b = brain();
  try {
    b.skill('weekly-review', { 'SKILL.md': CLEAN_MD });
    b.page('status-card', { 'page.html': '<div>hi</div>\n' });
    b.dir('starter-kit', { 'dir.yaml': 'title: x\nversion: 1\n', 'files/readme.md': 'Welcome.\n' });
    b.pack('starter-pack', [
      'id: starter-pack',
      'version: 1',
      'category: briefing',
      'contents:',
      '  skills: [weekly-review]',
      '  pages: [status-card]',
      '  dirs: [starter-kit]',
      '  context: [notes/setup.md]',
      '  prompts: []',
      '',
    ].join('\n'));
    const lib = libraryIds(b.root);
    assert.deepEqual(
      publishedIds({ items: { 'starter-pack': { audience: 'tied' } } }, lib, b.root).sort(),
      ['starter-kit', 'status-card', 'weekly-review'],
      'the pack id itself is not a library item, but everything it ships is scrubbed',
    );
    // path-shaped contents (context, prompts) are pack-relative files, not ids:
    // they must not silently vanish a real id, but they are not expanded here.
    assert.ok(!publishedIds({ items: { 'starter-pack': { audience: 'tied' } } }, lib, b.root).includes('notes/setup.md'));
  } finally { b.done(); }
});

test('a bare id in contents.prompts is expanded and scrubbed via the pack that entitles it (the leaked-key fixture)', () => {
  const b = brain();
  try {
    b.prompt('leaky', { 'PROMPT.md': 'Use this key:\nsk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n' });
    b.pack('kit', ['id: kit', 'version: 1', 'category: briefing', 'contents:', '  prompts: [leaky]', ''].join('\n'));
    const pol = path.join(b.root, 'pol.json');
    writeFileSync(pol, JSON.stringify({ items: { kit: { audience: 'tied' } } }));
    let out = '', code = 0;
    try { out = execFileSync('node', [SCRIPT, b.root, '--policy', pol], { encoding: 'utf8' }); } catch (e) { out = e.stdout; code = e.status; }
    assert.equal(code, 1, 'the leaked key must refuse the publish, not exit clean');
    assert.match(out, /ERROR: \/leaky cannot be published:\n  PROMPT\.md:2: looks like an API key/);
  } finally { b.done(); }
});

test('a pack-local path entry (not a library id) with a secret is caught, labelled with the pack', () => {
  const b = brain();
  try {
    mkdirSync(path.join(b.root, 'packs', 'kit', 'notes'), { recursive: true });
    writeFileSync(path.join(b.root, 'packs', 'kit', 'notes', 'setup.md'), 'Welcome.\ntoken=abc123\n');
    b.pack('kit', ['id: kit', 'version: 1', 'category: briefing', 'contents:', '  context: [notes/setup.md]', ''].join('\n'));
    const hits = scrubItem(b.root, 'kit');
    assert.deepEqual(hits, [{ file: 'kit/notes/setup.md', line: 2, reason: 'looks like a token assignment' }]);
  } finally { b.done(); }
});

test('a contents entry containing ".." is refused rather than resolved', () => {
  const b = brain();
  try {
    b.pack('kit', ['id: kit', 'version: 1', 'category: briefing', 'contents:', '  context: [../../../etc/passwd]', ''].join('\n'));
    const hits = scrubItem(b.root, 'kit');
    assert.deepEqual(hits, [{ file: 'kit/../../../etc/passwd', line: 0, reason: 'contents entry escapes the pack dir' }]);
  } finally { b.done(); }
});

test('a contents entry that is neither a known id nor an existing file is reported as unresolvable, not silently ignored', () => {
  const b = brain();
  try {
    b.pack('kit', ['id: kit', 'version: 1', 'category: briefing', 'contents:', '  prompts: [nonexistent-thing]', ''].join('\n'));
    const hits = scrubItem(b.root, 'kit');
    assert.deepEqual(hits, [{ file: 'kit/nonexistent-thing', line: 0, reason: 'not a known library id and no such file in the pack' }]);
  } finally { b.done(); }
});

test('the ERROR literal that gates publishing is exact, for any kind', () => {
  assert.equal(
    report('starter-kit', [{ file: 'dir.yaml', line: 1, reason: 'looks like a token assignment' }]),
    'ERROR: /starter-kit cannot be published:\n  dir.yaml:1: looks like a token assignment',
  );
});

test('CLI: exit 0 on clean, exit 1 with the hits on a leak; --policy reads the posted policy', () => {
  const b = brain();
  try {
    b.skill('clean', { 'SKILL.md': CLEAN_MD });
    b.skill('leaky', { 'SKILL.md': CLEAN_MD + 'token=abc\n' });
    const ok = execFileSync('node', [SCRIPT, b.root, 'clean'], { encoding: 'utf8' });
    assert.equal(ok.trim(), 'OK: /clean is clean.');
    const pol = path.join(b.root, 'pol.json');
    writeFileSync(pol, JSON.stringify({ items: { clean: { audience: 'tied' }, leaky: { audience: ['brendan'] } } }));
    let out = '', code = 0;
    try { out = execFileSync('node', [SCRIPT, b.root, '--policy', pol], { encoding: 'utf8' }); } catch (e) { out = e.stdout; code = e.status; }
    assert.equal(code, 1);
    assert.match(out, /OK: \/clean is clean\./);
    assert.match(out, /ERROR: \/leaky cannot be published:\n  SKILL\.md:9: looks like a token assignment/);
    // nothing offered: nothing scrubbed, nothing refused
    writeFileSync(pol, JSON.stringify({ items: { leaky: { audience: 'none' } } }));
    assert.equal(execFileSync('node', [SCRIPT, b.root, '--policy', pol], { encoding: 'utf8' }).trim(), '');
  } finally { b.done(); }
});
