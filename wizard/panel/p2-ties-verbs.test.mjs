// p2-ties-verbs.test.mjs: the box-side multi-tie channel (2026-08-23). A box
// holds one inbox per rock it is tied to (the anchor's at /state/org-inbox,
// a joined rock's at /state/org-inbox.d/<owner>/), and the app's verbs read
// and write across all of them:
//   catalog-list     the union of every inbox's catalogue, items tagged rock + rock_id
//   catalog-install  finds the offer in whichever inbox carries it; two joined
//                    rocks offering one id is refused by name unless `rock` says which
//   tie-drop         the box side of leaving a JOINED rock (fired by /rock-leave)
//   node --test wizard/panel/p2-ties-verbs.test.mjs
//
// Shell verbs run for real against a fixture tree, like p2-skill-member-verbs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { MEMBER_VERBS, createPanelServer } from './panel-server.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HTML_PATH = new URL('./member.html', import.meta.url).pathname;
const rewrite = (root, cmd) => cmd.replace(/\/state(?=[\/;"' ])/g, root + '/state').split('/app/engine/').join(root + '/app/engine/');

function box() {
  const root = tmpDir('p2ties-');
  mkdirSync(path.join(root, 'state', '.claude', 'skills'), { recursive: true });
  mkdirSync(path.join(root, 'state', 'secrets'), { recursive: true });
  mkdirSync(path.join(root, 'app', 'engine', 'skills'), { recursive: true });
  const w = (rel, body) => { const p = path.join(root, 'state', rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, body); };
  const offer = (inbox, id, version = 1) => {
    w(`${inbox}/offers/${id}/SKILL.md`, `---\ntitle: ${id}\n---\n# ${id}\n`);
    w(`${inbox}/offers/${id}/skill.yaml`, `title: ${id}\nversion: ${version}\n`);
  };
  const anchor = () => {
    w('org-inbox.conf', 'ORG_GH_OWNER=acme-gh\nSLUG=jane01\n');
    w('org-contact.json', JSON.stringify({ org: 'acme', name: 'Acme' }));
    w('org-inbox/MEMBERSHIP.yaml', 'status: active\n');
  };
  const joined = (owner, org) => {
    w(`org-inbox.d/${owner}.conf`, `ORG_GH_OWNER=${owner}\nSLUG=jane01\nORG=${org}\n`);
    w(`org-inbox.d/${owner}.contact.json`, JSON.stringify({ org }));
    w(`heartbeat.d/${owner}.conf`, `ORG_GH_OWNER=${owner}\nSLUG=jane01\nKEY=/state/secrets/heartbeat_deploy_key.${owner}\n`);
    for (const k of ['org_inbox_deploy_key', 'heartbeat_deploy_key']) { w(`secrets/${k}.${owner}`, 'PRIVATE'); w(`secrets/${k}.${owner}.pub`, 'ssh-ed25519 AAAA x'); }
    w(`secrets/.tie-keys-sent.${owner}`, 'x\n');
    w(`org-inbox.d/${owner}/MEMBERSHIP.yaml`, 'status: active\n');
    w(`.heartbeat-out/${owner}/.git/HEAD`, 'x\n');
  };
  const run = (cmd, stdin) => {
    let out = '', code = 0;
    try { out = execFileSync('bash', ['-c', rewrite(root, cmd)], { encoding: 'utf8', input: stdin || '', cwd: root, env: { ...process.env, BRAIN_ROOT: '' } }); } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); code = e.status; }
    return { out, code };
  };
  return { root, w, offer, anchor, joined, run, state: path.join(root, 'state'), done: () => rmSync(root, { recursive: true, force: true }) };
}
const CAT = (rock, items) => JSON.stringify({ rock, items });
const catalogOf = (out) => JSON.parse(out.split('__CATALOG__')[1].split('__ORGCONTACT__')[0].trim());

// ---- catalog-list -------------------------------------------------------------------

test('catalog-list merges the anchor and every joined inbox; items carry rock (label) and rock_id (handle)', () => {
  const b = box();
  try {
    b.anchor();
    b.w('org-inbox/catalog/catalog.json', CAT('Acme Guild', [{ id: 'deep-research', kind: 'skill', version: 2 }]));
    b.joined('tides-gh', 'tides');
    b.w('org-inbox.d/tides-gh/catalog/catalog.json', CAT('Tide Collective', [{ id: 'tide-tables', kind: 'skill', version: 1 }, { id: 'deep-research', kind: 'skill', version: 5 }]));
    b.joined('plain-gh', 'plain');   // a joined rock whose catalogue names no rock
    b.w('org-inbox.d/plain-gh/catalog/catalog.json', JSON.stringify({ items: [{ id: 'plain-one', kind: 'skill', version: 1 }] }));
    const r = b.run(MEMBER_VERBS['catalog-list'].build().command);
    assert.equal(r.code, 0, r.out);
    const cat = catalogOf(r.out);
    assert.equal(cat.rock, 'Acme Guild', 'the anchor’s own field survives at the top level');
    assert.deepEqual(cat.items.map((i) => [i.id, i.rock, i.rock_id, i.version]), [
      ['deep-research', 'Acme Guild', 'acme', 2],
      ['plain-one', 'plain', 'plain', 1],
      ['tide-tables', 'Tide Collective', 'tides', 1],
      ['deep-research', 'Tide Collective', 'tides', 5],
    ]);
    assert.deepEqual(cat.inboxes, [
      { rock_id: 'acme', rock: 'Acme Guild', owner: 'acme-gh', anchor: true },
      { rock_id: 'plain', rock: 'plain', owner: 'plain-gh', anchor: false },
      { rock_id: 'tides', rock: 'Tide Collective', owner: 'tides-gh', anchor: false },
    ]);
    assert.doesNotMatch(r.out, /__REQUESTS__/);
    assert.match(r.out, /__ORGCONTACT__\n\{"org":"acme"/);
  } finally { b.done(); }
});

test('catalog-list with no anchor and one joined rock still lists; with nothing at all it prints {} and exits 0', () => {
  const b = box();
  try {
    let r = b.run(MEMBER_VERBS['catalog-list'].build().command);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(catalogOf(r.out), { items: [], inboxes: [] });
    b.joined('tides-gh', 'tides');
    b.w('org-inbox.d/tides-gh/catalog/catalog.json', CAT('Tide Collective', [{ id: 'tide-tables', kind: 'skill', version: 1 }]));
    r = b.run(MEMBER_VERBS['catalog-list'].build().command);
    const cat = catalogOf(r.out);
    assert.equal(cat.rock, undefined);
    assert.deepEqual(cat.items.map((i) => [i.id, i.rock, i.rock_id]), [['tide-tables', 'Tide Collective', 'tides']]);
  } finally { b.done(); }
});

// ---- catalog-install ----------------------------------------------------------------

const origin = (b, id) => JSON.parse(readFileSync(path.join(b.state, '.claude', 'skills', id, '.origin.json'), 'utf8'));

test('catalog-install takes an offer that only a joined rock carries, and stamps .origin.json rock = that rock’s owner', () => {
  const b = box();
  try {
    b.anchor();
    b.joined('tides-gh', 'tides');
    b.offer('org-inbox.d/tides-gh', 'tide-tables', 4);
    const r = b.run(MEMBER_VERBS['catalog-install'].build({ id: 'tide-tables' }).command);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /OK: \/tide-tables installed/);
    assert.deepEqual({ ...origin(b, 'tide-tables'), installed: 'x' }, { rock: 'tides-gh', version: 4, installed: 'x' });
    assert.match(readFileSync(path.join(b.state, '.claude', 'skills', 'tide-tables', 'SKILL.md'), 'utf8'), /origin-rock: "tides-gh"/);
  } finally { b.done(); }
});

test('catalog-install prefers the anchor when both offer an id; two JOINED rocks offering it is refused by name unless rock is passed', () => {
  const b = box();
  try {
    b.anchor();
    b.offer('org-inbox', 'deep-research', 2);
    b.joined('tides-gh', 'tides');
    b.offer('org-inbox.d/tides-gh', 'deep-research', 5);
    let r = b.run(MEMBER_VERBS['catalog-install'].build({ id: 'deep-research' }).command);
    assert.equal(r.code, 0, r.out);
    assert.equal(origin(b, 'deep-research').rock, 'acme-gh', 'the anchor wins, quietly');
    assert.equal(origin(b, 'deep-research').version, 2);
    // the same id from the joined rock, explicitly: refused, it is already the anchor's
    r = b.run(MEMBER_VERBS['catalog-install'].build({ id: 'deep-research', rock: 'tides' }).command);
    assert.equal(r.code, 1);
    assert.match(r.out, /already installed from a different rock; nothing was changed/);
    // two joined rocks, anchor silent on the id
    b.joined('guild-gh', 'guild');
    b.offer('org-inbox.d/guild-gh', 'shared-thing', 1);
    b.offer('org-inbox.d/tides-gh', 'shared-thing', 3);
    r = b.run(MEMBER_VERBS['catalog-install'].build({ id: 'shared-thing' }).command);
    assert.equal(r.code, 1);
    assert.match(r.out, /ERROR: \/shared-thing is offered by more than one of your rocks \(guild,tides\)\. Say which one with rock\./);
    assert.ok(!existsSync(path.join(b.state, '.claude', 'skills', 'shared-thing')));
    r = b.run(MEMBER_VERBS['catalog-install'].build({ id: 'shared-thing', rock: 'tides' }).command);
    assert.equal(r.code, 0, r.out);
    assert.equal(origin(b, 'shared-thing').rock, 'tides-gh');
    assert.equal(origin(b, 'shared-thing').version, 3);
    // rock may also be the GitHub owner, and a rock that does not carry the id is "not in your inbox"
    r = b.run(MEMBER_VERBS['catalog-install'].build({ id: 'shared-thing', rock: 'tides-gh' }).command);
    assert.equal(r.code, 0, r.out);
    r = b.run(MEMBER_VERBS['catalog-install'].build({ id: 'shared-thing', rock: 'acme' }).command);
    assert.equal(r.code, 1);
    assert.match(r.out, /is not in your inbox/);
    assert.throws(() => MEMBER_VERBS['catalog-install'].build({ id: 'x', rock: 'not a rock' }), /rock must be a rock handle or GitHub owner/);
  } finally { b.done(); }
});

// ---- tie-drop -----------------------------------------------------------------------

test('tie-drop removes one joined rock’s confs, keys, marker and clones; the anchor and installed content stay; re-running is a NONE', () => {
  const b = box();
  try {
    b.anchor();
    b.w('heartbeat.conf', 'ORG_GH_OWNER=acme-gh\nSLUG=jane01\n');
    b.w('secrets/heartbeat_deploy_key', 'ANCHOR');
    b.w('secrets/org_inbox_deploy_key', 'ANCHOR');
    b.joined('tides-gh', 'tides');
    b.joined('guild-gh', 'guild');
    b.w('.claude/skills/tide-tables/SKILL.md', '# kept\n');
    b.w('.claude/skills/tide-tables/.origin.json', '{ "rock": "tides-gh" }\n');
    let r = b.run(MEMBER_VERBS['tie-drop'].build({ org: 'tides' }).command);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /TIE-DROP-OK: left tides \(tides-gh\)/);
    for (const f of ['org-inbox.d/tides-gh.conf', 'org-inbox.d/tides-gh.contact.json', 'org-inbox.d/tides-gh', 'heartbeat.d/tides-gh.conf',
      'secrets/org_inbox_deploy_key.tides-gh', 'secrets/org_inbox_deploy_key.tides-gh.pub', 'secrets/heartbeat_deploy_key.tides-gh',
      'secrets/.tie-keys-sent.tides-gh', '.heartbeat-out/tides-gh']) {
      assert.ok(!existsSync(path.join(b.state, f)), `${f} should be gone`);
    }
    for (const f of ['org-inbox.d/guild-gh.conf', 'heartbeat.d/guild-gh.conf', 'secrets/heartbeat_deploy_key.guild-gh',
      'org-inbox.conf', 'heartbeat.conf', 'secrets/heartbeat_deploy_key', 'secrets/org_inbox_deploy_key', '.claude/skills/tide-tables/SKILL.md']) {
      assert.ok(existsSync(path.join(b.state, f)), `${f} must survive`);
    }
    r = b.run(MEMBER_VERBS['tie-drop'].build({ org: 'tides' }).command);
    assert.equal(r.code, 0);
    assert.match(r.out, /TIE-DROP-NONE/);
    // the anchor's handle is never a joined conf, so dropping it is a NONE too
    r = b.run(MEMBER_VERBS['tie-drop'].build({ org: 'acme' }).command);
    assert.match(r.out, /TIE-DROP-NONE/);
    assert.ok(existsSync(path.join(b.state, 'org-inbox.conf')));
    assert.throws(() => MEMBER_VERBS['tie-drop'].build({ org: 'Not A Handle' }), /name the rock to leave/);
    assert.equal(MEMBER_VERBS['tie-drop'].mutating, true);
  } finally { b.done(); }
});

// ---- createPanelServer: catalog-list over /run, and /rock-leave firing tie-drop -----

const listen = (opts) => new Promise((resolve) => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlPath: HTML_PATH, ...opts });
  s.on('listening', () => resolve(s));
});
const idToken = (email) => 'x.' + Buffer.from(JSON.stringify({ email })).toString('base64url') + '.sig';

/** A bridge that runs the verb for real on the fixture box, streaming its lines. */
const realBridge = (b, log = []) => ({
  targets: () => [{ host: 'jane01-box', kind: 'member', org: 'jane01' }],
  tty: () => {},
  stream: (h, c, o = {}) => {
    log.push(c);
    const p = new EventEmitter(); p.kill = () => {};
    const child = spawn('bash', ['-c', rewrite(b.root, c)], { cwd: b.root, env: { ...process.env, BRAIN_ROOT: '' } });
    child.stdin.end(o.stdin || '');   // ties-write reads its payload from stdin; never leave a verb waiting on it
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; const parts = buf.split('\n'); buf = parts.pop(); for (const l of parts) if (o.onStdout) o.onStdout(l); });
    child.stderr.on('data', (d) => { if (o.onStderr) o.onStderr(String(d).trim()); });
    child.on('close', (code) => { if (buf && o.onStdout) o.onStdout(buf); p.emit('close', code); });
    return p;
  },
});
const sse = (text) => text.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));

test('createPanelServer: /run catalog-list on a two-rock box streams the merged catalogue the Skills page groups by rock', async () => {
  const b = box();
  b.anchor();
  b.w('org-inbox/catalog/catalog.json', CAT('Acme Guild', [{ id: 'deep-research', kind: 'skill', version: 2 }]));
  b.joined('tides-gh', 'tides');
  b.w('org-inbox.d/tides-gh/catalog/catalog.json', CAT('Tide Collective', [{ id: 'tide-tables', kind: 'skill', version: 1 }]));
  const s = await listen({ edition: 'member', bridge: realBridge(b) });
  const base = `http://127.0.0.1:${s.address().port}`;
  try {
    const r = await fetch(`${base}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'catalog-list', host: 'jane01-box', args: {} }) });
    assert.equal(r.status, 200);
    const lines = sse(await r.text());
    assert.equal(lines[lines.length - 1], '__DONE__');
    const cat = catalogOf(lines.join('\n'));
    const byRock = {};
    for (const it of cat.items) (byRock[it.rock] = byRock[it.rock] || []).push(it.id);
    assert.deepEqual(byRock, { 'Acme Guild': ['deep-research'], 'Tide Collective': ['tide-tables'] });
  } finally { s.close(); b.done(); }
});

test('/rock-leave is RETIRED (2026-09-01): leaving is a box-local act now', async () => {
  // The route chained the directory leave with the on-mineral tie-drop; the
  // directory is gone, so the route is too. tie-drop itself survives above as
  // the box-side half (the commons model reuses the inbox surfaces), so the
  // strongest remaining truth is that the app no longer offers the chained
  // route: a leave is whatever the box does to its own confs.
  const s = await listen({ bridge: { targets: () => [], stream: () => { throw new Error('no ssh'); }, tty: () => {} } });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/rock-leave`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 404, '/rock-leave must stay gone');
  } finally { s.closeAllConnections?.(); s.close(); }
});
