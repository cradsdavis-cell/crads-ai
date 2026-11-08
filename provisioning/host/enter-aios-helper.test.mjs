// enter-aios-helper.test.mjs: helper sessions are recorded on the HOST.
//   node --test provisioning/host/enter-aios-helper.test.mjs
// Spec: docs/superpowers/specs/2026-11-08-helper-access-design.md section 5.
// Runs the real script with a fake `docker` on PATH and a fake ExposeAuthInfo
// file, so it proves the branch logic without a box. Nothing here can reach a
// container: the fake echoes what it would have run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'enter-aios');
const GRANT = 'req_0123456789abcdef';

function rig() {
  const dir = tmpDir('enter-aios-');
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const home = join(dir, 'home'); mkdirSync(home);
  const key = (n) => {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', n, '-f', join(dir, n)]);
    const pub = readFileSync(join(dir, n + '.pub'), 'utf8').trim();
    const auth = join(dir, n + '.auth');
    writeFileSync(auth, `publickey ${pub}\n`);
    const fp = execFileSync('ssh-keygen', ['-lf', join(dir, n + '.pub')], { encoding: 'utf8' }).split(' ')[1];
    return { auth, fp };
  };
  const helper = key('helper'), member = key('member');
  // fake docker: running container; `exec -w /state ai-os cat ssh/<u>/helpers`
  // answers the helper index; every other exec prints what it would run.
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
[ "$1" = inspect ] && { echo true; exit 0; }
[ "$1" = exec ] && [ "$5" = cat ] && { echo "${helper.fp} ${GRANT}"; exit 0; }
echo "RAN $*"; echo "an error line" >&2
`);
  chmodSync(join(bin, 'docker'), 0o755);
  const run = (env) => spawnSync('bash', [SCRIPT], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, USER: 'member', ...env },
    encoding: 'utf8', input: '',
  });
  const logs = () => {
    const d = join(home, 'crads-sessions', GRANT);
    return existsSync(d) ? readdirSync(d).map((f) => readFileSync(join(d, f), 'utf8')) : [];
  };
  return { helper, member, run, logs, home };
}

test("a helper's command is recorded on the host, output and errors included", () => {
  const t = rig();
  const r = t.run({ SSH_USER_AUTH: t.helper.auth, SSH_ORIGINAL_COMMAND: 'ls /state' });
  assert.match(r.stdout, /RAN exec -i -e AIOS_LOGIN=member -e AIOS_HOST_RECORDS=1 -w \/state ai-os bash -lc ls \/state/);
  const [log] = t.logs();
  assert.ok(log, 'a record exists');
  assert.match(log, new RegExp(`key ${t.helper.fp.replace(/[+/]/g, '\\$&')}: ls /state`));
  // tee writes asynchronously after exec; give it a beat
  spawnSync('sleep', ['0.3']);
  assert.match(t.logs()[0], /RAN exec/);
});

test("a helper's SFTP is logged by sftp-server itself into the record", () => {
  const t = rig();
  const r = t.run({ SSH_USER_AUTH: t.helper.auth, SSH_ORIGINAL_COMMAND: 'internal-sftp' });
  assert.match(r.stdout, /sftp-server -l INFO -e$/m);
  assert.equal(t.logs().length, 1);
});

test("the member's own sessions are never recorded", () => {
  const t = rig();
  const r = t.run({ SSH_USER_AUTH: t.member.auth, SSH_ORIGINAL_COMMAND: 'ls' });
  assert.match(r.stdout, /RAN exec -i -e AIOS_LOGIN=member -e AIOS_HOST_RECORDS=1 -w \/state ai-os bash -lc ls/);
  assert.equal(t.logs().length, 0);
});

test('the member reads the record from the host; a helper asking the same runs it in the container', () => {
  const t = rig();
  t.run({ SSH_USER_AUTH: t.helper.auth, SSH_ORIGINAL_COMMAND: 'whoami' });
  const mine = t.run({ SSH_USER_AUTH: t.member.auth, SSH_ORIGINAL_COMMAND: `crads-helper-sessions ${GRANT}` });
  assert.match(mine.stdout, /: whoami/, 'the member sees what the helper ran');
  assert.doesNotMatch(mine.stdout, /bash -lc crads-helper-sessions/, 'answered on the host, never inside the container');
  const theirs = t.run({ SSH_USER_AUTH: t.helper.auth, SSH_ORIGINAL_COMMAND: 'crads-helper-sessions' });
  assert.match(theirs.stdout, /RAN exec .* bash -lc crads-helper-sessions/, 'the helper only reaches the container');
});

test('a host whose sshd does not expose the key records nothing and claims nothing', () => {
  const t = rig();
  const r = t.run({ SSH_ORIGINAL_COMMAND: 'ls' });
  assert.doesNotMatch(r.stdout, /AIOS_HOST_RECORDS/);
  assert.equal(t.logs().length, 0);
});

test('the read verb cannot be steered outside the record folder', () => {
  const t = rig();
  t.run({ SSH_USER_AUTH: t.helper.auth, SSH_ORIGINAL_COMMAND: 'whoami' });
  const r = t.run({ SSH_USER_AUTH: t.member.auth, SSH_ORIGINAL_COMMAND: 'crads-helper-sessions ../../etc' });
  assert.doesNotMatch(r.stdout, /root:/);
});
