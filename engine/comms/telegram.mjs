#!/usr/bin/env node
// telegram.mjs — the secondary channel (decisions D11 secondary, D4 default-deny).
//
// Long-polls Telegram, enqueues each inbound message as a 'message' job (carrying
// the chat id as reply_to), and sends the kernel's replies back from the outbox.
// The agent itself has NO send tools (runner restricts the 'message' job), so it
// can only DRAFT outbound — drafts flagged "PROPOSE-SEND:" are sent with inline
// Approve/Deny buttons. Run alongside the kernel daemon.
//
//   node telegram.mjs <state-dir>
// Needs <state>/secrets/telegram_bot_token (one line). No open ports (long-poll).
import { readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { enqueue, kpaths, ensureDirs } from '../kernel/lib/queue.mjs';
import { decideRoute } from './inbound-router.mjs';   // shared inbound-isolation guard (§3.P6.X.live)

const stateDir = path.resolve(process.argv[2] || process.env.STATE_DIR || '.');
// this box's OWN client chat — the bot is private to them; foreign chats are dropped (default-deny).
const allowedChatId = await readFile(path.join(stateDir, 'secrets', 'telegram_chat_id'), 'utf8').then((s) => s.trim()).catch(() => null);
const p = kpaths(stateDir);
const offsetFile = path.join(p.base, 'telegram-offset');
const outbox = path.join(p.base, 'outbox');
const log = (...m) => console.log(`[tg ${new Date().toISOString()}]`, ...m);

let token;
try {
  token = (await readFile(path.join(stateDir, 'secrets', 'telegram_bot_token'), 'utf8')).trim();
} catch {
  console.error(`No bot token at ${stateDir}/secrets/telegram_bot_token. Add it (from @BotFather), then restart.`);
  process.exit(1);
}
// Overridable so a test can point the bridge at a fake Telegram instead of the
// real network, matching engine/comms/telegram-link.mjs and connect-telegram.sh.
const API = `${(process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '')}/bot${token}`;

async function api(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}
const getOffset = async () => { try { return parseInt(await readFile(offsetFile, 'utf8'), 10) || 0; } catch { return 0; } };
const setOffset = (o) => writeFile(offsetFile, String(o));

async function pollUpdates() {
  const res = await api('getUpdates', { offset: await getOffset(), timeout: 25, allowed_updates: ['message', 'callback_query'] });
  if (!res.ok) { log('getUpdates:', res.description); return; }
  for (const u of res.result) {
    await setOffset(u.update_id + 1);
    if (u.message?.text) {
      const chat = u.message.chat.id;
      // §3.P6.X.live default-deny: this bot is private to its client; ignore any other chat.
      if (allowedChatId && decideRoute(allowedChatId, chat) === 'reject-foreign') { log(`drop foreign chat ${chat} (not ${allowedChatId})`); continue; }
      await enqueue(stateDir, { skill: 'message', args: { text: u.message.text }, reply_to: chat, source: 'telegram' });
      log(`in <- ${chat}: ${u.message.text.slice(0, 60)}`);
    } else if (u.callback_query) {
      const cq = u.callback_query;
      const [action, ref] = (cq.data || '').split(':');
      const chat = cq.message.chat.id;
      if (action === 'approve') {
        await enqueue(stateDir, { skill: 'execute-proposal', args: { ref }, source: 'telegram-approve' });
        await api('sendMessage', { chat_id: chat, text: '✅ Approved, queued.' });
      } else {
        await api('sendMessage', { chat_id: chat, text: '❌ Dropped.' });
      }
      await api('answerCallbackQuery', { callback_query_id: cq.id });
    }
  }
}

async function flushOutbox() {
  let files;
  try { files = (await readdir(outbox)).filter((f) => f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    const rec = JSON.parse(await readFile(path.join(outbox, f), 'utf8'));
    // DEFAULT-DENY OUTBOUND TOO, not just inbound. This used to send wherever the
    // record said, and a record is only ever as fresh as the chat it was written
    // for. A revoked chat leaves work behind (telegram-link's forget sweeps what
    // exists at that moment, but the cron scheduler read the chat id at ITS
    // startup and keeps stamping records with it), so a member who revokes and
    // relinks with a new bot could have their own drafted content flushed to the
    // chat they just cut off. The bound chat is the isolation boundary in both
    // directions: a record for any other chat is dropped, not retried.
    if (allowedChatId && decideRoute(allowedChatId, rec.chat_id) === 'reject-foreign') {
      log(`drop outbound for foreign chat ${rec.chat_id} (not ${allowedChatId})`);
      await rm(path.join(outbox, f)).catch(() => {});
      continue;
    }
    const body = { chat_id: rec.chat_id, text: rec.text || '(no reply)' };
    if (/(^|\n)PROPOSE-SEND:/.test(rec.text || '')) {
      body.reply_markup = { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${rec.job}` },
        { text: '❌ Deny', callback_data: `deny:${rec.job}` },
      ]] };
    }
    const r = await api('sendMessage', body);
    if (r.ok) await rm(path.join(outbox, f)).catch(() => {});
    else log('sendMessage:', r.description);
  }
}

async function main() {
  await ensureDirs(stateDir);
  await mkdir(outbox, { recursive: true });
  log(`telegram adapter up for ${stateDir}`);
  for (;;) {
    try { await pollUpdates(); await flushOutbox(); }
    catch (e) { log('loop:', String(e).slice(0, 150)); await new Promise((r) => setTimeout(r, 3000)); }
  }
}
main();
