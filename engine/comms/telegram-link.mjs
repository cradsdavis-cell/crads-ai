#!/usr/bin/env node
// telegram-link.mjs — connect Telegram from the APP, with no terminal.
//
// `connect-telegram` (engine/connect-telegram.sh) already did this well, but it is
// an interactive shell script inside the box, so the member app could only ever
// report the outcome and never change it: the Telegram row said "ready to link"
// and its button flipped you to the Claude Code tab. This is the same three steps
// broken into non-interactive calls the panel can drive one at a time.
//
//   node telegram-link.mjs <state-dir> status      -> {ok, token, chat, username}
//   node telegram-link.mjs <state-dir> verify      -> reads base64 token on STDIN
//   node telegram-link.mjs <state-dir> link        -> one poll; returns the pairing code to show
//   node telegram-link.mjs <state-dir> forget      -> unlink, so they can swap bots
//
// WHY THE MEMBER MAKES THEIR OWN BOT. One shared Crads-AI bot would be a single
// tap instead of a minute with @BotFather, and it was tempting. It would also put
// every member's messages through our infrastructure, make us hold the token for
// every box, and turn one outage into everyone's outage. The box long-polls
// Telegram directly with its own token: no open ports, no relay, nothing of the
// member's passing through us. The minute is worth it.
//
// The token is read from STDIN as base64 and never appears in a command line, a
// log, or any response body: an argv token is visible in `ps` to anything else on
// the box, and a token in a response is a token in the browser.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const stateDir = path.resolve(process.argv[2] || '/state');
const cmd = process.argv[3] || 'status';
const API = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
const SEC = path.join(stateDir, 'secrets');
const TOKEN_F = path.join(SEC, 'telegram_bot_token');
const CHAT_F = path.join(SEC, 'telegram_chat_id');
const META_F = path.join(stateDir, 'cockpit', 'telegram.json');
const REVOKED_F = path.join(SEC, 'telegram_revoked');
const SALT_F = path.join(SEC, 'telegram_revoke_salt');
// Overridable so the tests can prove the bridge is started without launching a
// real kernel daemon; the default is the only path the box ever uses.
const START_COMMS = process.env.AIOS_START_COMMS || path.join(import.meta.dirname, '..', 'start-comms.sh');

const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(0); };
const rd = (p) => { try { return readFileSync(p, 'utf8').trim(); } catch { return ''; } };
// Same placeholder rule the dashboard probe uses, so the two surfaces cannot
// disagree about whether this box is connected.
const real = (t) => !!t && !/PASTE|REPLACE|TEST-/.test(t);
const writeSecret = (p, v) => {
  mkdirSync(SEC, { recursive: true });
  writeFileSync(p, v, { mode: 0o600 });
  chmodSync(p, 0o600);   // an existing file keeps its old mode through writeFileSync
};
const meta = () => { try { return JSON.parse(readFileSync(META_F, 'utf8')); } catch { return {}; } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stop the comms daemons this box started, mirroring the shutdown trap at
// engine/box-up.sh:299. Returns labels for anything that would not die.
//
// WHY. forget used to delete the credential files and stop there. But
// engine/comms/telegram.mjs reads the token (:27) and the chat id (:19) ONCE at
// startup and never re-reads them inside its long-poll loop (:93), so deleting
// the files under a running bridge changes nothing it can see. Disconnect
// reported success while the channel stayed open until the next box restart,
// which is the exact situation the button exists to end.
async function stopComms() {
  const survivors = [];
  for (const name of ['telegram', 'kernel']) {
    const pf = path.join(stateDir, '.kernel', `${name}.pid`);
    let pid = 0;
    try { pid = Number(readFileSync(pf, 'utf8').trim()); } catch { continue; }
    if (!Number.isInteger(pid) || pid <= 0) { rmSync(pf, { force: true }); continue; }
    const alive = () => {
      try { process.kill(pid, 0); return true; } catch (e) {
        // EPERM means process exists but we cannot signal it. ESRCH means no such process.
        return e.code === 'EPERM';
      }
    };
    if (!alive()) { rmSync(pf, { force: true }); continue; }
    try { process.kill(pid, 'SIGTERM'); } catch { /* raced us */ }
    for (let i = 0; i < 50 && alive(); i++) await sleep(100);      // up to 5s
    if (alive()) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* raced us */ }
      for (let i = 0; i < 20 && alive(); i++) await sleep(100);    // up to 2s more
    }
    if (alive()) survivors.push(`${name} (pid ${pid})`);
    else rmSync(pf, { force: true });
  }
  return survivors;
}

// Salted, so the revoked list is useless to anyone who reads it, and per box so
// two boxes cannot be correlated by a shared digest. The dead credential itself
// is never retained.
const salt = () => {
  let s = rd(SALT_F);
  if (!s) { s = randomBytes(32).toString('hex'); writeSecret(SALT_F, s); }
  return s;
};
const tokenHash = (t) => createHash('sha256').update(`${salt()}:${t}`).digest('hex');
const revokedList = () => rd(REVOKED_F).split('\n').map((l) => l.trim()).filter(Boolean);
const isRevoked = (t) => !!t && revokedList().includes(tokenHash(t));
const recordRevoked = (t) => {
  if (!real(t) || isRevoked(t)) return;
  writeSecret(REVOKED_F, [...revokedList(), tokenHash(t)].join('\n'));
};
// One string for every refusal, so the three connect surfaces (check-revoked for
// the shell path, verify, link) cannot tell the member three different stories
// about the same token.
const REVOKED_MSG = 'That token was revoked on this mineral. Run /revoke in @BotFather to get a new one, then paste that.';

// PENDING WORK CARRIES CHAT IDS, AND DELETING THE CREDENTIALS DOES NOT TOUCH IT.
//
// forget used to truncate .kernel/telegram-offset and stop there, which closes
// the inbound replay but not the outbound one. engine/comms/telegram.mjs:76
// builds its send from the OUTBOX RECORD (`chat_id: rec.chat_id`), not from the
// bound chat, and its foreign-chat guard at :53 only covers inbound. So: the
// attacker messages the compromised chat, the bridge enqueues jobs carrying
// reply_to = the attacker's chat, the member revokes, makes a fresh bot and
// relinks, the kernel drains the leftovers into outbox records still holding the
// old chat id, and the NEW bridge posts the member's drafted content, built from
// their own mail and calendar, straight to the attacker.
//
// Only what carries a chat id or a reply target is removed. .kernel also holds
// gh auth, the crontab, logs, pidfiles and the voice lane, none of which is
// Telegram's to delete.
const listDir = (d) => { try { return readdirSync(d); } catch { return []; } };
// Voice turns are the one reply lane that is not Telegram: serve-voice.mjs
// enqueues them with reply_to 'voice' and source 'voice', and kernel.mjs:47
// routes their replies to .kernel/voice-outbox for the voice bridge to collect.
// Cutting Telegram off must not eat somebody's voice turn.
const carriesChat = (job) => {
  if (!job || job.source === 'voice') return false;
  if (String(job.source || '').startsWith('telegram')) return true;   // enqueued BY the compromised chat
  return job.reply_to !== undefined && job.reply_to !== null && String(job.reply_to) !== '';
};
function purgeChatWork() {
  const base = path.join(stateDir, '.kernel');
  // .kernel/outbox is the Telegram outbox by construction: kernel.mjs:47 sends
  // voice replies elsewhere precisely because everything left here gets flushed
  // to a Telegram chat, and every writer of it (kernel.mjs:128, custody-watch,
  // google-rekey-ping) stamps a chat_id. All of it is addressed to the chat we
  // are cutting off, so all of it goes.
  const outbox = path.join(base, 'outbox');
  for (const f of listDir(outbox)) {
    if (f.endsWith('.json')) { try { rmSync(path.join(outbox, f), { force: true }); } catch { /* */ } }
  }
  // The queue is mixed (cron housekeeping, voice, dashboard), so it is filtered
  // rather than emptied. A file we cannot parse is left alone: we cannot show it
  // carries a chat id, and forget is not the place to prune the queue.
  const queue = path.join(base, 'queue');
  for (const f of listDir(queue)) {
    if (!f.endsWith('.json')) continue;
    const jf = path.join(queue, f);
    let job;
    try { job = JSON.parse(readFileSync(jf, 'utf8')); } catch { continue; }
    if (carriesChat(job)) { try { rmSync(jf, { force: true }); } catch { /* */ } }
  }
}

async function tg(token, method, body) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: body ? 'POST' : 'GET',
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

if (cmd === 'status') {
  out({ ok: true, token: real(rd(TOKEN_F)), chat: !!rd(CHAT_F), username: meta().username || null });
}

if (cmd === 'check-revoked') {
  const raw = readFileSync(0, 'utf8').trim();
  let token = '';
  try { token = Buffer.from(raw, 'base64').toString('utf8').trim(); } catch { /* treated as clean below */ }
  if (isRevoked(token)) {
    out({ ok: false, revoked: true, error: REVOKED_MSG });
  }
  out({ ok: true, revoked: false });
}

if (cmd === 'verify') {
  const raw = readFileSync(0, 'utf8').trim();
  let token = '';
  try { token = Buffer.from(raw, 'base64').toString('utf8').trim(); } catch { /* handled below */ }
  // Shape first, so an obvious paste error costs no round trip and, more to the
  // point, so nothing shaped like a shell fragment ever reaches a network call.
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    out({ ok: false, error: "That doesn't look like a bot token. It should look like 123456789:AAF... straight from @BotFather." });
  }
  if (isRevoked(token)) {
    out({ ok: false, error: REVOKED_MSG });
  }
  let me;
  try { me = await tg(token, 'getMe'); }
  catch (e) { out({ ok: false, error: `Could not reach Telegram from this box (${String(e.message || e).slice(0, 80)}).` }); }
  if (!me?.ok) {
    out({ ok: false, error: `That token didn't work (${String(me?.description || 'rejected by Telegram').slice(0, 80)}). Check it with @BotFather and try again.` });
  }
  const username = me.result?.username || null;
  writeSecret(TOKEN_F, token);
  mkdirSync(path.dirname(META_F), { recursive: true });
  writeFileSync(META_F, JSON.stringify({ username, verified_at: new Date().toISOString() }, null, 2) + '\n');
  out({ ok: true, username });
}

if (cmd === 'link') {
  const token = rd(TOKEN_F);
  if (!real(token)) out({ ok: false, error: 'No bot token on this box yet. Do step 1 first.' });
  // THE THIRD CONNECT PATH. verify gates the token a member PASTES, but link
  // gates nothing: it reads whatever is on disk. A revoked token can still be
  // sitting there after a hand restore on the same box, or after a boot where
  // reconciliation came back indeterminate and deliberately left the credential
  // alone. Ungated, link would poll with it, greet the chat and write the chat
  // id, which is the whole connection back. Same check, same words as verify.
  if (isRevoked(token)) out({ ok: false, error: REVOKED_MSG });
  let up;
  try { up = await tg(token, 'getUpdates'); }
  catch (e) { out({ ok: false, error: `Could not reach Telegram (${String(e.message || e).slice(0, 80)}).` }); }
  if (!up?.ok) out({ ok: false, error: String(up?.description || 'Telegram refused the request').slice(0, 120) });
  // ONE poll, not a wait loop: the panel calls this every few seconds while the
  // member is on the page, so a blocking verb would just hold an SSH channel open
  // and time out on the slow-to-open-Telegram case this exists to serve.
  //
  // A PAIRING CODE, NOT THE FIRST COMER (2026-08-20 audit). This used to take the
  // first chat id in getUpdates. Bot usernames are globally searchable, BotFather
  // names are guessable, and getUpdates replays up to 24 hours of backlog, so any
  // stranger who had messaged this bot before the member did became the box's
  // bound chat. That chat id is the entire isolation boundary in telegram.mjs,
  // whose foreign-chat guard would then have rejected the real member, and
  // policy.json carries an auto_send lane for briefs and reminders to
  // client_self over telegram, so unattended briefs built from the member's own
  // brain content would have gone to the stranger.
  //
  // The code is minted here and returned so the panel can show it, because only
  // the person holding this screen can put it into Telegram. It is not a secret
  // to keep, it is a challenge to answer, so cockpit/telegram.json is the right
  // home for it. Ten minutes is long enough to find the app and short enough
  // that an abandoned attempt does not stay answerable.
  const PAIR_TTL_MS = 10 * 60 * 1000;
  const m0 = meta();
  const fresh = m0.pair_code && (Date.now() - Date.parse(m0.pair_started || 0) < PAIR_TTL_MS);
  const code = fresh ? String(m0.pair_code) : String(Math.floor(100000 + Math.random() * 900000));
  if (!fresh) {
    mkdirSync(path.dirname(META_F), { recursive: true });
    writeFileSync(META_F, JSON.stringify({ ...m0, pair_code: code, pair_started: new Date().toISOString() }, null, 2) + '\n');
  }
  // The id and the text must come from the SAME update, and the chat must be
  // private: a negative id is a group or channel the bot was added to, which is
  // never "you".
  const hit = (up.result || [])
    .map((u) => u.message || u.channel_post || {})
    .find((msg) => msg?.chat?.type === 'private' && String(msg.text || '').trim() === code);
  const chat = hit?.chat?.id;
  if (chat === undefined) out({ ok: true, linked: false, code });

  writeSecret(CHAT_F, String(chat));
  // Bring the bridge up now: connect-telegram.sh does this too, and without it
  // the member links successfully and then nothing answers until the next restart.
  let started = false;
  try { if (existsSync(START_COMMS)) { execFileSync('bash', [START_COMMS, stateDir], { stdio: 'ignore' }); started = true; } } catch { /* best effort */ }
  try {
    await tg(token, 'sendMessage', {
      chat_id: String(chat),
      text: '✅ Connected. Message me any time. I draft replies for you to approve, and never send anything on my own.',
    });
  } catch { /* the link is real even if the greeting fails */ }
  // The code is spent: a used challenge must not stay answerable.
  const { pair_code: _spent, pair_started: _started, ...m } = meta();
  writeFileSync(META_F, JSON.stringify({ ...m, linked_at: new Date().toISOString() }, null, 2) + '\n');
  out({ ok: true, linked: true, chat_id: String(chat), started });
}

if (cmd === 'forget') {
  // THE RECORD IS WRITTEN FIRST, BEFORE THE KILL. That order is load-bearing.
  //
  // engine/cron/scheduler.mjs:848 supervises comms every two minutes by running
  // start-comms.sh, and the scheduler's own pid lives in a shell variable in
  // engine/box-up.sh:294, not in a .kernel pidfile, so stopComms() below cannot
  // see it and cannot stop it. The kill window here is seconds wide (up to 5s
  // waiting on SIGTERM, 2s more on SIGKILL), so a supervisor tick lands inside
  // it often enough to matter.
  //
  // With the record written last, that tick found a token, a chat id and NO
  // revoked list, so it skipped the boot gate in start-comms.sh and launched a
  // fresh bridge that read the live token into memory. forget then deleted the
  // pidfile that relaunch had just written and returned ok. Net result: a live
  // bridge holding revoked credentials, with no pidfile, invisible to every
  // later stopComms, reported to the member as a success.
  //
  // Written first, the same tick meets a non-empty revoked list, the boot gate
  // matches the hash, and start-comms deletes the credentials instead of
  // launching anything.
  //
  // It also keeps the failure branch coherent. If the bridge then refuses to
  // die we say so and leave the credential files alone, because a live bridge
  // is still using them and the member's state should stay honest. But the hash
  // is already recorded, so the restart we ask for reconciles at boot: the
  // credentials go, and nothing that depends on them starts. A revoke that
  // cannot finish now finishes at that restart rather than quietly not at all.
  const dying = rd(TOKEN_F);
  recordRevoked(dying);
  const survivors = await stopComms();
  if (survivors.length) {
    out({ ok: false, error: `Could not stop ${survivors.join(' and ')}. Telegram is still connected on this mineral. Restart it and try again.` });
  }
  // After the bridge and the kernel are down, so neither can write a fresh
  // record behind the sweep.
  purgeChatWork();
  try { writeFileSync(path.join(stateDir, '.kernel', 'telegram-offset'), ''); } catch { /* never linked */ }
  for (const f of [TOKEN_F, CHAT_F]) { try { rmSync(f, { force: true }); } catch { /* */ } }
  try { rmSync(META_F, { force: true }); } catch { /* */ }
  out({ ok: true });
}

out({ ok: false, error: `unknown command: ${cmd}` });
