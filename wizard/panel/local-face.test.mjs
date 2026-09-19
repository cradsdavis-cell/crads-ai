// local-face.test.mjs: the no-server face through the real servers
// (2026-09-11). A local target gets LOCAL_VERBS and nothing that needs a box;
// the door makes and lists brain folders; the alias gate refuses a -local
// alias the registry never issued.
//   node --test wizard/panel/local-face.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { createPanelServer, MEMBER_VERBS } from './panel-server.mjs';
import { createDoorServer } from './door-server.mjs';
import { localBridge, composeBridge } from './local-bridge.mjs';
import { LOCAL_VERBS, LOCAL_ONLY_VERBS, REFRESHED, runLocalVerb, terminalLaunch, findClaude, claudeProjectDirName } from './local-verbs.mjs';
import { loadEngineAssets, scaffoldLocalBrain } from './local-scaffold.mjs';
import { listLocalTargets, registerLocalBrain, unregisterLocalBrain } from './local-targets.mjs';

const assets = loadEngineAssets();
const listen = (server) => new Promise((r) => server.on('listening', () => r(server)));
const base = (s) => `http://127.0.0.1:${s.address().port}`;
async function post(server, path, body, ct = 'application/json') {
  const res = await fetch(base(server) + path, { method: 'POST', headers: { 'content-type': ct }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}
const sseLines = (text) => text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));

async function brainAndServer(t) {
  const reg = join(tmpDir('lf-reg-'), 'local-brains.json');
  const box = join(tmpDir('lf-brain-'), 'idris');
  await scaffoldLocalBrain(box, { name: 'Idris', assets, git: false });
  writeFileSync(join(box, 'wiki', 'people', 'mel.md'), '# Mel\nknows [[priorities]]\n');
  registerLocalBrain('idris', { path: box, name: 'Idris' }, reg);
  const { EventEmitter } = await import('node:events');
  const sshCalls = [];
  const ssh = {
    targets: () => [{ host: 'acme-box', org: 'acme', kind: 'member' }],
    stream: (host, command, o = {}) => { sshCalls.push([host, command]); const ee = new EventEmitter(); setImmediate(() => { if (o.onStdout) o.onStdout('ssh-ran'); ee.emit('close', 0); }); return ee; },
    tty: () => { throw new Error('tty must not be reached for a local target'); },
  };
  const bridge = composeBridge({ ssh, local: localBridge({ targets: () => listLocalTargets(reg), assets }) });
  const server = await listen(createPanelServer({ port: 0, host: '127.0.0.1', bridge, htmlText: '<html></html>' }));
  t.after(() => server.close());
  return { server, box, reg, sshCalls, bridge };
}

test('LOCAL_VERBS is the member table\'s subset plus the named local-only verbs, and the server-only verbs are absent by name', () => {
  // 2026-09-18: a folder gained things a box does differently (connections in
  // its own .mcp.json, a terminal of its own). They are named, not smuggled:
  // every other local verb still exists on the member table.
  for (const v of Object.keys(LOCAL_VERBS)) {
    if (LOCAL_ONLY_VERBS.includes(v)) { assert.ok(!MEMBER_VERBS[v], `${v} is local-only and must not collide with a box verb`); continue; }
    assert.ok(MEMBER_VERBS[v], `${v} exists on the member table too (same page, same contract)`);
  }
  for (const v of LOCAL_ONLY_VERBS) assert.ok(LOCAL_VERBS[v], `${v} is served`);
  for (const gone of ['cadence-write', 'skill-run', 'skill-remove', 'telegram-link', 'telegram-status', 'mcp-add', 'mcp-status', 'secrets-put', 'secrets-discover',
    'devices-list', 'devices-add', 'support-grant', 'layout-write', 'box-refresh', 'mineral-claim', 'leave-org']) {
    assert.ok(!LOCAL_VERBS[gone], `${gone} needs a server and must not be served to a folder`);
  }
});

test('/targets surfaces the local row with its kind; /run serves LOCAL_VERBS to it and the member table to a box', async (t) => {
  const { server, box, sshCalls } = await brainAndServer(t);
  const tg = await fetch(base(server) + '/targets').then((r) => r.json());
  const local = tg.targets.find((x) => x.host === 'idris-local');
  assert.ok(local, 'the folder is a target');
  assert.equal(local.kind, 'local');
  assert.equal(local.path, box, 'the path rides the row so the page can show it');
  const bl = await post(server, '/run', { verb: 'brain-list', host: 'idris-local', args: {} });
  assert.equal(bl.status, 200);
  const lines = sseLines(bl.text);
  assert.ok(lines.includes('people/mel.md') && lines.includes('priorities.md'), `brain-list walked the folder: ${lines.join(' | ')}`);
  assert.equal(lines[lines.length - 1], '__DONE__');
  const rd = await post(server, '/run', { verb: 'brain-read', host: 'idris-local', args: { page: 'people/mel.md' } });
  assert.ok(sseLines(rd.text).includes('# Mel'));
  const dd = await post(server, '/run', { verb: 'dashboard-data', host: 'idris-local', args: { fresh: 1 } });
  const ddl = sseLines(dd.text);
  const data = JSON.parse(ddl[ddl.indexOf('__DATA__') + 1]);
  assert.equal(data.assistant, 'Idris');
  assert.equal(data.local, true);
  assert.equal(data.brain.people, 1);
  assert.ok(data.graph.links.some((l) => l.source === 'people/mel' || l.target === 'people/mel'), 'the wikilink became an edge');
  assert.deepEqual(data.connections, [], 'no server rows are claimed for a folder');
  const cs = await post(server, '/run', { verb: 'member-console-state', host: 'idris-local', args: {} });
  const st = JSON.parse(sseLines(cs.text).find((l) => l.startsWith('CONSOLE_STATE ')).slice(14));
  assert.equal(st.name, 'Idris'); assert.equal(st.local, true); assert.equal(st.backup.connected, false);
  const sk = await post(server, '/run', { verb: 'cadence-list', host: 'idris-local', args: {} });
  const all = JSON.parse(sseLines(sk.text).find((l) => l.startsWith('SKILLS_STATE ')).slice(13));
  assert.ok(all.skills.some((s) => s.id === 'onboard' && s.source === 'engine'), 'engine skills are classified as engine from the bag');
  const mb = await post(server, '/run', { verb: 'whoami', host: 'acme-box', args: {} });
  assert.equal(mb.status, 200);
  assert.deepEqual(sshCalls, [['acme-box', 'whoami']], 'the box still rides ssh, untouched');
});

test('/run 400s the server-only verbs on a local target as unknown; the same verbs are known on a box', async (t) => {
  const { server } = await brainAndServer(t);
  for (const verb of ['cadence-write', 'telegram-link', 'mcp-add', 'skill-run', 'secrets-discover']) {
    const r = await post(server, '/run', { verb, host: 'idris-local', args: {} });
    assert.equal(r.status, 400, `${verb} on a folder: ${r.status} ${r.text}`);
    assert.match(r.text, /unknown verb/);
  }
  const onBox = await post(server, '/run', { verb: 'telegram-status', host: 'acme-box', args: {} });
  assert.notEqual(onBox.status, 400, 'the box keeps its table');
});

test('/term/open 500s honestly for a local target and never touches the tty', async (t) => {
  const { server } = await brainAndServer(t);
  const r = await post(server, '/term/open', { host: 'idris-local', cols: 80, rows: 24 });
  assert.equal(r.status, 500);
  assert.match(r.text, /lives on this computer/);
  assert.match(r.text, /Claude Code/);
});

test('validTarget refuses a -local alias the registry never issued, and a bad arg is a 400 before the folder is touched', async (t) => {
  const { server } = await brainAndServer(t);
  const ghost = await post(server, '/run', { verb: 'brain-list', host: 'ghost-local', args: {} });
  assert.equal(ghost.status, 400);
  assert.match(ghost.text, /host must be a configured/);
  const trav = await post(server, '/run', { verb: 'brain-read', host: 'idris-local', args: { page: '../profile.yaml' } });
  assert.equal(trav.status, 400);
  const dot = await post(server, '/run', { verb: 'brain-read', host: 'idris-local', args: { page: '.git/config' } });
  assert.equal(dot.status, 400);
});

test('box-rename writes both names into the folder; page-delete removes a seeded page', async (t) => {
  const { server, box } = await brainAndServer(t);
  const r = await post(server, '/run', { verb: 'box-rename', host: 'idris-local', args: { name: 'Nia' } });
  assert.ok(sseLines(r.text).includes('OK: renamed to Nia'));
  assert.equal(readFileSync(join(box, 'box-name'), 'utf8'), 'Nia');
  assert.match(readFileSync(join(box, 'profile.yaml'), 'utf8'), /assistant_name: "Nia"/);
  const pl = await post(server, '/run', { verb: 'pages-list', host: 'idris-local', args: {} });
  assert.ok(sseLines(pl.text).some((l) => l.includes('"welcome"')));
  const del = await post(server, '/run', { verb: 'page-delete', host: 'idris-local', args: { id: 'welcome' } });
  assert.ok(sseLines(del.text).includes('OK: page welcome deleted.'));
  assert.ok(!existsSync(join(box, 'dashboard', 'pages', 'welcome.html')));
});

// ---------------------------------------------------------------- the door
test('door: POST /local/create scaffolds and registers; /local/status and /local/setup-steps read the folder; /probe answers without ssh', async (t) => {
  const reg = join(tmpDir('lf-doorreg-'), 'local-brains.json');
  const home = tmpDir('lf-home-');
  const targets = () => listLocalTargets(reg);
  const bridge = { targets, stream: () => { throw new Error('no ssh here'); } };
  const door = await listen(createDoorServer({ port: 0, host: '127.0.0.1', bridge, htmlText: '<html></html>',
    local: { assets, targets, register: (slug, rec) => registerLocalBrain(slug, rec, reg), unregister: (slug) => unregisterLocalBrain(slug, reg), home } }));
  t.after(() => door.close());
  const mk = await post(door, '/local/create', { name: 'Idris' });
  assert.equal(mk.status, 200, mk.text);
  const j = JSON.parse(mk.text);
  assert.equal(j.alias, 'idris-local');
  assert.equal(j.path, join(home, 'Crads-AI', 'idris'), 'the default folder is ~/Crads-AI/<slug>');
  assert.ok(existsSync(join(j.path, 'profile.yaml')) && existsSync(join(j.path, 'CLAUDE.md')));
  assert.ok(['initialised', 'unavailable'].includes(j.git));
  const inv = await fetch(base(door) + '/inventory').then((r) => r.json());
  const row = inv.rows.find((r) => r.alias === 'idris-local');
  assert.ok(row, 'the folder is in the inventory');
  assert.equal(row.tier, 'local'); assert.equal(row.label, 'Idris'); assert.equal(row.path, j.path);
  const pr = await post(door, '/probe', { host: 'idris-local' });
  assert.deepEqual(JSON.parse(pr.text), { ok: true, login: 'local' }, 'a folder that exists answers, no ssh');
  const st = await fetch(base(door) + '/local/status').then((r) => r.json());
  assert.deepEqual(st.brains.map((b) => [b.alias, b.state]), [['idris-local', 'brain']]);
  const steps = await fetch(base(door) + '/local/setup-steps?box=idris-local').then((r) => r.json());
  assert.deepEqual(steps, { reachable: true, github: { connected: false, repo: '' }, claude: null, path: j.path });
  const occupied = tmpDir('lf-occ-'); writeFileSync(join(occupied, 'stray.txt'), 'x');
  assert.equal((await post(door, '/local/create', { name: 'Two', path: occupied })).status, 400);
  assert.equal((await post(door, '/local/create', { name: 'Two', path: 'relative' })).status, 400);
  assert.equal((await post(door, '/local/create', { name: '' })).status, 400);
  assert.equal((await post(door, '/local/create', { name: 'x' }, 'text/plain')).status, 415);
  assert.equal((await fetch(base(door) + '/local/setup-steps?box=ghost-local')).status, 400);
  const mk2 = await post(door, '/local/create', { name: 'Idris', path: join(home, 'other') });
  assert.equal(JSON.parse(mk2.text).alias, 'idris-2-local', 'a second brain with the same name gets its own slug');
  const fg = await post(door, '/forget', { host: 'idris-local' });
  assert.equal(fg.status, 200);
  assert.ok(!targets().some((x) => x.host === 'idris-local'));
  assert.ok(existsSync(join(j.path, 'profile.yaml')), 'forget drops the registry row and leaves the folder alone');
});

test('door: an existing brain folder can be adopted by path (existed:true), and nothing of it is overwritten', async (t) => {
  const reg = join(tmpDir('lf-adoptreg-'), 'local-brains.json');
  const home = tmpDir('lf-adopthome-');
  const box = join(home, 'mine');
  mkdirSync(join(box, 'wiki'), { recursive: true });
  writeFileSync(join(box, 'wiki', 'me.md'), '# me\n');
  writeFileSync(join(box, 'profile.yaml'), 'identity:\n  assistant_name: "Kept"\n');
  const targets = () => listLocalTargets(reg);
  const door = await listen(createDoorServer({ port: 0, host: '127.0.0.1', bridge: { targets, stream: () => null }, htmlText: '<html></html>',
    local: { assets, targets, register: (slug, rec) => registerLocalBrain(slug, rec, reg), home } }));
  t.after(() => door.close());
  const mk = await post(door, '/local/create', { name: 'Mine', path: '~/mine' });
  assert.equal(mk.status, 200, mk.text);
  const j = JSON.parse(mk.text);
  assert.equal(j.existed, true);
  assert.equal(j.path, box, '~ expands to the home the route was given');
  assert.match(readFileSync(join(box, 'profile.yaml'), 'utf8'), /Kept/, 'the profile is theirs');
  assert.equal(j.name, 'Kept', 'the registry records the name the folder already had');
  assert.equal(readFileSync(join(box, 'wiki', 'me.md'), 'utf8'), '# me\n');
  assert.ok(existsSync(join(box, '.claude', 'skills', 'onboard', 'SKILL.md')), 'skills were added');
});

// ---------------------------------------------------------------- 2026-09-18
test('connections: add writes .mcp.json + the uncommitted approval, list reads it, remove undoes both; bad args are 400s', async (t) => {
  const { server, box } = await brainAndServer(t);
  const add = await post(server, '/run', { verb: 'local-mcp-add', host: 'idris-local', args: { name: 'notion', url: 'https://mcp.notion.com/mcp' } });
  assert.equal(add.status, 200, add.text);
  assert.ok(sseLines(add.text).includes('OK: notion added'), add.text);
  await post(server, '/run', { verb: 'local-mcp-add', host: 'idris-local', args: { name: 'linear', url: 'https://mcp.linear.app/sse' } });
  const cfg = JSON.parse(readFileSync(join(box, '.mcp.json'), 'utf8'));
  assert.deepEqual(cfg.mcpServers.notion, { type: 'http', url: 'https://mcp.notion.com/mcp' });
  assert.equal(cfg.mcpServers.linear.type, 'sse', 'an /sse endpoint is written as sse');
  const st = JSON.parse(readFileSync(join(box, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(st.enabledMcpjsonServers, ['notion', 'linear'], 'approved in the never-committed settings file');
  const ls = await post(server, '/run', { verb: 'local-mcp-list', host: 'idris-local', args: {} });
  const state = JSON.parse(sseLines(ls.text).find((l) => l.startsWith('LOCAL_MCP ')).slice(10));
  assert.deepEqual(state.servers.map((x) => x.name), ['notion', 'linear']);
  const rm = await post(server, '/run', { verb: 'local-mcp-remove', host: 'idris-local', args: { name: 'notion' } });
  assert.ok(sseLines(rm.text).includes('OK: notion removed'));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(box, '.mcp.json'), 'utf8')).mcpServers), ['linear']);
  assert.deepEqual(JSON.parse(readFileSync(join(box, '.claude', 'settings.local.json'), 'utf8')).enabledMcpjsonServers, ['linear']);
  for (const args of [{ name: 'x', url: 'http://plain.example/mcp' }, { name: 'x', url: 'file:///etc/passwd' }, { name: 'Bad Name', url: 'https://ok.example/mcp' }, { name: 'x', url: 'https://u:p@ok.example/mcp' }]) {
    const r = await post(server, '/run', { verb: 'local-mcp-add', host: 'idris-local', args });
    assert.equal(r.status, 400, `${JSON.stringify(args)} refused before the folder is touched`);
  }
  assert.ok(readFileSync(join(box, '.gitignore'), 'utf8').split('\n').includes('.mcp.json'), 'connections never ride a backup');
  const onBox = await post(server, '/run', { verb: 'local-mcp-add', host: 'acme-box', args: { name: 'n', url: 'https://a.example/mcp' } });
  assert.equal(onBox.status, 400, 'a box does not serve the folder verbs');
});

test('connections: a hand-written .mcp.json that does not parse is refused, never clobbered', async (t) => {
  const { server, box } = await brainAndServer(t);
  writeFileSync(join(box, '.mcp.json'), '{ not json');
  const r = await post(server, '/run', { verb: 'local-mcp-add', host: 'idris-local', args: { name: 'notion', url: 'https://mcp.notion.com/mcp' } });
  assert.ok(sseLines(r.text).some((l) => /not valid JSON/.test(l)), r.text);
  assert.equal(readFileSync(join(box, '.mcp.json'), 'utf8'), '{ not json');
});

test('terminal: the verb spawns the platform plan detached in the folder; the plans quote any path safely', async () => {
  const box = join(tmpDir('lf-term-'), 'idris');
  await scaffoldLocalBrain(box, { name: 'Idris', assets, git: false });
  const calls = [];
  const launcher = (exe, args, o) => { calls.push({ exe, args, o }); return { on() {}, unref() {} }; };
  const out = [];
  const code = await runLocalVerb({ path: box, host: 'idris-local' }, 'local-terminal', { claude: 1 }, { emit: (l) => out.push(l), launcher });
  if (terminalLaunch({ dir: box })) {
    assert.equal(code, 0, out.join('\n'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].o.detached, true); assert.equal(calls[0].o.cwd, box);
    assert.ok(out.some((l) => l.startsWith('LOCAL_TERMINAL ')));
  }
  // Windows: the whole script rides -EncodedCommand, so a space or an
  // apostrophe in the path never meets cmd.exe's quoting.
  const w = terminalLaunch({ dir: "C:\\Users\\Sam O'Neil\\Crads-AI\\t", claudePath: 'C:\\Users\\Sam O\'Neil\\.local\\bin\\claude.exe', platform: 'win32' });
  assert.equal(w.exe, 'powershell.exe');
  assert.equal(Buffer.from(w.args[w.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le'), w.script);
  assert.match(w.script, /-WorkingDirectory 'C:\\Users\\Sam O''Neil\\Crads-AI\\t'/);
  assert.match(w.script, /'\/K', '"C:\\Users\\Sam O''Neil\\.local\\bin\\claude\.exe"'/);
  const wNo = terminalLaunch({ dir: 'C:\\x', platform: 'win32' });
  assert.match(wNo.script, /where claude >nul 2>nul && claude & where claude >nul 2>nul \|\| echo /, 'the hint prints only when claude is missing');
  const m = terminalLaunch({ dir: "/Users/sam/it's here", platform: 'darwin' });
  assert.equal(m.exe, 'osascript');
  assert.match(m.script, /^cd '\/Users\/sam\/it'\\''s here' && if command -v claude/);
  const shell = terminalLaunch({ dir: '/x', runClaude: false, platform: 'linux', has: (e) => e === 'xterm' });
  assert.deepEqual(shell.args.slice(0, 3), ['-e', 'bash', '-lc']);
  assert.equal(terminalLaunch({ dir: '/x', platform: 'linux', has: () => false }), null, 'no terminal program: a null plan, and the verb says so');
});

test('findClaude checks PATH and the installers\' usual homes, per platform', () => {
  const seen = new Set(['/home/u/.local/bin/claude']);
  assert.equal(findClaude({ platform: 'linux', env: { PATH: '/usr/bin' }, home: '/home/u', exists: (p) => seen.has(p) }), '/home/u/.local/bin/claude');
  const win = new Set(['C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd']);
  assert.equal(findClaude({ platform: 'win32', env: { Path: 'C:\\Windows', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, home: 'C:\\Users\\u', exists: (p) => win.has(p) }), 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd');
  assert.equal(findClaude({ platform: 'linux', env: {}, home: '/h', exists: () => false }), null);
});

test('Overview data: "opened in Claude Code" is read from Claude Code\'s own project record or an answer, never left unknown', async () => {
  const { localDashboardData } = await import('./local-verbs.mjs');
  const box = join(tmpDir('lf-opened-'), 'idris');
  await scaffoldLocalBrain(box, { name: 'Idris', assets, git: false });
  const home = tmpDir('lf-opened-home-');
  let d = localDashboardData({ path: box, name: 'Idris' }, { home });
  assert.equal(d.claude_opened, false, 'a fresh folder: known false, so the page shows the step, not "still reading"');
  assert.equal(d.onboarding.total, 8, 'the 8 layers, not the legacy 11');
  assert.equal(d.pebble, '', 'never the folder name as a second name');
  assert.equal(d.health, 'onboarding', 'an intact folder is healthy');
  assert.equal(claudeProjectDirName('C:\\Users\\you\\x'), 'C--Users-you-x');
  mkdirSync(join(home, '.claude', 'projects', claudeProjectDirName(box)), { recursive: true });
  d = localDashboardData({ path: box, name: 'Idris' }, { home });
  assert.equal(d.claude_opened, true, 'Claude Code has a project record for this folder');
  const { rmSync } = await import('node:fs');
  rmSync(join(box, 'CLAUDE.md'));
  assert.match(localDashboardData({ path: box, name: 'Idris' }, { home }).health, /^degraded: CLAUDE\.md is missing/, 'the Health card checks the folder for real');
});

test('refresh on open: an existing brain gets this build\'s skills, the CLAUDE.md notes block and the 8-layer seed, once, keeping the member\'s own text', async (t) => {
  const { server, box } = await brainAndServer(t);
  // make it look like a folder born before 2026-09-18
  writeFileSync(join(box, 'CLAUDE.md'), '# my own notes\nkeep me\n');
  writeFileSync(join(box, 'onboarding-state.json'), JSON.stringify({ phase: 'interview', current_module: 'self', modules: { self: { status: 'in-progress', raw: [] }, voice: { status: 'not-started', raw: [] } } }));
  writeFileSync(join(box, '.claude', 'skills', 'onboard', 'SKILL.md'), 'stale');
  REFRESHED.delete(box);
  await post(server, '/run', { verb: 'dashboard-data', host: 'idris-local', args: { fresh: 1 } });
  const md = readFileSync(join(box, 'CLAUDE.md'), 'utf8');
  assert.match(md, /^# my own notes\nkeep me\n/, 'the member\'s CLAUDE.md is kept');
  assert.match(md, /crads-ai:engine-notes start[\s\S]*`\/state\/` means \*\*this folder\*\*[\s\S]*crads-ai:engine-notes end/, 'the paths note was appended');
  assert.equal(readFileSync(join(box, '.claude', 'skills', 'onboard', 'SKILL.md'), 'utf8'), assets.skills.onboard, 'engine skills re-synced');
  assert.ok(JSON.parse(readFileSync(join(box, 'onboarding-state.json'), 'utf8')).layers, 'the untouched legacy seed became the 8 layers');
  // once per run: a second read does not rewrite
  writeFileSync(join(box, '.claude', 'skills', 'onboard', 'SKILL.md'), 'edited after');
  await post(server, '/run', { verb: 'dashboard-data', host: 'idris-local', args: { fresh: 1 } });
  assert.equal(readFileSync(join(box, '.claude', 'skills', 'onboard', 'SKILL.md'), 'utf8'), 'edited after');
  // and a legacy file WITH answers is never replaced
  const box2 = join(tmpDir('lf-refresh2-'), 'k');
  await scaffoldLocalBrain(box2, { name: 'K', assets, git: false });
  const answered = { phase: 'interview', modules: { self: { status: 'in-progress', raw: ['I run a bakery'] } } };
  writeFileSync(join(box2, 'onboarding-state.json'), JSON.stringify(answered));
  const { refreshLocalBrain } = await import('./local-scaffold.mjs');
  await refreshLocalBrain(box2, assets);
  assert.deepEqual(JSON.parse(readFileSync(join(box2, 'onboarding-state.json'), 'utf8')), answered);
  // the notes block is replaced in place, not appended twice
  await refreshLocalBrain(box2, assets);
  assert.equal((readFileSync(join(box2, 'CLAUDE.md'), 'utf8').match(/engine-notes start/g) || []).length, 1);
});
