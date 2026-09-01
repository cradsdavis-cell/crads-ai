// telegram-link.test.mjs — run: node --test engine/comms/telegram-link.test.mjs
//
// Linking Telegram used to be `connect-telegram`, an interactive shell script you
// could only reach from a terminal inside the box. The member app could see the
// result ("ready to link" vs "linked") and offer no way to change it. This is the
// same three steps with no terminal, so the app can drive them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// execFile, NOT execFileSync: the fake Telegram below lives in THIS process, and a
// sync spawn blocks this event loop, so the server could never answer the pebble
// and both sides waited forever.
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, writeFileSync, statSync, chmodSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const SCRIPT = path.join(import.meta.dirname, 'telegram-link.mjs');
// The terminal connect path (engine/connect-telegram.sh), exercised below so the
// shell gate is proven with real behaviour, not just `bash -n`'s syntax check.
const SHELL_SCRIPT = path.join(import.meta.dirname, '..', 'connect-telegram.sh');
const ENGINE_DIR = path.join(import.meta.dirname, '..');
const GOOD = '123456789:AAFakeTokenForTestsOnly_not_a_real_one_x';
const NO_NET = 'http://127.0.0.1:1';   // forget and check-revoked never call Telegram

// A fake Telegram. `updates` is swapped per test to drive the chat-id wait.
function fakeTelegram(state) {
  const srv = createServer((req, res) => {
    const [, token, method] = req.url.split('?')[0].split('/');
    res.setHeader('content-type', 'application/json');
    if (token !== `bot${GOOD}`) return res.end(JSON.stringify({ ok: false, description: 'Unauthorized' }));
    if (method === 'getMe') return res.end(JSON.stringify({ ok: true, result: { username: 'marlow_bot' } }));
    if (method === 'getUpdates') return res.end(JSON.stringify({ ok: true, result: state.updates || [] }));
    if (method === 'sendMessage') { state.sent = true; return res.end(JSON.stringify({ ok: true })); }
    res.end(JSON.stringify({ ok: false }));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({
    srv, base: `http://127.0.0.1:${srv.address().port}`,
    // keep-alive sockets from fetch keep close() pending forever otherwise
    stop: () => { srv.closeAllConnections(); srv.close(); },
  })));
}

function box() {
  const d = tmpDir('tglink-');
  mkdirSync(path.join(d, 'secrets'), { recursive: true });
  const marker = path.join(d, 'comms-started');
  const sc = path.join(d, 'fake-start-comms.sh');
  writeFileSync(sc, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  chmodSync(sc, 0o755);
  return { dir: d, marker, startComms: sc };
}

async function raw(b, base, args, stdin) {
  const pebble = execFile('node', [SCRIPT, b.dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TELEGRAM_API_BASE: base, AIOS_START_COMMS: b.startComms },
  });
  const done = new Promise((res, rej) => {
    let o = '', e = '';
    pebble.stdout.on('data', (d) => { o += d; });
    pebble.stderr.on('data', (d) => { e += d; });
    pebble.on('error', rej);
    pebble.on('close', (code) => (code === 0 ? res(o) : rej(new Error(`exit ${code}: ${e}`))));
  });
  pebble.stdin.end(stdin ?? '');
  return done;
}
const run = async (b, base, args, stdin) => JSON.parse(await raw(b, base, args, stdin));

// Drives engine/connect-telegram.sh itself (STATE_DIR -> the temp box, ENGINE ->
// this repo's real engine/ so it finds telegram-link.mjs instead of the box
// image's hardcoded /app/engine, TELEGRAM_API_BASE -> fakeTelegram or NO_NET so
// no test ever reaches the real network). Unlike raw() above, a non-zero exit
// is an expected outcome here (a refusal), never a broken harness, so this
// resolves on close instead of rejecting.
function rawShell(b, apiBase, stdin) {
  const child = execFile('bash', [SHELL_SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, STATE_DIR: b.dir, ENGINE: ENGINE_DIR, TELEGRAM_API_BASE: apiBase },
  });
  const done = new Promise((res) => {
    let o = '', e = '';
    child.stdout.on('data', (d) => { o += d; });
    child.stderr.on('data', (d) => { e += d; });
    child.on('close', (code) => res({ code, stdout: o, stderr: e }));
  });
  child.stdin.end(stdin ?? '');
  return done;
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const sec = (b, n) => path.join(b.dir, 'secrets', n);

test('verify accepts a real token, stores it 0600, and never echoes it', async () => {
  const { base, stop } = await fakeTelegram({});
  try {
    const b = box();
    const text = await raw(b, base, ['verify'], b64(GOOD));
    const r = JSON.parse(text);
    assert.equal(r.ok, true);
    assert.equal(r.username, 'marlow_bot');
    assert.equal(readFileSync(sec(b, 'telegram_bot_token'), 'utf8'), GOOD);
    assert.equal(statSync(sec(b, 'telegram_bot_token')).mode & 0o777, 0o600, 'token must not be world-readable');
    // the whole point of a secret: it must not come back out through the app
    assert.ok(!text.includes(GOOD), 'the token leaked into the verb output');
  } finally { stop(); }
});

test('verify rejects a bad token and stores NOTHING', async () => {
  const { base, stop } = await fakeTelegram({});
  try {
    const b = box();
    // well-SHAPED but not a token this bot owns, so only Telegram can reject it
    const r = await run(b, base, ['verify'], b64('987654321:BBWrongTokenWellShapedButRejected_xyz'));
    assert.equal(r.ok, false);
    assert.match(r.error, /didn't work|Unauthorized/i);
    assert.ok(!existsSync(sec(b, 'telegram_bot_token')), 'a rejected token must not be written');
  } finally { stop(); }
});

test('verify refuses junk before it ever calls Telegram', async () => {
  const b = box();
  const r = await run(b, 'http://127.0.0.1:1', ['verify'], b64('hello i am not a token'));
  assert.equal(r.ok, false);
  assert.match(r.error, /doesn't look like/i);
  assert.ok(!existsSync(sec(b, 'telegram_bot_token')));
});

test('link waits: no message yet means not linked, and nothing is written', async () => {
  const st = { updates: [] };
  const { base, stop } = await fakeTelegram(st);
  try {
    const b = box();
    await run(b, base, ['verify'], b64(GOOD));
    const r = await run(b, base, ['link']);
    assert.equal(r.ok, true);
    assert.equal(r.linked, false);
    assert.ok(!existsSync(sec(b, 'telegram_chat_id')));
    assert.ok(!existsSync(b.marker), 'comms must not start before a chat is linked');
  } finally { stop(); }
});

test('link captures the chat id, starts comms, and confirms in the chat', async () => {
  const st = { updates: [] };
  const { base, stop } = await fakeTelegram(st);
  try {
    const b = box();
    await run(b, base, ['verify'], b64(GOOD));
    // First poll mints the challenge and links nothing: the member has to prove
    // they are the one holding the screen (2026-08-20 audit).
    const first = await run(b, base, ['link']);
    assert.equal(first.linked, false);
    assert.match(String(first.code), /^\d{6}$/, 'the panel is given a code to show');
    st.updates = [{ update_id: 1, message: { chat: { id: 987, type: 'private' }, text: first.code } }];
    const r = await run(b, base, ['link']);
    assert.equal(r.linked, true);
    assert.equal(r.chat_id, '987');
    assert.equal(readFileSync(sec(b, 'telegram_chat_id'), 'utf8'), '987');
    assert.equal(statSync(sec(b, 'telegram_chat_id')).mode & 0o777, 0o600);
    assert.ok(existsSync(b.marker), 'the bridge must come up without a box restart');
    assert.equal(st.sent, true, 'the member should see a confirmation in Telegram itself');
  } finally { stop(); }
});

// 2026-08-20 audit. Bot usernames are searchable and getUpdates replays a day of
// backlog, so "the first chat we see" handed the box to whoever messaged it
// first. The bound chat is the whole isolation boundary in telegram.mjs, and
// policy.json auto-sends briefs built from the member's brain to it.
test('a stranger who messaged the bot first cannot take the box', async () => {
  const st = { updates: [] };
  const { base, stop } = await fakeTelegram(st);
  try {
    const b = box();
    await run(b, base, ['verify'], b64(GOOD));
    const first = await run(b, base, ['link']);
    // the stranger got there first, and is chatting away
    st.updates = [
      { update_id: 1, message: { chat: { id: 666, type: 'private' }, text: 'hi' } },
      { update_id: 2, message: { chat: { id: 666, type: 'private' }, text: 'hello?' } },
    ];
    assert.equal((await run(b, base, ['link'])).linked, false, 'no code, no link');
    assert.equal(existsSync(sec(b, 'telegram_chat_id')), false, 'nothing is bound');

    // a group the bot was added to is never "you", even quoting the code
    st.updates = [{ update_id: 3, message: { chat: { id: -1009876, type: 'supergroup' }, text: first.code } }];
    assert.equal((await run(b, base, ['link'])).linked, false, 'a group chat cannot be the owner');
    assert.equal(existsSync(sec(b, 'telegram_chat_id')), false);

    // the member answers the challenge and wins, though the stranger is earlier in the list
    st.updates = [
      { update_id: 4, message: { chat: { id: 666, type: 'private' }, text: 'me me me' } },
      { update_id: 5, message: { chat: { id: 777, type: 'private' }, text: ' ' + first.code + ' ' } },
    ];
    const r = await run(b, base, ['link']);
    assert.equal(r.linked, true);
    assert.equal(r.chat_id, '777', 'the chat that answered the challenge, not the earliest one');
  } finally { stop(); }
});

test('status reports the three states the app has to render', async () => {
  const st = { updates: [] };
  const { base, stop } = await fakeTelegram(st);
  try {
    const b = box();
    assert.deepEqual(await run(b, base, ['status']), { ok: true, token: false, chat: false, username: null });
    await run(b, base, ['verify'], b64(GOOD));
    assert.deepEqual(await run(b, base, ['status']), { ok: true, token: true, chat: false, username: 'marlow_bot' });
    const pending = await run(b, base, ['link']);          // mints the challenge
    st.updates = [{ update_id: 1, message: { chat: { id: 55, type: 'private' }, text: pending.code } }];
    await run(b, base, ['link']);
    assert.deepEqual(await run(b, base, ['status']), { ok: true, token: true, chat: true, username: 'marlow_bot' });
  } finally { stop(); }
});

test('a placeholder token reads as NOT connected, matching the dashboard probe', async () => {
  const b = box();
  writeFileSync(sec(b, 'telegram_bot_token'), 'PASTE-your-token-here');
  const r = await run(b, 'http://127.0.0.1:1', ['status']);
  assert.equal(r.token, false, 'a placeholder is not a credential');
});

test('forget unlinks completely, so a member can move to a different bot', async () => {
  const st = { updates: [{ update_id: 1, message: { chat: { id: 7 } } }] };
  const { base, stop } = await fakeTelegram(st);
  try {
    const b = box();
    await run(b, base, ['verify'], b64(GOOD));
    await run(b, base, ['link']);
    const r = await run(b, base, ['forget']);
    assert.equal(r.ok, true);
    assert.ok(!existsSync(sec(b, 'telegram_bot_token')));
    assert.ok(!existsSync(sec(b, 'telegram_chat_id')));
    assert.deepEqual(await run(b, base, ['status']), { ok: true, token: false, chat: false, username: null });
  } finally { stop(); }
});

test('forget kills the running bridge, then removes the pidfile', async () => {
  const b = box();
  writeFileSync(sec(b, 'telegram_bot_token'), GOOD, { mode: 0o600 });
  writeFileSync(sec(b, 'telegram_chat_id'), '4242', { mode: 0o600 });
  mkdirSync(path.join(b.dir, '.kernel'), { recursive: true });
  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  victim.unref();
  writeFileSync(path.join(b.dir, '.kernel', 'telegram.pid'), String(victim.pid));

  const res = await run(b, NO_NET, ['forget']);

  assert.equal(res.ok, true);
  assert.equal(existsSync(path.join(b.dir, '.kernel', 'telegram.pid')), false, 'pidfile removed');
  assert.throws(() => process.kill(victim.pid, 0), 'the bridge process is gone');
  assert.equal(existsSync(sec(b, 'telegram_bot_token')), false);
});

test('forget refuses to report success when the bridge will not die', async () => {
  const b = box();
  writeFileSync(sec(b, 'telegram_bot_token'), GOOD, { mode: 0o600 });
  mkdirSync(path.join(b.dir, '.kernel'), { recursive: true });
  // pid 1 is alive and unkillable from here, so it stands in for a survivor.
  writeFileSync(path.join(b.dir, '.kernel', 'telegram.pid'), '1');

  const res = await run(b, NO_NET, ['forget']);

  assert.equal(res.ok, false);
  assert.match(res.error, /still connected/i);
  assert.ok(existsSync(sec(b, 'telegram_bot_token')),
    'credentials are left in place when the bridge survives, so state stays honest');
});

test('forget records a salted hash of the dead token and clears the offset', async () => {
  const b = box();
  writeFileSync(sec(b, 'telegram_bot_token'), GOOD, { mode: 0o600 });
  writeFileSync(sec(b, 'telegram_chat_id'), '4242', { mode: 0o600 });
  mkdirSync(path.join(b.dir, '.kernel'), { recursive: true });
  writeFileSync(path.join(b.dir, '.kernel', 'telegram-offset'), '99999');

  const res = await run(b, NO_NET, ['forget']);
  assert.equal(res.ok, true);

  const revoked = readFileSync(sec(b, 'telegram_revoked'), 'utf8').trim();
  assert.equal(revoked.split('\n').length, 1, 'one hash recorded');
  assert.match(revoked, /^[0-9a-f]{64}$/, 'a sha256 hex digest');
  assert.ok(!revoked.includes(GOOD), 'the token itself is never stored');
  assert.equal(statSync(sec(b, 'telegram_revoked')).mode & 0o777, 0o600);
  assert.equal(readFileSync(path.join(b.dir, '.kernel', 'telegram-offset'), 'utf8'), '',
    'queued updates cannot replay into a later session');
});

test('check-revoked flags a token that forget has already retired', async () => {
  const b = box();
  writeFileSync(sec(b, 'telegram_bot_token'), GOOD, { mode: 0o600 });
  await run(b, NO_NET, ['forget']);

  const hit = await run(b, NO_NET, ['check-revoked'], b64(GOOD));
  assert.equal(hit.revoked, true);
  assert.match(hit.error, /@BotFather/);

  const clean = await run(b, NO_NET, ['check-revoked'], b64('987654321:BBSomeOtherTokenValueForTests_xx'));
  assert.equal(clean.revoked, false);
  assert.equal(clean.ok, true);
});

test('verify refuses a revoked token and writes nothing', async () => {
  const b = box();
  const { base, stop } = await fakeTelegram({});
  writeFileSync(sec(b, 'telegram_bot_token'), GOOD, { mode: 0o600 });
  await run(b, NO_NET, ['forget']);

  const res = await run(b, base, ['verify'], b64(GOOD));
  stop();

  assert.equal(res.ok, false);
  assert.match(res.error, /revoked/i);
  assert.equal(existsSync(sec(b, 'telegram_bot_token')), false,
    'a refused token never reaches disk');
});

test('revoke stays silent: it must never message the bound chat', async () => {
  const b = box();
  const state = {};
  const { base, stop } = await fakeTelegram(state);
  writeFileSync(sec(b, 'telegram_bot_token'), GOOD, { mode: 0o600 });
  writeFileSync(sec(b, 'telegram_chat_id'), '4242', { mode: 0o600 });

  await run(b, base, ['forget']);
  stop();

  // link sends a greeting; revoke deliberately does not. During a compromise the
  // attacker is reading that chat, and a disconnect notice tells them what just
  // happened. Pinned because the asymmetry looks like an oversight to a future
  // reader and is not.
  assert.notEqual(state.sent, true, 'no sendMessage on revoke');
});

test('forget on an unconnected box is a clean no-op', async () => {
  const b = box();
  const res = await run(b, NO_NET, ['forget']);
  assert.equal(res.ok, true);
  assert.equal(existsSync(sec(b, 'telegram_revoked')), false,
    'nothing to revoke means nothing recorded');
});

// --- engine/connect-telegram.sh: the terminal path's own revoked-token gate ---
// `bash -n` proves the script parses; it proves nothing about behaviour. These
// three drive the real script (via rawShell above) to cover the fail-closed
// rule end to end on the path member boxes actually use from a terminal.

test('connect-telegram.sh refuses a revoked token, and it never reaches disk', async () => {
  const b = box();
  writeFileSync(sec(b, 'telegram_bot_token'), GOOD, { mode: 0o600 });
  await run(b, NO_NET, ['forget']);   // records the hash; revoked list is non-empty

  const res = await rawShell(b, NO_NET, `${GOOD}\n`);

  assert.equal(res.code, 1);
  assert.match(res.stdout, /revoked on this mineral/);
  assert.equal(existsSync(sec(b, 'telegram_bot_token')), false,
    'a refused token must not be written');
});

test('connect-telegram.sh lets a clean token past the gate when something else was revoked', async () => {
  const b = box();
  const { base, stop } = await fakeTelegram({});
  writeFileSync(sec(b, 'telegram_bot_token'), GOOD, { mode: 0o600 });
  await run(b, NO_NET, ['forget']);   // revoked list is non-empty, but for GOOD only

  const CLEAN = '987654321:BBSomeOtherTokenValueForTests_xx';
  const res = await rawShell(b, base, `${CLEAN}\n`);
  stop();

  // fakeTelegram rejects any token that isn't GOOD, so this still exits non-zero
  // past the gate: the point is it fails at the network step, not the gate.
  assert.doesNotMatch(res.stdout, /revoked on this mineral/);
  assert.doesNotMatch(res.stdout, /Could not confirm whether this token was revoked/);
});

test('connect-telegram.sh skips the gate entirely when nothing has ever been revoked', async () => {
  const b = box();
  const { base, stop } = await fakeTelegram({});
  assert.equal(existsSync(sec(b, 'telegram_revoked')), false, 'sanity: nothing revoked yet');

  const CLEAN = '987654321:BBSomeOtherTokenValueForTests_xx';
  const res = await rawShell(b, base, `${CLEAN}\n`);
  stop();

  assert.doesNotMatch(res.stdout, /revoked on this mineral/);
  assert.doesNotMatch(res.stdout, /Could not confirm whether this token was revoked/);
});

// --- engine/start-comms.sh: boot reconciliation for a hand-restored token ---
// There is no restore code path to hook (box-restore-runbook.md is a manual
// openssl-decrypt-and-untar), so box-up.sh:224 calling this on every boot is the
// one gate a hand-restored, previously-revoked credential has to pass.

test('start-comms deletes a revoked token at boot and starts nothing', async () => {
  const b = box();
  writeFileSync(sec(b, 'telegram_bot_token'), GOOD, { mode: 0o600 });
  await run(b, NO_NET, ['forget']);                        // records the hash
  // a hand restore puts the dead credentials back
  writeFileSync(sec(b, 'telegram_bot_token'), GOOD, { mode: 0o600 });
  writeFileSync(sec(b, 'telegram_chat_id'), '4242', { mode: 0o600 });

  await new Promise((r) => execFile('bash',
    [path.join(import.meta.dirname, '..', 'start-comms.sh'), b.dir], () => r()));

  assert.equal(existsSync(sec(b, 'telegram_bot_token')), false,
    'the resurrected token is removed');
  assert.equal(existsSync(sec(b, 'telegram_chat_id')), false);
  assert.equal(existsSync(path.join(b.dir, '.kernel', 'telegram.pid')), false,
    'and no bridge was launched');
});

test('start-comms leaves credentials alone and starts nothing when the check cannot run', async () => {
  const b = box();
  writeFileSync(sec(b, 'telegram_bot_token'), GOOD, { mode: 0o600 });
  await run(b, NO_NET, ['forget']);                        // makes the revoked list non-empty
  // a hand restore puts the dead credentials back, same as the deletion test above
  writeFileSync(sec(b, 'telegram_bot_token'), GOOD, { mode: 0o600 });
  writeFileSync(sec(b, 'telegram_chat_id'), '4242', { mode: 0o600 });

  // The check has to actually FAIL, and the old version of this test achieved
  // that by trimming PATH to /usr/bin:/bin and assuming node was on neither. On
  // an image that ships /usr/bin/node the check would have run perfectly well,
  // returned revoked:true, and this test would have gone green while proving the
  // opposite of what it claims. So node is shadowed with a stub that runs, says
  // nothing and exits non-zero, which is the indeterminate case exactly: not
  // "clean", not "revoked", just unknown. The stub touches a marker so the test
  // can prove it was the node the script found.
  const stubDir = path.join(b.dir, 'stub-bin');
  mkdirSync(stubDir, { recursive: true });
  const stubRan = path.join(b.dir, 'stub-node-ran');
  writeFileSync(path.join(stubDir, 'node'), `#!/bin/sh\ntouch ${JSON.stringify(stubRan)}\nexit 1\n`);
  chmodSync(path.join(stubDir, 'node'), 0o755);

  await new Promise((r) => execFile('bash',
    [path.join(import.meta.dirname, '..', 'start-comms.sh'), b.dir],
    { env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` } },
    () => r()));

  assert.ok(existsSync(stubRan), 'sanity: the stub really is the node the script ran');
  assert.equal(existsSync(sec(b, 'telegram_bot_token')), true,
    'a working credential is not deleted on a transient check failure');
  assert.equal(existsSync(sec(b, 'telegram_chat_id')), true);
  assert.equal(existsSync(path.join(b.dir, '.kernel', 'kernel.pid')), false,
    'and nothing that depends on the credential was started either');
  assert.equal(existsSync(path.join(b.dir, '.kernel', 'telegram.pid')), false);
});

// --- the revoke has to take the PENDING WORK with it, not just the credentials ---

// Helper: a box with a populated .kernel, so a purge can be shown to remove what
// carries a chat id and to leave everything else alone.
function kernelWithWork(b) {
  const k = (...p) => path.join(b.dir, '.kernel', ...p);
  for (const d of ['queue', 'outbox', 'voice-outbox', 'gh']) mkdirSync(k(d), { recursive: true });
  const job = (name, rec) => writeFileSync(k('queue', name), JSON.stringify(rec));
  // enqueued by the compromised chat itself
  job('1__a.json', { id: 'a', skill: 'message', source: 'telegram', reply_to: 666 });
  // an inline Approve the attacker tapped: no reply_to, but it is their work
  job('2__b.json', { id: 'b', skill: 'execute-proposal', source: 'telegram-approve' });
  // a cadence job the scheduler stamped with the bound chat id (scheduler.mjs:591)
  job('3__c.json', { id: 'c', skill: 'brief', source: 'cron', reply_to: '4242' });
  // ordinary housekeeping: no reply target, nobody's chat
  job('4__d.json', { id: 'd', skill: 'backup', source: 'cron' });
  // a voice turn: its reply goes to voice-outbox, never to Telegram
  job('5__e.json', { id: 'e', skill: 'message', source: 'voice', reply_to: 'voice' });
  writeFileSync(k('outbox', 'r1.json'), JSON.stringify({ chat_id: 666, text: 'drafted from their mail', job: 'a' }));
  writeFileSync(k('outbox', 'custody-1.json'), JSON.stringify({ chat_id: '4242', text: 'custody note', job: 'custody-watch' }));
  writeFileSync(k('voice-outbox', 'v1.json'), JSON.stringify({ chat_id: 'voice', text: 'spoken reply' }));
  writeFileSync(k('gh', 'hosts.yml'), 'github.com:\n');
  writeFileSync(k('crontab'), '# cadence\n');
  writeFileSync(k('kernel.log'), 'started\n');
  return k;
}

test('forget removes the queued and outbox work that carries a chat id', async () => {
  const b = box();
  writeFileSync(sec(b, 'telegram_bot_token'), GOOD, { mode: 0o600 });
  writeFileSync(sec(b, 'telegram_chat_id'), '4242', { mode: 0o600 });
  const k = kernelWithWork(b);

  const res = await run(b, NO_NET, ['forget']);
  assert.equal(res.ok, true);

  // The whole point: nothing addressed to a chat survives a revoke. Left behind,
  // these drain into outbox records still holding the old chat id, and the NEXT
  // bot the member links flushes the member's own drafted content to it.
  assert.equal(existsSync(k('queue', '1__a.json')), false, 'the job the compromised chat enqueued');
  assert.equal(existsSync(k('queue', '2__b.json')), false, 'the Approve it tapped');
  assert.equal(existsSync(k('queue', '3__c.json')), false, 'the cadence job stamped with that chat id');
  assert.equal(existsSync(k('outbox', 'r1.json')), false, 'the reply waiting to be sent to it');
  assert.equal(existsSync(k('outbox', 'custody-1.json')), false, 'and every other outbox record: they are all Telegram-bound');
});

test('forget leaves the rest of .kernel alone, including the voice lane', async () => {
  const b = box();
  writeFileSync(sec(b, 'telegram_bot_token'), GOOD, { mode: 0o600 });
  writeFileSync(sec(b, 'telegram_chat_id'), '4242', { mode: 0o600 });
  const k = kernelWithWork(b);

  assert.equal((await run(b, NO_NET, ['forget'])).ok, true);

  assert.equal(existsSync(k('queue', '4__d.json')), true, 'housekeeping with no reply target is not Telegram work');
  assert.equal(existsSync(k('queue', '5__e.json')), true, 'a voice turn is a different channel and must survive');
  assert.equal(existsSync(k('voice-outbox', 'v1.json')), true, 'so must its reply');
  assert.equal(existsSync(k('gh', 'hosts.yml')), true, 'GitHub auth is unrelated state');
  assert.equal(existsSync(k('crontab')), true);
  assert.equal(existsSync(k('kernel.log')), true);
});

// --- ordering: the record is written BEFORE the kill, not after ---

test('the revoked token is already recorded by the time the bridge is signalled', async () => {
  const b = box();
  writeFileSync(sec(b, 'telegram_bot_token'), GOOD, { mode: 0o600 });
  writeFileSync(sec(b, 'telegram_chat_id'), '4242', { mode: 0o600 });
  mkdirSync(path.join(b.dir, '.kernel'), { recursive: true });

  // The supervisor cannot be stopped by forget (scheduler.mjs:848 runs on a
  // 2-minute interval and its pid is a shell variable in box-up.sh, not a
  // pidfile), and the kill window below is seconds wide. What decides whether a
  // tick inside that window relaunches the bridge on the LIVE token is whether
  // secrets/telegram_revoked exists yet. So this stands in for the supervisor:
  // the bridge reports, at SIGTERM time, what the boot gate would have seen.
  const evidence = path.join(b.dir, 'seen-at-sigterm');
  const victim = spawn(process.execPath, ['-e', `
    const fs = require('fs');
    process.on('SIGTERM', () => {
      fs.writeFileSync(${JSON.stringify(evidence)}, String(fs.existsSync(${JSON.stringify(sec(b, 'telegram_revoked'))})));
      process.exit(0);
    });
    setInterval(() => {}, 1e9);
  `], { stdio: 'ignore' });
  victim.unref();
  writeFileSync(path.join(b.dir, '.kernel', 'telegram.pid'), String(victim.pid));

  assert.equal((await run(b, NO_NET, ['forget'])).ok, true);
  for (let i = 0; i < 40 && !existsSync(evidence); i++) await new Promise((r) => setTimeout(r, 50));

  assert.equal(readFileSync(evidence, 'utf8'), 'true',
    'a supervisor tick inside the kill window must find a non-empty revoked list, or it relaunches the bridge on the live token');
});

test('a forget that cannot kill the bridge still records the revocation, so the next boot finishes it', async () => {
  const b = box();
  writeFileSync(sec(b, 'telegram_bot_token'), GOOD, { mode: 0o600 });
  writeFileSync(sec(b, 'telegram_chat_id'), '4242', { mode: 0o600 });
  mkdirSync(path.join(b.dir, '.kernel'), { recursive: true });
  writeFileSync(path.join(b.dir, '.kernel', 'telegram.pid'), '1');   // alive and unkillable from here

  const res = await run(b, NO_NET, ['forget']);
  assert.equal(res.ok, false, 'the member is told the truth about the live bridge');
  assert.match(readFileSync(sec(b, 'telegram_revoked'), 'utf8').trim(), /^[0-9a-f]{64}$/,
    'but the hash is on disk, so the restart we ask for reconciles instead of resurrecting');

  // Prove it end to end: that is exactly what the boot gate does with it.
  await new Promise((r) => execFile('bash',
    [path.join(import.meta.dirname, '..', 'start-comms.sh'), b.dir], () => r()));
  assert.equal(existsSync(sec(b, 'telegram_bot_token')), false, 'boot removes the credential');
  assert.equal(existsSync(sec(b, 'telegram_chat_id')), false);
});

// --- link is a connect path too, and it reads the token off disk ---

test('link refuses a revoked token that is still sitting on disk', async () => {
  const st = { updates: [] };
  const { base, stop } = await fakeTelegram(st);
  try {
    const b = box();
    writeFileSync(sec(b, 'telegram_bot_token'), GOOD, { mode: 0o600 });
    await run(b, NO_NET, ['forget']);                          // records the hash, clears the file
    // A hand restore on the same box, or a boot whose reconciliation came back
    // indeterminate and deliberately left the credential in place.
    writeFileSync(sec(b, 'telegram_bot_token'), GOOD, { mode: 0o600 });
    st.updates = [{ update_id: 1, message: { chat: { id: 987, type: 'private' }, text: '123456' } }];

    const r = await run(b, base, ['link']);

    assert.equal(r.ok, false);
    assert.match(r.error, /revoked on this mineral/, 'the same words the other two connect paths use');
    assert.equal(existsSync(sec(b, 'telegram_chat_id')), false, 'no chat is bound');
    assert.notEqual(st.sent, true, 'and no greeting went out on a dead bot');
    assert.equal(existsSync(b.marker), false, 'nothing was started');
  } finally { stop(); }
});

// --- engine/comms/telegram.mjs: the outbound half of the isolation boundary ---
// Lives in this file so it runs with the rest of the revoke story: the bridge is
// what turns a leftover chat id into a delivered message.

function fakeTelegramBridge(state) {
  const srv = createServer((req, res) => {
    const [, , method] = req.url.split('?')[0].split('/');
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (method === 'sendMessage') {
        try { state.sent.push(JSON.parse(raw)); } catch { state.sent.push({ unparsable: raw }); }
        return res.end(JSON.stringify({ ok: true }));
      }
      // A short delay stands in for the long poll, so the bridge loop does not spin.
      if (method === 'getUpdates') return setTimeout(() => res.end(JSON.stringify({ ok: true, result: [] })), 250);
      res.end(JSON.stringify({ ok: true, result: [] }));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({
    base: `http://127.0.0.1:${srv.address().port}`,
    stop: () => { srv.closeAllConnections(); srv.close(); },
  })));
}

test('the bridge drops an outbox record addressed to any chat but the bound one', async () => {
  const state = { sent: [] };
  const { base, stop } = await fakeTelegramBridge(state);
  const b = box();
  writeFileSync(sec(b, 'telegram_bot_token'), GOOD, { mode: 0o600 });
  writeFileSync(sec(b, 'telegram_chat_id'), '4242', { mode: 0o600 });
  const outbox = path.join(b.dir, '.kernel', 'outbox');
  mkdirSync(outbox, { recursive: true });
  // forget sweeps what exists at revoke time, but the cron scheduler read the
  // chat id at ITS startup and keeps stamping records with it, so a record for a
  // cut-off chat can appear after the sweep. It must never be delivered.
  writeFileSync(path.join(outbox, 'foreign.json'), JSON.stringify({ chat_id: 666, text: 'draft built from their mail', job: 'x' }));
  writeFileSync(path.join(outbox, 'mine.json'), JSON.stringify({ chat_id: '4242', text: 'a real reply', job: 'y' }));

  const bridge = spawn(process.execPath, [path.join(import.meta.dirname, 'telegram.mjs'), b.dir], {
    stdio: 'ignore', env: { ...process.env, TELEGRAM_API_BASE: base },
  });
  try {
    for (let i = 0; i < 100 && readdirSync(outbox).length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(readdirSync(outbox), [], 'both records are dealt with, so neither is retried forever');
    assert.equal(state.sent.length, 1, 'exactly one message left the box');
    assert.equal(String(state.sent[0].chat_id), '4242', 'the bound chat, never the one in the stale record');
    assert.ok(!JSON.stringify(state.sent).includes('their mail'), 'the foreign draft was never sent');
  } finally { bridge.kill('SIGKILL'); stop(); }
});
