// claude-settings.test.mjs: the Claude Code start folder (R18, 2026-08-23).
//   node --test wizard/panel/claude-settings.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerClaudeSshConfig, startDirectoryFor, syncClaudeStartDir, OPEN_FOLDER_PROBE } from './claude-settings.mjs';
import { MEMBER_VERBS } from './panel-server.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const tmp = () => tmpDir('claude-settings-');

test('startDirectoryFor: /state/<name> for a sane name, /state otherwise', () => {
  assert.equal(startDirectoryFor('jane01\n'), '/state/jane01');
  assert.equal(startDirectoryFor('harriets-rock'), '/state/harriets-rock');
  assert.equal(startDirectoryFor('control-centre\n'), '/state/control-centre');
  assert.equal(startDirectoryFor('member\njane01\n'), '/state/jane01', 'last non-empty line wins');
  assert.equal(startDirectoryFor('state\n'), '/state', 'the no-link answer');
  assert.equal(startDirectoryFor(''), '/state');
  assert.equal(startDirectoryFor(undefined), '/state');
  assert.equal(startDirectoryFor('../etc\n'), '/state', 'nothing unsafe ever becomes a path');
  assert.equal(startDirectoryFor('Harriet Rock\n'), '/state', 'the box writes safe names; anything else is ignored');
});

test('the panel verb and the app probe are the same command', () => {
  assert.equal(MEMBER_VERBS['open-folder'].build().command, OPEN_FOLDER_PROBE);
  assert.equal(OPEN_FOLDER_PROBE, 'cat /state/open-folder 2>/dev/null || echo state');
  assert.ok(!MEMBER_VERBS['open-folder'].mutating, 'read-only');
});

test('syncClaudeStartDir updates one entry, touches nothing else, never creates', () => {
  const p = join(tmp(), 'settings.json');
  assert.deepEqual(syncClaudeStartDir('x-box', 'x', p), { ok: true, changed: false, startDirectory: '/state/x' }, 'no file: nothing to sync');
  writeFileSync(p, JSON.stringify({ theme: 'dark', sshConfigs: [
    { id: 'a-box', name: 'a', sshHost: 'a-box', startDirectory: '/state' },
    { id: 'b-rock', name: 'b', sshHost: 'b-rock', startDirectory: '/state' },
  ] }, null, 2) + '\n');
  const r = syncClaudeStartDir('b-rock', 'b\n', p);
  assert.deepEqual(r, { ok: true, changed: true, startDirectory: '/state/b' });
  const obj = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(obj.theme, 'dark');
  assert.equal(obj.sshConfigs[0].startDirectory, '/state', 'the other entry is untouched');
  assert.equal(obj.sshConfigs[1].startDirectory, '/state/b');
  assert.equal(syncClaudeStartDir('b-rock', 'b\n', p).changed, false, 'idempotent');
  assert.equal(syncClaudeStartDir('b-rock', 'state\n', p).startDirectory, '/state', 'and back to /state when the box says so');
  assert.equal(syncClaudeStartDir('nope', 'x', p).changed, false, 'unknown id: no-op');
  writeFileSync(p, '{not json');
  assert.equal(syncClaudeStartDir('b-rock', 'b', p).ok, false);
  assert.equal(readFileSync(p, 'utf8'), '{not json', 'a corrupt file is never rewritten');
});

test('register + sync round trip: /state first, then the mineral-named folder', () => {
  const p = join(tmp(), 'settings.json');
  registerClaudeSshConfig({ id: 'jane01-box', name: 'Jane', sshHost: 'jane01-box', startDirectory: startDirectoryFor('') }, p);
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).sshConfigs[0].startDirectory, '/state');
  syncClaudeStartDir('jane01-box', 'jane01\n', p);
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).sshConfigs[0].startDirectory, '/state/jane01');
});
