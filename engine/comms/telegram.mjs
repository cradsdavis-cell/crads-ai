#!/usr/bin/env node
// telegram.mjs — the secondary channel (decisions D11 secondary, D4 default-deny).
//
// Long-polls Telegram, enqueues each inbound message as a 'message' job (carrying
// the chat id as reply_to), and sends the kernel's replies back from the outbox.
// The agent itself has NO send tools (runner restricts the 'message' job), so it
// can only DRAFT outbound. Drafts flagged "PROPOSE-SEND:" go to the member as a
// draft for them to send themselves, with no buttons (telegram-drafts.mjs says
// why). Run alongside the kernel daemon.
//
//   node telegram.mjs <state-dir> [--send-only]
// Needs <state>/secrets/telegram_bot_token (one line). No open ports (long-poll).
//
// --send-only (adopt spec 2026-10-17 § Telegram, rehearsal T4 finding 6): while
// .kernel/telegram-reader says `host`, the person's own program on the server
// still answers the bot, and only one program may read a bot's updates. But
// replies and delivered job results reach Telegram ONLY through this file's
// outbox flush, so with the reader held back nothing was sent at all.
// start-comms.sh starts this mode in that state: it drains the outbox and sends,
// and it NEVER calls getUpdates (nor answers a button), so nothing here reads the
// bot. It exits by itself once the marker no longer says host (the full reader
// takes over on the next supervisor pass) or the brain goes into move-in mode
// (Move out, where nothing may send).
import { readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { enqueue, kpaths, ensureDirs } from '../kernel/lib/queue.mjs';
import { decideRoute } from './inbound-router.mjs';   // shared inbound-isolation guard (§3.P6.X.live)
import { outboundBody, STALE_BUTTON_REPLY } from './telegram-drafts.mjs';
import { makeApi, pollTurn, tokenBackoff, isTokenRefused, humanDelay } from './telegram-poll.mjs';
import { isMovingIn } from '../lib/mineral-identity.mjs';

const args = process.argv.slice(2);
const stateDir = path.resolve(args.find((a) => !a.startsWith('--')) || process.env.STATE_DIR || '.');
const sendOnly = args.includes('--send-only');
const tokenFile = path.join(stateDir, 'secrets', 'telegram_bot_token');
const chatIdFile = path.join(stateDir, 'secrets', 'telegram_chat_id');
const readChatId = () => readFile(chatIdFile, 'utf8').then((s) => s.trim() || null).catch(() => null);
// this box's OWN client chat: the bot is private to them, and foreign chats are dropped (default-deny).
let allowedChatId = await readChatId();
const p = kpaths(stateDir);
const offsetFile = path.join(p.base, 'telegram-offset');
const outbox = path.join(p.base, 'outbox');
const log = (...m) => console.log(`[tg ${new Date().toISOString()}]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token;
try {
  token = (await readFile(tokenFile, 'utf8')).trim();
} catch {
  console.error(`No bot token at ${stateDir}/secrets/telegram_bot_token. Add it (from @BotFather), then restart.`);
  process.exit(1);
}
// The base is overridable so a test can point the bridge at a fake Telegram
// instead of the real network, matching engine/comms/telegram-link.mjs and
// connect-telegram.sh. The token is read per call because it can change while
// the bridge runs (see reloadSecrets).
const api = makeApi({ base: process.env.TELEGRAM_API_BASE, getToken: () => token });

// After Telegram refuses the token, read the secrets again before the next try.
// start-comms.sh never relaunches a bridge that is still alive, so a member who
// pastes a corrected token is only heard if this process picks it up itself.
// The chat id comes along because relinking can change it; a missing chat file
// keeps the old id rather than dropping the default-deny filter. A missing token
// file means Telegram was disconnected, so the bridge stops.
async function reloadSecrets() {
  let fresh;
  try { fresh = (await readFile(tokenFile, 'utf8')).trim(); } catch {
    log('the bot token file is gone; Telegram was disconnected, so the bridge stops.');
    process.exit(0);
  }
  if (fresh && fresh !== token) { token = fresh; log('picked up a new bot token.'); }
  allowedChatId = (await readChatId()) ?? allowedChatId;
}

const getOffset = async () => { try { return parseInt(await readFile(offsetFile, 'utf8'), 10) || 0; } catch { return 0; } };
const setOffset = (o) => writeFile(offsetFile, String(o));

async function handleUpdates(updates) {
  for (const u of updates) {
    await setOffset(u.update_id + 1);
    if (u.message?.text) {
      const chat = u.message.chat.id;
      // §3.P6.X.live default-deny: this bot is private to its client; ignore any other chat.
      if (allowedChatId && decideRoute(allowedChatId, chat) === 'reject-foreign') { log(`drop foreign chat ${chat} (not ${allowedChatId})`); continue; }
      await enqueue(stateDir, { skill: 'message', args: { text: u.message.text }, reply_to: chat, source: 'telegram' });
      log(`in <- ${chat}: ${u.message.text.slice(0, 60)}`);
    } else if (u.callback_query) {
      // Only an Approve / Deny button left in the chat from an older version can
      // send one of these. Approve used to queue a job that never sent anything and
      // reply "Approved, queued." Now it queues nothing and says so.
      const cq = u.callback_query;
      const chat = cq.message?.chat?.id;
      const foreign = allowedChatId && decideRoute(allowedChatId, chat) === 'reject-foreign';
      if (chat !== undefined && !foreign) await api('sendMessage', { chat_id: chat, text: STALE_BUTTON_REPLY });
      await api('answerCallbackQuery', { callback_query_id: cq.id });
    }
  }
}

// Returns true when Telegram refused the token, so the send-only loop can back off.
async function flushOutbox() {
  let files;
  try { files = (await readdir(outbox)).filter((f) => f.endsWith('.json')); } catch { return false; }
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
    const r = await api('sendMessage', outboundBody(rec));
    if (r.ok) await rm(path.join(outbox, f)).catch(() => {});
    else { log('sendMessage:', r.description); if (isTokenRefused(r)) return true; }
  }
  return false;
}

// The person's own program still answers the bot (start-comms.sh reads the same marker).
const hostAnswers = () => readFile(path.join(p.base, 'telegram-reader'), 'utf8').then((s) => s.trim() === 'host', () => false);

async function mainSendOnly() {
  await ensureDirs(stateDir);
  await mkdir(outbox, { recursive: true });
  log(`telegram sender up for ${stateDir} (send only: your own program answers the bot, so nothing here reads it)`);
  const backoff = tokenBackoff();
  const pollMs = Number(process.env.TELEGRAM_SEND_POLL_MS || 2000);
  for (;;) {
    try {
      if (isMovingIn(stateDir)) { log('move-in mode: nothing is sent; the sender stops.'); process.exit(0); }
      if (!(await hostAnswers())) { log('Crads-AI answers the bot now; the sender stops so the reader can start.'); process.exit(0); }
      await reloadSecrets();   // a disconnect removes the token file: stop; a relink: use the new chat
      if (await flushOutbox()) {
        const waitMs = backoff.next();
        log(`sendMessage: Telegram refused the bot token. Retrying in ${humanDelay(waitMs)}.`);
        await sleep(waitMs);
        continue;
      }
      backoff.reset();
    } catch (e) { log('send loop:', String(e).slice(0, 150)); }
    await sleep(pollMs);
  }
}

async function main() {
  await ensureDirs(stateDir);
  await mkdir(outbox, { recursive: true });
  log(`telegram adapter up for ${stateDir}`);
  const backoff = tokenBackoff();
  for (;;) {
    try {
      const { waitMs, tokenRefused } = await pollTurn({ api, offset: await getOffset(), handleUpdates, flushOutbox, backoff, log });
      if (waitMs) await sleep(waitMs);
      if (tokenRefused) await reloadSecrets();
    } catch (e) { log('loop:', String(e).slice(0, 150)); await sleep(3000); }
  }
}
if (sendOnly) mainSendOnly(); else main();
