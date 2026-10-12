// team-routes.test.mjs: "Set up a team" against a fake provider, a fake GitHub, a
// fake device flow and fake boxes. Nothing touches the network or the real ~/.ssh.
//   node --test wizard/panel/team-routes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { teamRoutes, planTeam, personSlugs, deployKeysFor, enrolConfig, extendPlan } from './team-routes.mjs';
import { fakeClient } from '../dev-harness/provision-fixture.mjs';
import { validateConfig } from '../../engine/team/team-enrol.mjs';

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF6zXyq1x2Qq0m7T3v9m4T8u5X6a7B8c9D0e1F2g3H4i owner@door';
const TOKEN = 'HETZNER-SECRET-123';
const GHTOKEN = 'gho_GITHUB-SECRET-456';

function fakeGithub(log) {
  return () => ({
    whoami: async () => 'owner',
    ensureRepo: async (owner, name) => { log.push(['repo', `${owner}/${name}`]); return { created: true }; },
    ensureFile: async (full, path) => { log.push(['file', full, path]); return { created: true }; },
    ensureDeployKey: async (full, title, key, readOnly) => { log.push(['key', full, title, key, readOnly]); return { added: true }; },
    removeDeployKeys: async (full, boxSlug) => { log.push(['unkey', full, boxSlug]); return { removed: 1 }; },
    archiveRepo: async (full) => { log.push(['archive', full]); return { archived: true }; },
  });
}

function harness(over = {}) {
  const calls = []; const gh = []; const execs = []; const destroyed = []; const forgotten = [];
  const sshDir = tmpDir('team-');
  const handle = teamRoutes({
    sshDir,
    settingsPath: join(sshDir, 'claude-settings.json'),
    makeClient: (token, provider) => fakeClient(calls, provider),
    github: fakeGithub(gh),
    deviceFlow: async () => ({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', poll: async () => ({ ok: true, token: GHTOKEN }) }),
    exec: over.exec || (async (alias, cmd) => {
      execs.push([alias, cmd]);
      if (/ keys \/state /.test(cmd)) {
        const names = cmd.split(' keys /state ')[1].trim().split(' ');
        return { code: 0, stdout: `TEAM_KEYS ${JSON.stringify(Object.fromEntries(names.map((n) => [n, `ssh-ed25519 KEY-${alias}-${n}`])))}\n` };
      }
      if (/ enrol \/state /.test(cmd)) return { code: 0, stdout: 'TEAM_ENROLLED {"ok":true}\n' };
      return { code: 0, stdout: '' };
    }),
    install: () => ({ publicKey: PUB + '\n' }),
    pin: () => {},
    probe: async () => ({ code: 0, stdout: 'chain-ok\n' }),
    register: () => {}, openFolder: async () => ({ code: 1 }),
    sleep: async () => {},
    bootTimeoutMs: 2000,
    image: 'ghcr.io/example/pebble:sha-test',
    exportDir: join(sshDir, 'exports'),
    destroy: async (o) => { destroyed.push(o.state.serverId ?? null); return { destroyed: true }; },
    forget: (alias) => forgotten.push(alias),
    ...over,
  });
  const server = http.createServer((req, res) => { if (!handle(req, res, req.url.split('?')[0])) { res.writeHead(404); res.end(); } });
  const ready = new Promise((r) => server.listen(0, '127.0.0.1', r));
  const call = async (method, path, body) => {
    await ready;
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call, calls, gh, execs, sshDir, destroyed, forgotten, close: () => { server.closeAllConnections?.(); server.close(); } };
}

async function until(call, phase) {
  for (let i = 0; i < 400; i++) {
    const s = (await call('GET', '/team/status')).body;
    if (s.phase === phase) return s;
    if (s.phase === 'failed' && phase !== 'failed') assert.fail(`run failed: ${s.error}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`never reached ${phase}`);
}

const START = { company: 'acme', token: TOKEN, people: [{ name: 'Jess Smith' }, { name: 'Tom Lee' }] };

test('person slugs: first names, surnames only to break a tie, short enough for a server name', () => {
  assert.deepEqual(personSlugs([{ name: 'Jess Smith' }, { name: 'Tom' }]), ['jess', 'tom']);
  assert.deepEqual(personSlugs([{ name: 'Sam Davis' }, { name: 'Sam Jones' }]), ['sam-davis', 'sam-jones']);
  assert.ok(personSlugs([{ name: 'Bartholomew-Alexander' }])[0].length <= 11);
});

test('planTeam refuses what would break later', () => {
  assert.throws(() => planTeam('Acme Ltd', [{ name: 'Jess' }]), /team name/);
  assert.throws(() => planTeam('acme', []), /at least one/);
  assert.throws(() => planTeam('acme', [{ name: 'Agent' }]), /company agent/);
  assert.throws(() => planTeam('acme', Array.from({ length: 16 }, (_, i) => ({ name: `p${i}x` }))), /up to 15/);
});

test('the key matrix: staff READ the company brain and WRITE only their own repo; the agent writes the brain and reads each person', () => {
  const plan = planTeam('acme', [{ name: 'Jess' }, { name: 'Tom' }]);
  const hub = plan.boxes[0]; const jess = plan.boxes[1];
  assert.deepEqual(deployKeysFor(plan, jess), [
    { name: 'brain', repo: 'acme-team-brain', readOnly: true },
    { name: 'outbox', repo: 'acme-from-jess', readOnly: false },
  ]);
  const hk = deployKeysFor(plan, hub);
  assert.deepEqual(hk.filter((k) => !k.readOnly).map((k) => k.repo), ['acme-team-brain']);
  assert.deepEqual(hk.filter((k) => k.readOnly).map((k) => k.repo), ['acme-from-jess', 'acme-from-tom']);
});

test('the configs the app sends are exactly what the box-side enrol accepts', () => {
  const plan = planTeam('acme', [{ name: 'Jess' }, { name: 'Tom' }]);
  for (const b of plan.boxes) {
    const cfg = enrolConfig(plan, 'owner', b);
    assert.doesNotThrow(() => validateConfig(cfg));
    assert.match(cfg.brain.remote, /^ssh:\/\/git@github\.com\/owner\/acme-team-brain\.git$/);
  }
  assert.equal(enrolConfig(plan, 'owner', plan.boxes[1]).outbox.remote, 'ssh://git@github.com/owner/acme-from-jess.git');
});

test('the whole flow: GitHub code shown, repos, agent first then each person, keys, enrol, handover', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ deviceFlow: async () => ({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', poll: async () => { await gate; return { ok: true, token: GHTOKEN }; } }) });
  t.after(h.close);
  const r = await h.call('POST', '/team/start', START);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.boxes, ['acme-agent', 'acme-jess', 'acme-tom']);
  const waiting = await until(h.call, 'github');
  assert.equal(waiting.github.code, 'ABCD-1234');
  release();
  const s = await until(h.call, 'ready');
  // servers: agent first, each on the owner's provider account
  assert.deepEqual(h.calls.filter((c) => c[0] === 'create').map((c) => c[1]), ['aios-acme-agent', 'aios-acme-jess', 'aios-acme-tom']);
  // repos: company brain + one per person, company skeleton seeded
  assert.deepEqual(h.gh.filter((x) => x[0] === 'repo').map((x) => x[1]), ['owner/acme-team-brain', 'owner/acme-from-jess', 'owner/acme-from-tom']);
  assert.ok(h.gh.some((x) => x[0] === 'file' && x[2] === 'company/policies.md'));
  // deploy keys: the box's own minted key, with the right access
  const keys = h.gh.filter((x) => x[0] === 'key');
  assert.ok(keys.some((k) => k[1] === 'owner/acme-team-brain' && k[3] === 'ssh-ed25519 KEY-acme-jess-box-brain' && k[4] === true));
  assert.ok(keys.some((k) => k[1] === 'owner/acme-from-jess' && k[3] === 'ssh-ed25519 KEY-acme-jess-box-outbox' && k[4] === false));
  assert.ok(keys.some((k) => k[1] === 'owner/acme-team-brain' && k[3] === 'ssh-ed25519 KEY-acme-agent-box-brain' && k[4] === false));
  assert.ok(!keys.some((k) => k[1] === 'owner/acme-team-brain' && k[4] === false && /jess|tom/.test(k[3])), 'no staff box may write the company brain');
  // enrol ran on every box, then the first merge on the agent
  assert.equal(h.execs.filter(([, c]) => / enrol \/state /.test(c)).length, 3);
  assert.ok(h.execs.some(([a, c]) => a === 'acme-agent-box' && /team-hub\.mjs/.test(c)));
  assert.equal(s.handover.length, 3);
  assert.match(s.handover[1].todo.join(' '), /I already have one/);
  assert.ok(s.boxes.every((b) => b.phase === 'ready'));
});

test('neither token is ever written to disk', async (t) => {
  const h = harness(); t.after(h.close);
  await h.call('POST', '/team/start', START);
  await until(h.call, 'ready');
  for (const f of readdirSync(h.sshDir)) {
    const text = readFileSync(join(h.sshDir, f), 'utf8');
    assert.ok(!text.includes(TOKEN) && !text.includes(GHTOKEN), `${f} holds a token`);
  }
  const status = JSON.stringify((await h.call('GET', '/team/status')).body);
  assert.ok(!status.includes(TOKEN) && !status.includes(GHTOKEN));
});

test('a run that fails mid-way resumes without making any server twice', async (t) => {
  let failEnrol = true;
  const execs = [];
  const exec = async (alias, cmd) => {
    execs.push(cmd);
    if (/ keys \/state /.test(cmd)) {
      const names = cmd.split(' keys /state ')[1].trim().split(' ');
      return { code: 0, stdout: `TEAM_KEYS ${JSON.stringify(Object.fromEntries(names.map((n) => [n, `ssh-ed25519 K-${alias}-${n}`])))}\n` };
    }
    if (/ enrol \/state /.test(cmd) && alias === 'acme-tom-box' && failEnrol) return { code: 1, stdout: '', stderr: 'Cannot find module team-enrol.mjs' };
    if (/ enrol \/state /.test(cmd)) return { code: 0, stdout: 'TEAM_ENROLLED {}\n' };
    return { code: 0, stdout: '' };
  };
  const h = harness({ exec }); t.after(h.close);
  await h.call('POST', '/team/start', START);
  const f = await until(h.call, 'failed');
  assert.match(f.error, /Tom Lee: enrolment failed: Cannot find module/);
  failEnrol = false;
  // a boot failure leaves a box "failed"; the resume must show it as waiting again
  const teamFile = join(h.sshDir, 'acme-team.json');
  const saved = JSON.parse(readFileSync(teamFile, 'utf8'));
  saved.boxes['acme-tom'] = { state: {}, steps: [], phase: 'failed', error: 'boot timeout' };
  writeFileSync(teamFile, JSON.stringify(saved));
  await h.call('POST', '/team/start', START);
  const mid = (await h.call('GET', '/team/status')).body;
  assert.notEqual(mid.boxes.find((b) => b.slug === 'acme-tom').phase, 'failed', 'a resumed box does not keep the old failure');
  await until(h.call, 'ready');
  assert.equal(h.calls.filter((c) => c[0] === 'create').length, 4, 'resume reused the two finished servers and rebuilt only the one that never booted');
});

test('a second start while one runs is a 409; a resume with different people is refused', async (t) => {
  const gate = new Promise(() => {});
  const h = harness({ deviceFlow: async () => ({ userCode: 'X', verificationUri: 'u', poll: () => gate }) });
  t.after(h.close);
  await h.call('POST', '/team/start', START);
  assert.equal((await h.call('POST', '/team/start', START)).status, 409);
  const h2 = harness(); t.after(h2.close);
  await h2.call('POST', '/team/start', START);
  await until(h2.call, 'ready');
  const r = await h2.call('POST', '/team/start', { ...START, people: [{ name: 'Jess' }] });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /different people/);
});

// ---- stage 3: add a person, someone's leaving -------------------------------

test('extendPlan never renames anyone already on the team', () => {
  const plan = planTeam('acme', [{ name: 'Jess Smith' }, { name: 'Tom Lee' }]);
  const x = extendPlan(plan, [{ name: 'Jess Brown' }, { name: 'Ana Ruiz' }]);
  assert.deepEqual(x.added, ['acme-jess-brown', 'acme-ana']);
  assert.ok(x.plan.boxes.some((b) => b.slug === 'acme-jess'), 'the first Jess keeps her box name');
  assert.throws(() => extendPlan(x.plan, [{ name: 'Jess Brown' }]), /same box name/);
  assert.throws(() => extendPlan(plan, Array.from({ length: 14 }, (_, i) => ({ name: `p${i}x` }))), /up to 15/);
});

// the box's team-export.mjs answer: a header with the hash, then the archive
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const ARCHIVE = gzipSync(Buffer.from('fake-tar-of-private-pages'));
const EXPORT_OUT = `TEAM_EXPORT ${JSON.stringify({ files: 2, bytes: ARCHIVE.length, sha256: createHash('sha256').update(ARCHIVE).digest('hex') })}\n${ARCHIVE.toString('base64')}\n`;
function boxExec(execs, over = {}) {
  return async (alias, cmd) => {
    execs.push([alias, cmd]);
    if (over[alias] && over[alias](cmd)) return over[alias](cmd);
    if (/ keys \/state /.test(cmd)) {
      const names = cmd.split(' keys /state ')[1].trim().split(' ');
      return { code: 0, stdout: `TEAM_KEYS ${JSON.stringify(Object.fromEntries(names.map((n) => [n, `ssh-ed25519 KEY-${alias}-${n}`])))}\n` };
    }
    if (/ enrol \/state /.test(cmd)) return { code: 0, stdout: 'TEAM_ENROLLED {}\n' };
    if (/team-export\.mjs/.test(cmd)) return { code: 0, stdout: EXPORT_OUT };
    return { code: 0, stdout: '' };
  };
}
const enrolOf = (execs, alias) => JSON.parse(execs.filter(([a, c]) => a === alias && / enrol \/state /.test(c)).pop()[1].split(" enrol /state '")[1].replace(/'$/, ''));

test('add a person: one new server and repo, the agent learns them, nobody else is rebuilt', async (t) => {
  const execs = [];
  const h = harness({ exec: boxExec(execs) }); t.after(h.close);
  await h.call('POST', '/team/start', START);
  await until(h.call, 'ready');
  assert.equal((await h.call('POST', '/team/add', { company: 'acme', token: TOKEN, people: [{ name: 'Ana Ruiz' }] })).status, 200);
  const s = await until(h.call, 'ready');
  assert.deepEqual(h.calls.filter((c) => c[0] === 'create').map((c) => c[1]), ['aios-acme-agent', 'aios-acme-jess', 'aios-acme-tom', 'aios-acme-ana']);
  assert.ok(h.gh.some((x) => x[0] === 'repo' && x[1] === 'owner/acme-from-ana'));
  assert.ok(h.gh.some((x) => x[0] === 'key' && x[1] === 'owner/acme-from-ana' && x[3] === 'ssh-ed25519 KEY-acme-agent-box-from-ana' && x[4] === true), 'the agent can read Ana\'s repo');
  assert.deepEqual(enrolOf(execs, 'acme-agent-box').members.map((m) => m.slug), ['jess', 'tom', 'ana']);
  assert.deepEqual(s.handover.map((x) => x.slug), ['acme-ana'], 'the handover is only for the new person');
  const teams = (await h.call('GET', '/team/teams')).body.teams;
  assert.deepEqual(teams[0].people.map((p) => p.slug), ['jess', 'tom', 'ana']);
});

test('someone\'s leaving: their personal folder comes home, keys go, repo archived, agent updated, server deleted', async (t) => {
  const execs = [];
  const h = harness({ exec: boxExec(execs) }); t.after(h.close);
  await h.call('POST', '/team/start', START);
  await until(h.call, 'ready');
  const wrong = await h.call('POST', '/team/remove', { company: 'acme', token: TOKEN, person: 'tom', confirm: 'tom' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /Type Tom Lee's name exactly/);
  assert.equal((await h.call('POST', '/team/remove', { company: 'acme', token: TOKEN, person: 'tom', confirm: 'Tom Lee' })).status, 200);
  const s = await until(h.call, 'ready');
  // personal/ exported to this computer, byte for byte
  assert.ok(s.result.exported && existsSync(s.result.exported));
  assert.deepEqual(readFileSync(s.result.exported), ARCHIVE, 'byte for byte, and only after the hash matched');
  // order: export before anything is cut, server last
  const order = execs.map(([a, c]) => (/team-export/.test(c) ? 'export' : / enrol /.test(c) && a === 'acme-agent-box' ? 'hub' : null)).filter(Boolean);
  assert.equal(order[order.length - 2], 'export');
  assert.deepEqual(h.gh.filter((x) => x[0] === 'unkey').map((x) => x.slice(1)), [
    ['owner/acme-team-brain', 'acme-tom'], ['owner/acme-from-tom', 'acme-tom'], ['owner/acme-from-tom', 'acme-agent']]);
  assert.deepEqual(h.gh.filter((x) => x[0] === 'archive').map((x) => x[1]), ['owner/acme-from-tom'], 'archived, never deleted');
  assert.deepEqual(enrolOf(execs, 'acme-agent-box').members.map((m) => m.slug), ['jess']);
  assert.equal(h.destroyed.length, 1);
  assert.ok(h.calls.some((c) => c[0] === 'delete-key'), 'their owner key comes off the provider account too');
  assert.deepEqual(h.forgotten, ['acme-tom-box']);
  const team = (await h.call('GET', '/team/teams')).body.teams[0];
  assert.deepEqual(team.people.map((p) => p.slug), ['jess']);
  assert.deepEqual(team.left, ['Tom Lee']);
});

test('a leaver whose server will not answer stops before anything is cut, unless the owner says it is already gone', async (t) => {
  const execs = [];
  const exec = boxExec(execs, { 'acme-tom-box': (cmd) => (/team-export/.test(cmd) ? { code: 255, stdout: '', stderr: 'Connection refused' } : null) });
  const h = harness({ exec }); t.after(h.close);
  await h.call('POST', '/team/start', START);
  await until(h.call, 'ready');
  await h.call('POST', '/team/remove', { company: 'acme', token: TOKEN, person: 'tom', confirm: 'Tom Lee' });
  const f = await until(h.call, 'failed');
  assert.match(f.error, /already gone/);
  assert.ok(!h.gh.some((x) => x[0] === 'unkey' || x[0] === 'archive'), 'nothing was cut');
  assert.equal(h.destroyed.length, 0);
  await h.call('POST', '/team/remove', { company: 'acme', token: TOKEN, person: 'tom', confirm: 'Tom Lee', skip_export: true });
  const s = await until(h.call, 'ready');
  assert.match(s.result.note, /export skipped/);
  assert.equal(h.destroyed.length, 1);
});

test('a team whose last change stopped part way stays on the manage screen, marked unfinished', async (t) => {
  const execs = [];
  const exec = boxExec(execs, { 'acme-ana-box': (cmd) => (/ enrol \/state /.test(cmd) ? { code: 1, stdout: '', stderr: 'boom' } : null) });
  const h = harness({ exec }); t.after(h.close);
  await h.call('POST', '/team/start', START);
  await until(h.call, 'ready');
  await h.call('POST', '/team/add', { company: 'acme', token: TOKEN, people: [{ name: 'Ana Ruiz' }] });
  await until(h.call, 'failed');
  const team = (await h.call('GET', '/team/teams')).body.teams[0];
  assert.equal(team.unfinished, true);
  assert.deepEqual(team.people.map((p) => p.slug), ['jess', 'tom', 'ana']);
});

test('one support window: agent only by default, every server when asked, and revoke always closes all', async (t) => {
  const execs = [];
  const h = harness({ exec: boxExec(execs) }); t.after(h.close);
  await h.call('POST', '/team/start', START);
  await until(h.call, 'ready');
  const sup = () => execs.filter(([, c]) => /support-access\.mjs/.test(c));
  let r = await h.call('POST', '/team/support', { company: 'acme', action: 'grant' });
  assert.equal(r.status, 200);
  assert.deepEqual(sup().map(([a, c]) => [a, c.split('/state ')[1]]), [['acme-agent-box', 'grant 24']]);
  r = await h.call('POST', '/team/support', { company: 'acme', action: 'grant', scope: 'all', hours: 4 });
  assert.deepEqual(r.body.results.map((x) => x.slug), ['acme-agent', 'acme-jess', 'acme-tom']);
  execs.length = 0;
  r = await h.call('POST', '/team/support', { company: 'acme', action: 'revoke', scope: 'agent' });
  assert.equal(sup().length, 3, 'revoke reaches every server whatever the scope says');
  assert.equal((await h.call('POST', '/team/support', { company: 'acme', action: 'grant', hours: 500 })).status, 400);
});

test('review 5: an export that arrives cut short or corrupt stops the removal before anything is cut', async (t) => {
  for (const bad of [
    `TEAM_EXPORT ${JSON.stringify({ files: 1, bytes: ARCHIVE.length, sha256: 'f'.repeat(64) })}\n${ARCHIVE.toString('base64')}\n`,
    `TEAM_EXPORT ${JSON.stringify({ files: 1, bytes: ARCHIVE.length, sha256: createHash('sha256').update(ARCHIVE).digest('hex') })}\n${ARCHIVE.subarray(0, 10).toString('base64')}\n`,
  ]) {
    const execs = [];
    const exec = boxExec(execs, { 'acme-tom-box': (cmd) => (/team-export/.test(cmd) ? { code: 0, stdout: bad } : null) });
    const h = harness({ exec }); t.after(h.close);
    await h.call('POST', '/team/start', START);
    await until(h.call, 'ready');
    await h.call('POST', '/team/remove', { company: 'acme', token: TOKEN, person: 'tom', confirm: 'Tom Lee' });
    const f = await until(h.call, 'failed');
    assert.match(f.error, /arrived incomplete; nothing has been removed/);
    assert.ok(!h.gh.some((x) => x[0] === 'unkey' || x[0] === 'archive'));
    assert.equal(h.destroyed.length, 0);
  }
});

test('review 6: while someone is half way out, an add or a start cannot let them back in', async (t) => {
  const execs = [];
  let failEnrol = true;
  const exec = boxExec(execs, { 'acme-agent-box': (cmd) => (/ enrol \/state /.test(cmd) && failEnrol && execs.some(([, c]) => /team-export/.test(c)) ? { code: 1, stdout: '', stderr: 'boom' } : null) });
  const h = harness({ exec }); t.after(h.close);
  await h.call('POST', '/team/start', START);
  await until(h.call, 'ready');
  await h.call('POST', '/team/remove', { company: 'acme', token: TOKEN, person: 'tom', confirm: 'Tom Lee' });
  await until(h.call, 'failed');   // keys already cut, agent not yet updated
  const add = await h.call('POST', '/team/add', { company: 'acme', token: TOKEN, people: [{ name: 'Ana Ruiz' }] });
  assert.equal(add.status, 409);
  assert.match(add.body.error, /finish removing Tom Lee first/);
  assert.equal((await h.call('POST', '/team/start', START)).status, 409);
  assert.equal((await h.call('POST', '/team/remove', { company: 'acme', token: TOKEN, person: 'jess', confirm: 'Jess Smith' })).status, 409, 'not someone else either');
  failEnrol = false;
  await h.call('POST', '/team/remove', { company: 'acme', token: TOKEN, person: 'tom', confirm: 'Tom Lee' });
  await until(h.call, 'ready');
  assert.equal((await h.call('POST', '/team/add', { company: 'acme', token: TOKEN, people: [{ name: 'Ana Ruiz' }] })).status, 200);
  await until(h.call, 'ready');
});

test('review 13: a repo or a mineral this team did not make is refused, never reused', async (t) => {
  const gh = [];
  const github = () => ({
    whoami: async () => 'owner',
    ensureRepo: async (owner, name) => { gh.push(name); return { created: name !== 'acme-from-tom' }; },
    ensureFile: async () => ({ created: true }),
    ensureDeployKey: async () => ({ added: true }),
  });
  const h = harness({ github }); t.after(h.close);
  await h.call('POST', '/team/start', START);
  const f = await until(h.call, 'failed');
  assert.match(f.error, /owner\/acme-from-tom already exists in your GitHub and is not part of this team/);
  assert.equal(h.calls.filter((c) => c[0] === 'create').length, 0, 'no server was made');
  const h2 = harness(); t.after(h2.close);
  writeFileSync(join(h2.sshDir, 'acme-jess-box.key'), 'someone else\'s key');
  await h2.call('POST', '/team/start', START);
  const f2 = await until(h2.call, 'failed');
  assert.match(f2.error, /already has a mineral called acme-jess/);
});

test('review 2: names the agent uses for itself are reserved; a resumed start keeps what the team made', async (t) => {
  for (const name of ['Hub Jones', 'Owner', 'Slack']) assert.throws(() => planTeam('acme', [{ name }]), /reserved/);
  assert.throws(() => extendPlan(planTeam('acme', [{ name: 'Jess' }]), [{ name: 'Hub' }]), /same box name|reserved/);
  // a start that failed inside the repos step resumes and accepts its own repos
  let fail = true;
  const made = new Set();
  const github = () => ({
    whoami: async () => 'owner',
    // the hiccup happens BEFORE GitHub made the repo (a create that half-succeeded is refused
    // on resume, deliberately: recording it as ours unconfirmed would reopen the collision hole)
    ensureRepo: async (o, name) => { if (fail && name === 'acme-from-tom') throw new Error('GitHub hiccup'); const c = !made.has(name); made.add(name); return { created: c }; },
    ensureFile: async () => ({ created: true }), ensureDeployKey: async () => ({ added: true }),
  });
  const h = harness({ github }); t.after(h.close);
  await h.call('POST', '/team/start', START);
  await until(h.call, 'failed');
  fail = false;
  await h.call('POST', '/team/start', START);
  await until(h.call, 'ready');
});
