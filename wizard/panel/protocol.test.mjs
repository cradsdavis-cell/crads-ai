import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractInvite, registerProtocolHandler } from './protocol.mjs';

test('extractInvite finds the deep link in argv and normalises to the web shape', () => {
  const frag = 'v1.acme.jane01.cGF5bG9hZA';
  assert.equal(extractInvite(['C:\\app.exe', `crads-ai://join/${frag}`]), `https://crads-ai.com/join#${frag}`);
  assert.equal(extractInvite(['node', 'app.mjs']), '');
  assert.equal(extractInvite([]), '');
  assert.equal(extractInvite(null), '');
  assert.equal(extractInvite(['evil://join/x', 'crads-ai://other/x']), '');
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
