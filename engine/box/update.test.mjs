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

// trap 83: every pull left the previous version on disk (~3 GB) and nothing removed it.
test('dedicated server units clear old versions on every start, after the old container is gone', () => {
  for (const rel of [['provisioning', 'managed', 'cloud-init.template.yaml'], ['provisioning', 'rock', 'cloud-init.rock.template.yaml']]) {
    const tpl = readFileSync(join(ROOT, ...rel), 'utf8');
    const starts = tpl.split('\n').filter((l) => /^\s*ExecStartPre=/.test(l)).map((l) => l.trim());
    const prune = starts.indexOf('ExecStartPre=-/usr/bin/docker image prune -f');
    assert.ok(prune >= 0, `${rel.join('/')} prunes`);
    assert.ok(prune > starts.indexOf('ExecStartPre=-/usr/bin/docker rm -f ai-os'), 'after rm -f, so the old container no longer pins the old image');
    assert.ok(prune > starts.findIndex((l) => /docker pull/.test(l)), 'after the pull, so the version it replaced is already untagged');
    assert.doesNotMatch(tpl, /docker image prune -a|docker system prune/, 'dangling only: the tagged image about to run is never a candidate');
  }
  const adopt = readFileSync(join(ROOT, 'wizard', 'provision', 'adopt-cloudinit.mjs'), 'utf8');
  assert.doesNotMatch(adopt, /docker image prune/, "an adopted box is the owner's own server: never prune their images");
});

test('the host patch for existing servers adds the prune once, after the update gate, and refuses an adopted box', () => {
  const script = join(ROOT, 'provisioning', 'managed', 'patch-prune-images-host.sh');
  const fixture = (unit, dropins = {}) => {
    const t = tmpDir('host-');
    mkdirSync(join(t, 'etc', 'systemd', 'system', 'ai-os.service.d'), { recursive: true });
    writeFileSync(join(t, 'etc', 'systemd', 'system', 'ai-os.service'), unit);
    for (const [n, c] of Object.entries(dropins)) writeFileSync(join(t, 'etc', 'systemd', 'system', 'ai-os.service.d', n), c);
    return t;
  };
  const run = (t, ...a) => execFileSync('bash', [script, ...a], { encoding: 'utf8', env: { ...process.env, AIOS_PATCH_TEST: t } });
  const unit = '[Service]\nExecStartPre=-/usr/bin/docker pull ghcr.io/x/crads-pebble:v2\nExecStartPre=-/usr/bin/docker rm -f ai-os\n'
    + "ExecStart=/bin/bash -c 'exec /usr/bin/docker run --rm --name ai-os \\\n        -v /state:/state \\\n        img up'\n";
  const gated = fixture(unit, { 'zz-update-gate.conf': '[Service]\nExecStartPre=\nExecStartPre=-/usr/bin/docker rm -f ai-os\n' });
  const out = join(gated, 'etc/systemd/system/ai-os.service.d/zzz-prune-images.conf');
  assert.match(run(gated), /DRY RUN/);
  assert.equal(existsSync(out), false, 'a dry run writes nothing');
  run(gated, '--apply');
  assert.match(readFileSync(out, 'utf8'), /^\[Service\]\nExecStartPre=-\/usr\/bin\/docker image prune -f$/m);
  assert.doesNotMatch(readFileSync(out, 'utf8'), /^ExecStartPre=$/m, 'appends, never resets the list');
  assert.ok('zzz-prune-images.conf' > 'zz-update-gate.conf', "sorts after the gate's reset, so the reset cannot wipe it");
  assert.match(run(gated, '--apply'), /already prune/, 're-running is harmless');

  // A full disk (a member's server at 100%, 2026-11-11): no temp file, and the
  // prune runs before anything is written, or the cleanup never gets to run.
  const full = fixture(unit);
  execFileSync('bash', [script, '--apply'], { encoding: 'utf8', env: { ...process.env, AIOS_PATCH_TEST: full, TMPDIR: join(full, 'no-such-dir') } });
  assert.ok(existsSync(join(full, 'etc/systemd/system/ai-os.service.d/zzz-prune-images.conf')), 'applies with no writable temp space');
  const body = readFileSync(script, 'utf8');
  const apply = body.slice(body.indexOf('# Prune FIRST'));
  assert.ok(apply.indexOf('docker image prune -f') >= 0 && apply.indexOf('docker image prune -f') < apply.indexOf('> "$DROPIN"'), 'prunes before it writes the drop-in');
  assert.doesNotMatch(body, /TMPDIR|mktemp/, 'nothing goes through a temp file');

  const adopted = fixture('[Service]\nExecStartPre=-/usr/bin/docker rm -f ai-os\nExecStart=/usr/bin/docker run --rm --name ai-os -v /home/u/brain:/state img:v2 up\n');
  assert.throws(() => run(adopted, '--apply'), (e) => /adopted box/.test(e.stdout));
  assert.equal(existsSync(join(adopted, 'etc/systemd/system/ai-os.service.d/zzz-prune-images.conf')), false);
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
