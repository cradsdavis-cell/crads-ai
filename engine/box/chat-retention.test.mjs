// chat-retention.test.mjs: saved chats older than cleanupPeriodDays leave the box.
// Run: node --test engine/box/chat-retention.test.mjs
// The case: a member found every chat since day one still on the mineral, 40 days in,
// because Claude Code only clears old transcripts when an interactive session starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync, existsSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { pruneChats, retentionDays, DEFAULT_DAYS } from './chat-retention.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const DAY = 86400000;
function chat(state, rel, ageDays, now) {
  const p = path.join(state, '.claude-auth', 'projects', rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, '{}\n');
  const t = (now - ageDays * DAY) / 1000;
  utimesSync(p, t, t);
  return p;
}

test('default is Claude Code\'s own 30 days; old chats go, recent ones and other files stay', () => {
  const s = tmpDir('chatret-'); const now = Date.now();
  const old = chat(s, '-state/old.jsonl', 41, now);
  const recent = chat(s, '-state/recent.jsonl', 3, now);
  const sub = chat(s, '-state/abc/subagents/agent-1.jsonl', 45, now);
  const other = chat(s, '-state/notes.txt', 90, now);
  const r = pruneChats(s, { now });
  assert.deepEqual([r.days, r.removed, r.kept], [DEFAULT_DAYS, 2, 1]);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(sub), false);
  assert.equal(existsSync(path.dirname(sub)), false, 'an emptied folder is tidied');
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(other), true, 'only transcripts are touched');
});

test('the member\'s cleanupPeriodDays wins; nonsense falls back to 30', () => {
  const s = tmpDir('chatret-'); const now = Date.now();
  mkdirSync(path.join(s, '.claude-auth'), { recursive: true });
  writeFileSync(path.join(s, '.claude-auth', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 90 }));
  const keep = chat(s, 'p/a.jsonl', 41, now);
  assert.equal(pruneChats(s, { now }).removed, 0);
  assert.equal(existsSync(keep), true);
  writeFileSync(path.join(s, '.claude-auth', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 0 }));
  assert.equal(retentionDays(path.join(s, '.claude-auth')), DEFAULT_DAYS);
});

test('never follows a symlink out of projects/', () => {
  const s = tmpDir('chatret-'); const now = Date.now();
  const outside = path.join(s, 'wiki'); mkdirSync(outside, { recursive: true });
  const precious = path.join(outside, 'page.jsonl'); writeFileSync(precious, '{}');
  utimesSync(precious, (now - 400 * DAY) / 1000, (now - 400 * DAY) / 1000);
  mkdirSync(path.join(s, '.claude-auth', 'projects'), { recursive: true });
  symlinkSync(outside, path.join(s, '.claude-auth', 'projects', 'link'));
  pruneChats(s, { now });
  assert.equal(existsSync(precious), true);
});

test('a box with no chats at all is fine', () => {
  assert.deepEqual(pruneChats(tmpDir('chatret-')), { days: DEFAULT_DAYS, removed: 0, kept: 0 });
});
