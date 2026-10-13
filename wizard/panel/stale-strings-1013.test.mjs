// stale-strings-1013.test.mjs: the 13 Oct 2026 docs review found panel and door
// copy that named things that no longer exist (the Claude Code tab, the Map page,
// a "Start over" button) or spoke to one host only. Pinned as structure where it
// can be, and as the absence of the stale words everywhere else.
//   node --test wizard/panel/stale-strings-1013.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepWords } from './build-box.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const member = readFileSync(join(HERE, 'member.html'), 'utf8');
const door = readFileSync(join(HERE, 'door.html'), 'utf8');
const buildBox = readFileSync(join(HERE, 'build-box.mjs'), 'utf8');

test('Update and restart is sent to Help, where the button lives, never to the retired Claude Code tab', () => {
  assert.match(member, /<button class="act" id="boxRefreshBtn">Update and restart<\/button>/, 'the button is on Help');
  assert.match(member, /var MCP_TOO_OLD = '[^']*Open Help, press Update and restart/, 'the connect refusal names Help');
  assert.match(member, /Open <b>Help<\/b> and press <b>Update and restart<\/b>/, 'the Connections banner names Help');
  assert.doesNotMatch(member, /Open the Claude Code tab|Open the <b>Claude Code<\/b> tab/, 'no live copy names the tab');
});

test('a computer that is not let in is pointed at Add a device, not the retired Map page', () => {
  assert.doesNotMatch(member, /Map page/, 'the Map page is gone');
  assert.match(member, /choose Add a device/, 'the real way in');
  assert.match(door, /a\.textContent = 'Add a device';/, 'and the door really has that control');
});

test('a stopped assistant names both hosts, not Hetzner alone', () => {
  assert.match(member, /hosting console \(Hetzner or DigitalOcean\)/);
  assert.doesNotMatch(member, /hosting console \(Hetzner\)/);
});

test('the backup line renders a readable local date, not the raw ISO stamp', () => {
  assert.match(member, /function sentWhen\(v\)\{/);
  assert.equal((member.match(/seatEsc\(sentWhen\(b\.last\)\)/g) || []).length, 2, 'both faces of the Backup card use it');
  assert.doesNotMatch(member, /seatEsc\(b\.last \|\|/);
});

test('"this computer", not "your laptop", for what the desktop app signs in', () => {
  assert.ok(!/signs in (<b>)?your laptop/.test(member), 'member copy says this computer');
});

test('the Your mineral comment no longer claims a "Your pebble" default', () => {
  assert.doesNotMatch(member, /static default stays "Your pebble"/);
});

test('door build steps read as plain words, never raw step ids', () => {
  assert.equal(stepWords('validate-token'), 'Checking your hosting token');
  assert.equal(stepWords('create-server', 'cx33 @ nbg1'), 'Creating your server');
  assert.equal(stepWords('wait-running'), 'Waiting for the server to switch on');
  assert.equal(stepWords('done', '203.0.113.9'), 'Server switched on, at 203.0.113.9');
  assert.equal(stepWords('something-new', 'x'), 'something-new (x)', 'an unknown step still shows, as itself');
  assert.match(buildBox, /run\.steps\.push\(stepWords\(step, detail\)\)/);
});

test('a failed build names the buttons that are really there, in a sentence', () => {
  assert.ok(!(buildBox + door).includes('Start over'), 'no button by that name exists');
  assert.match(door, /<button class="act" id="shRetryBtn">Retry<\/button>/);
  assert.match(door, /<button class="act" id="shDestroyBtn">Remove the half-made server<\/button>/);
  assert.match(door, /Press Retry to carry on from where it stopped, or Remove the half-made server/);
  assert.match(door, /em = em\.charAt\(0\)\.toUpperCase\(\) \+ em\.slice\(1\);/, 'capitalised whatever the source');
});

test('the door footer about status dots hides when nothing is listed', () => {
  assert.match(door, /<div class="foot" id="invFoot">/);
  assert.match(door, /getElementById\('invFoot'\)\.style\.display = fresh \? 'none' : '';/);
});

test('the finish checklist does not tell people to type claude when the button runs it', () => {
  const hint = door.match(/<p class="hint" id="shClaudeHint">([^<]*(?:<[^/][^>]*>[^<]*<\/[^>]+>[^<]*)*)<\/p>/);
  assert.ok(hint, 'the hint exists');
  assert.doesNotMatch(hint[1], /run <span class="mono">claude<\/span> once/);
  assert.match(hint[1], /sign-in starts by itself/);
});
