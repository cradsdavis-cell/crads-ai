// host-update.test.mjs: the D55 host-update channel.
//   node --test provisioning/host-updates/host-update.test.mjs
// Two duties:
//   1. anti-drift: both cloud-init templates ship aios-host-update.sh VERBATIM —
//      rock inlines it, managed splices it from provisioning/host/ (65e3e8c)
//      (a fix landing in one place but not the others is how this channel rots)
//   2. behaviour: sign/verify/apply against a throwaway ed25519 key, plus every
//      refusal path (disarmed, unsigned, tampered, stale version, no apply.sh)
// Zero deps beyond ssh-keygen + tar + bash, all present on this repo's boxes;
// the whole suite is skipped if ssh-keygen is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const CANON = join(HERE, 'aios-host-update.sh');
const ROCK_TPL = join(REPO, 'provisioning', 'rock', 'cloud-init.rock.template.yaml');
const MANAGED_TPL = join(REPO, 'provisioning', 'managed', 'cloud-init.template.yaml');
// Since 65e3e8c the MANAGED template no longer inlines the applier: it carries a
// #__HOST_SCRIPTS__ marker that provision-pebble.sh fills at render time with a
// gz+b64 write_files block built from this file:
const HOST_COPY = join(REPO, 'provisioning', 'host', 'aios-host-update');
const PROVISION_PEBBLE = join(REPO, 'provisioning', 'managed', 'provision-pebble.sh');

// Plain-text block extraction (no YAML dep): find the write_files entry, take
// its `content: |` block, strip the 6-space cloud-init indent.
function embeddedScript(tplText) {
  const lines = tplText.split('\n');
  const at = lines.findIndex((l) => l.trim() === '- path: /usr/local/bin/aios-host-update');
  assert.ok(at >= 0, 'template carries the aios-host-update write_files entry');
  const start = lines.findIndex((l, i) => i > at && l.trim() === 'content: |');
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== '' && !l.startsWith('      ')) break;   // dedent = end of block
    body.push(l.startsWith('      ') ? l.slice(6) : '');
  }
  while (body.length && body[body.length - 1] === '') body.pop();
  return body.join('\n');
}

test('anti-drift: both cloud-init templates embed the canonical applier verbatim', () => {
  const canon = readFileSync(CANON, 'utf8').replace(/\n+$/, '');

  // Rock template: still inlines the applier as a plain `content: |` block.
  const rock = readFileSync(ROCK_TPL, 'utf8');
  assert.equal(embeddedScript(rock), canon, `embedded copy in ${ROCK_TPL} drifted from aios-host-update.sh`);

  // Managed template: the applier rides gz+b64, spliced by provision-pebble.sh
  // from provisioning/host/aios-host-update. Three links, each drift-tested so
  // the guarantee survives the indirection:
  //   1. the spliced source file is byte-identical to the canonical script
  assert.equal(readFileSync(HOST_COPY, 'utf8'), readFileSync(CANON, 'utf8'),
    `${HOST_COPY} drifted from aios-host-update.sh`);
  //   2. the template still carries the marker the splice lands on
  const managed = readFileSync(MANAGED_TPL, 'utf8');
  assert.match(managed, /^\s*#__HOST_SCRIPTS__\s*$/m,
    `${MANAGED_TPL} must carry the #__HOST_SCRIPTS__ splice marker`);
  //   3. provision-pebble actually splices that file to that path at that marker
  const pebble = readFileSync(PROVISION_PEBBLE, 'utf8');
  assert.match(pebble, /\/usr\/local\/bin\/aios-host-update:aios-host-update/,
    'provision-pebble.sh must splice provisioning/host/aios-host-update to /usr/local/bin/aios-host-update');
  assert.match(pebble, /#__HOST_SCRIPTS__/,
    'provision-pebble.sh must target the #__HOST_SCRIPTS__ marker');

  for (const [tpl, t] of [[ROCK_TPL, rock], [MANAGED_TPL, managed]]) {
    assert.match(t, /ai-os-host-update\.timer/, `${tpl} must enable the timer`);
    assert.match(t, /\/etc\/ai-os\/host-update-signers/, `${tpl} must bake the signers file`);
  }
});

const haveTools = spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error === undefined;

function sh(cmd, env = {}) {
  return spawnSync('bash', ['-c', cmd], { env: { ...process.env, ...env }, encoding: 'utf8' });
}

// One fixture per behaviour test: key, armed signers file, signed v2 bundle.
function fixture() {
  const dir = tmpDir('aios-hu-');
  const key = join(dir, 'key');
  assert.equal(sh(`ssh-keygen -t ed25519 -N '' -C updates@ai-os -f ${key} -q`).status, 0);
  const pub = readFileSync(key + '.pub', 'utf8').trim().split(' ').slice(0, 2).join(' ');
  writeFileSync(join(dir, 'signers'), `updates@ai-os namespaces="aios-host-update" ${pub}\n`);
  const payload = join(dir, 'payload');
  mkdirSync(payload);
  writeFileSync(join(payload, 'VERSION'), '2\n');
  writeFileSync(join(payload, 'apply.sh'), `#!/bin/bash\nset -eu\necho applied-v2 > ${dir}/marker\n`);
  const dist = join(dir, 'dist');
  const mk = sh(`bash ${join(HERE, 'make-bundle.sh')} ${payload} ${key} ${dist}`);
  assert.equal(mk.status, 0, `make-bundle failed: ${mk.stdout}${mk.stderr}`);
  assert.ok(existsSync(join(dist, 'current.tar.gz')) && existsSync(join(dist, 'current.tar.gz.sig')));
  return { dir, key, dist,
    env: (over = {}) => ({
      AIOS_HU_SIGNERS: join(dir, 'signers'),
      AIOS_HU_SRC: dist,
      AIOS_HU_VERSION_FILE: join(dir, 'version'),
      AIOS_HU_LOG: join(dir, 'log'),
      ...over,
    }) };
}

test('applies a signed bundle once, records the version, never re-applies', { skip: !haveTools }, () => {
  const f = fixture();
  try {
    assert.equal(sh(`bash ${CANON}`, f.env()).status, 0);
    assert.equal(readFileSync(join(f.dir, 'marker'), 'utf8').trim(), 'applied-v2');
    assert.equal(readFileSync(join(f.dir, 'version'), 'utf8').trim(), '2');
    rmSync(join(f.dir, 'marker'));
    assert.equal(sh(`bash ${CANON}`, f.env()).status, 0, 'same version re-run exits 0');
    assert.ok(!existsSync(join(f.dir, 'marker')), 'same version must not re-apply');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('disarmed signers file (comments only) is a silent no-op', { skip: !haveTools }, () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'signers'), '# no signer configured\n');
    assert.equal(sh(`bash ${CANON}`, f.env()).status, 0);
    assert.ok(!existsSync(join(f.dir, 'marker')), 'disarmed channel must not apply');
    assert.ok(!existsSync(join(f.dir, 'version')));
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('tampered bundle and wrong-key signature both refuse loudly', { skip: !haveTools }, () => {
  const f = fixture();
  try {
    // tamper: one appended byte breaks the detached signature
    const bundle = join(f.dist, 'current.tar.gz');
    writeFileSync(bundle, Buffer.concat([readFileSync(bundle), Buffer.from('x')]));
    const r = sh(`bash ${CANON}`, f.env());
    assert.equal(r.status, 1, 'tampered bundle must exit 1');
    assert.ok(!existsSync(join(f.dir, 'marker')), 'tampered bundle must not apply');
    assert.match(readFileSync(join(f.dir, 'log'), 'utf8'), /SIGNATURE REFUSED/);

    // wrong key: a valid signature from a DIFFERENT signer is still refused
    const g = fixture();
    try {
      copyFileSync(join(g.dist, 'current.tar.gz'), bundle);
      copyFileSync(join(g.dist, 'current.tar.gz.sig'), bundle + '.sig');
      assert.equal(sh(`bash ${CANON}`, f.env()).status, 1, 'foreign signer must exit 1');
      assert.ok(!existsSync(join(f.dir, 'marker')));
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('an older bundle never rolls the host back', { skip: !haveTools }, () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'version'), '7\n');       // host already at v7; bundle is v2
    assert.equal(sh(`bash ${CANON}`, f.env()).status, 0);
    assert.ok(!existsSync(join(f.dir, 'marker')), 'older version must not apply');
    assert.equal(readFileSync(join(f.dir, 'version'), 'utf8').trim(), '7');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('missing signature / absent bundle behave per contract', { skip: !haveTools }, () => {
  const f = fixture();
  try {
    rmSync(join(f.dist, 'current.tar.gz.sig'));
    assert.equal(sh(`bash ${CANON}`, f.env()).status, 1, 'bundle without signature refuses');
    rmSync(join(f.dist, 'current.tar.gz'));
    assert.equal(sh(`bash ${CANON}`, f.env()).status, 0, 'no bundle at all is a quiet no-op');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
