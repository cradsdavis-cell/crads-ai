#!/usr/bin/env node
// slack-dm.mjs: the owner's DM with their assistant in Slack, a second chat
// channel beside Telegram (telegram.mjs), with the same contract.
//
// Socket Mode (engine/lib/slack-api.mjs): the box dials out, so there are no
// open ports. Each message the OWNER writes in their DM with the bot is
// enqueued as a 'message' job, exactly like a Telegram message, with reply_to
// `slack:<DM channel id>`; the kernel writes the reply into .kernel/outbox with
// that chat_id, and this bridge posts it back with chat.postMessage. The agent
// has NO send tools (the runner restricts 'message'), so a reply that would go
// to anyone else arrives as a "PROPOSE-SEND:" draft, and it is shown to the
// owner to send themselves, in the same words as Telegram (telegram-drafts.mjs).
//
//   node slack-dm.mjs <state-dir>
//
// Needs three files in <state>/secrets/, and does not run without all three
// (delivery-target.mjs readSlackSecrets): slack_app_token (xapp-, scope
// connections:write), slack_bot_token (xoxb-) and slack_owner_user (the owner's
// Slack user id, U...). start-comms.sh starts it only when they exist.
//
// DEFAULT-DENY, both ways (the spirit of decideRoute in inbound-router.mjs):
//   in:  only `message` events in a DM (channel_type im), from the owner's user
//        id, with no bot_id and no subtype. That last part matters: other
//        programs post into the same DM as the bot (the owner's own
//        notifications), and edits, joins and file shares carry a subtype.
//        Everything else is acked and dropped.
//   out: only outbox records whose chat_id starts `slack:` (the Telegram bridge
//        leaves exactly those alone), and of those only the ones addressed to
//        the owner: their user id (what scheduled deliveries carry, see
//        delivery-target.mjs) or the DM channel learned from their own
//        messages. A record for any other Slack id is dropped, not retried, as
//        Telegram drops a record for a foreign chat.
//
// Robustness, as Telegram's: a refused token backs off 5 s doubling to 10 min
// (telegram-poll.mjs tokenBackoff, trap 71) and the secrets are re-read every
// pass, so a corrected token works without a restart; removed secrets stop the
// bridge; a closed socket reconnects; move-in mode (isMovingIn) stops it before
// anything is sent; and slack.com is reached IPv4-first (trap 78).
import '../lib/net-reach.mjs';   // FIRST: IPv4-first + 2 s connect attempts (trap 78), slack.com is as far from Sydney as Telegram
import { readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { enqueue, kpaths, ensureDirs } from '../kernel/lib/queue.mjs';
import { outboundBody } from './telegram-drafts.mjs';
import { tokenBackoff, humanDelay } from './telegram-poll.mjs';
import { isMovingIn } from '../lib/mineral-identity.mjs';
import { isMain } from '../lib/is-main.mjs';
import { slackCall, slackEscape, chunks, socketSession, isSlackTokenRefused } from '../lib/slack-api.mjs';
import { readSlackSecrets, isSlackTarget, slackTargetId, SLACK_PREFIX } from '../lib/delivery-target.mjs';

// ---- inbound: which envelopes become a turn ------------------------------------

// Slack sends the owner's text with its own markup: links as <url|label>, people
// as <@U..>, channels as <#C..|name>, and &, <, > escaped. The model gets what
// the owner typed, as Telegram would hand it over.
export function plainFromSlack(text) {
  return String(text || '')
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_, url, label) => (label === url.replace(/^mailto:/, '') ? label : `${label} (${url})`))
    .replace(/<((?:https?|mailto):[^>]+)>/g, (_, url) => url.replace(/^mailto:/, ''))
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, '@$1')
    .replace(/<@([A-Z0-9]+)(\|[^>]*)?>/g, '@$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// One Socket Mode envelope -> { text, channel, id } for a turn, { ignore } for
// something seen and refused (the reason is for the log), or null when it is
// not a message at all. Pure, for tests.
export function inboundFrom(envelope, { owner }) {
  if (!envelope || envelope.type !== 'events_api') return null;
  const p = envelope.payload || {};
  const e = p.event || {};
  if (e.type !== 'message') return null;
  if (e.channel_type !== 'im' || !/^D[A-Z0-9]+$/.test(String(e.channel || ''))) return { ignore: 'not-a-dm' };
  // The bot's own posts, anything another program posts as the bot, edits,
  // deletions, joins and file shares: none of them is the owner talking.
  if (e.bot_id || e.app_id || e.subtype || e.hidden) return { ignore: 'not-a-person' };
  // Slack Connect: a person from another workspace is never the owner.
  if (p.is_ext_shared_channel || (e.user_team && p.team_id && e.user_team !== p.team_id)) return { ignore: 'other-workspace' };
  if (!owner || e.user !== owner) return { ignore: 'not-owner', user: e.user };
  const text = plainFromSlack(e.text).trim();
  if (!text) return { ignore: 'empty' };
  return { text, channel: e.channel, id: p.event_id || `${e.channel}:${e.ts}` };
}

// ---- outbound: the reply as Slack mrkdwn ---------------------------------------

// The model writes Markdown (and now and then Telegram-style HTML). Slack's
// mrkdwn is close but not the same: bold is *one* star, there are no headings,
// a [label](url) link is not one, and &, <, > must be escaped or they become
// pings and disguised links. Code is escaped but otherwise left as written.
// Links come out as `label (url)`, never as <url|label>: a label must not hide
// where a link goes, and Slack links the bare url by itself.
export function toMrkdwn(text) {
  const s = String(text ?? '')
    .replace(/<\s*(b|strong)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, '**$2**')
    .replace(/<\s*(i|em)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, '_$2_')
    .replace(/<\s*(s|del|strike)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, '~~$2~~')
    .replace(/<\s*pre\s*>([\s\S]*?)<\s*\/\s*pre\s*>/gi, '```\n$1\n```')
    .replace(/<\s*code\s*>([^<]*?)<\s*\/\s*code\s*>/gi, '`$1`')
    .replace(/<\s*a\s+href\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\s*\/\s*a\s*>/gi, '[$2]($1)')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n');
  return s.split(/(```[\s\S]*?```|`[^`\n]+`)/).map((part, i) => {
    if (i % 2) return slackEscape(part).replace(/^```[\w+-]*\n/, '```\n');   // code: escaped, language tag dropped
    return slackEscape(part)
      .replace(/^(\s*)[*+]\s+/gm, '$1• ')                        // "* item" would read as bold
      .replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, '*$1*')             // headings
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/__(.+?)__/g, '*$1*')
      .replace(/~~(.+?)~~/g, '~$1~')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => (label === url ? url : `${label} (${url})`));
  }).join('');
}

// The messages one outbox record becomes. Drafts get Telegram's treatment (the
// PROPOSE-SEND line removed, "copy it and send it yourself" added), then mrkdwn,
// then split to Slack's comfortable length.
export const slackMessages = (rec) => chunks(toMrkdwn(outboundBody(rec).text));

// ---- the bridge ----------------------------------------------------------------

const SEEN_MAX = 500;

export function createBridge(stateDir, {
  fetcher = fetch, WS = globalThis.WebSocket,
  log = (...m) => console.log(`[slack ${new Date().toISOString()}]`, ...m),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs = Number(process.env.SLACK_SEND_POLL_MS || 2000),
} = {}) {
  const p = kpaths(stateDir);
  const outbox = path.join(p.base, 'outbox');
  const dmFile = path.join(p.base, 'slack-dm-channel');
  let secrets = readSlackSecrets(stateDir);
  let ownerDm = null;
  let stopReason = null;
  const seen = new Set();
  const sentParts = new Map();     // outbox file -> parts already posted, so a retry never repeats them
  const lastError = new Map();     // outbox file -> last error logged, so a stuck record logs once
  let pending = Promise.resolve(); // enqueues in arrival order

  const stop = (why) => { if (!stopReason) { stopReason = why; log(why); } };

  // Re-read the secrets. Missing or incomplete means Slack was disconnected: stop.
  function reload() {
    const fresh = readSlackSecrets(stateDir);
    if (!fresh) { stop('the Slack secrets are gone or incomplete; Slack was disconnected, so the bridge stops.'); return false; }
    if (secrets && (fresh.app !== secrets.app || fresh.bot !== secrets.bot)) log('picked up new Slack tokens.');
    if (secrets && fresh.owner !== secrets.owner) { log('the owner changed; forgetting the old DM.'); ownerDm = null; }
    secrets = fresh;
    return true;
  }

  // The learned DM is stored as `<owner user id> <DM channel id>`, and only read
  // back for the same owner: the DM is an allowed outbound target, so a DM
  // learned for a previous owner must never carry over to a new one.
  async function loadDm() {
    try {
      const [who, d] = (await readFile(dmFile, 'utf8')).trim().split(/\s+/);
      if (who === secrets.owner && /^D[A-Z0-9]+$/.test(d || '')) ownerDm = d;
    } catch { /* learned on the first message */ }
  }
  async function learnDm(channel) {
    if (!/^D[A-Z0-9]+$/.test(String(channel || '')) || channel === ownerDm) return;
    ownerDm = channel;
    await writeFile(dmFile, `${secrets.owner} ${channel}\n`).catch(() => {});
  }

  function onEnvelope(env) {
    if (stopReason) return;
    const m = inboundFrom(env, { owner: secrets?.owner });
    if (!m) return;
    if (m.ignore) {
      // Bot posts are routine in this DM (the owner's notifications); only a
      // person who is not the owner is worth a line.
      if (m.ignore === 'not-owner' || m.ignore === 'other-workspace') log(`drop message from ${m.user || 'another workspace'} (not the owner)`);
      return;
    }
    if (seen.has(m.id)) return;   // Slack redelivers an envelope it thinks was missed
    seen.add(m.id);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
    pending = pending.then(async () => {
      await learnDm(m.channel);
      await enqueue(stateDir, { skill: 'message', args: { text: m.text }, reply_to: `${SLACK_PREFIX}${m.channel}`, source: 'slack' });
      log(`in <- ${m.channel}: ${m.text.slice(0, 60)}`);
    }).catch((e) => log('enqueue:', String(e).slice(0, 150)));
  }

  // Send what is ours in the outbox. Returns { refused } when Slack refused the
  // bot token, so the caller backs off instead of retrying at once.
  async function flushOutbox() {
    let files;
    try { files = (await readdir(outbox)).filter((f) => f.endsWith('.json')).sort(); } catch { return {}; }
    for (const f of files) {
      if (stopReason) return {};
      const file = path.join(outbox, f);
      let rec;
      // The kernel writes these in place, so one can be read half-written:
      // leave it for the next pass rather than drop it.
      try { rec = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
      if (!isSlackTarget(rec.chat_id)) continue;   // Telegram's (or a voice-era leftover): never ours to touch
      const target = slackTargetId(rec.chat_id);
      if (target !== secrets.owner && target !== ownerDm) {
        log(`drop outbound for ${target} (not the owner's DM)`);
        await rm(file).catch(() => {});
        continue;
      }
      // The owner's user id posts into their DM with the bot; once that DM is
      // known, post to it directly.
      const channel = target === secrets.owner ? (ownerDm || secrets.owner) : target;
      const parts = slackMessages(rec);
      let done = sentParts.get(f) || 0;
      let failed = null;
      for (; done < parts.length; done += 1) {
        const r = await slackCall('chat.postMessage', secrets.bot, { channel, text: parts[done], unfurl_links: false, unfurl_media: false }, { fetcher })
          .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        if (!r.ok) { failed = r; break; }
        if (target === secrets.owner && String(r.channel || '').startsWith('D')) await learnDm(r.channel);
      }
      if (!failed) { sentParts.delete(f); lastError.delete(f); await rm(file).catch(() => {}); continue; }
      sentParts.set(f, done);
      if (isSlackTokenRefused(failed)) return { refused: true, error: failed.error };
      if (lastError.get(f) !== failed.error) { lastError.set(f, failed.error); log(`chat.postMessage: ${failed.error}; kept for the next try.`); }
      if (failed.error === 'ratelimited') return {};   // stop this pass; Slack asked for a pause
    }
    return {};
  }

  async function outboundLoop({ once = false } = {}) {
    const backoff = tokenBackoff();
    while (!stopReason) {
      try {
        if (isMovingIn(stateDir)) { stop('move-in mode: nothing is sent; the Slack bridge stops.'); break; }
        if (!reload()) break;
        const r = await flushOutbox();
        if (r.refused) {
          const waitMs = backoff.next();
          log(`chat.postMessage: Slack refused the bot token (${r.error}). Retrying in ${humanDelay(waitMs)}; a corrected token is picked up without a restart.`);
          if (once) return;
          await sleep(waitMs);
          continue;
        }
        const n = backoff.reset();
        if (n) log(`chat.postMessage: the bot token works again after ${n} refused ${n === 1 ? 'attempt' : 'attempts'}.`);
      } catch (e) { log('send loop:', String(e).slice(0, 150)); }
      if (once) return;
      await sleep(pollMs);
    }
  }

  async function inboundLoop({ once = false } = {}) {
    const backoff = tokenBackoff();
    let wait = 1000;
    while (!stopReason) {
      try {
        if (isMovingIn(stateDir)) { stop('move-in mode: nothing is read or sent; the Slack bridge stops.'); break; }
        if (!reload()) break;
        const open = await slackCall('apps.connections.open', secrets.app, {}, { fetcher }).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        if (!open.ok) {
          if (isSlackTokenRefused(open)) {
            const waitMs = backoff.next();
            log(`apps.connections.open: Slack refused the app-level token (${open.error}). Retrying in ${humanDelay(waitMs)}; a corrected token is picked up without a restart.`);
            if (once) return;
            await sleep(waitMs);
            continue;
          }
          log(`apps.connections.open: ${open.error}. Retrying in ${humanDelay(wait)}.`);
          if (once) return;
          await sleep(wait); wait = Math.min(wait * 2, 60_000);
          continue;
        }
        const n = backoff.reset();
        if (n) log(`apps.connections.open: the app-level token works again after ${n} refused ${n === 1 ? 'attempt' : 'attempts'}.`);
        const end = await socketSession({ url: open.url, WS, onEnvelope, onHello: () => { wait = 1000; log('connected'); } });
        await pending;
        if (once) return;
        if (!stopReason) log(`socket ended (${end.disconnect || (end.error ? end.error : 'closed')}); reconnecting in ${humanDelay(wait)}.`);
      } catch (e) { log('read loop:', String(e).slice(0, 150)); }
      if (once) return;
      await sleep(wait); wait = Math.min(wait * 2, 60_000);
    }
  }

  // once: one socket session, then one outbox pass (tests). Otherwise both loops
  // run until either stops the bridge; the reason is returned.
  async function run({ once = false } = {}) {
    if (!secrets) return 'Slack is not configured on this box.';
    await ensureDirs(stateDir);
    await mkdir(outbox, { recursive: true });
    await loadDm();
    log(`slack DM bridge up for ${stateDir}`);
    if (once) { await inboundLoop({ once }); await outboundLoop({ once }); return stopReason; }
    await Promise.race([inboundLoop(), outboundLoop()]);
    return stopReason;
  }

  return { run, onEnvelope, flushOutbox, inboundLoop, outboundLoop, reload, get ownerDm() { return ownerDm; }, get stopped() { return stopReason; }, settle: () => pending };
}

if (isMain(import.meta.url)) {
  const stateDir = path.resolve(process.argv[2] || process.env.STATE_DIR || '.');
  if (!readSlackSecrets(stateDir)) {
    console.error(`Slack is not configured: ${stateDir}/secrets/ needs slack_app_token (xapp-), slack_bot_token (xoxb-) and slack_owner_user (U...).`);
    process.exit(1);
  }
  createBridge(stateDir).run().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
