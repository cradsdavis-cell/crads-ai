// claude-credential.test.mjs: one reader, and it only claims what it can see.
//   node --test engine/lib/claude-credential.test.mjs
//
// 2026-08-20 audit. Three files asked "is this box signed in to Claude" and each
// asked it differently: engine/heartbeat.mjs with existsSync, box-account.mjs
// with a non-empty read, box-cockpit.mjs with a truthy read. So a zero-byte
// credential file counted as a sign-in in two of the three, and all three named
// the answer as though it were about auth rather than about a file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readClaudeCredential } from './claude-credential.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

// A token shaped like the real thing, so a leak would be visible in the output.
const TOKEN = 'sk-ant-oat01-THIS-MUST-NEVER-LEAVE-THE-MODULE';
function box({ creds, account } = {}) {
  const dir = tmpDir('cred-');
  mkdirSync(join(dir, '.claude-auth'), { recursive: true });
  if (creds !== undefined) writeFileSync(join(dir, '.claude-auth', '.credentials.json'), creds);
  if (account !== undefined) writeFileSync(join(dir, '.claude-auth', '.claude.json'), account);
  return dir;
}
const signedIn = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: TOKEN, expiresAt: 1 } });

test('no credential file at all is not signed in', () => {
  assert.deepEqual(readClaudeCredential(box()), { present: false, account: null });
});

test('an EMPTY credential file is not signed in either', () => {
  // What a half-written sign-in leaves behind. box-account.mjs already refused to
  // count it and the heartbeat counted it, which is the drift this module ends.
  assert.equal(readClaudeCredential(box({ creds: '' })).present, false);
  assert.equal(readClaudeCredential(box({ creds: '   \n' })).present, false);
});

test('a credential plus an account file names the account', () => {
  const r = readClaudeCredential(box({ creds: signedIn, account: JSON.stringify({ oauthAccount: { emailAddress: 'member@example.com' } }) }));
  assert.deepEqual(r, { present: true, account: 'member@example.com' });
});

test('a missing or broken account file does not undo the credential', () => {
  // "Signed in, account unknown" is a real state and the callers already print
  // it (box-account emits UNKNOWN, box-up.sh reads it). Turning it into
  // NOT-SIGNED-IN would send a member to re-run a sign-in they already have.
  assert.deepEqual(readClaudeCredential(box({ creds: signedIn })), { present: true, account: null });
  assert.deepEqual(readClaudeCredential(box({ creds: signedIn, account: '{not json' })), { present: true, account: null });
  assert.deepEqual(readClaudeCredential(box({ creds: signedIn, account: '{}' })), { present: true, account: null });
});

test('THE PROMISE: nothing secret comes back out', () => {
  // The credential file holds live tokens. This module reads that file, so the
  // one thing it must never do is hand any of it on: the return value is logged
  // by box-up.sh, rendered in the app and (as `present`) pushed to a rock.
  const dir = box({ creds: signedIn, account: JSON.stringify({ oauthAccount: { emailAddress: 'member@example.com' } }) });
  const dump = JSON.stringify(readClaudeCredential(dir));
  assert.ok(!dump.includes(TOKEN), 'a token reached the caller: ' + dump);
  assert.ok(!/accessToken|refreshToken|sk-ant/.test(dump), 'no credential material at all: ' + dump);
  assert.deepEqual(Object.keys(readClaudeCredential(dir)).sort(), ['account', 'present'],
    'exactly two fields, and neither of them is a guess about whether the grant still works');
});

test('THE FIELD IT DOES NOT RETURN: the credential\'s own expiry', () => {
  // Deliberate, and the reason is measured rather than assumed. On 2026-08-20 a
  // working machine held claudeAiOauth.expiresAt = 2026-08-14T07:50:29Z, five
  // days and eighteen hours in the past, while Claude Code was running on it.
  // Claude Code renews in process and does not always rewrite the file, so a past
  // expiry is the ordinary state of a healthy box, and a health check built on it
  // would have lit up most of the fleet. The header says so; this pins it, so
  // nobody adds the field back on the strength of how sensible it sounds.
  const past = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.parse('2020-01-01T00:00:00Z') } });
  const r = readClaudeCredential(box({ creds: past }));
  assert.equal(r.present, true, 'a long-past expiry says nothing about presence');
  assert.equal(r.expires_at, undefined, 'and this module does not report an expiry it cannot interpret');
});


