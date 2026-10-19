// telegram-drafts.test.mjs — run: node --test engine/comms/telegram-drafts.test.mjs
//
// Pins trap 70: Telegram showed Approve / Deny on drafted replies, Approve queued an
// 'execute-proposal' job the runner only stubbed, and the member was told
// "Approved, queued." while nothing was ever sent. The bridge now shows a draft as a
// draft (no buttons), an old button left in a chat queues nothing and says so, and
// a stale execute-proposal job stops in the runner instead of reaching the generic
// skill branch (which has shell + MCP).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { outboundBody, DRAFT_FOOTER, STALE_BUTTON_REPLY, CONNECTED_GREETING } from './telegram-drafts.mjs';
import { runSkill, EXECUTE_PROPOSAL_RETIRED } from '../kernel/lib/runner.mjs';
import { kpaths } from '../kernel/lib/queue.mjs';

const BRIDGE = path.join(import.meta.dirname, 'telegram.mjs');
const TOKEN = '123456789:AAFakeTokenForTestsOnly_not_a_real_one_x';

test('a drafted reply goes out as a draft: no buttons, no marker line, the member sends it', () => {
  const b = outboundBody({ chat_id: 4242, job: 'j1', text: 'Hi Jo,\n\nThursday works.\nPROPOSE-SEND: reply to Jo about Thursday' });
  assert.equal(b.reply_markup, undefined, 'no Approve / Deny: there is nothing behind them');
  assert.doesNotMatch(b.text, /PROPOSE-SEND/);
  assert.equal(b.text, `Hi Jo,\n\nThursday works.\n\n${DRAFT_FOOTER}`);
  assert.equal(b.chat_id, 4242);
});

test('a reply with no draft in it is passed through untouched', () => {
  assert.deepEqual(outboundBody({ chat_id: 1, text: 'Your brief is on the Today page.' }), { chat_id: 1, text: 'Your brief is on the Today page.' });
  assert.deepEqual(outboundBody({ chat_id: 1 }), { chat_id: 1, text: '(no reply)' });
});

test('every promise the bridge makes says the member sends, never that approving sends', () => {
  for (const s of [DRAFT_FOOTER, STALE_BUTTON_REPLY, CONNECTED_GREETING]) assert.doesNotMatch(s, /approv|queued/i, s);
  const sh = readFileSync(path.join(import.meta.dirname, '..', 'connect-telegram.sh'), 'utf8');
  assert.doesNotMatch(sh, /approve/i, 'the terminal connect path makes the same promise');
  const voice = readFileSync(path.join(import.meta.dirname, '..', 'voice', 'voice.html'), 'utf8');
  assert.doesNotMatch(voice, /approve in Telegram/i);
});

test('a stale execute-proposal job stops in the runner, live or dry, and sends nothing', async () => {
  const state = tmpDir('tgdraft-run-');
  for (const dryRun of [true, false]) {
    const r = await runSkill(state, { id: 'x', skill: 'execute-proposal', args: { ref: 'j1' }, source: 'telegram-approve' }, { dryRun });
    assert.deepEqual(r, { ok: true, output: EXECUTE_PROPOSAL_RETIRED }, `dryRun=${dryRun}`);
  }
});

// The bridge end to end, against a fake Telegram: one Approve tap left over from an
// older version, one Deny, one foreign chat's tap, and one drafted reply waiting in
// the outbox.
test('the bridge queues nothing on an old Approve tap, answers it honestly, and sends drafts without buttons', async (t) => {
  const state = tmpDir('tgdraft-bridge-');
  mkdirSync(path.join(state, 'secrets'), { recursive: true });
  writeFileSync(path.join(state, 'secrets', 'telegram_bot_token'), TOKEN);
  writeFileSync(path.join(state, 'secrets', 'telegram_chat_id'), '4242');
  const p = kpaths(state);
  mkdirSync(path.join(p.base, 'outbox'), { recursive: true });
  writeFileSync(path.join(p.base, 'outbox', 'r1.json'), JSON.stringify({ chat_id: '4242', job: 'j1', text: 'Draft body\nPROPOSE-SEND: email Jo' }));

  const calls = [];
  let served = false;
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ method, body });
      res.setHeader('content-type', 'application/json');
      if (method === 'getUpdates') {
        const result = served ? [] : [
          { update_id: 1, callback_query: { id: 'cq1', data: 'approve:j0', message: { chat: { id: 4242 } } } },
          { update_id: 2, callback_query: { id: 'cq2', data: 'deny:j0', message: { chat: { id: 4242 } } } },
          { update_id: 3, callback_query: { id: 'cq3', data: 'approve:j9', message: { chat: { id: 666 } } } },
        ];
        served = true;
        return res.end(JSON.stringify({ ok: true, result }));
      }
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());

  const child = spawn(process.execPath, [BRIDGE, state], {
    env: { ...process.env, TELEGRAM_API_BASE: `http://127.0.0.1:${srv.address().port}` },
    stdio: 'ignore',
  });
  t.after(() => child.kill('SIGKILL'));

  const sends = () => calls.filter((c) => c.method === 'sendMessage');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (calls.filter((c) => c.method === 'answerCallbackQuery').length === 3 && sends().some((c) => /Draft body/.test(c.body.text))) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  const queued = existsSync(p.queue) ? readdirSync(p.queue).filter((f) => f.endsWith('.json')) : [];
  assert.deepEqual(queued, [], 'an Approve tap queues nothing');
  assert.equal(calls.filter((c) => c.method === 'answerCallbackQuery').length, 3, 'every tap is acknowledged so the spinner stops');

  const replies = sends().filter((c) => c.body.text === STALE_BUTTON_REPLY);
  assert.equal(replies.length, 2, 'the bound chat hears the honest line for Approve and Deny');
  assert.ok(replies.every((c) => String(c.body.chat_id) === '4242'), 'a foreign chat is never answered');
  assert.ok(!sends().some((c) => /queued|Approved/.test(c.body.text || '')), 'nothing claims an approval was queued');

  const draft = sends().find((c) => /Draft body/.test(c.body.text));
  assert.ok(draft, 'the drafted reply was sent');
  assert.equal(draft.body.reply_markup, undefined, 'with no buttons');
  assert.equal(draft.body.text, `Draft body\n\n${DRAFT_FOOTER}`);
});
