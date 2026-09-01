// enter-aios-parity.test.mjs: one landing wrapper for both faces (R18, 2026-08-23).
//   node --test provisioning/host/enter-aios-parity.test.mjs
//
// Until R18 the rock's enter-aios was a second, hand-maintained copy inside
// cloud-init.rock.template.yaml, and it had drifted: it landed in /state/brain
// while the pebble landed in /state, and it had never received the pebble's
// break-glass block (a stopped container meant a dead door with nothing to
// read). Now the rock template embeds provisioning/host/enter-aios gz+b64 and
// this test decodes it, so the two cannot drift again without failing here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const CANON = readFileSync(join(HERE, 'enter-aios'), 'utf8');
const ROCK_TPL = readFileSync(join(REPO, 'provisioning', 'rock', 'cloud-init.rock.template.yaml'), 'utf8');

export function rockEnterAios(tpl = ROCK_TPL) {
  const m = tpl.match(/  - path: \/usr\/local\/bin\/enter-aios\n    permissions: '0755'\n    encoding: gz\+b64\n    content: (\S+)\n/);
  assert.ok(m, 'the rock template carries enter-aios as a gz+b64 write_files entry');
  return gunzipSync(Buffer.from(m[1], 'base64')).toString('utf8');
}

test('the rock template embeds provisioning/host/enter-aios byte for byte', () => {
  assert.equal(rockEnterAios(), CANON,
    'rock enter-aios drifted from provisioning/host/enter-aios: run `bash provisioning/rock/embed-enter-aios.sh`');
});

test('both faces land in /state, never /state/brain', () => {
  const execs = CANON.split('\n').filter((l) => /^\s*exec docker exec /.test(l));
  assert.equal(execs.length, 3, 'sftp, remote command, interactive shell');
  for (const l of execs) {
    assert.match(l, / -w \/state ai-os /, `lands in /state: ${l.trim()}`);
    assert.doesNotMatch(l, /\/state\/brain/, `no rock-only landing dir: ${l.trim()}`);
    assert.match(l, /-e AIOS_LOGIN="\$USER"/, `carries the sshd login in (D46): ${l.trim()}`);
  }
  assert.doesNotMatch(CANON, /\/state\/brain/, 'the script names no rock-only path anywhere');
});

test('the break-glass block ships to rocks too', () => {
  const rock = rockEnterAios();
  assert.match(rock, /docker start ai-os/, 'tries to heal a stopped container');
  assert.match(rock, /exit 75/, 'EX_TEMPFAIL when it cannot');
  assert.match(rock, /systemctl status ai-os\.service/, 'hands over the service log');
});

test('the pebble splices the same file, and the embed script targets the same entry', () => {
  const pebble = readFileSync(join(REPO, 'provisioning', 'managed', 'provision-pebble.sh'), 'utf8');
  assert.match(pebble, /\/usr\/local\/bin\/enter-aios:enter-aios/, 'provision-pebble.sh splices provisioning/host/enter-aios');
  const embed = readFileSync(join(REPO, 'provisioning', 'rock', 'embed-enter-aios.sh'), 'utf8');
  assert.match(embed, /gzip -9nc/, 'deterministic gzip (no timestamp)');
  assert.match(embed, /encoding: gz\\\+b64/, 'replaces the gz+b64 entry in place');
});

test('the rock template carries no second, inline enter-aios', () => {
  assert.equal((ROCK_TPL.match(/path: \/usr\/local\/bin\/enter-aios/g) || []).length, 1);
  assert.doesNotMatch(ROCK_TPL, /-w \/state\/brain/, 'no inline landing in /state/brain survives');
});
