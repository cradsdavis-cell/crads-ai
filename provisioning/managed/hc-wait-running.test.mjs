// hc-wait-running.test.mjs: waiting for a new VM survives a bad answer from
// Hetzner, and tells the truth about the two ways waiting can end badly.
//   node --test provisioning/managed/hc-wait-running.test.mjs
//
// Why this file exists. On 2026-08-10 a rock build died three seconds in on:
//
//   ✓ server 161073973 (cx33 @ nbg1)
//   ▸ Waiting for the VM to boot
//   curl: (22) The requested URL returned error: 404
//
// The VM had been created and then deleted underneath the build (every server
// in the project went that evening). But the message was the same one a rate
// limit or a 502 would have produced, because the boot-wait loop polled with
// `hc`, which is curl -f: any non-2xx exits 22, and under `set -e` that killed
// the script from inside the command substitution on the FIRST poll. The 60x3s
// retry could only ever retry "created, not running yet".
//
// The other half was quieter and worse: if the loop DID run out, it fell
// through to `ok "running at $IP"` with IP still "null" and wrote that into the
// state file. An exhausted wait looked like a built box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync, chmodSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, 'lib.sh');
const PEBBLE = join(HERE, 'provision-pebble.sh');
const ROCK = join(HERE, '..', 'rock', 'provision-rock.sh');

// lib.sh exits unless a deployment domain is set, and auto-sources .env.local
// from ITS OWN directory. Every run below therefore uses a COPY in a temp dir:
// no real .env.local is in scope, so no real token can ever load, and the
// stubbed curl on PATH means nothing can reach Hetzner even if one did.
const DOMAIN_ENV = { CF_TUNNEL_ROOT_DOMAIN: 'example.test', CF_ZONE_NAME: 'example.test' };

const OK = (ip = '203.0.113.9') =>
  `200|{"server":{"status":"running","public_net":{"ipv4":{"ip":"${ip}"}}}}`;
const BOOTING = '200|{"server":{"status":"initializing","public_net":{"ipv4":{"ip":null}}}}';
const GONE = '404|{"error":{"code":"not_found","message":"server not found"}}';
const NETWORK_DOWN = '000|';

/**
 * Run hc_wait_running against a scripted sequence of Hetzner answers.
 * Each entry is "<http_code>|<body>"; 000 means curl itself failed. The last
 * entry repeats forever, so a test only lists the answers it cares about.
 */
function wait(responses, { id = '161073973', tries = 5 } = {}) {
  const dir = tmpDir('hc-wait-');
  copyFileSync(LIB, join(dir, 'lib.sh'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'responses'), responses.join('\n') + '\n');
  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env bash
n=$(cat "$STUB_COUNTER" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB_COUNTER"
line="$(sed -n "\${n}p" "$STUB_RESPONSES")"
[ -n "$line" ] || line="$(tail -n1 "$STUB_RESPONSES")"
code="\${line%%|*}"; body="\${line#*|}"
[ "$code" = "000" ] && exit 7
printf '%s\\n%s' "$body" "$code"
`,
  );
  chmodSync(join(bin, 'curl'), 0o755);

  // gap 0: the wait's pacing is not what is under test. The EXIT trap reports
  // HC_WAIT_KEEP_SERVER on BOTH paths, since `die` exits before any trailing echo.
  const script = `. "${dir}/lib.sh"\n`
    + `trap 'echo "KEEP=\${HC_WAIT_KEEP_SERVER:-0}"' EXIT\n`
    + `hc_wait_running ${id} ${tries} 0\necho "IP=$SERVER_IPV4"`;
  const r = spawnSync('bash', ['-c', script], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...DOMAIN_ENV,
      PATH: `${bin}:${process.env.PATH}`,
      HCLOUD_TOKEN: 'stub-token-never-leaves-this-test',
      STUB_RESPONSES: join(dir, 'responses'),
      STUB_COUNTER: join(dir, 'counter'),
    },
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('a booting VM is waited out and its IPv4 handed back', () => {
  const r = wait([BOOTING, BOOTING, OK('203.0.113.9')]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /IP=203\.0\.113\.9/);
});

test('one bad answer does not kill the build (the 2026-08-10 regression)', () => {
  // This is the whole point of the file. Under the old `hc` loop each of these
  // exited 22 on the first poll and took the run with it.
  for (const blip of ['500|{"error":"internal"}', '429|{"error":"rate limited"}', NETWORK_DOWN, GONE]) {
    const r = wait([blip, BOOTING, OK()]);
    assert.equal(r.status, 0, `a single ${blip.split('|')[0]} must be survivable:\n${r.out}`);
    assert.match(r.out, /IP=203\.0\.113\.9/);
  }
});

test('a server that answers and THEN 404s repeatedly is reported as deleted', () => {
  // The distinction is the difference between "wait longer" and "someone is
  // tearing down your project while you build in it". It is only available once
  // the server has answered at least once: before that, see the two tests below.
  const r = wait([BOOTING, GONE, GONE, GONE, OK()]);
  assert.notEqual(r.status, 0, `must fail:\n${r.out}`);
  assert.match(r.out, /GONE/, 'says the server is gone');
  assert.match(r.out, /deleted it underneath/, 'and names the cause it actually is');
  assert.doesNotMatch(r.out, /IP=203/, 'and never returns a late IP after giving up');
});

test('a fresh server that 404s before it is ever seen is waited out, not buried', () => {
  // The 2026-08-12 regression. `aios-pebble-local-test-1` was created, 404ed on
  // its first three polls and was declared GONE ~6s later; the rollback trap then
  // deleted the VM, so the verdict proved itself and the evidence went with it.
  // Three 404s followed by a healthy answer is a build that must SUCCEED.
  const r = wait([GONE, GONE, GONE, OK('203.0.113.9')]);
  assert.equal(r.status, 0, `a 404 before the server is ever seen must be survivable:\n${r.out}`);
  assert.match(r.out, /IP=203\.0\.113\.9/, 'and the late IP is handed back');
  assert.doesNotMatch(r.out, /GONE/, 'and nothing is accused of deleting it');
});

test('a server that never once answers fails as unproven, and is NOT rolled back', () => {
  const r = wait([GONE], { tries: 4 });
  assert.notEqual(r.status, 0, `must fail:\n${r.out}`);
  assert.match(r.out, /never became visible/, 'says what it can actually prove');
  assert.doesNotMatch(r.out, /deleted it underneath/, 'and does not blame a teardown it cannot see');
  assert.match(r.out, /KEEP=1/, 'and tells the caller to leave the VM alone');
});

test('a rejected token says so instead of burning the full wait', () => {
  const r = wait(['401|{"error":{"code":"unauthorized"}}', OK()]);
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /HCLOUD_TOKEN/);
});

test('running out of attempts is a failure, not a box with a null IP', () => {
  const r = wait([BOOTING], { tries: 3 });
  assert.notEqual(r.status, 0, `an exhausted wait must not look like success:\n${r.out}`);
  assert.match(r.out, /never reached 'running'/);
  assert.doesNotMatch(r.out, /IP=null/, 'the old loop wrote exactly this into the state file');
});

test('both provisioners use the shared wait, and neither polls with hc again', () => {
  for (const [name, path] of [['pebble', PEBBLE], ['rock', ROCK]]) {
    const s = readFileSync(path, 'utf8');
    assert.match(s, /hc_wait_running "\$SERVER_ID"/, `${name} must use the shared wait`);
    assert.doesNotMatch(
      s,
      /for .*seq 1 60[\s\S]{0,200}hc "\$HC_API\/servers\//,
      `${name} must not go back to polling the server with curl -f in a loop`,
    );
  }
});
