import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as protocol from './protocol.mjs';

const { registerProtocolHandler } = protocol;

test('RETIREMENT PIN (self-host sweep, 2026-09-01): the join deep link stays dead', () => {
  // Invitations-to-a-box cannot exist with nothing central. extractInvite was
  // the argv hook that routed crads-ai://join/ links to the retired invite
  // surface; an old link now just opens the app (the door explains the flows).
  assert.equal(protocol.extractInvite, undefined, 'extractInvite must not come back');
  const app = readFileSync(new URL('../app.mjs', import.meta.url), 'utf8');
  assert.ok(!app.includes('extractInvite'), 'app.mjs must not route join links anywhere');
});

test('windows registration writes the three HKCU keys with the exe path', async () => {
  const calls = [];
  const runner = async (cmd, args) => { calls.push([cmd, ...args].join(' ')); };
  const r = await registerProtocolHandler({ execPath: 'C:\\Apps\\Crads-AI.exe', platform: 'win32', runner });
  assert.equal(r.done, true);
  const all = calls.join('\n');
  assert.match(all, /HKCU\\Software\\Classes\\crads-ai \/ve/);
  assert.match(all, /URL Protocol/);
  assert.match(all, /shell\\open\\command .* "C:\\Apps\\Crads-AI\.exe" "%1"/);
});

test('mac + linux are honest no-ops', async () => {
  assert.equal((await registerProtocolHandler({ platform: 'darwin' })).done, false);
  assert.equal((await registerProtocolHandler({ platform: 'linux' })).done, false);
});

test('a failing reg write reports, never throws', async () => {
  const runner = async () => { throw new Error('registry denied'); };
  const r = await registerProtocolHandler({ platform: 'win32', runner });
  assert.equal(r.done, false);
  assert.match(r.reason, /denied/);
});
