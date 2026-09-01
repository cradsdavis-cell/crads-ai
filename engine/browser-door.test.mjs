// browser-door.test.mjs — the browser door is shut, and shutting it must never brick a box.
//
// Sam's ruling 2026-08-05: a box is reached with the Crads-AI app and Claude Code over
// SSH. The old shape published every box at https://<slug>.<domain> in front of
// code-server, whose entire gate was one shared 24-char password: no MFA, no rotation
// verb, no lockout, no per-device binding, on a surface that hands out a container
// terminal. Two ends had to close, and both are pinned here:
//
//   1. provisioning routes NOTHING at the IDE port, so the hostname has no surface
//   2. the box does not start the IDE at all, so there is nothing behind the port
//
// The hazard this file mainly exists for is (2). Both entrypoints USED the IDE process
// as the thing that kept the container alive: box-up.sh ended in `wait "$CSPID"` and
// boot-rock.sh `exec`ed code-server as PID 1's pebble. Remove the IDE naively and the
// entrypoint returns, the unit restarts it under Restart=always, and it returns again.
// That is not a degraded box, it is an unreachable one: the ONLY SSH door runs THROUGH
// this container, so the box cannot be entered to be repaired. brain-2 did exactly this
// 106 times on 2026-07-30 and needed Hetzner rescue mode plus the provider API token to
// recover, a credential no member has. So: an app-first entrypoint MUST block forever.
//
//   node --test engine/browser-door.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// executable text only: whole-line and trailing comments stripped, so prose about the
// old behaviour never satisfies (or trips) a pin about the current behaviour
const exec = (src) => src.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');

const BOX_UP = read('engine/box-up.sh');
const BOOT_ROCK = read('provisioning/rock/boot-rock.sh');
const MEMBER_CI = read('provisioning/managed/cloud-init.template.yaml');
const ROCK_CI = read('provisioning/rock/cloud-init.rock.template.yaml');
const PROV_CLIENT = read('provisioning/managed/provision-pebble.sh');
const PROV_ROCK = read('provisioning/rock/provision-rock.sh');
const WIZARD = read('wizard/engine.mjs');

// --- 1. the entrypoints must not be able to fall off the end when the IDE is off ------

test('box-up.sh blocks forever on the app-first path instead of returning', () => {
  const src = exec(BOX_UP);
  assert.match(src, /BROWSER_IDE:-on/, 'box-up.sh reads the flag');
  // the app-first branch must exist as its own arm, not share the interactive fallback
  assert.match(src, /elif \[ "\$\{BROWSER_IDE:-on\}" = "off" \]; then/,
    'app-first is its own branch in the banner if/else');
  const arm = src.split(/elif \[ "\$\{BROWSER_IDE:-on\}" = "off" \]; then/)[1] || '';
  const body = arm.split(/\nelse\b/)[0];
  assert.match(body, /sleep infinity/,
    'the app-first arm ends in a blocking call; without it the container exits and Restart=always loops');
  // `claude` in COMMAND position only. The arm legitimately names the binary inside a
  // help string ("open a terminal here and run claude"), and a bare word match would
  // fail on that while still missing `foo; claude`. What must never appear is an
  // invocation: the fallback arm's `cd "$BOX"; claude || true` returns immediately on a
  // headless box, which is the exact shape that turns this branch into a restart loop.
  assert.ok(!/(^|;|&&|\|\||\n)\s*claude\b/.test(body),
    'the app-first arm must NOT invoke interactive `claude`, which returns at once when headless');
});

test('boot-rock.sh replaces the code-server exec rather than skipping it', () => {
  const src = exec(BOOT_ROCK);
  assert.match(src, /BROWSER_IDE:-on/, 'boot-rock.sh reads the flag');
  // the guard has to come BEFORE the code-server exec, and has to exec something itself
  const guard = src.indexOf('BROWSER_IDE:-on');
  const csExec = src.search(/exec env HOME=.*code-server|exec env .*code-server/s);
  assert.ok(guard !== -1 && csExec !== -1 && guard < csExec,
    'the app-first guard precedes the code-server exec');
  const between = src.slice(guard, csExec);
  assert.match(between, /exec sleep infinity/,
    'the app-first path execs a blocking process; a bare exit here is a restart loop');
});

// --- 2. legacy boxes must not lose their door to an image update ----------------------

test('the flag defaults to ON when absent, so a pre-2026-08-05 box is untouched', () => {
  // Both scripts ship in the image. An old-era client box reaches its
  // box through this door and is hands-off per Sam's 2026-07-28 ruling, so it must keep
  // working when it pulls a new :v2 and finds a flag its cloud-init never wrote.
  for (const [name, src] of [['box-up.sh', BOX_UP], ['boot-rock.sh', BOOT_ROCK]]) {
    assert.match(exec(src), /\$\{BROWSER_IDE:-on\}/,
      `${name} defaults the flag to on, never off`);
    assert.ok(!/\$\{BROWSER_IDE:-off\}/.test(exec(src)),
      `${name} must not default the flag to off (that would cut a live client's access)`);
  }
});

// --- 3. new boxes are stamped with the door shut --------------------------------------

test('both cloud-init templates stage BROWSER_IDE=off into the container env', () => {
  for (const [name, ci] of [['member', MEMBER_CI], ['rock', ROCK_CI]]) {
    assert.match(ci, /^\s*BROWSER_IDE=off\s*$/m, `${name} cloud-init stages the flag`);
    // it has to land in the file docker actually reads
    const envBlock = ci.split('/etc/ai-os/env')[1] || '';
    assert.match(envBlock.slice(0, 800), /BROWSER_IDE=off/,
      `${name} stages it inside /etc/ai-os/env (the --env-file docker run reads)`);
  }
  assert.match(MEMBER_CI, /--env-file \/etc\/ai-os\/env/, 'member container reads that env file');
  assert.match(ROCK_CI, /--env-file \/etc\/ai-os\/env/, 'rock container reads that env file');
});

// --- 4. no provisioning path publishes the IDE port ----------------------------------

test('no provisioning path routes a tunnel at the IDE port', () => {
  for (const [name, src] of [
    ['provision-pebble.sh', PROV_CLIENT],
    ['provision-rock.sh', PROV_ROCK],
    ['wizard/engine.mjs', WIZARD],
  ]) {
    const ingress = src.match(/ingress[^\n]*\n?[^\n]*/g) || [];
    for (const line of ingress) {
      assert.ok(!/7781/.test(line),
        `${name} must not route ingress at 7781 (a public code-server is the surface we closed)`);
    }
  }
});

test('the tunnel and DNS record still exist in the legacy shell path, so its teardown keeps working', () => {
  // Shutting the door is an ingress change, NOT a "stop making tunnels" change: teardown
  // deletes by tunnel id. The JS engine's tunnel path DIED with the org wizard
  // (2026-09-01; the self-host flow makes no tunnels at all), so only the
  // legacy shell provisioners are pinned here until they retire too.
  assert.match(PROV_CLIENT, /cfd_tunnel/, 'member provisioning still creates a tunnel');
  assert.match(PROV_CLIENT, /dns_records/, 'member provisioning still creates the DNS record');
  assert.ok(!/cfd_tunnel/.test(WIZARD), 'the stripped engine reaches no Cloudflare API');
});

// --- 5. the Access block must not assert an exposure the door-shut ruling removed ------
//
// Trap 31 (2026-08-10): the Access-app call kept only the `id`, so every failure became
// one indistinguishable "could not create" naming no cause, and the account-wide
// `access.api.error.not_enabled` hid behind it from the day the block was written. The
// warning ALSO claimed the box was "code-server-password-only", which stopped being true
// on 2026-08-05 when the hostname started routing http_status:404.
//
// That repair landed in the brain-template repo's factory/stamp-pebble.sh and NOT in this
// repo's rock path, which kept the false claim for another fifteen days until 2026-08-25.
// A comment saying "mirrors <file in another repo>" is not a test, and cross-repo is
// exactly where a half-applied fix hides. This pins the ai-os half.

test('no provisioning path claims a password-only exposure the 404 ruling removed', () => {
  for (const [name, src] of [
    ['provision-rock.sh', PROV_ROCK],
    ['provision-pebble.sh', PROV_CLIENT],
  ]) {
    // executable text only: the prose ABOVE these blocks legitimately explains what
    // "password only" used to mean, and must stay readable without tripping this pin
    assert.doesNotMatch(exec(src), /password[- ]only/i,
      `${name} must not tell an operator the box is password-only; since 2026-08-05 the ` +
      `hostname routes http_status:404, so there is no browser door and no password gate`);
  }
});

test('the rock Access failure prints what the API said, not eleven words naming no cause', () => {
  const src = exec(PROV_ROCK);
  // the whole response is kept, not just the id parsed out of it
  assert.match(src, /ACCESS_RESP=/,
    'provision-rock.sh keeps the whole Access API response');
  assert.match(src, /ACCESS_RESP[\s\S]{0,400}?\.errors\[0\]\.message/,
    'the failure branch reads the error message out of that response');
  // and the id still comes from the SAME response, not a second call
  assert.match(src, /ACCESS_APP_ID=[\s\S]{0,120}?ACCESS_RESP/,
    'the app id is parsed from the kept response rather than a separate request');
});

test('an Access failure is loud (warn/stderr), not a dim line that scrolls past', () => {
  // A stamp that believes it is email-gating and is not must surface. `warn` is red and
  // goes to stderr; `say "${c_dim}WARN: ..."` is grey on stdout and reads as noise.
  const src = exec(PROV_ROCK);
  const block = src.slice(src.indexOf('access/apps'));
  assert.ok(!/say\s+"\s*\$\{c_dim\}WARN/.test(block),
    'the Access branch must not report failure with a dim say(); use warn()');
  assert.match(block, /\n\s*warn\s+"/,
    'the Access failure branch calls warn()');
});
