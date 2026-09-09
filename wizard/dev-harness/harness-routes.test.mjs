// harness-routes.test.mjs — run: node --test wizard/dev-harness/harness-routes.test.mjs
//
// The dev-harness is the third server. panel-server and door-server are pinned
// to answer the routes the pages call (version-chip.test.mjs, "both servers
// answer /whats-new"); the harness never was, and on 2026-08-14 that cost
// fifteen red assertions across three qa-* files.
//
// The mechanism, which is trap 43 and is the /favicon.ico comment in harness.mjs
// wearing a new shirt: the pages fetch a handful of routes unprompted at load.
// A route the harness does not know 404s, Chromium logs "Failed to load
// resource" to the page console, and EVERY driven test asserts a clean console.
// So one missing stub reddens every qa-* test on every face at once, in a shape
// (deep-equal [] vs [string]) that reads exactly like ordinary string rot.
//
// Pinned as the class, not the instance: the load-time GET surface is derived
// from the pages themselves, so the next route someone adds to member.html is
// covered the day it lands rather than the day it breaks a qa file.
//
// No playwright and no browser: this is node's http against a spawned harness,
// so unlike the qa-* files it runs in the clean-checkout suite and cannot rot
// invisibly (trap 15).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, '..', 'panel');
const HARNESS = join(HERE, 'harness.mjs');

let harness, base;

before(async () => {
  // --port 0: any free port, reported back on the startup line. A fixed port
  // here would reintroduce exactly the false failures this file exists to stop.
  harness = spawn(process.execPath, [HARNESS, '--port', '0'], { stdio: 'pipe' });
  base = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('dev-harness did not start')), 10000);
    let buf = '';
    harness.stdout.on('data', (d) => {
      buf += String(d);
      const m = buf.match(/dev-harness up on (http:\/\/localhost:\d+)/);
      if (m) { clearTimeout(t); res(m[1]); }
    });
    harness.on('exit', (c) => rej(new Error(`dev-harness exited early (${c})`)));
  });
});

after(() => { if (harness) harness.kill(); });

// The no-options form of fetch is always a GET and always a route the page
// reads on its own initiative. Anything needing a verb, a body or a header is
// written with an options object and is deliberately not matched: this is the
// read-only surface, the part a page can reach without the member deciding
// anything. Some of it fires at load (the version chip) and some behind a
// condition the fixtures may not reach today (/account/devices needs a denied
// connection), which is the point of deriving it rather than listing it.
function plainGets(file) {
  const src = readFileSync(join(PANEL, file), 'utf8');
  return [...new Set([...src.matchAll(/fetch\('(\/[^']*)'\)/g)].map((m) => m[1]))].sort();
}

for (const file of ['member.html', 'door.html']) {
  test(`the harness answers every route ${file} GETs`, async () => {
    const routes = plainGets(file);
    assert.ok(routes.length > 3, `${file}: expected a read-only GET surface, found ${routes.length}`);
    const missing = [];
    for (const r of routes) {
      const res = await fetch(base + r);
      if (res.status === 404) missing.push(`${r} → 404`);
      else if (!res.ok) missing.push(`${r} → ${res.status}`);
    }
    assert.deepEqual(missing, [],
      `${file}: the harness 404s routes the page opens with, which reddens every driven test on every face`);
  });
}

// The instance that taught it. Both real servers promise 200 + {entries,hidden}
// and never 404 even offline; a harness that answers differently is a harness
// the version chip cannot be driven against.
test('/whats-new: the harness keeps the same contract as both real servers', async () => {
  const res = await fetch(base + '/whats-new');
  assert.equal(res.status, 200, '/whats-new must never 404: the chip fetches it on every face at load');
  const body = await res.json();
  assert.ok(Array.isArray(body.entries), 'entries is a list, the shape plainRelease() returns');
  assert.equal(typeof body.hidden, 'number', 'hidden is a count');
  // the fold and the hover summary both read `plain`; an entry without it paints blank
  for (const e of body.entries) assert.equal(typeof e.plain, 'string', 'every entry carries its plain line');
});

// ---- Google BYO connect (design-google-byo-connect.md, 2026-08-17) ---------
// member.html's wizard card calls four /google-connect/* routes whose GET is
// built by concatenation, so plainGets() above cannot see it: this pins the
// surface by hand, against the same contract panel-server promises.
const post = async (path, body) => (await fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})).json();
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
// /run answers over SSE: data: <json-string> per line, then "__DONE__"
async function runVerb(verb, args = {}) {
  const text = await (await fetch(base + '/run', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb, args }),
  })).text();
  const lines = [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]))
    .filter((l) => l !== '__DONE__' && !/^__FAIL__/.test(String(l)));
  return JSON.parse(lines[lines.length - 1]);
}

test('mcp-status: the harness box speaks contract 2 and carries the byo google row', async () => {
  await fetch(base + '/state/rich');   // fresh flows
  // the fixture contract must never outrun the real engine's CONTRACT
  const engine = readFileSync(join(HERE, '..', '..', 'engine', 'comms', 'mcp-connect.mjs'), 'utf8');
  const real = Number(engine.match(/^const CONTRACT = (\d+);/m)[1]);
  const fixtures = readFileSync(join(HERE, 'fixtures.mjs'), 'utf8');
  const faked = Number(fixtures.match(/const MCP_CONTRACT = (\d+);/)[1]);
  assert.ok(faked <= real, `fixture contract ${faked} claims more than the engine's ${real}`);
  assert.equal(faked, 2, 'the google row rides contract 2; the fixture must announce it');
  const d = await runVerb('mcp-status');
  assert.equal(d.contract, 2);
  const g = d.services.find((s) => s.key === 'google');
  assert.ok(g, 'the google row is in the box report');
  assert.equal(g.byo, 'google');
  assert.equal(g.auth, 'byo');
  assert.equal(g.state, 'off', 'a fresh rich world starts disconnected');
  assert.equal(g.url, undefined, 'no url on the byo row: the page must never DCR-sign-in google');
  // the dead mcp-login-* fixture family stays dead (verb removed 2026-08-09)
  assert.doesNotMatch(fixtures, /mcp-login-(start|finish|cancel)/, 'the mcp-login-* fixtures were deleted; nothing may quietly revive them');
});

test('/google-connect: refusals are honest before the flow starts', async () => {
  await fetch(base + '/state/rich');
  // start before any key file: the exact reason the page re-opens step 2 on
  const early = await post('/google-connect/start', { host: 'mel-box' });
  assert.equal(early.ok, false);
  assert.match(early.reason, /key file/);
  // a Web-application client is the documented mix-up: named, with the fix
  const web = await post('/google-connect/client', { host: 'mel-box', email: 'mel@gmail.com', client_json_b64: b64({ web: { client_id: 'x' } }) });
  assert.equal(web.ok, false);
  assert.match(web.reason, /Desktop app/);
  // not a client file at all
  const junk = await post('/google-connect/client', { host: 'mel-box', email: 'mel@gmail.com', client_json_b64: Buffer.from('not json').toString('base64') });
  assert.equal(junk.ok, false);
});

test('/google-connect: the happy path walks to done with append-only steps, and the row flips on', async () => {
  await fetch(base + '/state/rich');
  const okc = await post('/google-connect/client', { host: 'mel-box', email: 'mel@gmail.com',
    client_json_b64: b64({ installed: { client_id: 'abc.apps.googleusercontent.com', client_secret: 's' } }) });
  assert.equal(okc.ok, true);
  assert.ok(okc.client, 'the accepted key answers with a client summary');
  assert.equal((await post('/google-connect/start', { host: 'mel-box' })).ok, true);
  let seen = [], stage = '', last = null;
  for (let i = 0; i < 8 && stage !== 'done'; i++) {
    last = await (await fetch(base + '/google-connect/status?host=mel-box')).json();
    stage = last.stage;
    assert.deepEqual(last.steps.slice(0, seen.length), seen, 'steps[] is append-only across polls');
    assert.ok(last.steps.length >= seen.length);
    seen = last.steps;
  }
  assert.equal(stage, 'done');
  assert.equal(last.email, 'mel@gmail.com');
  assert.ok(!last.rekey_due_at, 'no re-key clock rides done any more: a published key has no scheduled death');
  const g = (await runVerb('mcp-status')).services.find((s) => s.key === 'google');
  assert.equal(g.state, 'on', 'the box row agrees with the finished flow');
  assert.equal(g.rekey_due_at, undefined, 'nor does the row carry one');
});

test('/google-connect: the failure variant names the refusal and keeps the steps', async () => {
  await fetch(base + '/state/rich');
  await post('/google-connect/client', { host: 'mel-box', email: 'denied@gmail.com',
    client_json_b64: b64({ installed: { client_id: 'abc.apps.googleusercontent.com', client_secret: 's' } }) });
  assert.equal((await post('/google-connect/start', { host: 'mel-box' })).ok, true);
  let st = null;
  for (let i = 0; i < 6; i++) {
    st = await (await fetch(base + '/google-connect/status?host=mel-box')).json();
    if (st.stage === 'failed') break;
  }
  assert.equal(st.stage, 'failed');
  assert.ok(st.reason, 'a failure always says why');
  assert.ok(st.steps.length >= 1, 'the steps that did happen stay on record');
  // cancel is idempotent and always answers
  assert.equal((await post('/google-connect/cancel', { host: 'mel-box' })).ok, true);
});

// A page that opened cleanly is the whole point: prove the harness serves both
// faces without a single 4xx/5xx on the way in.
for (const face of ['/panel', '/member', '/door']) {
  test(`${face} is served`, async () => {
    const res = await fetch(base + face);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /verChip/, 'the face carries the version chip that does the fetching');
  });
}

// ---- the door's self-host wizard, stubbed end to end (2026-09-09) ----------
// The docs photograph every wizard screen from this harness with no server
// ever made. Pinned here, browserless, so the page-level switches the shots
// rely on (`?provision=`, `?setup=`) cannot rot between rig runs.
const asDoor = (query = '') => ({ headers: { referer: `${base}/door${query ? `?${query}` : ''}` } });
const postJson = (path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(extra.headers || {}) }, body: JSON.stringify(body) });

test('provision/validate: a good token answers the catalogue, a bad one 401s', async () => {
  await fetch(base + '/state/empty');
  const good = await postJson('/provision/validate', { token: 'fixture-token' });
  assert.equal(good.status, 200);
  const cat = await good.json();
  assert.equal(cat.ok, true);
  assert.ok(cat.locations.length >= 3 && cat.server_types.length >= 3, 'enough choices to photograph');
  assert.equal(cat.defaults.location, 'nbg1');
  for (const t of cat.server_types) {
    assert.ok(Array.isArray(t.locations), `${t.name}: stamped with the locations that sell it`);
    for (const loc of t.locations) assert.equal(typeof t.prices[loc], 'number', `${t.name}: a price at ${loc}`);
  }
  const bad = await postJson('/provision/validate', { token: 'bad-token' });
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).ok, false);
});

test('provision/start walks to ready across status polls, then destroy resets to idle', async () => {
  await fetch(base + '/state/empty');
  assert.equal((await (await fetch(base + '/provision/status')).json()).phase, 'idle');
  const r = await postJson('/provision/start', { token: 'fixture-token', name: 'mel', location: 'nbg1', server_type: 'cx33' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).alias, 'mel-box');
  const phases = []; let steps = 0;
  for (let i = 0; i < 8; i++) {
    const s = await (await fetch(base + '/provision/status')).json();
    phases.push(s.phase);
    assert.ok(s.steps.length >= steps, 'steps are append-only');
    steps = s.steps.length;
    assert.ok(!('token' in s), 'the run view never carries the token');
    if (s.phase === 'ready') break;
  }
  assert.ok(phases.includes('provisioning') && phases.includes('booting') && phases.at(-1) === 'ready', `walk was ${phases.join(' > ')}`);
  const again = await postJson('/provision/start', { token: 'fixture-token', name: 'mel' });
  assert.equal(again.status, 200, 'a finished run does not block a new one');
  const s2 = await (await fetch(base + '/provision/status')).json();
  assert.equal(s2.phase, 'provisioning');
  const busy = await postJson('/provision/start', { token: 'fixture-token', name: 'mel' });
  assert.equal(busy.status, 409, 'one run at a time, like the real routes');
  const d = await postJson('/provision/destroy', { token: 'fixture-token', name: 'mel' });
  assert.equal(d.status, 200);
  assert.equal((await (await fetch(base + '/provision/status')).json()).phase, 'idle');
  const badName = await postJson('/provision/start', { token: 'fixture-token', name: 'Mel Harper' });
  assert.equal(badName.status, 400);
});

test('?provision= on the door URL lands the flow on a chosen screen', async () => {
  await fetch(base + '/state/empty');
  const booting = await (await fetch(base + '/provision/status', asDoor('provision=booting'))).json();
  assert.equal(booting.phase, 'booting');
  assert.ok(booting.steps.length > 0 && booting.ip, 'a build screen has steps and a server');
  const ready = await (await fetch(base + '/provision/status', asDoor('provision=ready'))).json();
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.alias, 'mel-box');
  // failed: the page attaches to a run in flight, then its first poll fails
  const f1 = await (await fetch(base + '/provision/status', asDoor('provision=failed'))).json();
  const f2 = await (await fetch(base + '/provision/status', asDoor('provision=failed'))).json();
  assert.equal(f1.phase, 'booting');
  assert.equal(f2.phase, 'failed');
  assert.match(f2.error, /never answered/);
  // a fresh world clears the switch's own state too
  await fetch(base + '/state/empty');
  assert.equal((await (await fetch(base + '/provision/status', asDoor('provision=failed'))).json()).phase, 'booting');
  assert.equal((await (await fetch(base + '/provision/status'))).ok, true);
});

test('setup-steps answers not-yet by default and done with ?setup=done', async () => {
  const not = await (await fetch(base + '/setup-steps?box=mel-box', asDoor())).json();
  assert.deepEqual(not, { reachable: true, github: { connected: false, repo: '' }, claude: { signedIn: false } });
  const done = await (await fetch(base + '/setup-steps?box=mel-box', asDoor('setup=done'))).json();
  assert.equal(done.github.connected, true);
  assert.ok(done.github.repo);
  assert.equal(done.claude.signedIn, true);
});

test('provision/providers lists the registry; validate answers each provider in its own currency', async () => {
  const reg = await (await fetch(base + '/provision/providers')).json();
  assert.deepEqual(reg.providers.map((p) => p.id), ['hetzner', 'digitalocean']);
  const dO = await (await postJson('/provision/validate', { token: 'fixture-token', provider: 'digitalocean' })).json();
  assert.equal(dO.symbol, '$');
  assert.equal(dO.defaults.location, 'syd1', 'Sydney by default on DigitalOcean');
  assert.ok(dO.locations.some((l) => l.name === 'syd1'));
  assert.ok(dO.chains.standard.every((slug) => dO.server_types.some((t) => t.name === slug) || slug.endsWith('-amd')), 'the fixture sells the chain it names');
  const hz = await (await postJson('/provision/validate', { token: 'fixture-token' })).json();
  assert.equal(hz.symbol, '€');
  assert.equal((await postJson('/provision/validate', { token: 'fixture-token', provider: 'aws' })).status, 400);
});
