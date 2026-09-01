// backup-on-seat.test.mjs — "I just want to be able to click a button and connect to
// GitHub" (Sam, 2026-08-05).
//
// The Backup card's button used to NAVIGATE to /go/connect, the claim wizard on the
// member-connect server, whose page is headed "Connect to your box" and whose other
// cards are all about acquiring a box you already have. Opening the right fold over
// there (the earlier fix) made the landing correct without making it the right place
// to be. The flow now runs on the seat itself.
//
// These pin the three things that make that true: the panel serves the routes, the
// seat never navigates away, and a box the app does not manage is refused rather than
// dialled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPanelServer } from './panel-server.mjs';
import { ownBrain } from './own-brain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEMBER_HTML = readFileSync(path.join(HERE, 'member.html'), 'utf8');

// own-brain checks each box step's OUTPUT, not just its exit code, so a stub that
// only returns code 0 stops at the credential step and never reaches the push.
const OK = (cmd) => ({ code: 0, stdout: /echo stored/.test(cmd) ? 'stored\n' : '', stderr: '' });
const GH_OK = async (u) => ({ ok: true, status: 200,
  json: async () => (String(u).endsWith('/user') ? { login: 'cradsdavis-cell' } : { name: 'keith-brain' }) });

const TARGETS = [{ host: 'keith-box', kind: 'member' }];
const listen = (opts) => new Promise((resolve) => {
  const s = createPanelServer({
    port: 0, host: '127.0.0.1', htmlText: MEMBER_HTML, edition: 'member',
    bridge: { targets: () => TARGETS, stream: () => { throw new Error('unused'); }, tty: () => { throw new Error('unused'); } },
    ...opts,
  });
  s.on('listening', () => resolve(s));
});
const url = (s, p) => `http://127.0.0.1:${s.address().port}${p}`;
const post = (s, p, body) => fetch(url(s, p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const stubFlow = ({ ownResult = { ok: true, repo: 'cradsdavis-cell/keith-brain', pushed: true } } = {}) => {
  const seen = {};
  return {
    seen,
    deviceFlow: async () => ({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', poll: async () => ({ ok: true, token: 'gho_secret' }) }),
    ownBrain: async (args) => { seen.args = args; args.log('created private repo'); return ownResult; },
  };
};

// ---------------------------------------------------------------- the seat serves it

test('the member panel serves the own-brain flow itself', async () => {
  const st = stubFlow();
  const s = await listen({ deviceFlow: st.deviceFlow, ownBrain: st.ownBrain });
  try {
    const r = await post(s, '/own-brain/start', { slug: 'keith', box: 'keith-box' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.userCode, 'ABCD-1234', 'the code comes back to the card, not to another surface');

    let body;
    for (let i = 0; i < 60; i++) {
      body = await (await fetch(url(s, '/own-brain/status'))).json();
      if (body.stage === 'done' || body.stage === 'failed') break;
      await new Promise((r2) => setTimeout(r2, 25));
    }
    assert.equal(body.stage, 'done');
    assert.equal(body.result.repo, 'cradsdavis-cell/keith-brain');
    assert.ok(!JSON.stringify(body).includes('gho_secret'), 'the token never leaves the server');
    // The seat knows the real alias, so the guessed one is no longer load-bearing.
    assert.equal(st.seen.args.boxAlias, 'keith-box');
    assert.equal(st.seen.args.slug, 'keith');
  } finally { s.close(); }
});

test('a box this app does not manage is refused, not dialled', async () => {
  const st = stubFlow();
  const s = await listen({ deviceFlow: st.deviceFlow, ownBrain: st.ownBrain });
  try {
    for (const bad of ['someone-else-box', '../../evil', 'localhost']) {
      const r = await post(s, '/own-brain/start', { slug: 'keith', box: bad });
      assert.equal(r.status, 400, `${bad} must be refused`);
    }
    assert.equal(st.seen.args, undefined, 'no flow ever started');
  } finally { s.close(); }
});

test('precheck answers for the box the seat names, and offers its slug', async () => {
  const probes = [];
  const s = await listen({ precheckBridge: async (host, cmd) => { probes.push([host, cmd]); return { code: 0, stdout: '{"owner":"member"}' }; } });
  try {
    const j = await (await fetch(url(s, '/own-brain/precheck?box=keith-box'))).json();
    assert.equal(j.orgOwned, false);
    assert.equal(j.box, 'keith-box');
    assert.equal(j.slug, 'keith', 'the card can offer a username without asking for one');
    assert.equal(probes[0][0], 'keith-box');
  } finally { s.close(); }
});

test('the org console does not serve a personal-brain flow', async () => {
  const s = await listen({ edition: 'org', htmlText: '<html></html>' });
  try {
    assert.notEqual((await fetch(url(s, '/own-brain/precheck'))).status, 200);
  } finally { s.close(); }
});

// ---------------------------------------------------------------- the button stays put

test('the seat runs the flow in place: no navigation, no typed username', () => {
  const m = MEMBER_HTML.match(/var gh = \$\('seatBackupGh'\);[^\n]*\n/);
  assert.ok(m, 'the Backup button is still wired');
  assert.doesNotMatch(m[0], /location\.href/, 'pressing it must not leave the page');
  assert.match(m[0], /seatObStart/, 'it starts the flow here');
  assert.match(MEMBER_HTML, /fetch\('\/own-brain\/start'/, 'against this server');
  assert.match(MEMBER_HTML, /seatObSlug/, 'the slug comes from the box, not from a text field');
});

test('a rejected start does not leave the button permanently dead (qa-connect D1 class)', () => {
  const fn = MEMBER_HTML.slice(MEMBER_HTML.indexOf('function seatObStart()'), MEMBER_HTML.indexOf('function seatObPoll()'));
  assert.match(fn, /\.catch\(/, 'the fetch has a rejection path');
  const after = fn.slice(fn.indexOf('.catch('));
  assert.match(after, /disabled = false/, 'and it re-enables the button');
});

test('the live flow does not render inside the card that finishing repaints', () => {
  // Found by clicking, not by reading: the first cut put #seatObLive inside the string
  // loadSeat() writes into #seatBackup, so reaching "Done" repainted the card and wiped
  // the confirmation the member had been waiting on. It has to be a sibling.
  assert.match(MEMBER_HTML, /<div id="seatObLive"/, 'it lives in the static markup');
  const render = MEMBER_HTML.slice(MEMBER_HTML.indexOf("$('seatBackup').innerHTML"), MEMBER_HTML.indexOf("var dl = $('seatBackupDl')"));
  assert.doesNotMatch(render, /seatObLive/, 'and never inside what the repaint overwrites');
});

// ---------------------------------------------------------------- honest failure text

test('a hop that never reached git is not reported as a push failure', async () => {
  const reset = 'Connection reset by 167.233.159.203 port 22';
  const r = await ownBrain({
    slug: 'keith', boxAlias: 'keith-box', token: 't',
    fetcher: GH_OK,
    bridge: async (host, cmd) => (/git push/.test(cmd)
      ? { code: 255, stdout: '', stderr: reset }
      : OK(cmd)),
  });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.reason, /^brain push failed/, 'the transport failed, git never ran');
  assert.match(r.reason, /could not reach your box/);
  assert.match(r.reason, /resumes here/, 'and it says a retry is safe, because every leg is idempotent');
  assert.match(r.reason, /Connection reset/, 'without hiding what actually happened');
});

test('a real git rejection is still called a push failure', async () => {
  const r = await ownBrain({
    slug: 'keith', boxAlias: 'keith-box', token: 't',
    fetcher: GH_OK,
    bridge: async (host, cmd) => (/git push/.test(cmd)
      ? { code: 1, stdout: '', stderr: '! [rejected] HEAD -> main (fetch first)' }
      : OK(cmd)),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^brain push failed/);
});

test('the bulk push gets a budget sized for a bulk push, not for a one-line verb', async () => {
  let pushOpts = null;
  await ownBrain({
    slug: 'keith', boxAlias: 'keith-box', token: 't',
    fetcher: GH_OK,
    // The wire push specifically (`-u origin HEAD`). The later receipt push is a tiny
    // one, and matching that too would overwrite the value we came to read.
    bridge: async (host, cmd, o) => { if (/git push -q -u origin HEAD/.test(cmd)) pushOpts = o; return OK(cmd); },
  });
  assert.ok(pushOpts && pushOpts.hardTimeoutMs, 'the wire call carries its own timeout');
  // The bridge default is 25s and SIGKILLs on overrun, leaving box-side connections to
  // age out; that is what compounds into MaxStartups drops.
  assert.ok(pushOpts.hardTimeoutMs >= 120000, `got ${pushOpts.hardTimeoutMs}ms, want a real budget`);
});
