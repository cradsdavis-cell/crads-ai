// adopt-host.test.mjs: "Yes, my assistant is already on it" (spec
// docs/superpowers/specs/2026-10-17-adopt-existing-server.md § Flow 1 and 2, T1).
//   node --test wizard/provision/adopt-host.test.mjs
//
// Nothing here reaches a network or a real server. The probe is parsed from
// fixtures shaped like the first real case (a busy Ubuntu 24.04 Arm server
// whose brain is a git repo on master), and run once for real against a
// scratch folder with every system tool stubbed. Setup and teardown are run
// for real too, in a scratch tree that stands in for / (renderAdoptSetup's
// hostRoot), with systemctl, sshd, useradd, docker and friends stubbed, so the
// record they leave and the undo they do are the real thing, not a reading of
// the script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import {
  parseAdoptProbe, adoptRefusal, inventoryFrom, probeScript, parseBrainRoot, collectInventory,
  setupSharedHost, teardownSharedHost, renderForFacts, ADOPT_MIN_FREE_DISK_GB, INVENTORY_REL, HOST_SETUP_REL,
} from './adopt-host.mjs';
import { renderAdoptSetup, mergeOwnership, ADOPT_HOST_FILES } from './adopt-cloudinit.mjs';
import { OwnServerClient, parseOwnServer, ADOPT_CHOICE } from './own-server.mjs';
import { AS_ROOT_SCRIPT } from './own-server-shared.mjs';
import { provisionSelfHost } from './engine.mjs';

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF6zXyq1x2Qq0m7T3v9m4T8u5X6a7B8c9D0e1F2g3H4i owner@wizard';
const IMAGE = 'ghcr.io/cradsdavis-cell/crads-pebble:v2';
const BRAIN = '/home/pat/second-brain';
const TOKEN = JSON.stringify({ host: '203.0.113.10', user: 'pat', slug: 'idris', mode: 'adopt', brainRoot: '~/second-brain' });

// ---- fixtures ---------------------------------------------------------------

// What the probe prints on a server like the first real case: busy (crontab,
// containers, public listeners), a brain on master with clashing skills, a
// Telegram service and a WhatsApp bridge running from the folder.
function probeOut(over = {}, extra = []) {
  const kv = {
    uid: '1000', sudo: 'ok', cloudinit: 'yes', os: 'ubuntu', version: '24.04', arch: 'aarch64', mem_mb: '23990', cpus: '4',
    systemd: 'yes', tz: 'Australia/Sydney', existing: 'no', member_user: 'no', member_ours: 'no',
    docker: 'yes', docker_pkg: 'ce', aios_container: 'no', disk_gb: '6',
    login_home: '/home/pat', folder_input: '~/second-brain', folder: BRAIN, folder_dir: 'yes', login_home_real: '/home/pat',
    owner_uid: '1002', owner_gid: '1002', owner_name: 'pat',
    git: 'yes', git_top: BRAIN, branch: 'master', remote: 'origin', git_op: '', dirty: '3', claude_md: 'yes',
    ownership_b64: '', probe: 'done', ...over,
  };
  const lines = Object.entries(kv).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${v}`);
  const T = (...a) => a.join('\t');
  lines.push(
    T('container', 'cockpit', 'cockpit:latest', 'Up 6 weeks'),
    T('container', 'aios-tg-livetest', 'ghcr.io/x/crads-pebble:v2', 'Up 6 weeks'),
    T('listen', '0.0.0.0:22'), T('listen', '*:8080'), T('listen', '0.0.0.0:8898'), T('listen', '127.0.0.1:4620'), T('listen', '[::]:22'), T('listen', '100.94.140.82:48439'),
    ...['capture', 'daily', 'followup', 'inbox', 'weekly', 'lead'].map((n) => T('skill', n)),
    T('lazy', 'grill-me'), T('lazy', 'roadmap'),
    T('hook', 'cadence_check.py'), T('hook', 'wiki_guard.py'),
    T('mcp', 'todoist'), T('mcp', 'google_workspace'), T('mcp', 'whatsapp'),
    T('env', 'vps/.env'), T('env', 'cockpit/.env'),
    T('top', 'notes'), T('top', 'cockpit'), T('top', '.claude'),
    T('cron', 'pat', '1', 'SHELL=/bin/bash'),
    T('cron', 'pat', '2', 'PATH=/home/pat/.nvm/versions/node/v22.11.0/bin:/usr/bin:/bin'),
    T('cron', 'pat', '4', '@reboot cd /home/pat/whatsapp-mcp/whatsapp-bridge && ./whatsapp-bridge >> /tmp/wa.log 2>&1'),
    T('cron', 'pat', '7', '*/15 * * * * cd /home/pat/second-brain && node cockpit/run-job.mjs email-ingest\t# tab kept'),
    T('unit', 'system', 'telegram-chat.service', 'active', `${BRAIN}/cockpit`, '{ path=/usr/bin/node ; argv[]=/usr/bin/node /home/pat/second-brain/cockpit/telegram-chat.mjs ; ignore_errors=no ; start_time=[n/a] }'),
    T('unit', 'system', 'cloudflared.service', 'active', '', '{ path=/usr/bin/cloudflared ; argv[]=/usr/bin/cloudflared --no-autoupdate tunnel run ; ignore_errors=no }'),
    T('unit', 'system', 'ssh.service', 'active', '', '{ path=/usr/sbin/sshd ; argv[]=/usr/sbin/sshd -D ; ignore_errors=no }'),
    T('unit', 'user', 'brain-sync.service', 'inactive', '', `{ path=/usr/bin/bash ; argv[]=/usr/bin/bash -c --dir=${BRAIN}/scripts/sync.sh ; ignore_errors=no }`),
    T('unit', 'system', 'other.service', 'active', '/home/pat/second-brain-old', '{ path=/x ; argv[]=/x /home/pat/second-brainy/y ; }'),
    ...extra,
  );
  return lines.join('\n') + '\n';
}

function fakeServer({ check = probeOut(), code = 0, setupOut = 'crads-step: folder\ncrads-setup-ok\n', setupCode = 0 } = {}) {
  const calls = [];
  const runner = async (o) => {
    calls.push(o);
    if (o.command === 'bash -s') return { code, stdout: check, stderr: '' };
    return { code: setupCode, stdout: setupOut, stderr: '' };
  };
  return { runner, calls };
}
const client = (fake, token = TOKEN) => new OwnServerClient(token, { sshDir: '/tmp/keys', runner: fake.runner });

// ---- details ------------------------------------------------------------------

test('details: adopt carries the folder; ~ is kept for the server to expand; bad folders are refused in words', () => {
  assert.deepEqual(parseOwnServer(TOKEN), { host: '203.0.113.10', user: 'pat', port: 22, slug: 'idris', mode: 'adopt', brainRoot: '~/second-brain' });
  assert.equal(parseOwnServer({ host: 'h', slug: 'idris', mode: 'adopt', brainRoot: '/srv/brain/' }).brainRoot, '/srv/brain', 'a trailing slash is dropped');
  assert.equal(parseOwnServer({ host: 'h', slug: 'idris' }).mode, undefined, 'no mode: today\'s path, details unchanged');
  assert.equal(parseOwnServer({ host: 'h', slug: 'idris', mode: 'dedicated' }).brainRoot, undefined);
  assert.match(parseOwnServer({ host: 'h', slug: 'idris', mode: 'adopt' }).error, /folder your assistant lives in/);
  for (const bad of ['relative/path', '/home/pat/my brain', '/home/$(id)', "/home/'x", '~pat/brain', '/']) {
    assert.ok(parseOwnServer({ host: 'h', slug: 'idris', mode: 'adopt', brainRoot: bad }).error, bad);
  }
  assert.match(parseOwnServer({ host: 'h', slug: 'idris', mode: 'take-over' }).error, /does not know/);
  assert.equal(parseBrainRoot('~').brainRoot, '~');
});

// ---- the probe ----------------------------------------------------------------

test('probe: parsed into facts; units filtered to the folder; secrets never in the output', () => {
  const f = parseAdoptProbe(probeOut());
  assert.equal(f.folder, BRAIN);
  assert.deepEqual([f.ownerUid, f.ownerGid, f.branch, f.remote, f.dirty, f.gitOp], [1002, 1002, 'master', 'origin', 3, '']);
  assert.deepEqual(f.skills, ['capture', 'daily', 'followup', 'inbox', 'weekly', 'lead']);
  assert.deepEqual(f.lazySkills, ['grill-me', 'roadmap']);
  assert.deepEqual(f.mcpServers, ['todoist', 'google_workspace', 'whatsapp']);
  assert.deepEqual(f.units.map((u) => u.name), ['telegram-chat.service', 'brain-sync.service'], 'only units under the folder (a sibling folder with the same prefix is not)');
  assert.equal(f.units[0].exec_start, '/usr/bin/node /home/pat/second-brain/cockpit/telegram-chat.mjs');
  assert.equal(f.units[1].scope, 'user');
  assert.equal(f.crontab[3].text, '*/15 * * * * cd /home/pat/second-brain && node cockpit/run-job.mjs email-ingest\t# tab kept', 'the exact line, tabs and all');
  assert.equal(f.crontab[2].line_no, 4);
});

test('host inventory: exactly the shape /move-in reads (the contract with Builder B)', () => {
  const f = parseAdoptProbe(probeOut());
  const inv = inventoryFrom(f, { login: 'pat', now: new Date('2026-10-18T01:02:03Z') });
  assert.deepEqual(Object.keys(inv), ['version', 'collected_at', 'login', 'brain_root', 'owner', 'crontab', 'units', 'containers', 'listeners', 'skills', 'lazy_skills', 'hooks', 'mcp_servers', 'env_files', 'git']);
  assert.equal(inv.version, 1);
  assert.equal(inv.collected_at, '2026-10-18T01:02:03.000Z');
  assert.deepEqual(inv.owner, { uid: 1002, gid: 1002 });
  assert.deepEqual(Object.keys(inv.crontab[0]), ['user', 'line_no', 'text']);
  assert.deepEqual(inv.crontab[0], { user: 'pat', line_no: 1, text: 'SHELL=/bin/bash' });
  assert.deepEqual(Object.keys(inv.units[0]), ['name', 'scope', 'working_directory', 'exec_start', 'active']);
  assert.deepEqual(inv.units[0], { name: 'telegram-chat.service', scope: 'system', working_directory: `${BRAIN}/cockpit`, exec_start: '/usr/bin/node /home/pat/second-brain/cockpit/telegram-chat.mjs', active: true });
  assert.deepEqual(inv.containers[0], { name: 'cockpit', image: 'cockpit:latest', status: 'Up 6 weeks' });
  assert.deepEqual(inv.listeners, ['*:8080', '0.0.0.0:8898'], 'public only: SSH, loopback and Tailscale left out');
  assert.deepEqual(inv.env_files, ['vps/.env', 'cockpit/.env'], 'paths relative to the brain, never contents');
  assert.deepEqual(inv.git, { branch: 'master', remote: 'origin', dirty: 3 });
  assert.ok(!JSON.stringify(inv).includes('\u2014'));
});

test('the probe changes nothing: no writes, no service or container verbs, sudo only to read', () => {
  const s = probeScript({ login: 'pat', folder: '~/second-brain' });
  const code = s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  for (const re of [/\brm\s/, /\bmv\s/, /\bchown\b/, /\bchmod\b/, /\btee\b/, /\binstall\s+-/, /\bmkdir\b/, /\btouch\b/, /\buseradd\b/, /\bapt(-get)?\s/,
    /systemctl[^|\n]*\b(start|stop|enable|disable|restart|reload|daemon-reload)\b/, /docker\s+(run|rm|stop|start|pull|exec|kill)\b/, /git[^\n]*\b(commit|checkout|reset|rebase|merge|add|stash|fetch|pull|push)\b/]) {
    assert.doesNotMatch(code, re, `the probe must not ${re}`);
  }
  // every redirect goes to /dev/null or is a heredoc
  for (const m of code.matchAll(/(\d?)>{1,2}\s*([^\s&|;)]+)/g)) assert.ok(m[2] === '/dev/null' || m[2].startsWith('&'), `writes to ${m[2]}`);
  assert.match(code, /--no-optional-locks/, 'git does not even refresh the index');
  assert.doesNotMatch(code, /remote get-url|remote -v/, 'the remote URL can carry a token; only its name is read');
  assert.match(s, /sudo -n true/, 'sudo checked without a password prompt');
});

// The probe for real, against a scratch brain, every system tool stubbed.
function stubBin(dir, scripts) {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

test('the probe runs: mid-rebase repo, skills, hooks, .mcp.json names and env files read off a real folder', () => {
  const home = tmpDir('adopt-home-');
  const b = join(home, 'brain');
  mkdirSync(join(b, '.claude', 'skills', 'capture'), { recursive: true });
  mkdirSync(join(b, '.claude', 'skills', '_lazy', 'roadmap'), { recursive: true });
  mkdirSync(join(b, '.claude', 'hooks'), { recursive: true });
  mkdirSync(join(b, 'vps'), { recursive: true });
  writeFileSync(join(b, '.claude', 'hooks', 'guard.py'), '#\n');
  writeFileSync(join(b, 'CLAUDE.md'), '# mine\n');
  writeFileSync(join(b, '.mcp.json'), JSON.stringify({ mcpServers: { todoist: { env: { TOKEN: 'SECRET-VALUE' } }, whatsapp: {} } }));
  writeFileSync(join(b, 'vps', '.env'), 'TELEGRAM_BOT_TOKEN=SECRET-VALUE\n');
  const g = (...a) => execFileSync('git', ['-c', 'user.name=p', '-c', 'user.email=p@x', ...a], { cwd: b, encoding: 'utf8' });
  g('init', '-q', '-b', 'master');
  writeFileSync(join(b, 'shared.md'), 'base\n'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  g('checkout', '-q', '-b', 'feature'); writeFileSync(join(b, 'shared.md'), 'feature\n'); g('commit', '-q', '-am', 'f');
  g('checkout', '-q', 'master'); writeFileSync(join(b, 'shared.md'), 'master\n'); g('commit', '-q', '-am', 'm');
  g('checkout', '-q', 'feature');
  assert.notEqual(spawnSync('git', ['-c', 'user.name=p', '-c', 'user.email=p@x', 'rebase', 'master'], { cwd: b }).status, 0, 'precondition: a rebase stopped on a conflict');
  const uid = process.getuid(); const gid = process.getgid();
  const bin = stubBin(tmpDir('adopt-stub-'), {
    sudo: '[ "$1" = -n ] && shift; exec "$@"',
    getent: `case "$2" in pat) echo "pat:x:${uid}:${gid}::${home}:/bin/bash" ;; ${uid}) echo "pat:x:${uid}:${gid}::${home}:/bin/bash" ;; *) exit 2 ;; esac`,
    'cloud-init': 'exit 0',
    systemctl: 'case "$1" in list-units) echo "telegram-chat.service loaded active running T" ;; list-unit-files) echo "telegram-chat.service enabled enabled" ;; show) printf "Id=telegram-chat.service\\nActiveState=active\\nWorkingDirectory=%s\\nExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node x.mjs ; }\\n" "$CRADS_TEST_BRAIN" ;; *) exit 0 ;; esac',
    runuser: 'exit 1',
    timedatectl: 'echo Australia/Sydney',
    docker: 'case "$1" in ps) [ "$2" = -a ] && { echo cockpit; exit 0; }; printf "cockpit\\tcockpit:latest\\tUp 6 weeks\\n" ;; esac',
    dpkg: '[ "$2" = docker-ce ] && echo "Status: install ok installed"; exit 0',
    ss: 'echo "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*"; echo "LISTEN 0 4096 *:8080 *:*"',
    crontab: 'printf "# a comment\\nSHELL=/bin/bash\\n\\n*/5 * * * * echo hi\\n"',
  });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CRADS_TEST_BRAIN: b };
  const r = spawnSync('bash', ['-s'], { input: probeScript({ login: 'pat', folder: '~/brain' }), env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const f = parseAdoptProbe(r.stdout);
  assert.equal(f.complete, true, 'the probe ran to its last line');
  assert.equal(f.sudo, true);
  assert.equal(f.folder, b, '~ expanded to the login\'s home on the server');
  assert.deepEqual([f.ownerUid, f.ownerGid], [uid, gid]);
  assert.equal(f.git, true);
  assert.equal(f.gitOp, 'rebase', 'a rebase in progress is seen');
  assert.deepEqual(f.skills, ['capture']);
  assert.deepEqual(f.lazySkills, ['roadmap']);
  assert.deepEqual(f.hooks, ['guard.py']);
  assert.deepEqual(f.mcpServers, ['todoist', 'whatsapp']);
  assert.deepEqual(f.envFiles, ['vps/.env']);
  assert.equal(f.claudeMd, true);
  assert.deepEqual(f.crontab, [{ user: 'pat', line_no: 2, text: 'SHELL=/bin/bash' }, { user: 'pat', line_no: 4, text: '*/5 * * * * echo hi' }], 'comments and blanks skipped, real line numbers kept');
  assert.deepEqual(f.units.map((u) => u.name), ['telegram-chat.service']);
  assert.deepEqual(f.containers, [{ name: 'cockpit', image: 'cockpit:latest', status: 'Up 6 weeks' }]);
  assert.equal(f.dockerPkg, 'ce');
  assert.ok(!r.stdout.includes('SECRET-VALUE'), 'no secret value ever leaves the server');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: b, encoding: 'utf8' }).includes('shared.md'), true, 'the rebase is still exactly where it stopped');

  // A folder that is not there, and the login's home itself.
  const miss = parseAdoptProbe(spawnSync('bash', ['-s'], { input: probeScript({ login: 'pat', folder: '~/nope' }), env, encoding: 'utf8' }).stdout);
  assert.match(adoptRefusal(miss, { login: 'pat' }), /no folder at .*nope/);
  const homeIt = parseAdoptProbe(spawnSync('bash', ['-s'], { input: probeScript({ login: 'pat', folder: '~' }), env, encoding: 'utf8' }).stdout);
  assert.match(adoptRefusal(homeIt, { login: 'pat' }), /home folder of "pat" itself/);
});

// ---- refusals ---------------------------------------------------------------

test('adopt refuses only what the spec lists, each in words a person can act on', () => {
  const why = (over, extra) => adoptRefusal(parseAdoptProbe(probeOut(over, extra)), { login: 'pat' });
  assert.equal(why({}), null, 'a busy server with an assistant on it is exactly what adopt is for');
  assert.equal(why({ cloudinit: 'no' }), null, 'no cloud-init needed: the shared setup is a plain script');
  assert.equal(why({ mem_mb: '1900' }), null, 'memory is not an adopt refusal (the assistant already runs there)');
  assert.match(why({ sudo: 'no' }), /passwordless sudo/);
  assert.match(why({ version: '20.04' }), /Ubuntu 24\.04/);
  assert.match(why({ arch: 'armv7l' }), /x86_64|aarch64/);
  assert.match(why({ folder_dir: 'no', folder_exists: 'no', folder: '/home/pat/nope' }), /no folder at \/home\/pat\/nope/);
  assert.match(why({ folder_dir: 'no', folder_exists: 'yes', folder: '/home/pat/notes.md' }), /is a file, not a folder/);
  assert.match(why({ folder: '/home/pat' }), /home folder of "pat" itself/);
  assert.match(why({ owner_uid: '0', owner_gid: '0' }), /belongs to root/);
  assert.match(why({ docker_pkg: 'io' }), /docker\.io[\s\S]*docker-ce[\s\S]*changed nothing/, 'docker.io refused: mixing the two breaks apt');
  assert.match(why({ docker_pkg: 'other' }), /snap/);
  assert.equal(why({ docker: 'no', docker_pkg: 'none' }), null, 'no docker at all: setup installs docker-ce');
  assert.match(why({ aios_container: 'yes' }), /container named ai-os/);
  assert.match(why({}, ['listen\t127.0.0.1:7780']), /port 7780/);
  assert.match(why({ member_user: 'yes' }), /login named "member"/);
  assert.match(why({ existing: 'yes' }), /already has a Crads-AI assistant/);
  assert.equal(why({ existing: 'yes', setup_b64: Buffer.from('[]').toString('base64'), aios_container: 'yes', member_user: 'yes', member_ours: 'yes' }, ['listen\t127.0.0.1:7780']), null, 'a re-run on our own adopted setup passes');
  assert.match(why({ disk_gb: '4' }), new RegExp(`at least ${ADOPT_MIN_FREE_DISK_GB} GB`));
  assert.equal(why({ disk_gb: '5' }), null, 'the adopt floor is 5 GB, not the dedicated 15');
  assert.match(why({ probe: undefined }), /stopped answering/);
  for (const over of [{ sudo: 'no' }, { docker_pkg: 'io' }, { folder: '/home/pat' }, { disk_gb: '1' }]) assert.doesNotMatch(why(over), /\u2014/);
});

test('busy server: accepted in adopt mode, refused in dedicated mode with a pointer to the adopt answer', async () => {
  const v = await client(fakeServer()).validateToken();
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.adopt.folder, BRAIN);
  assert.equal(v.adopt.skills, 8);
  assert.equal(v.adopt.cron, 2, 'settings lines (SHELL=, PATH=) are not jobs');
  assert.equal(v.adopt.units, 2);
  // the same server, answered "No": the busy guard, and it now names the Yes answer
  const busyCheck = 'uid=1000\nsudo=ok\nos=ubuntu\nversion=24.04\narch=aarch64\nmem_mb=23990\ncpus=4\ndisk_gb=40\ncloudinit=yes\nsystemd=yes\nexisting=no\nlisten=*:8080,0.0.0.0:22\nbusy_cron=1\nbusy_containers=cockpit\nbusy_repos=5\n';
  const d = await client(fakeServer({ check: busyCheck }), JSON.stringify({ host: '203.0.113.10', user: 'pat', slug: 'idris' })).validateToken();
  assert.equal(d.ok, false);
  assert.match(d.reason, /already runs other things/);
  assert.ok(d.reason.includes(`"${ADOPT_CHOICE}"`), 'points at "Yes, my assistant is already on it"');
  assert.match(d.reason, /changed nothing/);
  assert.doesNotMatch(d.reason, /\u2014/);
});

test('adopt check: docker.io refused, an unreachable server answered in words, and the probe is one read-only ssh', async () => {
  const f = fakeServer({ check: probeOut({ docker_pkg: 'io' }) });
  const v = await client(f).validateToken();
  assert.equal(v.ok, false);
  assert.match(v.reason, /docker\.io/);
  assert.equal(f.calls.length, 1, 'one ssh session');
  assert.equal(f.calls[0].command, 'bash -s', 'run as the login; sudo only inside, to read');
  assert.match(f.calls[0].input, /CRADS_FOLDER='~\/second-brain'/);
  const down = await client(fakeServer({ code: 255 })).validateToken();
  assert.equal(down.ok, false);
});

// ---- the render ---------------------------------------------------------------

const decoded = (files, path) => files.find((x) => x.path === path).content;
const facts = () => parseAdoptProbe(probeOut());

test('shared-server render: no firewall, no global sshd line, no timezone, no aios; the folder mounted with its owner\'s uid', () => {
  const { files, script } = renderForFacts(facts(), { boxName: 'idris', ownerPubKey: PUB, image: IMAGE, login: 'pat' });
  const all = script + '\n' + files.map((f) => f.content).join('\n');
  assert.doesNotMatch(all, /\bufw\b/, 'the person\'s firewall is theirs');
  assert.doesNotMatch(all, /fail2ban/);
  assert.doesNotMatch(all, /timedatectl set-timezone|^timezone:|ln -sf \/usr\/share\/zoneinfo/m, 'the host zone is not changed');
  assert.doesNotMatch(all, /useradd[^\n]*\baios\b|name: aios|chown -R aios/, 'no aios service account');
  assert.doesNotMatch(all, /swapfile/, 'no swap unless asked');
  assert.doesNotMatch(script, /\bcloud-init\b/, 'never replays the provider\'s own cloud-config');
  const sshd = decoded(files, '/etc/ssh/sshd_config.d/60-aios-member.conf');
  const beforeMatch = sshd.slice(0, sshd.indexOf('Match User member'));
  assert.equal(beforeMatch.trim(), '', 'nothing outside the Match block: other logins sign in exactly as before');
  assert.match(sshd, /^Match User member\n(  .+\n)+$/, 'every line after it is indented into the block');
  assert.match(sshd, /ForceCommand \/usr\/local\/bin\/enter-aios/);
  const unit = decoded(files, '/etc/systemd/system/ai-os.service');
  assert.match(unit, /--user 1002:1002/, 'the container runs as the folder\'s owner');
  assert.match(unit, new RegExp(`-v ${BRAIN}:/state`), 'the folder IS /state, mounted in place');
  assert.match(unit, /-e AIOS_ADOPTED=1/);
  assert.match(unit, /--name ai-os/);
  assert.match(unit, /-p 127\.0\.0\.1:7780:7780/);
  assert.doesNotMatch(unit, /-v \/state:\/state/, 'no host /state');
  assert.doesNotMatch(unit, /^User=/m, 'no login of the person\'s joins the docker group for it');
  assert.match(decoded(files, '/etc/ai-os/env'), /^TZ=Australia\/Sydney$/m, 'the host zone, read, not set');
  assert.match(decoded(files, '/usr/local/bin/aios-state-keys'), new RegExp(`D=${BRAIN}\\n`), 'the door reads the roster in the brain');
  assert.match(script, /useradd --create-home --shell \/bin\/bash --groups docker member/);
  assert.ok(script.indexOf('step ownership') < script.indexOf('enable --now ai-os.service'), 'ownership.json is merged before the service first starts');
  assert.match(script, /if command -v docker[\s\S]*else[\s\S]*apt-get install -y docker-ce/, 'docker installed only when absent');
  // (aios-host-update and enter-aios ride verbatim from provisioning/host/, as on every box)
  const ours = script + '\n' + files.filter((f) => !/aios-host-update|enter-aios/.test(f.path)).map((f) => f.content).join('\n');
  assert.ok(!/\u2014/.test(ours), 'no em dashes in anything this renderer writes');
  // swap only when ticked
  assert.match(renderForFacts(facts(), { boxName: 'idris', ownerPubKey: PUB, image: IMAGE, login: 'pat', swap: true }).script, /swapfile/);
  assert.throws(() => renderAdoptSetup({ boxName: 'idris', ownerPubKey: PUB, image: IMAGE, brainRoot: BRAIN, uid: 0, gid: 0 }), /non-root owner/);
  assert.throws(() => renderAdoptSetup({ boxName: 'idris', ownerPubKey: PUB, image: IMAGE, brainRoot: '/x y', uid: 1, gid: 1 }), /plain characters/);
});

test('ownership.json merge keeps every existing key and refuses a file it cannot read', () => {
  const merged = JSON.parse(mergeOwnership(JSON.stringify({ mineral_id: 'min_0123456789abcdef01234567', holder: { kind: 'account', email: 'a@b.c' }, access: [{ role: 'owner' }], adopted: false })));
  assert.deepEqual(merged, { mineral_id: 'min_0123456789abcdef01234567', holder: { kind: 'account', email: 'a@b.c' }, access: [{ role: 'owner' }], adopted: true, moving_in: true });
  assert.deepEqual(JSON.parse(mergeOwnership(null)), { adopted: true, moving_in: true }, 'created when missing');
  assert.throws(() => mergeOwnership('{not json'), /not a JSON object/);
  assert.throws(() => mergeOwnership('[1,2]'), /not a JSON object/);
});

// ---- setup and teardown, run for real in a scratch tree ------------------------

function scratchHost({ sshdOk = true, memberExists = false } = {}) {
  const root = tmpDir('adopt-root-');
  const brain = tmpDir('adopt-brain-');
  writeFileSync(join(brain, 'ownership.json'), JSON.stringify({ mineral_id: 'min_0123456789abcdef01234567', theirs: 'kept' }, null, 2) + '\n');
  const state = tmpDir('adopt-state-');
  const log = join(state, 'calls.log');
  if (memberExists) writeFileSync(join(state, 'member'), '');
  const L = `echo "$(basename "$0") $*" >> ${log}`;
  // Every tool that could change this machine is a stub that only logs.
  const bin = stubBin(join(state, 'bin'), {
    systemctl: `${L}; case "$1" in cat) [ -e ${state}/unit-$2 ] ;; enable) touch ${state}/unit-$3 ;; disable) rm -f ${state}/unit-$3 ;; esac; exit 0`,
    sshd: `${L}; exit ${sshdOk ? 0 : 1}`,
    useradd: `${L}; touch ${state}/member`,
    usermod: L, pkill: L, swapon: L, swapoff: L, mkswap: L, fallocate: L, 'apt-get': L, curl: L,
    userdel: `${L}; rm -f ${state}/member`,
    getent: `${L}; [ "$2" = member ] && [ -e ${state}/member ] && echo "member:x:1500:1500::/home/member:/bin/bash"`,
    dpkg: `${L}; exit 1`,
    docker: `${L}; exit 0`,
    sudo: `${L}; echo "sudo must not be reached in a test" >&2; exit 99`,
  });
  // The local runner: AS_ROOT becomes plain bash (we ARE the stand-in root).
  const runner = async ({ command, input }) => {
    const r = spawnSync('bash', command === AS_ROOT_SCRIPT ? ['-s'] : ['-c', command], { input, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
  const c = new OwnServerClient(TOKEN, { sshDir: '/tmp/keys', runner });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  return { root, brain, state, c, calls };
}

function scratchFacts(h) {
  return parseAdoptProbe(probeOut({
    folder: h.brain, owner_uid: String(process.getuid()), owner_gid: String(process.getgid()),
    ownership_b64: Buffer.from(readFileSync(join(h.brain, 'ownership.json'))).toString('base64'),
  }));
}
const render = (h, f = scratchFacts(h), extra = {}) => renderAdoptSetup({
  boxName: 'idris', ownerPubKey: PUB, image: IMAGE, brainRoot: f.folder, uid: f.ownerUid, gid: f.ownerGid, tz: f.tz,
  inventory: inventoryFrom(f, { login: 'pat' }), ownershipText: f.ownershipText, hostRoot: h.root, ...extra,
});
const record = (h) => JSON.parse(readFileSync(join(h.brain, HOST_SETUP_REL), 'utf8'));
const mode = (p) => (statSync(p).mode & 0o777).toString(8);

test('setup records every host change before making it, and teardown undoes each one', async () => {
  const h = scratchHost();
  const out = await setupSharedHost(h.c, { script: render(h).script });
  assert.equal(out.ok, true);
  const rec = record(h);
  assert.ok(Array.isArray(rec), 'host-setup.json is a list of {what, reverse}');
  for (const e of rec) assert.deepEqual(Object.keys(e), ['what', 'reverse']);
  // every host file it wrote, written and recorded
  // /etc/ai-os/passwd and group are written by aios-passwd when the service
  // starts, not by setup; they are recorded up front so Move out removes them.
  const ATSTART = ['/etc/ai-os/passwd', '/etc/ai-os/group'];
  for (const p of ADOPT_HOST_FILES) {
    if (!ATSTART.includes(p)) assert.ok(existsSync(join(h.root, p)), `${p} written`);
    assert.ok(rec.some((e) => e.reverse.op === 'remove-file' && e.reverse.path === p), `${p} recorded`);
  }
  assert.ok(rec.some((e) => e.reverse.op === 'remove-dir' && e.reverse.path === '/etc/ai-os'));
  assert.ok(rec.some((e) => e.reverse.op === 'remove-user' && e.reverse.user === 'member'));
  assert.deepEqual(rec.filter((e) => e.reverse.op === 'stop-unit').map((e) => e.reverse.unit), ['ai-os-host-update.timer', 'ai-os.service']);
  assert.ok(!rec.some((e) => /docker/i.test(e.what)), 'docker was there already (a stub on PATH), so nothing about it is recorded');
  assert.match(h.calls(), /useradd --create-home --shell \/bin\/bash --groups docker member/);
  assert.match(h.calls(), /systemctl enable --now ai-os\.service/);
  assert.doesNotMatch(h.calls(), /ufw|timedatectl|apt-get/);
  // inside the brain: owned by its owner, private where it should be
  const inv = join(h.brain, INVENTORY_REL);
  assert.equal(mode(inv), '600');
  assert.equal(mode(join(h.brain, HOST_SETUP_REL)), '600');
  assert.equal(statSync(inv).uid, process.getuid());
  assert.equal(JSON.parse(readFileSync(inv, 'utf8')).brain_root, h.brain);
  assert.deepEqual(JSON.parse(readFileSync(join(h.brain, 'ownership.json'), 'utf8')), { mineral_id: 'min_0123456789abcdef01234567', theirs: 'kept', adopted: true, moving_in: true });
  assert.match(readFileSync(join(h.brain, 'devices', 'this-computer.yaml'), 'utf8'), /pubkeys:\n  - ssh-ed25519 /);
  assert.equal(readFileSync(join(h.brain, 'ssh', 'member', 'authorized_keys'), 'utf8').trim(), PUB);

  // a second run adds nothing to the record
  await setupSharedHost(h.c, { script: renderAdoptSetup({ ...scratchArgs(h), priorEntries: rec.map((e) => JSON.stringify(e)) }).script });
  assert.deepEqual(record(h), rec, 'a re-run records nothing twice');

  // teardown, newest first
  const brainBefore = snapshot(h.brain);
  const t = await teardownSharedHost(h.c, { brainRoot: h.brain, hostRoot: h.root });
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.equal(t.failed.length, 0);
  for (const p of ADOPT_HOST_FILES) assert.ok(!existsSync(join(h.root, p)), `${p} removed`);
  assert.ok(!existsSync(join(h.root, 'etc', 'ai-os')), '/etc/ai-os removed once empty');
  assert.match(h.calls(), /systemctl disable --now ai-os\.service/);
  assert.match(h.calls(), /systemctl disable --now ai-os-host-update\.timer/);
  assert.match(h.calls(), /docker rm -f ai-os/);
  assert.match(h.calls(), /userdel -r member/);
  assert.doesNotMatch(h.calls(), /apt-get (remove|purge)|docker-ce/, 'docker is never uninstalled');
  const order = (re) => h.calls().search(re);
  assert.ok(order(/disable --now ai-os\.service/) < order(/userdel/), 'the service stops before its login goes');
  assert.ok(!existsSync(join(h.brain, HOST_SETUP_REL)), 'the record is deleted last');
  const brainAfter = snapshot(h.brain);
  delete brainBefore[HOST_SETUP_REL];
  assert.deepEqual(brainAfter, brainBefore, 'nothing else in the folder was touched');
  assert.ok(t.kept.some((w) => /ownership\.json/.test(w)), 'what stays is said, not hidden');

  // nothing left to undo
  assert.equal((await teardownSharedHost(h.c, { brainRoot: h.brain, hostRoot: h.root })).nothing, true);
});

function scratchArgs(h) {
  const f = scratchFacts(h);
  f.ownershipText = readFileSync(join(h.brain, 'ownership.json'), 'utf8');
  return { boxName: 'idris', ownerPubKey: PUB, image: IMAGE, brainRoot: f.folder, uid: f.ownerUid, gid: f.ownerGid, tz: f.tz, inventory: inventoryFrom(f, { login: 'pat' }), ownershipText: f.ownershipText, hostRoot: h.root };
}
function snapshot(dir, base = dir, out = {}) {
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, n.name);
    if (n.isDirectory()) snapshot(p, base, out);
    else out[p.slice(base.length + 1)] = readFileSync(p, 'utf8');
  }
  return out;
}

test('a setup that dies part way leaves a record of exactly what it did, and teardown undoes that', async () => {
  const h = scratchHost({ sshdOk: false });
  await assert.rejects(setupSharedHost(h.c, { script: render(h).script }), (e) => e.code === 'setup_failed' && /SSH server rejected/.test(e.message) && /host-setup\.json/.test(e.message));
  const rec = record(h);
  assert.ok(rec.some((e) => e.reverse.path === '/etc/systemd/system/ai-os.service'), 'files written before the failure are on the record');
  assert.ok(!rec.some((e) => e.reverse.op === 'stop-unit'), 'nothing was started, so no unit is on the record');
  assert.ok(!existsSync(join(h.root, 'etc', 'ssh', 'sshd_config.d', '60-aios-member.conf')), 'the rejected drop-in was taken out at once');
  assert.ok(!JSON.parse(readFileSync(join(h.brain, 'ownership.json'), 'utf8')).moving_in, 'ownership.json was never reached');
  const t = await teardownSharedHost(h.c, { brainRoot: h.brain, hostRoot: h.root });
  assert.equal(t.ok, true, JSON.stringify(t));
  for (const p of ADOPT_HOST_FILES) assert.ok(!existsSync(join(h.root, p)), `${p} gone`);
  assert.ok(!existsSync(join(h.root, 'etc', 'ai-os')));
});

test('teardown runs only its own reverses: an entry the container could have written is skipped, never run', async () => {
  const h = scratchHost();
  await setupSharedHost(h.c, { script: render(h).script });
  const rec = record(h);
  writeFileSync(join(h.root, 'precious'), 'keep me\n');
  rec.push({ what: 'evil', reverse: { op: 'remove-file', path: '/precious' } }, { what: 'evil2', reverse: { op: 'shell', cmd: `rm -rf ${h.root}` } }, { what: 'evil3', reverse: { op: 'remove-user', user: 'pat' } });
  writeFileSync(join(h.brain, HOST_SETUP_REL), JSON.stringify(rec));
  const t = await teardownSharedHost(h.c, { brainRoot: h.brain, hostRoot: h.root });
  assert.deepEqual(t.skipped.sort(), ['evil', 'evil2', 'evil3']);
  assert.equal(t.ok, false, 'a skipped entry is reported, not swallowed');
  assert.ok(existsSync(join(h.root, 'precious')), 'a path outside the setup\'s own list is never removed');
  assert.doesNotMatch(h.calls(), /userdel -r pat/);
  assert.ok(existsSync(join(h.brain, HOST_SETUP_REL)), 'the record stays for a person to read');
  for (const p of ADOPT_HOST_FILES) assert.ok(!existsSync(join(h.root, p)), `${p}: the real entries were still undone`);
});

test('setup refuses to merge into an ownership.json that changed since the check', async () => {
  const h = scratchHost();
  const script = render(h).script;
  writeFileSync(join(h.brain, 'ownership.json'), '{"edited":"after the check"}\n');
  await assert.rejects(setupSharedHost(h.c, { script }), /changed since the check/);
  assert.deepEqual(JSON.parse(readFileSync(join(h.brain, 'ownership.json'), 'utf8')), { edited: 'after the check' });
});

test('collectInventory reads the server fresh, in the contract\'s shape', async () => {
  const inv = await collectInventory(client(fakeServer()));
  assert.equal(inv.brain_root, BRAIN);
  assert.equal(inv.login, 'pat');
  assert.deepEqual(inv.skills.slice(0, 2), ['capture', 'daily']);
  await assert.rejects(collectInventory(client(fakeServer({ check: probeOut({ folder_dir: 'no', folder_exists: 'no' }) }))), /no folder/);
});

// ---- through the engine ---------------------------------------------------------

test('the engine drives adopt through the same steps; the setup is the shared-server one, rendered from the check', async () => {
  const f = fakeServer();
  const state = {};
  const steps = [];
  const r = await provisionSelfHost({
    token: TOKEN, boxName: 'idris', ownerPubKey: PUB, state, provider: 'own',
    onStep: (s) => steps.push(s),
    overrides: { client: client(f), image: IMAGE, sleep: async () => {} },
  });
  assert.equal(r.ip, '203.0.113.10');
  assert.deepEqual(steps, ['validate-token', 'ensure-ssh-key', 'create-server', 'wait-running', 'done']);
  const setup = f.calls.find((x) => x.command !== 'bash -s');
  assert.equal(setup.command, AS_ROOT_SCRIPT, 'root work on stdin, as for a dedicated server');
  assert.match(setup.input, /step ownership/);
  assert.doesNotMatch(setup.input, /cloud-init|ufw/);
  assert.match(setup.input, /useradd --create-home --shell \/bin\/bash --groups docker member/);

  // resumed after a crash between check and setup: the client checks again before rendering
  const f2 = fakeServer();
  await provisionSelfHost({ token: TOKEN, boxName: 'idris', ownerPubKey: PUB, state: { provider: 'own', tokenValidated: true, sshKeyId: 'own' }, provider: 'own', overrides: { client: client(f2), image: IMAGE, sleep: async () => {} } });
  assert.equal(f2.calls[0].command, 'bash -s', 'a resume re-reads the server before setting it up');
});

// Follow-up (2026-10-18): the move-in's server steps and Move out SSH in as the
// adopting login with the mineral's own key (<slug>-box.key), the one the app
// used for setup. Setup must leave that way in exactly as it found it.
test('setup and teardown leave the adopting login\'s key and sign-in alone', async () => {
  const { files, script } = renderForFacts(facts(), { boxName: 'idris', ownerPubKey: PUB, image: IMAGE, login: 'pat' });
  // the only authorized_keys it writes is the member door inside the brain
  const keyWrites = [...script.matchAll(/authorized_keys/g)].length;
  assert.equal(keyWrites, 2, 'two mentions, both the brain\'s ssh/member/authorized_keys');
  assert.ok(script.split('\n').filter((l) => l.includes('authorized_keys')).every((l) => l.includes('"$B/ssh/member/authorized_keys"')));
  assert.doesNotMatch(script, /\/home\/pat\/\.ssh|~\/\.ssh|\$HOME|\.ssh\//, 'never the login\'s own ~/.ssh');
  assert.doesNotMatch(script, /usermod[^\n]*\bsam\b|^\s*passwd\s|\bchage\s/m, 'the login itself is never changed');
  const sshd = decoded(files, '/etc/ssh/sshd_config.d/60-aios-member.conf');
  const outside = sshd.slice(0, sshd.indexOf('Match User member'));
  assert.equal(outside.trim(), '', 'no sshd setting outside the member block, so the login signs in exactly as before');
  // and teardown only ever removes the member login
  const h = scratchHost();
  const home = join(h.root, 'home', 'pat', '.ssh');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'authorized_keys'), `${PUB.replace('owner@wizard', 'idris-box')}\n`);
  const before = readFileSync(join(home, 'authorized_keys'), 'utf8');
  await setupSharedHost(h.c, { script: render(h).script });
  await teardownSharedHost(h.c, { brainRoot: h.brain, hostRoot: h.root });
  assert.equal(readFileSync(join(home, 'authorized_keys'), 'utf8'), before, 'the mineral\'s key is still on the login after setup and Move out');
  assert.doesNotMatch(h.calls(), /userdel[^\n]*\bsam\b/);
});

// Shadow test on Oracle (2026-10-19): the owner was uid 1002, which the image
// does not name, so `whoami` failed and HOME was "/" (npx could not cache, every
// npx connection died). aios-passwd gives the owner a name and a home.
test('aios-passwd names an owner the image does not know, and leaves a known one alone', () => {
  const r = renderAdoptSetup({ boxName: 'shadow', ownerPubKey: PUB, image: 'ghcr.io/x/y:v2', brainRoot: '/srv/brain', uid: 1002, gid: 1002 });
  const script = r.files.find((f) => f.path === '/usr/local/bin/aios-passwd').content;
  const svc = r.files.find((f) => f.path === '/etc/systemd/system/ai-os.service').content;
  assert.match(svc, /ExecStartPre=\/usr\/local\/bin\/aios-passwd ghcr\.io\/x\/y:v2 1002 1002 \/srv\/brain/);
  assert.match(svc, /-e HOME=\/state\/\.kernel\/home -v \/etc\/ai-os\/passwd:\/etc\/passwd:ro -v \/etc\/ai-os\/group:\/etc\/group:ro/);
  const run = (uid, gid, hostName) => {
    const d = tmpDir('aios-passwd-');
    const bin = join(d, 'bin'); mkdirSync(bin); const etc = join(d, 'etc'); mkdirSync(etc); const brain = join(d, 'brain'); mkdirSync(join(brain, '.kernel'), { recursive: true });
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\ncase "$*" in *passwd*) printf "root:x:0:0::/root:/bin/sh\\nnode:x:1000:1000::/home/node:/bin/sh\\n";; *) printf "root:x:0:\\nnode:x:1000:\\n";; esac\n', { mode: 0o755 });
    writeFileSync(join(bin, 'getent'), `#!/bin/sh\necho "${hostName}:x:$2:$2::/home/${hostName}:/bin/bash"\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'install'), '#!/bin/sh\nfor a; do last="$a"; done; mkdir -p "$last"\n', { mode: 0o755 });
    const sh = join(d, 'aios-passwd'); writeFileSync(sh, script, { mode: 0o755 });
    const res = spawnSync('sh', [sh, 'img', String(uid), String(gid), brain], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AIOS_ETC: etc }, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return { passwd: readFileSync(join(etc, 'passwd'), 'utf8'), group: readFileSync(join(etc, 'group'), 'utf8'), home: existsSync(join(brain, '.kernel', 'home')) };
  };
  const sam = run(1002, 1002, 'pat');
  assert.match(sam.passwd, /^pat:x:1002:1002:Crads-AI owner:\/state\/\.kernel\/home:\/bin\/bash$/m, 'the owner is named, with a home inside the brain');
  assert.match(sam.group, /^pat:x:1002:$/m);
  assert.ok(sam.home, '.kernel/home exists for npx and git');
  const known = run(1000, 1000, 'fixture');
  assert.equal((known.passwd.match(/:1000:/g) || []).length, 1, 'a uid the image names is left as it is');
  const clash = run(1003, 1003, 'node');
  assert.match(clash.passwd, /^crads-node:x:1003:/m, 'a host name the image already uses for another uid is prefixed');
});
