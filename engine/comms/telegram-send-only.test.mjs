// telegram-send-only.test.mjs: Crads-AI can send on Telegram while the person's
// own program still answers the bot, and never reads the bot to do it.
// Run: node --test engine/comms/telegram-send-only.test.mjs
//
// Adopt rehearsal T4 (2026-10-18), finding 6. While .kernel/telegram-reader says
// `host` (spec 2026-10-17 § Telegram), start-comms.sh started no Telegram process
// at all, and replies and delivered job results reach Telegram only through
// telegram.mjs's outbox flush, so nothing was ever sent, while the app said
// sending works in that state. Now telegram.mjs --send-only drains the outbox and
// never calls getUpdates (two programs reading one bot steal each other's
// messages). Every test here talks to a fake Telegram on 127.0.0.1 and asserts
// on its request log; nothing reaches api.telegram.org.
//
// The rehearsal's other half: a hand-queued `--reply-to` job wrote no outbox
// file. That was move-in mode (the kernel drains only hand jobs from the app
// then, and writes no reply for them), which is right: during a move-in nothing
// may send. Pinned below both ways, plus the scheduler's own deliver path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const ENGINE = path.join(import.meta.dirname, '..');
const BRIDGE = path.join(import.meta.dirname, 'telegram.mjs');
const KERNEL = path.join(ENGINE, 'kernel', 'kernel.mjs');
const ENQUEUE = path.join(ENGINE, 'kernel', 'enqueue.mjs');
const GOOD = '123456789:AAFakeTokenForTestsOnly_not_a_real_one_x';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake Telegram that records every method called on it, in order.
function fakeTelegram() {
  const calls = [];
  const sent = [];
  const srv = createServer((req, res) => {
    const [, , method] = req.url.split('?')[0].split('/');
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      calls.push(method);
      res.setHeader('content-type', 'application/json');
      if (method === 'sendMessage') { try { sent.push(JSON.parse(raw)); } catch { sent.push({ raw }); } }
      if (method === 'getUpdates') return setTimeout(() => res.end(JSON.stringify({ ok: true, result: [] })), 200);
      res.end(JSON.stringify({ ok: true, result: [] }));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({
    calls, sent, base: `http://127.0.0.1:${srv.address().port}`,
    stop: () => { srv.closeAllConnections(); srv.close(); },
  })));
}

function brain({ host = true, ownership = { adopted: true } } = {}) {
  const d = tmpDir('tgsend-');
  mkdirSync(path.join(d, 'secrets'), { recursive: true });
  writeFileSync(path.join(d, 'secrets', 'telegram_bot_token'), GOOD);
  writeFileSync(path.join(d, 'secrets', 'telegram_chat_id'), '4242');
  writeFileSync(path.join(d, 'ownership.json'), JSON.stringify(ownership, null, 2) + '\n');
  writeFileSync(path.join(d, 'profile.yaml'), 'identity:\n  user_short: "Pat"\n');
  mkdirSync(path.join(d, '.kernel', 'outbox'), { recursive: true });
  if (host) writeFileSync(path.join(d, '.kernel', 'telegram-reader'), 'host\n');
  return d;
}
const outbox = (d) => path.join(d, '.kernel', 'outbox');
const queueReply = (d, name, rec) => writeFileSync(path.join(outbox(d), name), JSON.stringify(rec));
const listOutbox = (d) => { try { return readdirSync(outbox(d)).filter((f) => f.endsWith('.json')); } catch { return []; } };

function sender(d, base) {
  const p = spawn(process.execPath, [BRIDGE, d, '--send-only'], {
    stdio: 'ignore', env: { ...process.env, TELEGRAM_API_BASE: base, TELEGRAM_SEND_POLL_MS: '100' },
  });
  const exited = new Promise((r) => p.on('exit', (code) => r(code)));
  return { p, exited };
}
const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => 'timeout')]);

test('send-only: queued replies are sent to the bound chat, and the bot is never read', async () => {
  const tg = await fakeTelegram();
  const d = brain();
  queueReply(d, 'a.json', { chat_id: '4242', text: 'your morning brief', job: 'a' });
  queueReply(d, 'b.json', { chat_id: 666, text: 'not for this chat', job: 'b' });
  const s = sender(d, tg.base);
  try {
    for (let i = 0; i < 100 && listOutbox(d).length; i++) await sleep(50);
    assert.deepEqual(listOutbox(d), [], 'both records dealt with');
    // and a few more loops, so a getUpdates on any later pass would show
    queueReply(d, 'c.json', { chat_id: '4242', text: 'a later result', job: 'c' });
    for (let i = 0; i < 100 && listOutbox(d).length; i++) await sleep(50);
    await sleep(400);
    assert.deepEqual(tg.sent.map((m) => [String(m.chat_id), m.text]), [['4242', 'your morning brief'], ['4242', 'a later result']]);
    assert.ok(!tg.calls.includes('getUpdates'), `the bot was read: ${tg.calls.join(',')}`);
    assert.deepEqual([...new Set(tg.calls)], ['sendMessage'], 'sendMessage is the only call it makes');
  } finally { s.p.kill('SIGKILL'); tg.stop(); }
});

test('send-only: stops by itself once Crads-AI answers the bot, and in move-in mode, sending nothing', async () => {
  const tg = await fakeTelegram();
  try {
    // the cutover removes the marker: the sender gets out of the reader's way
    const d = brain();
    const s = sender(d, tg.base);
    await sleep(300);
    execFileSync('rm', [path.join(d, '.kernel', 'telegram-reader')]);
    assert.equal(await within(s.exited, 5000), 0, 'exits on its own');

    // Move out sets moving_in again: nothing may send, so it stops before flushing
    const m = brain({ ownership: { adopted: true, moving_in: true, moving_out: true } });
    queueReply(m, 'x.json', { chat_id: '4242', text: 'must not go', job: 'x' });
    const s2 = sender(m, tg.base);
    assert.equal(await within(s2.exited, 5000), 0, 'exits on its own');
    assert.deepEqual(listOutbox(m), ['x.json'], 'the record is left, not sent');
    assert.equal(tg.calls.length, 0, `nothing reached Telegram: ${tg.calls.join(',')}`);
  } finally { tg.stop(); }
});

test('send-only: a disconnect (token file removed) stops it', async () => {
  const tg = await fakeTelegram();
  const d = brain();
  const s = sender(d, tg.base);
  try {
    await sleep(300);
    execFileSync('rm', [path.join(d, 'secrets', 'telegram_bot_token')]);
    assert.equal(await within(s.exited, 5000), 0);
  } finally { s.p.kill('SIGKILL'); tg.stop(); }
});

// ---- the kernel side: who writes the outbox file the sender drains ----

test('kernel: outside move-in mode a delivered job writes its result to the outbox; in move-in mode nothing is written', () => {
  // moved in, the host still answers the bot: the result is queued for the sender
  const d = brain();
  execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: d });
  execFileSync('node', [ENQUEUE, d, 'daily', '--source=cron', '--reply-to=4242']);
  execFileSync('node', [KERNEL, d, '--once', '--dry-run']);
  const files = listOutbox(d);
  assert.equal(files.length, 1, 'one reply queued');
  const rec = JSON.parse(readFileSync(path.join(outbox(d), files[0]), 'utf8'));
  assert.equal(String(rec.chat_id), '4242');
  assert.match(rec.text, /daily/);

  // moving in: a scheduled delivered job stays queued, and a hand job (the only
  // kind that runs then) writes no reply, so the outbox stays empty
  const m = brain({ ownership: { adopted: true, moving_in: true } });
  execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: m });
  execFileSync('node', [ENQUEUE, m, 'daily', '--source=cron', '--reply-to=4242']);
  execFileSync('node', [ENQUEUE, m, 'daily', '--source=dashboard', '--reply-to=4242']);
  const bin = tmpDir('tgsend-claude-');
  writeFileSync(path.join(bin, 'claude'), '#!/usr/bin/env bash\necho "the run is done"\n', { mode: 0o755 });
  execFileSync('node', [KERNEL, m, '--once'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.deepEqual(listOutbox(m), [], 'nothing queued to send during a move-in');
  assert.equal(readdirSync(path.join(m, '.kernel', 'done')).filter((f) => f.endsWith('.json')).length, 1, 'the hand job did run');
});

test('scheduler: a deliver:true job reaches the outbox with the chat id, and the sender delivers it', async () => {
  const d = brain();
  execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: d });
  mkdirSync(path.join(d, 'cockpit'), { recursive: true });
  // no nightly restart in a test, whatever minute it runs in
  writeFileSync(path.join(d, 'cockpit', 'auto-update.json'), '{"enabled": false}\n');
  // the first tick fires a job scheduled for this minute; keep clear of the boundary
  if (new Date().getUTCSeconds() >= 50) await sleep((61 - new Date().getUTCSeconds()) * 1000);
  const now = new Date();
  const hhmm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  writeFileSync(path.join(d, 'cockpit', 'cadence.json'), JSON.stringify({ version: 2, migrated_profile_cadence: true, jobs: {
    daily: { enabled: true, deliver: true, schedule: { kind: 'times', days: [], times: [hhmm] } },
  } }, null, 2));
  const sched = spawn('node', [path.join(ENGINE, 'cron', 'scheduler.mjs'), d], { stdio: 'ignore', env: { ...process.env, DRY_RUN: '1', HOME: d } });
  const tg = await fakeTelegram();
  let s;
  try {
    for (let i = 0; i < 100 && !listOutbox(d).length; i++) await sleep(100);
    const files = listOutbox(d);
    assert.equal(files.length, 1, 'the scheduler enqueued with --reply-to and the kernel queued the reply');
    const rec = JSON.parse(readFileSync(path.join(outbox(d), files[0]), 'utf8'));
    assert.equal(String(rec.chat_id), '4242');
    assert.match(rec.text, /daily/, 'and it is the daily job\'s result');
    s = sender(d, tg.base);
    for (let i = 0; i < 100 && listOutbox(d).length; i++) await sleep(50);
    assert.equal(tg.sent.length, 1, 'delivered');
    assert.ok(!tg.calls.includes('getUpdates'));
  } finally { sched.kill('SIGKILL'); s?.p.kill('SIGKILL'); tg.stop(); }
});

test('scheduler: reads the chat id when a job fires, not once at start', () => {
  // Telegram is usually connected after the scheduler is up; a value read at start
  // left delivered jobs undelivered until the next restart.
  const src = readFileSync(path.join(ENGINE, 'cron', 'scheduler.mjs'), 'utf8');
  const fire = src.slice(src.indexOf('function fire(job)'), src.indexOf('\n}\n', src.indexOf('function fire(job)')));
  assert.match(fire, /readChatId\(\)/, 'fire() reads it');
  assert.doesNotMatch(src, /^const chatId\s*=/m, 'no module-level copy');
});
