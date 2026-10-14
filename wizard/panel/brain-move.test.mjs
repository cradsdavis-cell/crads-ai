// brain-move.test.mjs: a brain moves from a folder on this computer onto a server
// and back again (Sam's rulings, 2026-10-14). Run: node --test wizard/panel/brain-move.test.mjs
//
// Real on every end that can be real without a server: the folder is made by the
// real local scaffold, the brain travels as a real git bundle, the server-side
// merge is the real engine/restore.mjs in the runbook's copy-in layout (linked
// into this checkout's engine/ the way a server's links into /app/engine), and
// the pack is the real engine/move-pack.mjs. The one stand-in is the server: a
// temp directory shaped like /state, reached by running the same commands
// through bash instead of ssh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { loadEngineAssets, scaffoldLocalBrain, REPO_ROOT } from './local-scaffold.mjs';
import { listLocalTargets, registerLocalBrain } from './local-targets.mjs';
import { moveUp, moveDown, shellTransport, loadToolFiles, localMcpFromServer, serverMcpFromLocal, judgeUpDiff, pausedSummary, stillVerified, readPaused, MoveRefusal, buildUpPack } from './brain-move.mjs';
import { packPaths, readPack } from '../../engine/move-pack.mjs';

const skip = process.platform === 'win32' ? 'the stand-in server is bash' : false;
const assets = loadEngineAssets();
const toolFiles = loadToolFiles();
const APP = join(REPO_ROOT, 'engine');
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const g = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...ID } }).trim();
const read = (...p) => readFileSync(join(...p), 'utf8');
const noRestart = async () => ({ code: 0 });
const KEY = 'ssh-ed25519 AAAASERVERKEY this-laptop';

// A server as the wizard leaves it: box-up's ignore list, a named folder link,
// this computer's key on the roster, its own Claude sign-in, committed.
function server(root, name = 'srv', more = () => {}) {
  const d = join(root, name + '-state');
  mkdirSync(join(d, 'wiki'), { recursive: true });
  mkdirSync(join(d, 'devices'), { recursive: true });
  copyFileSync(join(APP, 'lib', 'brain-ignore.txt'), join(d, '.gitignore'));
  writeFileSync(join(d, 'profile.yaml'), `identity:\n  assistant_name: "${name}"\n  user_short: ""\n`);
  writeFileSync(join(d, 'box-name'), name);
  writeFileSync(join(d, 'open-folder'), name + '\n');
  symlinkSync('.', join(d, name));
  writeFileSync(join(d, 'devices', 'this-computer.yaml'), `pubkeys:\n  - ${KEY}\n`);
  writeFileSync(join(d, 'wiki', 'priorities.md'), '# Priorities\n_(populated by /onboard)_\n');
  mkdirSync(join(d, '.claude-auth'), { recursive: true });
  writeFileSync(join(d, '.claude-auth', '.credentials.json'), '{"server":"claude"}\n');
  mkdirSync(join(d, 'secrets'), { recursive: true });
  writeFileSync(join(d, 'secrets', 'backup_passphrase'), 'a'.repeat(64) + '\n', { mode: 0o600 });
  more(d);
  execFileSync('git', ['init', '-q', '-b', 'master', d]);
  g(d, 'add', '-A'); g(d, 'commit', '-q', '-m', 'init: brain scaffold');
  return d;
}

// A server that has lived: schedule, Telegram, connections of three kinds.
const lived = (d) => {
  writeFileSync(join(d, 'wiki', 'clients.md'), '# Clients\nHarbour & Fern, Tuesdays.\n');
  writeFileSync(join(d, 'secrets', 'telegram_bot_token'), 'BOT-TOKEN\n', { mode: 0o600 });
  writeFileSync(join(d, 'secrets', 'telegram_chat_id'), '4242\n');
  writeFileSync(join(d, 'secrets', 'notion_api'), 'svc\n');
  mkdirSync(join(d, 'cockpit'), { recursive: true });
  writeFileSync(join(d, 'cockpit', 'cadence.json'), JSON.stringify({ version: 2, jobs: {
    daily: { enabled: true, deliver: true, schedule: { kind: 'times', days: [], times: ['07:00'] } },
    weekly: { enabled: true, deliver: true, schedule: { kind: 'times', days: ['sun'], times: ['17:00'] } },
    inbox: { enabled: false, deliver: false, schedule: { kind: 'every', minutes: 60, quiet: true } },
  } }));
  mkdirSync(join(d, '.kernel', 'google-creds'), { recursive: true });
  writeFileSync(join(d, '.kernel', 'crontab'), '0 7 * * * daily\n');
  writeFileSync(join(d, '.kernel', 'telegram-offset'), '991\n');
  writeFileSync(join(d, '.kernel', 'mcp-oauth.json'), JSON.stringify({ notion: { refresh: 'r' } }));
  writeFileSync(join(d, '.kernel', 'mcp-added.json'), JSON.stringify(['notion', 'acme', 'google']));
  writeFileSync(join(d, '.kernel', 'google-creds', 'ana.json'), '{"refresh_token":"g"}\n');
  mkdirSync(join(d, '.kernel', 'gh'), { recursive: true });
  writeFileSync(join(d, '.kernel', 'gh', 'hosts.yml'), 'github.com: server\n');
  writeFileSync(join(d, '.mcp.json'), JSON.stringify({ mcpServers: {
    notion: { type: 'http', url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer short' }, headersHelper: 'node /app/engine/comms/mcp-header.mjs /state' },
    acme: { type: 'http', url: 'https://mcp.acme.example/mcp', headers: { Authorization: 'Bearer my-own-api-key' } },
    google: { type: 'stdio', command: '/opt/gws/bin/gws', args: ['--single-user'] },
  } }, null, 2));
  mkdirSync(join(d, '.claude', 'skills', 'capture'), { recursive: true });
  writeFileSync(join(d, '.claude', 'skills', 'capture', 'SKILL.md'), 'engine copy\n');
  mkdirSync(join(d, '.claude', 'skills', 'quote-writer'), { recursive: true });
  writeFileSync(join(d, '.claude', 'skills', 'quote-writer', 'SKILL.md'), '# my own skill\n');
};

async function folder(root, name = 'Idris') {
  const f = join(root, 'Crads-AI', name.toLowerCase());
  await scaffoldLocalBrain(f, { name, assets });
  writeFileSync(join(f, 'wiki', 'people.md'), '# People\nMaria at the bakery.\n');
  mkdirSync(join(f, '.claude', 'skills', 'my-skill'), { recursive: true });
  writeFileSync(join(f, '.claude', 'skills', 'my-skill', 'SKILL.md'), '# mine\n');
  writeFileSync(join(f, '.mcp.json'), JSON.stringify({ mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } } }));
  return f;
}

function registry(root) {
  const p = join(root, 'local-brains.json');
  return { path: p, targets: () => listLocalTargets(p), register: (s, o) => registerLocalBrain(s, o, p) };
}

test('pure: a server’s connections, as a computer can use them, and back', () => {
  const srv = { mcpServers: {
    notion: { type: 'http', url: 'https://n/mcp', headers: { Authorization: 'Bearer x' }, headersHelper: 'node /app/x' },
    acme: { type: 'sse', url: 'https://a/sse', headers: { Authorization: 'Bearer mine' } },
    plain: { type: 'http', url: 'https://p/mcp' },
    google: { type: 'stdio', command: '/opt/gws', args: [] },
  } };
  const l = localMcpFromServer(srv, { oauthNames: ['notion'] });
  assert.deepEqual(l.mcp.mcpServers.notion, { type: 'http', url: 'https://n/mcp' }, 'a sign-in the server renews is signed in again by Claude Code');
  assert.deepEqual(l.mcp.mcpServers.acme, { type: 'sse', url: 'https://a/sse', headers: { Authorization: 'Bearer mine' } }, 'the member’s own API token keeps working');
  assert.deepEqual(l.needsServer, ['google']);
  assert.deepEqual(l.signIn.sort(), ['notion', 'plain']);
  // back up: the paused copy wins for what both have; removed here goes; added here comes
  const back = serverMcpFromLocal(srv, { mcpServers: { notion: l.mcp.mcpServers.notion, linear: { type: 'http', url: 'https://l/mcp' } } });
  assert.equal(back.mcpServers.notion.headersHelper, 'node /app/x');
  assert.ok(back.mcpServers.google, 'a box-only connection always comes back');
  assert.ok(!back.mcpServers.acme && !back.mcpServers.plain, 'removed on the computer, removed on the server');
  assert.deepEqual(back.mcpServers.linear, { type: 'http', url: 'https://l/mcp' });
});

test('pure: the check after a move up names what went missing, and forgives what the server keeps', () => {
  assert.equal(judgeUpDiff('A\twiki/x.md\nM\tbox-name\nM\tprofile.yaml\nD\tdevices/old.yaml').ok, true);
  const bad = judgeUpDiff('D\twiki/people.md\nM\twiki/clients.md');
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.lost, ['missing: wiki/people.md', 'changed: wiki/clients.md']);
});

test('pure: what is paused, in words', () => {
  const files = { 'cockpit/cadence.json': JSON.stringify({ version: 2, jobs: { daily: { enabled: true, deliver: true, schedule: { kind: 'times', days: [], times: ['07:00'] } }, weekly: { enabled: true, schedule: { kind: 'times', days: ['sun'], times: ['17:00'] } } } }), 'secrets/telegram_bot_token': 'x' };
  const s = pausedSummary((p) => (p in files ? files[p] : null), { from: 'srv-box' });
  assert.deepEqual(s.items.map((i) => i.id), ['morning-brief', 'schedule', 'telegram']);
  assert.match(s.items[0].detail, /daily at 07:00, sent to Telegram/);
  assert.match(s.items[1].detail, /\/weekly sun at 17:00/);
});

test('the Claude sign-in never travels, whatever asks for it', () => {
  const d = tmpDir('mvpack-');
  mkdirSync(join(d, '.claude-auth'), { recursive: true });
  writeFileSync(join(d, '.claude-auth', '.credentials.json'), 'secret');
  mkdirSync(join(d, '.opencode-auth'), { recursive: true });
  writeFileSync(join(d, '.opencode-auth', 'auth.json'), 'secret');
  const p = packPaths(d, ['.claude-auth', '.opencode-auth', '.claude-auth/.credentials.json']);
  assert.equal(p.files.length, 0);
  assert.throws(() => readPack(JSON.stringify({ kind: 'crads-move-pack', version: 1, files: [{ path: '.claude-auth/.credentials.json', mode: 384, b64: '' }] })), /must not/);
  assert.throws(() => readPack(JSON.stringify({ kind: 'crads-move-pack', version: 1, files: [{ path: '../escape', mode: 384, b64: '' }] })), /must not/);
});

test('UP: a folder moves onto a fresh server; the server keeps its door, the assistant keeps its name, the folder is untouched', { skip }, async () => {
  const root = tmpDir('mvup-');
  const f = await folder(root);
  const srv = server(root);
  const before = g(f, 'rev-parse', 'HEAD');
  const steps = [];
  const r = await moveUp({ folder: f, to: 'idris-box', transport: shellTransport(), toolFiles, state: srv, app: APP, staging: join(root, 'stage'), restart: noRestart, step: (s) => steps.push(s) });
  assert.equal(r.verified, true);
  assert.equal(r.via, 'ssh');
  // the folder: its pending changes committed once, nothing else moved
  assert.notEqual(g(f, 'rev-parse', 'HEAD'), before, 'pending changes were recorded first');
  assert.equal(g(f, 'rev-parse', 'HEAD'), r.commit);
  assert.ok(existsSync(join(f, 'wiki', 'people.md')), 'the folder still has its brain');
  assert.equal(JSON.parse(read(f, '.kernel', 'moved.json')).to, 'idris-box');
  // the server: the brain arrived, the name came with it
  assert.match(read(srv, 'wiki', 'people.md'), /Maria at the bakery/);
  assert.equal(read(srv, 'box-name').trim(), 'Idris');
  assert.match(read(srv, 'profile.yaml'), /assistant_name: "Idris"/);
  // ... the door did not: the server's key, its folder link, its own Claude sign-in
  assert.match(read(srv, 'devices', 'this-computer.yaml'), /SERVERKEY/);
  assert.ok(lstatSync(join(srv, 'srv')).isSymbolicLink());
  assert.equal(read(srv, '.claude-auth', '.credentials.json'), '{"server":"claude"}\n', 'the server’s Claude sign-in is untouched');
  // what travels beside the brain: the member's own skill and the connection
  assert.equal(read(srv, '.claude', 'skills', 'my-skill', 'SKILL.md'), '# mine\n');
  assert.deepEqual(JSON.parse(read(srv, '.mcp.json')).mcpServers.linear, { type: 'http', url: 'https://mcp.linear.app/mcp' });
  // and the staging was removed on both sides
  assert.ok(!existsSync(join(srv, '.kernel', 'move')), 'the move tool and files were removed from the server');
  assert.ok(steps.includes('Checking the move before changing anything') && steps.indexOf('Checking the move before changing anything') < steps.indexOf('Moving your brain in'));
});

test('DOWN then UP again: the brain, sign-ins and connections come to a folder, the schedule and Telegram pause, and the next server gets them back as they were', { skip }, async () => {
  const root = tmpDir('mvdown-');
  const srv = server(root, 'ana', lived);
  writeFileSync(join(srv, 'wiki', 'late.md'), '# Written today, not yet committed\n');
  const reg = registry(root);
  const dest = join(root, 'Crads-AI', 'ana');
  const r = await moveDown({ from: 'ana-box', folder: dest, transport: shellTransport(), toolFiles, assets, state: srv, app: APP, staging: join(root, 'stage'), targets: reg.targets, register: reg.register });

  // verified against the server: its commit (the late page included) and its file count
  assert.equal(r.verified, true);
  assert.equal(r.commit, g(srv, 'rev-parse', 'HEAD'));
  assert.equal(r.files, g(srv, 'ls-files').split('\n').length);
  assert.match(read(dest, 'wiki', 'late.md'), /not yet committed/, 'the server committed what was pending before packing');
  assert.equal(stillVerified(r).ok, true);
  // registered
  assert.deepEqual(reg.targets().map((t) => [t.org, t.path]), [['ana', dest]]);
  // the Claude sign-in did not come: the computer's own login is the one that counts
  assert.ok(!existsSync(join(dest, '.claude-auth', '.credentials.json')));
  // the server's folder link is not a second path to the folder here
  assert.ok(!existsSync(join(dest, 'ana')));
  // sign-ins and connections came (ruling 4)
  assert.equal(read(dest, 'secrets', 'notion_api'), 'svc\n');
  assert.equal(read(dest, '.kernel', 'google-creds', 'ana.json'), '{"refresh_token":"g"}\n');
  assert.ok(existsSync(join(dest, '.kernel', 'mcp-oauth.json')));
  assert.ok(!existsSync(join(dest, '.kernel', 'gh')), 'the server’s GitHub CLI login stays there');
  const mcp = JSON.parse(read(dest, '.mcp.json')).mcpServers;
  assert.deepEqual(Object.keys(mcp).sort(), ['acme', 'notion']);
  assert.ok(!mcp.notion.headers, 'Claude Code signs in to notion itself on a computer');
  assert.equal(mcp.acme.headers.Authorization, 'Bearer my-own-api-key');
  assert.deepEqual(JSON.parse(read(dest, '.claude', 'settings.local.json')).enabledMcpjsonServers.sort(), ['acme', 'notion']);
  assert.equal(read(dest, '.claude', 'skills', 'quote-writer', 'SKILL.md'), '# my own skill\n');
  assert.notEqual(read(dest, '.claude', 'skills', 'capture', 'SKILL.md'), 'engine copy\n', 'engine skills are this computer’s own');
  // paused, kept, switched off (ruling 5)
  assert.ok(!existsSync(join(dest, 'secrets', 'telegram_bot_token')), 'Telegram is not left live in secrets/');
  assert.equal(read(dest, '.kernel', 'paused', 'secrets', 'telegram_bot_token'), 'BOT-TOKEN\n');
  assert.ok(existsSync(join(dest, '.kernel', 'paused', 'cockpit', 'cadence.json')));
  assert.ok(!existsSync(join(dest, 'cockpit', 'cadence.json')));
  const paused = readPaused(dest);
  assert.deepEqual(paused.items.map((i) => i.id), ['morning-brief', 'schedule', 'telegram', 'connections']);
  assert.match(paused.items.find((i) => i.id === 'connections').detail, /google/);
  // nothing paused or credential-shaped is tracked in the folder's history
  const tracked = g(dest, 'ls-files').split('\n');
  assert.ok(!tracked.some((t) => /^(secrets|\.kernel|\.claude-auth|\.mcp\.json|cockpit)/.test(t)));
  // and the server was not changed by the move beyond its own pending commit
  assert.ok(existsSync(join(srv, 'secrets', 'telegram_bot_token')) && !existsSync(join(srv, '.kernel', 'move')));

  // ---- the member edits on the computer, then moves to a new server
  writeFileSync(join(dest, 'wiki', 'from-laptop.md'), '# Written on the laptop\n');
  const srv2 = server(root, 'ana2');
  const up = await moveUp({ folder: dest, to: 'ana2-box', transport: shellTransport(), toolFiles, state: srv2, app: APP, staging: join(root, 'stage2'), restart: noRestart });
  assert.equal(up.verified, true);
  assert.deepEqual(up.restored.sort(), ['.kernel/crontab', '.kernel/telegram-offset', 'cockpit/cadence.json', 'secrets/telegram_bot_token', 'secrets/telegram_chat_id']);
  assert.equal(read(srv2, 'secrets', 'telegram_bot_token'), 'BOT-TOKEN\n');
  assert.equal(read(srv2, 'secrets', 'telegram_chat_id'), '4242\n');
  assert.equal(read(srv2, '.kernel', 'telegram-offset'), '991\n');
  assert.equal(read(srv2, '.kernel', 'crontab'), '0 7 * * * daily\n');
  assert.deepEqual(JSON.parse(read(srv2, 'cockpit', 'cadence.json')), JSON.parse(read(srv, 'cockpit', 'cadence.json')), 'the schedule is back exactly');
  assert.deepEqual(JSON.parse(read(srv2, '.mcp.json')), JSON.parse(read(srv, '.mcp.json')), 'connections are back with the server’s own sign-in plumbing');
  assert.match(read(srv2, 'wiki', 'from-laptop.md'), /laptop/);
  assert.match(read(srv2, 'wiki', 'clients.md'), /Harbour & Fern/);
  assert.equal(read(srv2, '.claude-auth', '.credentials.json'), '{"server":"claude"}\n');
  assert.equal((statSync(join(srv2, 'secrets', 'telegram_bot_token')).mode & 0o077), 0, 'nobody but the mineral reads its secrets');
});

test('DOWN refuses a wrong folder before anything happens', { skip }, async () => {
  const root = tmpDir('mvwrong-');
  const srv = server(root, 'bo', lived);
  const reg = registry(root);
  const go = (to) => moveDown({ from: 'bo-box', folder: to, transport: shellTransport(), toolFiles, assets, state: srv, app: APP, staging: join(root, 'stage'), targets: reg.targets, register: reg.register });
  const occupied = join(root, 'Documents');
  mkdirSync(occupied); writeFileSync(join(occupied, 'tax.pdf'), 'x');
  await assert.rejects(go(occupied), (e) => e instanceof MoveRefusal && /already has other files/.test(e.message));
  await assert.rejects(go('relative/path'), /full path/);
  const other = await folder(root, 'Cy');
  reg.register('cy', { path: other, name: 'Cy' });
  await assert.rejects(go(join(other, 'inside')), /inside another brain folder/);
  await assert.rejects(go(other), /changes of its own/, 'a brain with uncommitted work is never written over');
  g(other, 'add', '-A'); g(other, 'commit', '-q', '-m', 'mine');
  await assert.rejects(go(other), /already holds a different brain/);
  assert.ok(!existsSync(join(other, 'wiki', 'clients.md')), 'the other brain was not touched');
});

test('a copy cut short (the laptop slept) changes nothing, either way', { skip }, async () => {
  const root = tmpDir('mvcut-');
  const reg = registry(root);
  // down: the download dies; no folder is left behind
  const srv = server(root, 'cu', lived);
  const cut = { ...shellTransport(), download: async () => ({ code: 255, stderr: 'Connection reset' }) };
  const dest = join(root, 'Crads-AI', 'cu');
  await assert.rejects(moveDown({ from: 'cu-box', folder: dest, transport: cut, toolFiles, assets, state: srv, app: APP, staging: join(root, 's1'), targets: reg.targets, register: reg.register }), /interrupted twice/);
  assert.ok(!existsSync(dest), 'no half folder');
  assert.deepEqual(reg.targets(), []);
  // up: the upload dies and the folder has no GitHub to fall back on; the server brain is unchanged
  const f = await folder(root, 'Dee');
  const srv2 = server(root, 'dee');
  const tip = g(srv2, 'rev-parse', 'HEAD');
  const cutUp = { ...shellTransport(), upload: async () => ({ code: 255, stderr: 'Broken pipe' }) };
  await assert.rejects(moveUp({ folder: f, to: 'dee-box', transport: cutUp, toolFiles, state: srv2, app: APP, staging: join(root, 's2'), restart: noRestart }), /interrupted twice.*Nothing on the server or in your folder has changed/s);
  assert.equal(g(srv2, 'rev-parse', 'HEAD'), tip);
  assert.ok(!existsSync(join(f, '.kernel', 'moved.json')));
});

test('UP falls back to the member’s own GitHub when the direct copy keeps failing', { skip }, async () => {
  const root = tmpDir('mvgh-');
  const f = await folder(root, 'Eve');
  const gh = join(root, 'eve-brain.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', gh]);
  g(f, 'remote', 'add', 'origin', gh);
  const srv = server(root, 'eve');
  const base = shellTransport();
  let tries = 0;
  const flaky = { ...base, upload: async (l, r, o) => (/brain\.bundle$/.test(r) ? (tries++, { code: 255, stderr: 'reset' }) : base.upload(l, r, o)) };
  const r = await moveUp({ folder: f, to: 'eve-box', transport: flaky, toolFiles, state: srv, app: APP, staging: join(root, 'st'), restart: noRestart });
  assert.equal(tries, 2, 'the direct copy was tried twice first');
  assert.equal(r.via, 'github');
  assert.equal(r.verified, true);
  assert.match(read(srv, 'wiki', 'people.md'), /Maria/);
  assert.equal(g(gh, 'rev-parse', 'master'), r.commit, 'the folder’s brain went to its own repository on the way');
});

test('the pack a folder sends up names only what it carries', async () => {
  const root = tmpDir('mvpk-');
  const f = await folder(root, 'Fi');
  const { pack } = buildUpPack(f);
  const paths = pack.files.map((x) => x.path).sort();
  assert.ok(paths.includes('.mcp.json') && paths.includes('.claude/skills/my-skill/SKILL.md'));
  assert.ok(!paths.some((p) => p.startsWith('.claude/skills/onboard/')), 'engine skills stay: the server has its own');
  assert.ok(!paths.some((p) => p.startsWith('.claude-auth') || p.startsWith('.claude/settings')));
});

test('back down into the very folder it came up from: the same brain is brought up to date, not refused', { skip }, async () => {
  const root = tmpDir('mvhome-');
  const reg = registry(root);
  const f = await folder(root, 'Gil');
  reg.register('gil', { path: f, name: 'Gil' });
  const srv = server(root, 'gil');
  const up = await moveUp({ folder: f, to: 'gil-box', transport: shellTransport(), toolFiles, state: srv, app: APP, staging: join(root, 's1'), restart: noRestart });
  writeFileSync(join(srv, 'wiki', 'on-the-server.md'), '# Written on the server\n');
  const down = await moveDown({ from: 'gil-box', folder: f, transport: shellTransport(), toolFiles, assets, state: srv, app: APP, staging: join(root, 's2'), targets: reg.targets, register: reg.register });
  assert.equal(down.verified, true);
  assert.equal(down.slug, 'gil', 'the folder keeps its own registry row');
  assert.match(read(f, 'wiki', 'on-the-server.md'), /server/);
  assert.equal(execFileSync('git', ['-C', f, 'merge-base', '--is-ancestor', up.commit, 'HEAD']).length, 0, 'its own history is kept underneath');
  assert.ok(!existsSync(join(f, '.kernel', 'moved.json')), 'it is the live copy again');
  assert.equal(reg.targets().length, 1);
});

test('DOWN refuses a team’s server before anything is packed', { skip }, async () => {
  const root = tmpDir('mvteam-');
  const srv = server(root, 'tm');
  const reg = registry(root);
  // a stand-in /app/engine whose team-status says this box is in a team
  const app = join(root, 'app-engine');
  mkdirSync(join(app, 'team'), { recursive: true });
  for (const l of ['box', 'brain-push.sh', 'lib']) symlinkSync(join(APP, l), join(app, l));
  writeFileSync(join(app, 'team', 'team-status.mjs'), 'console.log(\'TEAM_STATUS {"team":true,"role":"member"}\')\n');
  const dest = join(root, 'Crads-AI', 'tm');
  await assert.rejects(moveDown({ from: 'tm-box', folder: dest, transport: shellTransport(), toolFiles, assets, state: srv, app, staging: join(root, 's'), targets: reg.targets, register: reg.register }), /belongs to a team/);
  assert.ok(!existsSync(dest));
});

test('a folder reached through a symlink moves up, and a move down into one is not re-initialised (live drill, 2026-10-14)', { skip }, async () => {
  const root = tmpDir('mvlink-');
  const f = await folder(root, 'Hal');
  const link = join(root, 'linked-home');
  symlinkSync(join(root, 'Crads-AI'), link);
  const viaLink = join(link, 'hal');
  const srv = server(root, 'hal');
  const up = await moveUp({ folder: viaLink, to: 'hal-box', transport: shellTransport(), toolFiles, state: srv, app: APP, staging: join(root, 's1'), restart: noRestart });
  assert.equal(up.verified, true, 'the linked path is the same repository');
  const reg = registry(root);
  const dest = join(link, 'hal-home');
  const down = await moveDown({ from: 'hal-box', folder: dest, transport: shellTransport(), toolFiles, assets, state: srv, app: APP, staging: join(root, 's2'), targets: reg.targets, register: reg.register });
  assert.equal(down.verified, true);
  const subjects = g(dest, 'log', '--format=%s', '-3').split('\n');
  assert.equal(subjects[0], 'move: set up for this computer', 'the adaptation is its own commit');
  assert.ok(!subjects.includes('init: brain scaffold'), 'not a second scaffold commit on top of the moved brain');
});
