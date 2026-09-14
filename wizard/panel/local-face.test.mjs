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
import { LOCAL_VERBS } from './local-verbs.mjs';
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

test('LOCAL_VERBS is a strict subset of the member table, and the server-only verbs are absent by name', () => {
  for (const v of Object.keys(LOCAL_VERBS)) assert.ok(MEMBER_VERBS[v], `${v} exists on the member table too (same page, same contract)`);
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
