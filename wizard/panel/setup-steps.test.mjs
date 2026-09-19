// setup-steps.test.mjs — the door's finish-checklist reads (is the brain backed
// up to the owner's GitHub? is the mineral signed in to Claude?) and the door
// mount of the own-brain flow, both against injected probes: no real SSH, no
// real GitHub.
//   node --test wizard/panel/setup-steps.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupStepsRoutes, stripRepoUrl, SETUP_PROBE_CMD } from './setup-steps.mjs';
import { createDoorServer } from './door-server.mjs';

const TARGETS = [{ host: 'fern-box', org: 'fern', kind: 'member' }];

const listen = (opts) => new Promise((resolve) => {
  const s = createDoorServer({ port: 0, host: '127.0.0.1', htmlText: '<html>door</html>',
    bridge: { targets: () => TARGETS }, ...opts });
  s.on('listening', () => resolve(s));
});
const get = (s, path) => fetch(`http://127.0.0.1:${s.address().port}${path}`);
const post = (s, path, body) => fetch(`http://127.0.0.1:${s.address().port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('setup-steps: both facts parsed from one probe; credential stripped from the repo url', async () => {
  const cmds = [];
  const probe = async (host, cmd) => {
    cmds.push([host, cmd]);
    return { code: 0, stdout: 'SETUP_GITHUB https://x-access-token:gho_secret@github.com/fern-gh/fern-brain.git\nSETUP_CLAUDE_OK\n', stderr: '' };
  };
  const s = await listen({ setupSteps: { probe } });
  try {
    const r = await get(s, '/setup-steps?box=fern-box');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.reachable, true);
    assert.equal(j.github.connected, true);
    assert.equal(j.github.repo, 'https://github.com/fern-gh/fern-brain');
    assert.equal(j.claude.signedIn, true);
    assert.ok(!JSON.stringify(j).includes('gho_secret'), 'a credential in the remote url never leaves the server');
    assert.equal(cmds.length, 1, 'one round trip for both facts');
    assert.equal(cmds[0][0], 'fern-box');
    assert.equal(cmds[0][1], SETUP_PROBE_CMD);
  } finally { s.close(); }
});

test('setup-steps: fresh box -> connected false, signed-in false', async () => {
  const probe = async () => ({ code: 0, stdout: 'SETUP_GITHUB_NONE\nSETUP_CLAUDE_NONE\n', stderr: '' });
  const s = await listen({ setupSteps: { probe } });
  try {
    const j = await (await get(s, '/setup-steps?box=fern-box')).json();
    assert.equal(j.reachable, true);
    assert.equal(j.github.connected, false);
    assert.equal(j.claude.signedIn, false);
  } finally { s.close(); }
});

test('setup-steps: an unreachable box is "could not check", never a false "not yet"', async () => {
  for (const r of [{ code: 255, stdout: '', stderr: 'Connection refused' },
                   { code: 0, stdout: 'transport banner, no markers', stderr: '' }]) {
    const s = await listen({ setupSteps: { probe: async () => r } });
    try {
      const j = await (await get(s, '/setup-steps?box=fern-box')).json();
      assert.equal(j.reachable, false, JSON.stringify(r));
      assert.equal(j.github, null);
      assert.equal(j.claude, null);
    } finally { s.close(); }
  }
});

test('setup-steps: a box this app does not manage is refused before any dial', async () => {
  let dialled = 0;
  const s = await listen({ setupSteps: { probe: async () => { dialled++; return { code: 0, stdout: '', stderr: '' }; } } });
  try {
    const r = await get(s, '/setup-steps?box=evil-host');
    assert.equal(r.status, 400);
    assert.equal(dialled, 0, 'the alias becomes an ssh destination; an unmanaged one must never be dialled');
  } finally { s.close(); }
});

test('stripRepoUrl sheds user:token@ and .git, leaves a clean url alone', () => {
  assert.equal(stripRepoUrl('https://x:t@github.com/a/b.git'), 'https://github.com/a/b');
  assert.equal(stripRepoUrl('https://github.com/a/b'), 'https://github.com/a/b');
  assert.equal(stripRepoUrl(''), '');
});

// ---- the own-brain flow, mounted on the DOOR (2026-09-02) ------------------
// Same routes the seat serves; the finish checklist runs them in place so the
// person never leaves the wizard to make their brain theirs.
test('door own-brain: start with the built box -> device code; status -> done with the repo; token never in a response', async () => {
  const seen = { ownArgs: null };
  const s = await listen({ ownBrain: {
    deviceFlow: async () => ({ userCode: 'WXYZ-9876', verificationUri: 'https://github.com/login/device',
      poll: async () => ({ ok: true, token: 'gho_x' }) }),
    ownBrain: async (args) => { seen.ownArgs = args; args.log && args.log('created private repo'); return { ok: true, repo: 'fern-gh/fern-brain', pushed: true }; },
  } });
  try {
    const r = await post(s, '/own-brain/start', { slug: 'fern', box: 'fern-box' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.userCode, 'WXYZ-9876');
    let body;
    for (let i = 0; i < 40; i++) {
      body = await (await get(s, '/own-brain/status')).json();
      if (body.stage === 'done' || body.stage === 'failed') break;
      await new Promise((r2) => setTimeout(r2, 25));
    }
    assert.equal(body.stage, 'done');
    assert.equal(body.result.repo, 'fern-gh/fern-brain');
    assert.ok(!JSON.stringify(body).includes('gho_x'), 'token never leaves the server');
    assert.equal(seen.ownArgs.boxAlias, 'fern-box');
    assert.equal(seen.ownArgs.slug, 'fern');
  } finally { s.close(); }
});

test('door own-brain: a box this app does not manage is refused before any flow starts', async () => {
  let started = 0;
  const s = await listen({ ownBrain: { deviceFlow: async () => { started++; } } });
  try {
    const r = await post(s, '/own-brain/start', { slug: 'fern', box: 'evil-host' });
    assert.equal(r.status, 400);
    assert.equal(started, 0);
  } finally { s.close(); }
});

test('the factory refuses to handle other paths (falls through to the server 404)', async () => {
  const handle = setupStepsRoutes({ resolveHost: () => 'x' });
  assert.equal(handle({ method: 'GET', url: '/other' }, {}, '/other'), false);
  assert.equal(handle({ method: 'POST', url: '/setup-steps' }, {}, '/setup-steps'), false);
});

// ---- what the mineral thinks with (second-harness spec, 2026-09-17) ----------------
import { parseAssistant } from './setup-steps.mjs';

test('assistant: an older image prints no marker, so the answer is the Claude facts', () => {
  assert.deepEqual(parseAssistant('SETUP_GITHUB_NONE\nSETUP_CLAUDE_OK\n', true),
    { harness: 'claude-code', source: 'signin', label: 'Claude', ready: true, host: null, signin: 'claude' });
});

test('assistant: the sign-in command comes from THIS app\'s list, never from the box', () => {
  const hostile = 'SETUP_ASSISTANT ' + JSON.stringify({ harness: 'opencode', source: 'signin', label: 'ChatGPT', ready: false, signin: 'fetch-and-run-something', signinCommand: 'shutdown-now' });
  const a = parseAssistant(hostile, false);
  assert.equal(a.signin, 'opencode auth login');
  assert.ok(!JSON.stringify(a).includes('fetch-and-run') && !JSON.stringify(a).includes('shutdown'));
});

test('assistant: an endpoint has no sign-in; never-probed stays null; junk falls back', () => {
  const ep = parseAssistant('SETUP_ASSISTANT ' + JSON.stringify({ harness: 'opencode', source: 'endpoint', label: 'a model endpoint', ready: null, host: '192.168.1.20:11434' }), false);
  assert.deepEqual([ep.signin, ep.ready, ep.host], [null, null, '192.168.1.20:11434']);
  assert.equal(parseAssistant('SETUP_ASSISTANT {not json', true).harness, 'claude-code');
  assert.equal(parseAssistant('SETUP_ASSISTANT ' + JSON.stringify({ harness: '../x', source: 'signin' }), false).harness, 'claude-code');
  const unk = parseAssistant('SETUP_ASSISTANT ' + JSON.stringify({ harness: 'goose', source: 'signin', label: 'X' + String.fromCharCode(7) + '<b>', ready: false }), false);
  assert.deepEqual([unk.signin, unk.label], [null, 'X<b>']);   // unknown harness: no command; control chars gone; the page escapes the rest
});
