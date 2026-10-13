// brain-claude-md.test.mjs: the "read your brain first" block in a mineral's
// CLAUDE.md (2026-10-13). Run: node --test engine/box/brain-claude-md.test.mjs
//
// Six public docs pages promise the assistant reads the layer pages at the start
// of every session. This pins the block that makes it true: where it is written,
// that it imports the right pages, that it is stable byte for byte, and that it
// never touches the member's own words or the Teams block in the same file.
// Teams' Slack and inbox turns running OUTSIDE /state is pinned in
// engine/team/team.test.mjs and team-inbox.test.mjs, not repeated here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, utimesSync, symlinkSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBrainClaudeMd, buildBrainSection, upsertBrainSection, MARK_START, MARK_END, IMPORTED } from './brain-claude-md.mjs';
import { LAYERS } from '../onboarding/layers.mjs';
import { upsertClaudeSection, claudeSection, CLAUDE_MARK_START, CLAUDE_MARK_END } from '../team/team-enrol.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..');
const REPO = join(ENGINE, '..');
const env = {};   // never the developer's own BRAIN_ROOT
const ensure = (sd) => ensureBrainClaudeMd(sd, { env });
const read = (sd) => readFileSync(join(sd, 'CLAUDE.md'), 'utf8');
const between = (text, a, b) => text.slice(text.indexOf(a), text.indexOf(b) + b.length);

function pebble() {
  const d = tmpDir('brain-claude-md-');
  writeFileSync(join(d, 'ownership.json'), JSON.stringify({ tier: 'pebble' }));
  return d;
}
const TEAM = { slug: 'jess', company: 'acme', role: 'member', person: 'Jess',
  brain: { remote: 'git@x:acme/brain.git', key: 'k' }, outbox: { remote: 'git@x:acme/jess.git', key: 'k2' } };

test('fresh pebble: CLAUDE.md is created at the state dir with one marked block', () => {
  const sd = pebble();
  const r = ensure(sd);
  assert.equal(r.action, 'created');
  assert.equal(r.file, join(sd, 'CLAUDE.md'));
  const t = read(sd);
  assert.equal(t.split(MARK_START).length - 1, 1);
  assert.equal(t.split(MARK_END).length - 1, 1);
  assert.ok(t.startsWith(MARK_START), 'a fresh file is just the block');
  assert.ok(t.endsWith(`${MARK_END}\n`));
});

test('the block imports 8-workflow and 3-self, and names every other layer without importing it', () => {
  const s = buildBrainSection();
  assert.deepEqual(IMPORTED, ['8-workflow', '3-self']);
  for (const id of LAYERS) {
    const p = `wiki/_layers/${id}.md`;
    if (IMPORTED.includes(id)) {
      // Claude Code's import syntax: whitespace, @, a path. Relative to this file.
      assert.match(s, new RegExp(`(^|\\s)@${p.replace(/[.]/g, '\\.')}(\\s|$)`), `${id} is imported`);
    } else {
      // A code span is never imported by Claude Code: listed, read when relevant.
      assert.ok(s.includes(`\`${p}\``), `${id} is listed`);
      assert.ok(!s.includes(`@${p}`), `${id} is not imported`);
    }
  }
  assert.equal((s.match(/(^|\s)@\S/g) || []).length, IMPORTED.length, 'exactly the two imports, nothing else starts with @');
  assert.match(s, /`STATE\.md`/, 'STATE.md is named for questions about the mineral');
  assert.match(s, /`\/onboard`/, 'a mineral with no layer pages points at the interview');
});

test('idempotent: a second start is byte-identical and does not touch the file', () => {
  const sd = pebble();
  ensure(sd);
  const f = join(sd, 'CLAUDE.md');
  const before = readFileSync(f);
  const old = new Date('2026-01-01T00:00:00Z');
  utimesSync(f, old, old);
  assert.equal(ensure(sd).action, 'kept');
  assert.equal(ensure(sd).action, 'kept');
  assert.deepEqual(readFileSync(f), before);
  assert.equal(statSync(f).mtimeMs, old.getTime(), 'no rewrite, so no mtime churn and no nightly diff');
});

test('stable across minerals: no host, name, date or path leaks into the text', () => {
  const a = pebble();
  const b = pebble();
  writeFileSync(join(b, 'box-name'), 'Wren\n');
  ensure(a); ensure(b);
  assert.equal(read(a), read(b));
  assert.ok(!read(a).includes(a), 'the absolute state path is never written');
  assert.doesNotMatch(read(a), /\d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(read(a), /\u2014/, 'zero em dashes');
});

test('member content outside the markers is preserved, and an old block is updated in place', () => {
  const sd = pebble();
  const head = '# My own rules\n\nAlways call me Jo.\n';
  const tail = '\n## More of mine\n\nNever book Mondays.\n';
  writeFileSync(join(sd, 'CLAUDE.md'), `${head}\n${MARK_START} -->\nan older wording\n${MARK_END}\n${tail}`);
  assert.equal(ensure(sd).action, 'updated');
  const t = read(sd);
  assert.ok(t.startsWith(`${head}\n`), 'text above the block untouched');
  assert.ok(t.endsWith(`\n${tail}`), 'text below the block untouched');
  assert.ok(!t.includes('an older wording'));
  assert.equal(between(t, MARK_START, MARK_END), buildBrainSection());
  assert.equal(ensure(sd).action, 'kept');
});

test('an existing CLAUDE.md with no block gets the block appended, nothing else changes', () => {
  const sd = pebble();
  const mine = '# Mine\n\nKeep it short.\n';
  writeFileSync(join(sd, 'CLAUDE.md'), mine);
  ensure(sd);
  const t = read(sd);
  assert.ok(t.startsWith(mine));
  assert.equal(t, `${mine.trimEnd()}\n\n${buildBrainSection()}\n`);
});

test('coexists with the Teams block: Teams first, then this', () => {
  const sd = pebble();
  const f = join(sd, 'CLAUDE.md');
  upsertClaudeSection(f, claudeSection(TEAM));
  const teams = between(read(sd), CLAUDE_MARK_START, CLAUDE_MARK_END);
  ensure(sd);
  let t = read(sd);
  assert.equal(between(t, CLAUDE_MARK_START, CLAUDE_MARK_END), teams, 'Teams block byte-intact');
  assert.equal(between(t, MARK_START, MARK_END), buildBrainSection());
  // Teams re-enrols with a change: its block moves on, ours stays put.
  upsertClaudeSection(f, claudeSection({ ...TEAM, person: 'Jessica' }));
  t = read(sd);
  assert.equal(between(t, MARK_START, MARK_END), buildBrainSection());
  assert.match(between(t, CLAUDE_MARK_START, CLAUDE_MARK_END), /Jessica/);
  assert.equal(ensure(sd).action, 'kept', 'a Teams rewrite does not make this one churn');
  assert.equal(t.split(CLAUDE_MARK_START).length - 1, 1);
});

test('coexists with the Teams block: this first, then Teams', () => {
  const sd = pebble();
  const f = join(sd, 'CLAUDE.md');
  ensure(sd);
  upsertClaudeSection(f, claudeSection(TEAM));
  const t = read(sd);
  assert.equal(between(t, MARK_START, MARK_END), buildBrainSection(), 'Teams appending does not disturb this block');
  assert.ok(t.indexOf(MARK_END) < t.indexOf(CLAUDE_MARK_START));
  assert.equal(ensure(sd).action, 'kept');
  upsertClaudeSection(f, claudeSection(TEAM));
  assert.equal(read(sd), t, 'and a Teams re-enrol is stable too');
});

test('missing layer pages change nothing: same block before and after the interview', () => {
  const sd = pebble();
  assert.ok(!existsSync(join(sd, 'wiki')));
  ensure(sd);
  const before = read(sd);
  mkdirSync(join(sd, 'wiki', '_layers'), { recursive: true });
  for (const id of LAYERS) writeFileSync(join(sd, 'wiki', '_layers', `${id}.md`), `# ${id}\n`);
  assert.equal(ensure(sd).action, 'kept');
  assert.equal(read(sd), before);
});

test('path resolution: imports are relative to the CLAUDE.md, via resolveBrainRoot', () => {
  // A brain root below the state dir (not an org) gets the prefix on every path.
  const sd = pebble();
  mkdirSync(join(sd, 'brain'), { recursive: true });
  ensure(sd);
  const t = read(sd);
  assert.match(t, /@brain\/wiki\/_layers\/8-workflow\.md/);
  assert.match(t, /`brain\/STATE\.md`/);
  // A brain root outside the state dir would make every import external: skip.
  const other = tmpDir('brain-claude-md-elsewhere-');
  const sd2 = pebble();
  const r = ensureBrainClaudeMd(sd2, { env: { BRAIN_ROOT: other } });
  assert.equal(r.action, 'skipped');
  assert.ok(!existsSync(join(sd2, 'CLAUDE.md')));
});

test('org boxes are skipped: a born rock and a member-born rock keep their own CLAUDE.md', () => {
  const rock = tmpDir('brain-claude-md-rock-');
  mkdirSync(join(rock, 'brain'), { recursive: true });
  writeFileSync(join(rock, 'brain', 'org-policy.yaml'), 'name: acme\n');
  writeFileSync(join(rock, 'CLAUDE.md'), 'org pointer\n');
  assert.equal(ensure(rock).action, 'skipped');
  assert.equal(read(rock), 'org pointer\n');

  const born = tmpDir('brain-claude-md-mbrock-');
  writeFileSync(join(born, 'ownership.json'), JSON.stringify({ tier: 'rock' }));
  assert.equal(ensure(born).action, 'skipped');
  assert.ok(!existsSync(join(born, 'CLAUDE.md')));
});

test('broken or doubled markers: the file is left exactly as the member has it', () => {
  for (const body of [
    `mine\n${MARK_START} -->\nno end marker, then my notes\n`,
    `mine\n${MARK_END}\nend before start\n${MARK_START} -->\n`,
    `${buildBrainSection()}\n\n${buildBrainSection()}\n`,
  ]) {
    const sd = pebble();
    writeFileSync(join(sd, 'CLAUDE.md'), body);
    assert.equal(ensure(sd).action, 'skipped');
    assert.equal(read(sd), body);
    assert.equal(upsertBrainSection(body, buildBrainSection()).malformed, true);
  }
});

test('a symlinked CLAUDE.md is never written through', () => {
  const sd = pebble();
  const target = join(tmpDir('brain-claude-md-link-'), 'AGENTS.md');
  writeFileSync(target, 'theirs\n');
  symlinkSync(target, join(sd, 'CLAUDE.md'));
  assert.equal(ensure(sd).action, 'skipped');
  assert.equal(readFileSync(target, 'utf8'), 'theirs\n');
  assert.ok(lstatSync(join(sd, 'CLAUDE.md')).isSymbolicLink());
});

test('wiring: box-up runs it on every start, against the box root, never fatally', () => {
  const up = readFileSync(join(ENGINE, 'box-up.sh'), 'utf8');
  assert.match(up, /^node "\$ENGINE\/box\/brain-claude-md\.mjs" "\$BOX" \|\| true$/m);
  // It must sit in the unconditional start path, not inside the first-run scaffold.
  assert.ok(up.indexOf('brain-claude-md.mjs') > up.indexOf('open-folder.mjs'));
  assert.ok(up.indexOf('brain-claude-md.mjs') < up.indexOf('scheduler.mjs'));
});

test('wiring: every way in starts at or under the state dir, and both harnesses read CLAUDE.md', async () => {
  // Terminal tab, SSH commands and the Claude Code app's SFTP all land in /state.
  const enter = readFileSync(join(REPO, 'provisioning', 'host', 'enter-aios'), 'utf8');
  const execs = enter.split('\n').filter((l) => /docker exec/.test(l) && /ai-os/.test(l));
  assert.ok(execs.length >= 3);
  for (const l of execs) assert.match(l, /-w \/state /, `lands outside /state: ${l.trim()}`);
  // Scheduled runs: runTurn defaults cwd to the state dir in both harnesses.
  for (const h of ['claude-code', 'opencode']) {
    const src = readFileSync(join(ENGINE, 'kernel', 'lib', 'harness', `${h}.mjs`), 'utf8');
    assert.match(src, /cwd: cwd \|\| stateDir/, `${h} runs default to the state dir`);
    const mod = await import(join(ENGINE, 'kernel', 'lib', 'harness', `${h}.mjs`));
    assert.equal(mod.manifest.reads.contextFile, 'CLAUDE.md', `${h} reads CLAUDE.md`);
  }
  const runner = readFileSync(join(ENGINE, 'kernel', 'lib', 'runner.mjs'), 'utf8');
  assert.match(runner, /runTurn\(\{ stateDir, prompt, grants \}\)/, 'skill jobs pass no cwd of their own');
});
