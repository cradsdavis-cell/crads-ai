// P3.5: opening the app opportunistically pushes owned brains (fail-silent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushOwnedBrains } from './brain-push.mjs';

function bridgeScript(responses) {
  const cmds = [];
  const run = async (host, cmd) => { cmds.push({ host, cmd }); return responses(host, cmd); };
  run.cmds = cmds;
  return run;
}

test('pushes only boxes with an owned brain (origin remote present), silently skips the rest', async () => {
  const bridge = bridgeScript((host, cmd) => {
    if (cmd.includes('remote get-url')) return host === 'jane01-box' ? { code: 0, stdout: 'git@github.com:jane-gh/jane01-brain.git\n' } : { code: 1, stdout: '', stderr: 'no origin' };
    return { code: 0, stdout: '', stderr: '' };
  });
  const out = await pushOwnedBrains({ targets: [{ host: 'jane01-box', kind: 'member' }, { host: 'bob02-box', kind: 'member' }, { host: 'acme-rock', kind: 'rock' }], bridge });
  assert.deepEqual(out.pushed, ['jane01-box']);
  assert.ok(!bridge.cmds.some((c) => c.host === 'acme-rock'), 'rocks untouched');
  const push = bridge.cmds.filter((c) => c.host === 'jane01-box').map((c) => c.cmd).join('\n');
  // 2026-08-20 audit: this used to assert on an open-coded `git add -A` and
  // `git push`, which was the fourth path pushing this tree and the only
  // unattended one, carrying none of brain-push.sh's protective-.gitignore
  // refusal or its untrack pass. Asserting the DELEGATION is the point now: a
  // literal push here would be the bug coming back.
  assert.match(push, /brain-push\.sh/, 'the guarded pusher does the pushing');
  assert.doesNotMatch(push, /git add -A/, 'never open-code a push of the brain tree again');
});

test('a failing push never throws, just reports', async () => {
  const bridge = bridgeScript((host, cmd) => {
    if (cmd.includes('remote get-url')) return { code: 0, stdout: 'git@github.com:x/y.git\n' };
    return { code: 1, stdout: '', stderr: 'network down' };
  });
  const out = await pushOwnedBrains({ targets: [{ host: 'jane01-box', kind: 'member' }], bridge });
  assert.deepEqual(out.pushed, []);
  assert.equal(out.failed.length, 1);
});

test('no member targets: no SSH at all', async () => {
  const bridge = bridgeScript(() => ({ code: 0, stdout: '' }));
  const out = await pushOwnedBrains({ targets: [{ host: 'acme-rock', kind: 'rock' }], bridge });
  assert.equal(bridge.cmds.length, 0);
  assert.deepEqual(out.pushed, []);
});
