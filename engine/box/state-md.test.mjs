// state-md.test.mjs — R24 (panel iteration 2, 2026-08-23): STATE.md, the page
// the assistant reads before answering what this mineral is, whose it is and
// what it can do. Fixture-backed, one pebble and one rock, on the
// rock-brain-root.test.mjs pattern: the rock's brain is NOT its state dir, so a
// reader that joins the wrong root fails here and nowhere else.
//
// Assertions are structural (sections exist, the facts under them are the
// fixture's facts), never copied sentences.
//   node --test engine/box/state-md.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStateMd, writeStateMd, readSkillOrigins } from './state-md.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, '..');
const HEARTBEAT = path.join(ENGINE, 'heartbeat.mjs');
const w = (p, s) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, s); };
const NOW = new Date('2026-08-23T10:00:00Z');
const SECRET = 'sk-ant-oat01-MUST-NEVER-APPEAR-IN-STATE-MD';
const TOKEN = 'Bearer xoxb-THIS-VALUE-MUST-NEVER-APPEAR';

function skill(state, id, origin) {
  w(path.join(state, '.claude', 'skills', id, 'SKILL.md'), `---\ntitle: ${id} title\n---\n# ${id}\n`);
  if (origin) w(path.join(state, '.claude', 'skills', id, '.origin.json'), JSON.stringify(origin));
}

/** A pebble: state dir IS the brain root, anchored to a rock, one grant, two devices. */
function pebble() {
  const state = tmpDir('statemd-pebble-');
  w(path.join(state, 'box-name'), 'Harriet’s pebble');
  w(path.join(state, 'org-inbox.conf'), 'SLUG=harriet\nORG_GH_OWNER=acme-rock\n');
  w(path.join(state, 'ownership.json'), JSON.stringify({
    owner: 'member', managed_by: 'org', machinery_by: 'crads-ai', tier: 'pebble', anchor: 'acme-rock',
    holder_email: 'harriet@example.com',
    grants: [{ email: 'helper@example.com', role: 'user', status: 'active', added_at: '2026-08-20' }],
  }));
  w(path.join(state, 'devices', 'laptop.yaml'), 'slug: laptop\nlabel: "Harriet laptop"\nstatus: active\nlast_seen: "2026-08-22"\npubkey: "ssh-ed25519 AAAA"\n');
  w(path.join(state, 'devices', 'old-phone.yaml'), 'slug: old-phone\nlabel: "Old phone"\nstatus: revoked\nlast_seen: "2026-07-01"\n');
  w(path.join(state, '.mcp.json'), JSON.stringify({ mcpServers: {
    slack: { type: 'http', url: 'https://mcp.slack.test/', headers: { Authorization: TOKEN } },
    notion: { type: 'http', url: 'https://mcp.notion.test/' },
  } }));
  w(path.join(state, 'cockpit', 'connectors.json'), JSON.stringify({ at: NOW.getTime() - 60000, names: ['claude.ai Linear', 'Notion'] }));
  skill(state, 'pulse-plus', { rock: 'acme-rock', version: 2, installed: '2026-08-20' });
  skill(state, 'my-notes', null);
  w(path.join(state, 'org-inbox', 'catalog', 'catalog.json'), JSON.stringify({ rock: 'acme-rock', items: [
    { id: 'pulse-plus', kind: 'skill', version: 2 },
    { id: 'weekly-review', kind: 'skill', version: 1 },
    { id: 'starter-pack', kind: 'pack', version: 1 },
  ] }));
  w(path.join(state, 'custody-log.jsonl'), [1, 2, 3, 4, 5, 6, 7].map((i) =>
    JSON.stringify({ at: `2026-08-1${i}T00:00:00Z`, event: `event number ${i}`, owner: 'member', anchor: 'acme-rock' })).join('\n') + '\n');
  // the things that must never leak
  w(path.join(state, 'secrets', 'telegram_bot_token'), SECRET);
  w(path.join(state, '.claude-auth', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }));
  w(path.join(state, '.kernel', 'mcp-oauth.json'), JSON.stringify({ google: { token: SECRET } }));
  return state;
}

/** A rock exactly as boot-rock.sh leaves one: brain at <box>/brain, two members. */
function rock() {
  const box = tmpDir('statemd-rock-');
  const brain = path.join(box, 'brain');
  w(path.join(box, 'deployment.yaml'), `deployment_name: acme\nbrain_root: ${brain}\n`);
  w(path.join(brain, 'org-policy.yaml'), 'org:\n  name: "acme-rock"\n  display_name: "Acme Rock"\n');
  w(path.join(box, 'box-name'), 'Foreman');
  w(path.join(box, 'ownership.json'), JSON.stringify({ owner: 'member', managed_by: 'crads-ai', machinery_by: 'crads-ai', tier: 'rock', anchor: '', grants: [] }));
  w(path.join(brain, 'registry', 'members', '_TEMPLATE.yaml'), 'slug: ""\n');
  w(path.join(brain, 'registry', 'members', 'harriet.yaml'), 'slug: "harriet"\ndisplay_name: "Harriet"\nstatus: "active"\n');
  w(path.join(brain, 'registry', 'members', 'ingrid.yaml'), 'slug: "ingrid"\ndisplay_name: "Ingrid"\nstatus: "left"\n');
  w(path.join(brain, 'heartbeats', 'harriet.json'), JSON.stringify({ generated_at: new Date(NOW.getTime() - 3 * 3600e3).toISOString() }));
  return { box, brain };
}

const section = (md, heading) => {
  const i = md.indexOf(`\n## ${heading}\n`);
  assert.notEqual(i, -1, `missing section "${heading}"`);
  const rest = md.slice(i + heading.length + 5);
  const j = rest.indexOf('\n## ');
  return j === -1 ? rest : rest.slice(0, j);
};

test('a pebble describes itself: tier, name, anchor, custody, grants, devices, connections', () => {
  const md = buildStateMd(pebble(), { now: NOW, version: 'abc1234' });
  assert.match(md.split('\n')[0], /^Generated by the heartbeat at 2026-08-23T10:00:00\.000Z\./, 'the header carries the run time');
  assert.match(md.split('\n')[0], /Do not edit/, 'and says it is rewritten');
  const what = section(md, 'What this is');
  assert.match(what, /Tier: pebble/);
  assert.match(what, /Name: Harriet’s pebble/);
  assert.match(what, /Anchor: acme-rock/);
  assert.match(what, /Owner: member/);
  assert.match(what, /Managed by: org/);
  assert.match(what, /Machinery by: crads-ai/);
  assert.match(section(md, 'Grants'), /helper@example\.com.*user.*active/);
  const dev = section(md, 'Devices that can sign in');
  assert.match(dev, /Harriet laptop.*2026-08-22/);
  assert.doesNotMatch(dev, /Old phone/, 'a revoked device cannot sign in and is not listed');
  assert.match(section(md, 'Software'), /abc1234/);
});

test('connections carry a state word and the account connectors are marked chat-only', () => {
  const conn = section(buildStateMd(pebble(), { now: NOW, version: '' }), 'Connections');
  assert.match(conn, /- slack: on/);
  assert.match(conn, /- notion: configured/);
  assert.match(conn, /- Linear: account/, 'the cached claude.ai probe is read while fresh');
  assert.equal((conn.match(/notion/gi) || []).length, 1, 'a name the box already serves is not listed twice from the account probe');
});

// TRAP 61 (2026-08-25). The assertion directly above passed for two days and then
// went permanently red with nobody touching it. buildStateMd takes an injected
// `now` precisely so its output is a function of the fixture and nothing else,
// but the account-probe freshness window read Date.now(): the fixture's `at` sits
// 60s before the fixed NOW, so the probe counted as fresh only while the REAL
// clock stood within 24h of 2026-08-23. A test that passes because wall-clock
// time is near the fixture is not pinned, it is scheduled to fail. Moving the
// fixture forward only re-arms it, so the pin is the property the injection
// promises: same fixture, same `now`, same bytes, whatever day it is run on.
test('the injected clock is the only clock: the same now builds the same bytes at any real-clock moment', () => {
  const state = pebble();
  const RealDate = Date;
  const atRealClock = (ms) => {
    class Frozen extends RealDate {
      constructor(...a) { if (a.length === 0) super(ms); else super(...a); }
      static now() { return ms; }
    }
    globalThis.Date = Frozen;
    try { return buildStateMd(state, { now: NOW, version: '' }); }
    finally { globalThis.Date = RealDate; }
  };
  const yearBefore = atRealClock(NOW.getTime() - 365 * 24 * 3600e3);
  const yearAfter = atRealClock(NOW.getTime() + 365 * 24 * 3600e3);
  assert.equal(yearBefore, yearAfter,
    'buildStateMd read the real clock: one fixture and one injected now gave two different pages');
  // and not vacuously equal: the clock-sensitive line must still be exercised
  assert.match(section(yearAfter, 'Connections'), /- Linear: account/,
    'the fixture no longer exercises the freshness judgement, so this pins nothing');
});



test('custody shows the last five events only, newest last', () => {
  const cust = section(buildStateMd(pebble(), { now: NOW, version: '' }), 'Custody, last 5 events');
  const rows = cust.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(rows.length, 5);
  assert.match(rows[0], /event number 3/);
  assert.match(rows[4], /event number 7/);
});

test('a pebble has no Members section; the Mountain is named when nothing anchors it', () => {
  const state = pebble();
  w(path.join(state, 'ownership.json'), JSON.stringify({ owner: 'member', tier: 'pebble', anchor: 'crads-ai', grants: [] }));
  const md = buildStateMd(state, { now: NOW, version: '' });
  assert.doesNotMatch(md, /\n## Members\n/);
  assert.match(section(md, 'What this is'), /Anchor: Crads AI, the Mountain/);
  assert.match(section(md, 'Grants'), /None/);
});

test('no secret value ever reaches the page', () => {
  const md = buildStateMd(pebble(), { now: NOW, version: '' });
  assert.doesNotMatch(md, new RegExp(SECRET));
  assert.doesNotMatch(md, /xoxb-/, 'the .mcp.json header value is never printed');
  assert.doesNotMatch(md, /—/, 'zero em dashes');
});

test('a rock lists its members with status and heartbeat age, and writes STATE.md into the BRAIN', () => {
  const { box, brain } = rock();
  const out = writeStateMd(box, { now: NOW, version: 'r0ck123' });
  assert.equal(out, path.join(brain, 'STATE.md'), 'the brain root, not the state dir');
  assert.ok(existsSync(out));
  assert.ok(!existsSync(path.join(box, 'STATE.md')), 'and nothing in the state dir');
  assert.ok(!existsSync(out + '.tmp'), 'the tmp file is gone after the atomic rename');
  const md = readFileSync(out, 'utf8');
  const what = section(md, 'What this is');
  assert.match(what, /Tier: rock/);
  assert.match(what, /Name: Acme Rock/, 'the org display name, never the assistant persona');
  assert.match(what, /Anchor: Crads AI, the Mountain/);
  const mem = section(md, 'Members');
  assert.match(mem, /- harriet \(Harriet\): active, last heartbeat 3 h ago/);
  assert.match(mem, /- ingrid \(Ingrid\): left, last heartbeat never/);
  assert.doesNotMatch(mem, /_TEMPLATE/);
});

test('the heartbeat writes STATE.md every run, and the receipts it reads are the ones the page lists', () => {
  const state = pebble();
  execFileSync('node', [HEARTBEAT, state], { encoding: 'utf8', env: { ...process.env, AIOS_ENGINE_SKILLS_DIR: path.join(ENGINE, 'skills') } });
  const md = readFileSync(path.join(state, 'STATE.md'), 'utf8');
  assert.match(md, /\n## Skills installed\n/);
  const hb = JSON.parse(readFileSync(path.join(state, 'cockpit', 'heartbeat.json'), 'utf8'));
  assert.deepEqual(hb.skills_from_rocks, readSkillOrigins(state));
  assert.deepEqual(hb.skills_from_rocks, [{ id: 'pulse-plus', rock: 'acme-rock', version: 2 }]);
});

test('rewritten in place: a second run replaces the file rather than appending', () => {
  const state = pebble();
  writeStateMd(state, { now: NOW, version: '' });
  const later = new Date(NOW.getTime() + 3600e3);
  writeStateMd(state, { now: later, version: '' });
  const md = readFileSync(path.join(state, 'STATE.md'), 'utf8');
  assert.equal((md.match(/Generated by the heartbeat/g) || []).length, 1);
  assert.match(md, new RegExp(later.toISOString().replace(/\./g, '\\.')));
});
