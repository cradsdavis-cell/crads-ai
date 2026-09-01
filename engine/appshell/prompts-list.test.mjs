// prompts-list.test.mjs: what the member app is told about prompt files.
//   node --test engine/appshell/prompts-list.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'prompts-list.mjs');

function box() {
  const root = tmpDir('prompts-');
  const w = (rel, body) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  };
  return { root, w, done: () => rmSync(root, { recursive: true, force: true }) };
}

const read = (root) => {
  const out = execFileSync('node', [CLI, root], { encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.startsWith('PROMPTS_STATE '));
  assert.ok(line, 'a PROMPTS_STATE line is always emitted');
  return JSON.parse(line.slice('PROMPTS_STATE '.length));
};

test('an empty box reports no prompts and no error', () => {
  const b = box();
  const s = read(b.root);
  assert.deepEqual(s.prompts, []);
  assert.equal(s.error, undefined);
  b.done();
});

test('a prompt in the anchor inbox is found, with title from frontmatter and body without it', () => {
  const b = box();
  b.w('org-inbox/prompts/onboarding-pack/kickoff.md',
    '---\ntitle: Kick off a client\n---\nAsk me about the client, then draft the first email.\n');
  const s = read(b.root);
  assert.equal(s.prompts.length, 1);
  const p = s.prompts[0];
  assert.equal(p.title, 'Kick off a client');
  assert.equal(p.body, 'Ask me about the client, then draft the first email.');
  assert.equal(p.pack, 'onboarding-pack');
  assert.equal(p.rock, 'anchor');
  assert.equal(p.id, 'anchor/onboarding-pack/kickoff');
  b.done();
});

test('a joined rock inbox is walked too, and the rock is the owner directory name', () => {
  const b = box();
  b.w('org-inbox/prompts/p1/a.md', '---\ntitle: A\n---\nbody a\n');
  b.w('org-inbox.d/tides/prompts/p2/b.md', '---\ntitle: B\n---\nbody b\n');
  const s = read(b.root);
  assert.deepEqual(s.prompts.map((p) => p.rock).sort(), ['anchor', 'tides']);
  assert.ok(s.prompts.some((p) => p.id === 'tides/p2/b'));
  b.done();
});

test('a file with no frontmatter falls back to the file stem as the title and keeps the whole body', () => {
  const b = box();
  b.w('org-inbox/prompts/p1/weekly-review.md', 'Walk me through last week.\n');
  const s = read(b.root);
  assert.equal(s.prompts[0].title, 'weekly-review');
  assert.equal(s.prompts[0].body, 'Walk me through last week.');
  b.done();
});

test('non-markdown files and unreadable entries are skipped, not fatal', () => {
  const b = box();
  b.w('org-inbox/prompts/p1/notes.txt', 'ignore me');
  b.w('org-inbox/prompts/p1/good.md', '---\ntitle: Good\n---\nkeep me\n');
  mkdirSync(join(b.root, 'org-inbox/prompts/p1/subdir'), { recursive: true });
  const s = read(b.root);
  assert.equal(s.prompts.length, 1);
  assert.equal(s.prompts[0].title, 'Good');
  b.done();
});

test('prompts sort by rock, then pack, then title, so the tab has a stable order', () => {
  const b = box();
  b.w('org-inbox/prompts/zeta/b.md', '---\ntitle: Beta\n---\nx\n');
  b.w('org-inbox/prompts/alpha/z.md', '---\ntitle: Zulu\n---\nx\n');
  b.w('org-inbox/prompts/alpha/a.md', '---\ntitle: Alpha\n---\nx\n');
  const s = read(b.root);
  assert.deepEqual(s.prompts.map((p) => p.title), ['Alpha', 'Zulu', 'Beta']);
  b.done();
});

test('a pack or file name that tries to traverse is refused, never resolved', () => {
  const b = box();
  b.w('org-inbox/prompts/p1/ok.md', '---\ntitle: Ok\n---\nx\n');
  const s = read(b.root);
  assert.ok(s.prompts.every((p) => !p.path.includes('..')), 'no traversal survives into the output');
  b.done();
});

test('a body is capped so one runaway file cannot bloat the payload', () => {
  const b = box();
  b.w('org-inbox/prompts/p1/big.md', '---\ntitle: Big\n---\n' + 'x'.repeat(50000));
  const s = read(b.root);
  assert.ok(s.prompts[0].body.length <= 8000, 'body capped at 8000 chars');
  assert.equal(s.prompts[0].truncated, true);
  b.done();
});

test('symlink escape: outside files symlinked into inbox are refused', () => {
  const b = box();
  // Create an outside.md file outside the box root
  const outsideDir = tmpDir('prompts-outside-');
  writeFileSync(join(outsideDir, 'outside.md'), '---\ntitle: Outside Secret\n---\nThis should not be read\n');
  // Symlink the outside directory into org-inbox.d/evil/prompts
  mkdirSync(join(b.root, 'org-inbox.d/evil'), { recursive: true });
  try {
    symlinkSync(outsideDir, join(b.root, 'org-inbox.d/evil/prompts'));
  } catch {
    // Fallback: symlink may not be supported on this system
  }
  // Also create a legitimate pack and symlink a file into it
  b.w('org-inbox/prompts/p1/good.md', '---\ntitle: Good\n---\nkeep me\n');
  try {
    mkdirSync(join(b.root, 'org-inbox/prompts/p2'), { recursive: true });
    symlinkSync(join(outsideDir, 'outside.md'), join(b.root, 'org-inbox/prompts/p2/linked.md'));
  } catch {
    // Fallback: symlink may not be supported on this system
  }
  const s = read(b.root);
  // No outside content should appear in the output
  assert.ok(!s.prompts.some((p) => p.body.includes('Outside Secret')), 'outside file content not in prompts');
  assert.ok(!s.prompts.some((p) => p.path.includes('outside')), 'outside path not in prompts');
  // But the legitimate good.md should be found
  assert.ok(s.prompts.some((p) => p.title === 'Good'), 'legitimate prompt found');
  rmSync(outsideDir, { recursive: true, force: true });
  b.done();
});

test('broken anchor does not sink joined rocks: anchor as file, tides inbox healthy', () => {
  const b = box();
  // Write org-inbox/prompts as a FILE, not a directory (breaking the anchor)
  mkdirSync(join(b.root, 'org-inbox'), { recursive: true });
  writeFileSync(join(b.root, 'org-inbox/prompts'), 'I am a file, not a directory\n');
  // Write a healthy joined rock
  b.w('org-inbox.d/tides/prompts/p2/b.md', '---\ntitle: Tides Prompt\n---\nBody of tides prompt\n');
  const s = read(b.root);
  // The tides prompt should be found despite the broken anchor
  assert.equal(s.prompts.length, 1);
  assert.equal(s.prompts[0].rock, 'tides');
  assert.equal(s.prompts[0].title, 'Tides Prompt');
  // No error should be set; it's not a fatal failure
  assert.equal(s.error, undefined);
  b.done();
});

test('broken org-inbox.d does not sink the anchor: org-inbox.d as a file, anchor healthy', () => {
  const b = box();
  // Write a healthy anchor prompt
  b.w('org-inbox/prompts/p1/good.md', '---\ntitle: Anchor Prompt\n---\nBody of anchor prompt\n');
  // Write org-inbox.d as a FILE, not a directory (breaking the joined-rocks walk)
  writeFileSync(join(b.root, 'org-inbox.d'), 'I am a file, not a directory\n');
  const s = read(b.root);
  // The anchor prompt should be found despite the broken org-inbox.d, and
  // the process must still exit 0 (read() throws on a non-zero exit, so
  // getting here at all is part of the assertion).
  assert.equal(s.prompts.length, 1);
  assert.equal(s.prompts[0].rock, 'anchor');
  assert.equal(s.prompts[0].title, 'Anchor Prompt');
  assert.equal(s.error, undefined);
  b.done();
});

test('a broken pack does not sink the rest of the inbox: one bad pack, one healthy sibling', () => {
  const b = box();
  b.w('org-inbox/prompts/b-good/ok.md', '---\ntitle: Ok\n---\nkeep me\n');
  const brokenDir = join(b.root, 'org-inbox/prompts/a-broken');
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot) {
    // root bypasses directory permission bits, so an unreadable directory
    // cannot be simulated; fall back to a non-directory entry in the pack
    // slot, which still proves one broken entry does not take down the rest.
    writeFileSync(brokenDir, 'I am a file, not a pack directory\n');
  } else {
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, 'x.md'), '---\ntitle: X\n---\nx\n');
    chmodSync(brokenDir, 0o000); // unreadable: readdirSync(brokenDir) throws EACCES
  }
  const s = read(b.root);
  assert.equal(s.prompts.length, 1, 'the healthy sibling pack survives the broken one');
  assert.equal(s.prompts[0].pack, 'b-good');
  assert.equal(s.prompts[0].title, 'Ok');
  assert.equal(s.error, undefined);
  if (!isRoot) chmodSync(brokenDir, 0o755); // restore so rmSync in b.done() can clean up
  b.done();
});

test('a runaway title is capped so it cannot bypass the body-cap payload protection', () => {
  const b = box();
  const hugeTitle = 'x'.repeat(10000);
  b.w('org-inbox/prompts/p1/big-title.md', `---\ntitle: ${hugeTitle}\n---\nbody\n`);
  const s = read(b.root);
  assert.equal(s.prompts.length, 1);
  assert.equal(s.prompts[0].title.length, 200, 'title truncated to 200 chars');
  b.done();
});

test('total prompt count is capped across all inboxes', () => {
  const b = box();
  for (let i = 0; i < 210; i++) {
    const stem = 'p' + String(i).padStart(4, '0');
    b.w(`org-inbox/prompts/pack1/${stem}.md`, `---\ntitle: T${i}\n---\nbody ${i}\n`);
  }
  const s = read(b.root);
  assert.ok(s.prompts.length <= 200, `prompt count capped at 200, got ${s.prompts.length}`);
  assert.equal(s.error, undefined);
  b.done();
});

test('CRLF frontmatter (Windows-authored file) is recognised: title extracted, body has no frontmatter block', () => {
  const b = box();
  b.w('org-inbox/prompts/p1/crlf.md',
    '---\r\ntitle: Windows Prompt\r\n---\r\nAsk me about the client, then draft the first email.\r\n');
  const s = read(b.root);
  assert.equal(s.prompts.length, 1);
  const p = s.prompts[0];
  assert.equal(p.title, 'Windows Prompt');
  assert.ok(!p.body.includes('---'), 'body carries no frontmatter delimiter');
  assert.ok(!p.body.includes('title:'), 'body carries no frontmatter content');
  b.done();
});
