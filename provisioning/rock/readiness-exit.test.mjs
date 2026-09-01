// readiness-exit.test.mjs — a rock that never served must not report success.
// Run: node --test provisioning/rock/readiness-exit.test.mjs
//
// Why this file exists. provision-pebble.sh (the PEBBLE path) fixed this on
// 2026-07-20 and says so in its own comment: "Callers must see a non-zero exit
// either way." provision-rock.sh (the ROCK path) still printed
// "⚠ not serving yet — likely still pulling" and fell through to exit 0.
//
// The caller is cockpit/jobs/fulfil-arrivals.mjs. On a zero exit its buildRock
// path unconditionally takes the success branch: it posts progress done/100,
// emails the owner that it is up with a link to it, records the request
// as fulfilled, writes the durable `built:` marker (so re-submitting the name
// answers "you already have this one"), and creates the Stripe subscription.
//
// So a stranger whose rock box crash-looped or pulled a bad image was
// told it was ready, given a link to nothing, billed, and blocked from
// retrying under the same name. Exactly what the pebble path refuses to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const rock = readFileSync(join(HERE, 'provision-rock.sh'), 'utf8');
const pebble = readFileSync(join(HERE, '..', 'managed', 'provision-pebble.sh'), 'utf8');

// the not-ready branch: from the readiness verdict to the end of that if-block.
// The verdict moved from a boolean ($READY) to a three-state string
// ($READY_STATE: live | reachable | timeout) on 2026-08-09, when the old
// 200/302 probe was found to be polling the browser door the 2026-08-05 ruling
// shut — it could never pass, so it burned 12 minutes and exited 9 on a
// perfectly healthy rock. The intent this file guards is unchanged.
function notReadyBranch(src) {
  const i = src.indexOf('if [ "$READY_STATE" = "live" ]');
  assert.ok(i > -1, 'the readiness branch must still exist');
  return src.slice(i, i + 1200);
}

test('the rock path exits non-zero when the box never served', () => {
  const branch = notReadyBranch(rock);
  assert.match(branch, /exit [1-9]/, 'a box that never answered is not a successful build');
});

test('it matches the pebble path, which already got this right', () => {
  const p = notReadyBranch(rock).match(/exit ([1-9]\d*)/);
  const c = notReadyBranch(pebble).match(/exit ([1-9]\d*)/);
  assert.ok(c, 'the pebble path must still exit non-zero');
  assert.equal(p[1], c[1], 'the same failure should carry the same exit code on both paths');
});

test('the success branch is untouched: a live box still exits cleanly', () => {
  const branch = notReadyBranch(rock);
  const ok = branch.indexOf('rock is $READY_STATE');
  const ex = branch.search(/exit [1-9]/);
  assert.ok(ok > -1 && ex > ok, 'the non-zero exit must sit in the failure half, not the success half');
});

test('the operator is still told what to do, not just failed at', () => {
  const branch = notReadyBranch(rock);
  assert.match(branch, /VM|tunnel|DNS|deprovision|journalctl|systemctl/i,
    'the infra exists and is recoverable; say so rather than exiting silently');
});

// --- 2026-08-09 regression pins -------------------------------------------
// The bug: both provisioners waited for code-server (200/302) on a hostname
// that provisioning deliberately routes at NOTHING since the browser-door-shut
// ruling. Healthy boxes could only ever time out. Sam's own `test-org-2` rock
// was reported to him as a failed build while sshd answered, the container ran
// and the org brain sat on disk.
test('neither path waits for the browser door that provisioning shut', () => {
  for (const [name, src] of [['rock', rock], ['pebble', pebble]]) {
    assert.doesNotMatch(src, /code=.*url_status[\s\S]{0,120}"\$code" = "200"/,
      `${name}: still gates readiness on a 200/302 from the shut browser door`);
    assert.match(src, /wait_for_box/, `${name}: must use the two-layer readiness probe`);
  }
});

test('a rock proves itself as aios-op, a pebble as member', () => {
  assert.match(rock, /AIOS_READY_USER=aios-op wait_for_box/, "a rock's door is aios-op");
  assert.match(pebble, /AIOS_READY_USER=member wait_for_box/, "a pebble's door is member");
});

test('reachable (tunnel up, no key) is accepted, timeout is not', () => {
  const branch = notReadyBranch(rock);
  const head = rock.slice(rock.indexOf('READY_STATE='), rock.indexOf('READY_STATE=') + 400);
  assert.match(head, /"reachable"/, 'a tunnel-level proof must be accepted when no key is available');
  assert.match(branch, /exit [1-9]/, 'a timeout must still fail the build');
});

// ---- 2026-08-12: a key must not be able to DISABLE the probe ----
//
// wait_for_box gated its tunnel arm on `[ -z "$key" ]`, so configuring
// AIOS_READY_SSH_KEY did not add a check, it replaced the working one. On a
// recycled Hetzner IP the ssh arm then failed every attempt (stale known_hosts
// pin + `accept-new`, which auto-accepts an unknown host and REFUSES a changed
// one), the tunnel arm was switched off, and a healthy rock burned twelve
// minutes and exited 9. Same class as the bug this file already guards: the box
// was fine and the machinery said otherwise.
const lib = readFileSync(join(HERE, '..', 'managed', 'lib.sh'), 'utf8');

function waitForBoxBody() {
  const i = lib.indexOf('wait_for_box(){');
  assert.ok(i > -1, 'wait_for_box must still exist');
  return lib.slice(i, lib.indexOf('\n}', i));
}

test('a configured ready-key cannot switch the tunnel probe off', () => {
  const body = waitForBoxBody();
  // the tunnel arm must run unconditionally; only the EARLY RETURN may be
  // gated on there being no key, because a key promises a stronger answer.
  assert.match(body, /seen_tunnel=1/,
    'the tunnel arm must record that it saw the tunnel even when a key is set');
  assert.doesNotMatch(body, /\*\)\s*\[ -z "\$key" \] && \{ echo "reachable"; return 0; \} ;;/,
    'the tunnel arm must not be gated entirely on the absence of a key');
});

test('ssh silence with a live tunnel reports reachable, never timeout', () => {
  const body = waitForBoxBody();
  const tail = body.slice(body.lastIndexOf('done'));
  assert.match(tail, /seen_tunnel[\s\S]{0,200}echo "reachable"/,
    'a box whose tunnel answered must not be reported as a failed build');
  assert.match(tail, /echo "timeout"/,
    'a box that never answered on any layer must still time out');
});

test('the liveness probe does not consult known_hosts', () => {
  // These boxes are ephemeral and Hetzner recycles addresses, so a host-key pin
  // is a stale-data source rather than a security control. The probe runs `true`
  // and carries no payload; what it proves is that OUR key opens the door.
  const body = waitForBoxBody();
  assert.match(body, /UserKnownHostsFile=\/dev\/null/,
    'the probe must not be defeated by a pin left behind by a destroyed box');
  assert.doesNotMatch(body, /StrictHostKeyChecking=accept-new/,
    'accept-new refuses a CHANGED key, which is exactly the recycled-IP case');
});
