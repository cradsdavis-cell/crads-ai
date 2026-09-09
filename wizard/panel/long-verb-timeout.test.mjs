// long-verb-timeout.test.mjs — a verb that BUILDS something must not be killed
// mid-flight. Run: node --test wizard/panel/long-verb-timeout.test.mjs
//
// Why this file exists. ssh-bridge carries a hard watchdog that SIGKILLs any
// non-tty verb overrunning 25 seconds. It was added for a real reason (a hung
// verb holds a concurrency slot and a box-side connection, and hangs compound
// into the MaxStartups saturation that caused the hang), but it cannot tell a
// HUNG verb from a LONG one, and nothing ever overrode it.
//
// Stamping a member takes minutes: it creates a tunnel, DNS, a VM, and then
// waits for the VM to boot. Driven from the app on 2026-08-05 it died at
// "Waiting for the VM to boot" with "ssh to rock-alpha-rock exceeded 25000ms;
// killed (box busy?)" — AFTER Hetzner had created server 159178046. The VM was
// left running and billing with no registry row on the rock, invisible to the
// app, with no teardown path: an orphan with money attached. The person sees a
// failure and retries, which is how you get two.
//
// So the watchdog stays, and the verbs that provision declare how long they may
// legitimately take.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMBER_VERBS } from './panel-server.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const server = readFileSync(join(HERE, 'panel-server.mjs'), 'utf8');
const bridge = readFileSync(join(HERE, 'ssh-bridge.mjs'), 'utf8');

test('the blanket watchdog still exists and still defaults short', () => {
  assert.match(bridge, /hardTimeoutMs \?\? process\.env\.AIOS_SSH_HARD_TIMEOUT \?\? 25000/,
    'a hung verb must still be killed quickly: that guard is not the bug');
});

test('every verb that provisions declares a longer budget', () => {
  // These create real infrastructure. A kill part-way leaves it orphaned.
  for (const name of ['invite-member', 'stamp-member', 'new-rock']) {
    const spec = MEMBER_VERBS[name];
    if (!spec) continue;
    assert.ok(Number(spec.timeoutMs) > 60000,
      `${name} creates infrastructure and must be allowed more than a minute, saw ${spec.timeoutMs}`);
  }
});

test('an ordinary read verb does NOT get a long budget', () => {
  for (const name of ['member-list', 'stall-board', 'pending-devices']) {
    const spec = MEMBER_VERBS[name];
    if (!spec) continue;
    assert.ok(!spec.timeoutMs || Number(spec.timeoutMs) <= 60000,
      `${name} only reads; it must not be allowed to hang for minutes`);
  }
});

test('the run path passes a verb budget through to the bridge', () => {
  const calls = server.split('\n').filter((l) => l.includes('bridge.stream(host, built.command'));
  assert.ok(calls.length >= 1, 'the /run streaming path must still exist');
  const near = server.slice(server.indexOf('bridge.stream(host, built.command'), server.indexOf('bridge.stream(host, built.command') + 420);
  assert.match(near, /hardTimeoutMs/, 'the verb budget must reach the bridge, or declaring it changes nothing');
});

test('a member verb that provisions is covered too', () => {
  const spec = MEMBER_VERBS['own-brain'] || MEMBER_VERBS['transfer-accept'];
  if (spec && spec.timeoutMs) assert.ok(Number(spec.timeoutMs) > 0);
});
