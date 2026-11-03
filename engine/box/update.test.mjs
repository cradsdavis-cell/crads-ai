// update.test.mjs: trap 82. A member box restarted itself every night onto
// whatever was published, wiping everything outside /state, and the host pulled
// new software on every start. Sam's rulings (2026-11-03): only the
// infrastructure resets, and the box restarts only when the member wants to
// update. These tests pin both halves.
//   node --test engine/box/update.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { autoUpdateEnabled, autoStep, checkForUpdate, currentBuild, isIdle, parseImage, FLAG_FILE } from './update.mjs';
import { MEMBER_VERBS } from '../../wizard/panel/panel-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A registry that answers two tags with fixed digests, plus an image config.
function fakeRegistry({ latest = 'sha256:aaa', mine = 'sha256:aaa', env = [], fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (fail) return { ok: false, status: 503 };
    if (url.includes('/token')) return { ok: true, json: async () => ({ token: 't' }) };
    const res = (digest, body) => ({ ok: true, headers: { get: () => digest }, json: async () => body });
    if (url.endsWith('/manifests/v2')) return res(latest, { config: { digest: 'sha256:cfg' } });
    if (url.endsWith('/manifests/sha-mine')) return res(mine, { config: { digest: 'sha256:cfg0' } });
    if (url.includes('/blobs/')) return { ok: true, json: async () => ({ config: { Env: env } }) };
    return { ok: false, status: 404 };
  };
  return { fetchImpl, calls };
}
const build = { tag: 'sha-mine', sha: 'abc', security: 0 };
const IMG = 'ghcr.io/cradsdavis-cell/crads-pebble:v2';

test('the overnight update is opt-in: only an explicit true switches it on', () => {
  const s = tmpDir('upd-');
  assert.equal(autoUpdateEnabled(s), false, 'no file is off');
  mkdirSync(join(s, 'cockpit'));
  for (const [body, want] of [['{"enabled": false}', false], ['{}', false], ['garbage', false], ['{"enabled": "yes"}', false], ['{"enabled": true}', true]]) {
    writeFileSync(join(s, 'cockpit', 'auto-update.json'), body);
    assert.equal(autoUpdateEnabled(s), want, body);
  }
});

test('check: same digest is up to date, a different one is an update, and a security bump is named', async () => {
  assert.equal((await checkForUpdate({ image: IMG, build, fetchImpl: fakeRegistry().fetchImpl })).available, false);
  const r = await checkForUpdate({ image: IMG, build, fetchImpl: fakeRegistry({ latest: 'sha256:bbb', env: ['AIOS_IMAGE_TAG=sha-new'] }).fetchImpl });
  assert.equal(r.available, true);
  assert.equal(r.latest, 'sha-new');
  assert.equal(r.security, false, 'an image with no security level is not a security update');
  const sec = await checkForUpdate({ image: IMG, build, fetchImpl: fakeRegistry({ latest: 'sha256:bbb', env: ['AIOS_SECURITY_LEVEL=1'] }).fetchImpl });
  assert.equal(sec.security, true, 'a higher security level than this build carries is a security update');
});

test('check never throws and never guesses: an unreachable registry or an unknown build says so', async () => {
  const down = await checkForUpdate({ image: IMG, build, fetchImpl: fakeRegistry({ fail: true }).fetchImpl });
  assert.equal(down.available, null);
  assert.ok(down.error);
  const nobuild = await checkForUpdate({ image: IMG, build: { tag: null, security: 0 }, fetchImpl: fakeRegistry().fetchImpl });
  assert.equal(nobuild.available, null);
  assert.equal(parseImage('not an image'), null);
  assert.deepEqual(parseImage(IMG), { registry: 'ghcr.io', repo: 'cradsdavis-cell/crads-pebble', tag: 'v2' });
});

test('currentBuild reads the baked stamp, and the env as a fallback', () => {
  const d = tmpDir('upd-');
  writeFileSync(join(d, 'b'), '{"sha":"s1","tag":"sha-s1"}');
  assert.deepEqual(currentBuild({ buildFile: join(d, 'b'), env: { AIOS_SECURITY_LEVEL: '2' } }), { tag: 'sha-s1', sha: 's1', security: 2 });
  assert.equal(currentBuild({ buildFile: join(d, 'none'), env: { AIOS_IMAGE_TAG: 'sha-e' } }).tag, 'sha-e');
});

test('idle means no Claude session and a quiet machine', () => {
  const proc = tmpDir('proc-');
  const pid = (n, cmd) => { mkdirSync(join(proc, String(n))); writeFileSync(join(proc, String(n), 'cmdline'), cmd.split(' ').join('\0')); };
  pid(1, '/usr/bin/tini -- /usr/local/bin/entrypoint.sh up');
  pid(7, 'node /app/engine/cron/scheduler.mjs /state');
  assert.equal(isIdle({ procDir: proc, load: 0.1 }).idle, true);
  assert.equal(isIdle({ procDir: proc, load: 2.3 }).idle, false, 'a render or a download keeps the load up');
  pid(9, 'node /usr/local/bin/claude --resume');
  assert.equal(isIdle({ procDir: proc, load: 0.1 }).idle, false, 'a live Claude session is never cut off');
});

test('autoStep restarts only when switched on, a new version exists, and nothing is running', async () => {
  const s = tmpDir('upd-');
  const now = new Date('2026-11-04T04:15:00Z');
  const newer = async () => ({ checked_at: now.toISOString(), available: true, latest: 'sha-new' });
  const same = async () => ({ checked_at: now.toISOString(), available: false });
  const quiet = () => ({ idle: true });
  const busy = () => ({ idle: false, why: 'a Claude session is running' });

  assert.equal((await autoStep(s, { now, check: newer, idle: quiet })).restart, false, 'off by default');
  mkdirSync(join(s, 'cockpit'), { recursive: true });
  writeFileSync(join(s, 'cockpit', 'auto-update.json'), '{"enabled": true}');
  assert.equal((await autoStep(s, { now, check: same, idle: quiet })).restart, false, 'no new version: no restart');
  writeFileSync(join(s, 'cockpit', 'update-status.json'), '{}');   // force a fresh check
  assert.equal((await autoStep(s, { now, check: newer, idle: busy })).restart, false, 'busy: try again later');
  assert.equal(existsSync(FLAG_FILE(s)), false, 'and no update was requested');
  const r = await autoStep(s, { now, check: newer, idle: quiet });
  assert.equal(r.restart, true);
  assert.ok(existsSync(FLAG_FILE(s)), 'the flag the host reads is left before the restart');
});

test('the Update button leaves the flag the host pulls on, then restarts', () => {
  const cmd = MEMBER_VERBS['box-refresh'].build().command;
  const flag = cmd.indexOf('/state/.kernel/update-requested');
  assert.ok(flag >= 0, 'box-refresh writes the update flag');
  assert.ok(flag < cmd.indexOf('kill 1'), 'and writes it BEFORE the restart');
  assert.doesNotMatch(cmd, /\/app\/engine\/box\/update\.mjs/, 'plain shell, so it works on a mineral older than this fix');
  assert.match(MEMBER_VERBS['update-status'].build().command, /update\.mjs check \/state/);
});

test('the server unit pulls only when the flag is there (new servers, self-hosted and adopted)', () => {
  const tpl = readFileSync(join(ROOT, 'provisioning', 'managed', 'cloud-init.template.yaml'), 'utf8');
  assert.doesNotMatch(tpl, /^\s*ExecStartPre=-?\/usr\/bin\/docker pull /m, 'no unconditional pull left');
  assert.match(tpl, /ExecStartPre=-\/bin\/sh -c 'F=\/state\/\.kernel\/update-requested;\[ -e \$\$F \]&&docker pull __IMAGE__&&rm \$\$F'/);
  const adopt = readFileSync(join(ROOT, 'wizard', 'provision', 'adopt-cloudinit.mjs'), 'utf8');
  assert.doesNotMatch(adopt, /`ExecStartPre=-\/usr\/bin\/docker pull \$\{image\}`/);
  assert.match(adopt, /F=\$\{brainRoot\}\/\.kernel\/update-requested;\[ -e \$\$F \]&&\/usr\/bin\/docker pull \$\{image\}/);
});

test('the flag gate itself: no flag no pull, a flag pulls then clears, a failed pull keeps it', () => {
  const d = tmpDir('gate-');
  const F = join(d, 'update-requested');
  const gate = (pull) => { try { return execFileSync('sh', ['-c', `F=${F};[ -e $F ]&&${pull}&&rm $F`], { encoding: 'utf8' }); } catch { return ''; } };
  assert.equal(gate('echo PULL'), '', 'a restart nobody asked to be an update does not pull');
  writeFileSync(F, 'x');
  assert.equal(gate('echo PULL').trim(), 'PULL');
  assert.equal(existsSync(F), false, 'cleared after a pull');
  writeFileSync(F, 'x');
  gate('false');
  assert.ok(existsSync(F), 'a pull that failed is retried at the next start');
});

test('the host patch for existing servers swaps only the pull line, dedicated and adopted', () => {
  const script = join(ROOT, 'provisioning', 'managed', 'patch-update-gate-host.sh');
  const fixture = (unit) => {
    const t = tmpDir('host-');
    mkdirSync(join(t, 'etc', 'systemd', 'system'), { recursive: true });
    writeFileSync(join(t, 'etc', 'systemd', 'system', 'ai-os.service'), unit);
    return t;
  };
  const run = (t, ...a) => execFileSync('bash', [script, ...a], { encoding: 'utf8', env: { ...process.env, AIOS_PATCH_TEST: t } });
  const dedicated = fixture('[Service]\nExecStartPre=-/usr/bin/docker pull ghcr.io/x/crads-pebble:v2\nExecStartPre=-/usr/bin/docker rm -f ai-os\n'
    + "ExecStart=/bin/bash -c 'exec /usr/bin/docker run --rm --name ai-os \\\n        -v /state:/state \\\n        img up'\n");
  const dry = run(dedicated);
  assert.match(dry, /DRY RUN/);
  assert.equal(existsSync(join(dedicated, 'etc/systemd/system/ai-os.service.d/zz-update-gate.conf')), false, 'a dry run writes nothing');
  run(dedicated, '--apply');
  const conf = readFileSync(join(dedicated, 'etc/systemd/system/ai-os.service.d/zz-update-gate.conf'), 'utf8');
  assert.match(conf, /^ExecStartPre=$/m, 'the list is reset, then rebuilt');
  assert.match(conf, /F=\/state\/\.kernel\/update-requested;\[ -e \$\$F \]&&\/usr\/bin\/docker pull ghcr\.io\/x\/crads-pebble:v2&&rm \$\$F/);
  assert.match(conf, /^ExecStartPre=-\/usr\/bin\/docker rm -f ai-os$/m, 'every other line is kept');
  assert.doesNotMatch(conf, /^ExecStartPre=-\/usr\/bin\/docker pull /m);

  const adopted = fixture('[Service]\nExecStartPre=-/usr/bin/docker pull img:v2\nExecStartPre=-/usr/bin/docker rm -f ai-os\nExecStartPre=/usr/local/bin/aios-passwd img:v2 1000 1000 /home/u/brain\n'
    + 'ExecStart=/usr/bin/docker run --rm --name ai-os -v /home/u/brain:/state -p 1:1 img:v2 up\n');
  run(adopted, '--apply');
  const c2 = readFileSync(join(adopted, 'etc/systemd/system/ai-os.service.d/zz-update-gate.conf'), 'utf8');
  assert.match(c2, /F=\/home\/u\/brain\/\.kernel\/update-requested/, 'an adopted box keeps the flag in its brain folder');
  assert.match(c2, /aios-passwd/, 'the adopt-only step survives');
  assert.match(run(adopted), /nothing to patch|DRY RUN/, 're-running is harmless');
});

test('only the infrastructure resets: the member home, temp files and installs live on /state', () => {
  const df = readFileSync(join(ROOT, 'Dockerfile.member'), 'utf8');
  assert.match(df, /ENV HOME=\/state\/\.kernel\/home/, 'docker exec (how a member\'s Claude runs) never passes through the entrypoint');
  assert.match(df, /TMPDIR=\/state\/\.kernel\/tmp/);
  assert.match(df, /PATH=\/state\/\.kernel\/home\/\.local\/bin:\$PATH/);
  assert.match(df, /\/etc\/profile\.d\/crads-home\.sh/, 'the login shell resets PATH, so profile.d puts it back');
  // The entrypoint moves a HOME outside /state (compose's /tmp, docker's default /) onto /state.
  const ep = join(ROOT, 'engine', 'entrypoint.sh');
  const auth = tmpDir('ep-');
  const env = (home) => execFileSync('bash', [ep, 'shell'], {
    encoding: 'utf8', input: 'echo "$HOME|$TMPDIR|$PATH"\n',
    env: { PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: auth, ...(home ? { HOME: home } : {}) },
  }).trim().split('|');
  const [h, t, p] = env('/tmp');
  assert.equal(h, '/state/.kernel/home');
  assert.equal(t, '/state/.kernel/tmp');
  assert.ok(p.startsWith('/state/.kernel/home/.local/bin:'), 'tools the assistant installs are found after a restart');
  assert.equal(env('/state/.kernel/home')[0], '/state/.kernel/home', 'an adopted box keeps the HOME it was given');
});

test('the security level is baked from engine/security-level by CI', () => {
  assert.match(readFileSync(join(ROOT, 'engine', 'security-level'), 'utf8'), /^\d+\n$/);
  assert.match(readFileSync(join(ROOT, 'docker-bake.hcl'), 'utf8'), /SECURITY_LEVEL = SECURITY_LEVEL/);
  assert.match(readFileSync(join(ROOT, '.github', 'workflows', 'docker-publish.yml'), 'utf8'), /SECURITY_LEVEL=\$\(tr -dc 0-9 < engine\/security-level\)/);
  assert.match(readFileSync(join(ROOT, 'Dockerfile.member'), 'utf8'), /ENV AIOS_SECURITY_LEVEL=\$SECURITY_LEVEL/);
});

test('the box tells its Claude what survives a restart, every time it starts', async () => {
  const { buildBrainSection } = await import('./brain-claude-md.mjs');
  const block = buildBrainSection();
  assert.match(block, /What survives a restart/);
  assert.match(block, /~\/\.local\/bin/, 'where installs go');
  assert.match(block, /never with apt or sudo/);
  assert.match(block, /100 MB/, 'why big files stay out of the brain folder');
});
