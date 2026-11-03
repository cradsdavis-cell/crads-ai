// slack-dm.test.mjs: the owner's Slack DM with their assistant.
// Run: node --test engine/comms/slack-dm.test.mjs
//
// Pins the contract slack-dm.mjs promises: only the owner, in their DM, as a
// person (never a bot post, an edit or a join) becomes a turn; replies come back
// as Slack mrkdwn with drafts shown, never sent; the bridge takes only `slack:`
// records from the outbox it shares with Telegram, and only the owner's; refused
// tokens back off and are re-read; removed secrets and move-in mode stop it; a
// closed socket reconnects. Every Slack call goes to a fake; nothing here
// reaches slack.com.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { inboundFrom, plainFromSlack, toMrkdwn, slackMessages, createBridge } from './slack-dm.mjs';
import { deliveryTarget, primaryChannel, slackConfigured, isSlackTarget } from '../lib/delivery-target.mjs';
import { DRAFT_FOOTER } from './telegram-drafts.mjs';
import { TOKEN_BACKOFF_FIRST_MS } from './telegram-poll.mjs';
import { classifyJob } from '../lib/ledger.mjs';

const ENGINE = path.join(import.meta.dirname, '..');
const KERNEL = path.join(ENGINE, 'kernel', 'kernel.mjs');
const COMMS = path.join(ENGINE, 'start-comms.sh');
const OWNER = 'U0OWNER1';
const DM = 'D0OWNERDM';
const BOT = 'U0BOTUSER';

function box({ secrets = true, ownership = null } = {}) {
  const d = tmpDir('slackdm-');
  mkdirSync(path.join(d, 'secrets'), { recursive: true });
  mkdirSync(path.join(d, '.kernel', 'outbox'), { recursive: true });
  if (secrets) {
    writeFileSync(path.join(d, 'secrets', 'slack_app_token'), 'xapp-1-good\n');
    writeFileSync(path.join(d, 'secrets', 'slack_bot_token'), 'xoxb-good\n');
    writeFileSync(path.join(d, 'secrets', 'slack_owner_user'), `${OWNER}\n`);
  }
  if (ownership) writeFileSync(path.join(d, 'ownership.json'), JSON.stringify(ownership));
  return d;
}
const outboxDir = (d) => path.join(d, '.kernel', 'outbox');
const listOutbox = (d) => readdirSync(outboxDir(d)).filter((f) => f.endsWith('.json')).sort();
const putRecord = (d, name, rec) => writeFileSync(path.join(outboxDir(d), name), JSON.stringify(rec));
const queued = (d) => { try { return readdirSync(path.join(d, '.kernel', 'queue')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(d, '.kernel', 'queue', f), 'utf8'))); } catch { return []; } };

// A fake Slack Web API: records [method, body, auth] and answers per method.
function fakeSlack(overrides = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    const method = url.split('/').pop();
    const body = JSON.parse(init.body || '{}');
    const auth = init.headers.authorization;
    calls.push([method, body, auth]);
    const h = overrides[method];
    const res = h ? h(body, auth) : method === 'apps.connections.open' ? { ok: true, url: 'wss://fake' }
      : method === 'chat.postMessage' ? { ok: true, channel: String(body.channel).startsWith('U') ? DM : body.channel, ts: '1.2' }
        : { ok: true };
    return new Response(JSON.stringify(res), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetcher, calls, posts: () => calls.filter(([m]) => m === 'chat.postMessage').map(([, b]) => b) };
}

// A fake Socket Mode WebSocket that plays `msgs` then disconnects.
function fakeWS(msgs, acks) {
  return class {
    constructor(url) { assert.equal(url, 'wss://fake'); setTimeout(() => { for (const m of msgs.concat({ type: 'disconnect', reason: 'refresh_requested' })) this.onmessage({ data: JSON.stringify(m) }); }, 0); }
    send(x) { acks.push(JSON.parse(x).envelope_id); }
    close() { this.onclose && this.onclose(); }
  };
}

let n = 0;
const ev = (event, extra = {}) => ({ type: 'events_api', envelope_id: `E${++n}`, payload: { type: 'event_callback', team_id: 'T1', event_id: `Ev${n}`, event: { type: 'message', channel: DM, channel_type: 'im', user: OWNER, text: 'hi', ts: `${n}.0`, ...event }, ...extra } });
const quiet = () => {};

// ---- inbound: who gets to talk to it ----------------------------------------

test('only the owner, as a person, in a DM, becomes a turn; everything else is refused', () => {
  const ok = inboundFrom(ev({ text: 'what is on today?' }), { owner: OWNER });
  assert.deepEqual([ok.text, ok.channel], ['what is on today?', DM]);
  const refused = {
    'a bot post in the same DM (the owner\'s own notifications)': ev({ bot_id: 'B1', user: BOT, text: 'Your call: 1 a / 1 b' }),
    'a post another program made as the bot': ev({ app_id: 'A1', text: 'fleet note' }),
    'an edit': ev({ subtype: 'message_changed' }),
    'a file share': ev({ subtype: 'file_share' }),
    'a join': ev({ subtype: 'channel_join' }),
    'someone else in their own DM with the bot': ev({ user: 'U0SOMEONE', channel: 'D0OTHER' }),
    'a channel, not a DM': ev({ channel: 'C0GENERAL', channel_type: 'channel' }),
    'a group DM': ev({ channel: 'G0GROUP', channel_type: 'mpim' }),
    'a person from another workspace': ev({ user_team: 'T2' }),
    'an empty message': ev({ text: '   ' }),
  };
  for (const [what, env] of Object.entries(refused)) {
    const r = inboundFrom(env, { owner: OWNER });
    assert.ok(r && r.ignore, `${what} is refused`);
  }
  assert.equal(inboundFrom({ type: 'hello' }, { owner: OWNER }), null);
  assert.equal(inboundFrom(ev({ type: 'app_mention' }), { owner: OWNER }), null, 'a mention is not a DM message');
  assert.ok(inboundFrom(ev({}), { owner: '' }).ignore, 'no owner configured: nobody is the owner');
});

test('Slack markup in what the owner wrote comes through as plain text', () => {
  assert.equal(plainFromSlack('see <https://x.example/a|the doc> &amp; <https://y.example> &lt;3 <@U9> <#C1|general> <!here> <mailto:a@b.co|a@b.co>'),
    'see the doc (https://x.example/a) & https://y.example <3 @U9 #general @here a@b.co');
});

// ---- outbound: what the owner sees ------------------------------------------

test('replies become Slack mrkdwn, and nothing in them can ping or hide a link', () => {
  const out = toMrkdwn([
    '# Today', '**Three things**, and __one__ more', '* first', '+ second', '- third',
    'Read [the brief](https://x.example/b) and ~~skip~~ this. <!channel> & <https://evil.example|safe>',
    '<b>From HTML</b> <a href="https://h.example">link</a>',
    'Run `a && b` then:', '```js', 'if (x < 2) **not bold**', '```',
  ].join('\n'));
  assert.equal(out, [
    '*Today*', '*Three things*, and *one* more', '• first', '• second', '- third',
    'Read the brief (https://x.example/b) and ~skip~ this. &lt;!channel&gt; &amp; &lt;https://evil.example|safe&gt;',
    '*From HTML* link (https://h.example)',
    'Run `a &amp;&amp; b` then:', '```', 'if (x &lt; 2) **not bold**', '```',
  ].join('\n'));
});

test('a PROPOSE-SEND draft is shown to the owner to send themselves, as on Telegram', () => {
  const parts = slackMessages({ chat_id: `slack:${DM}`, text: 'Hi Jo,\n\nThanks for **Tuesday**.\nPROPOSE-SEND: email to Jo' });
  assert.equal(parts.length, 1);
  assert.doesNotMatch(parts[0], /PROPOSE-SEND/);
  assert.equal(parts[0], `Hi Jo,\n\nThanks for *Tuesday*.\n\n${DRAFT_FOOTER}`);
  assert.equal(slackMessages({ chat_id: `slack:${DM}`, text: 'a'.repeat(5000) }).length, 2, 'long replies are split');
});

// ---- the bridge, end to end with fakes ---------------------------------------

test('the bridge acks every envelope, enqueues only the owner\'s DM messages, once each, and learns the DM', async () => {
  const d = box();
  const slack = fakeSlack();
  const acks = [];
  const owners = ev({ text: 'move my 3pm' });
  const msgs = [
    { type: 'hello', envelope_id: undefined },
    owners,
    { ...owners, envelope_id: 'E-redelivered' },                       // Slack redelivers what it thinks was missed
    ev({ bot_id: 'B1', user: BOT, text: 'Your call:\n1. a\n2. b' }),   // the fleet's notification in the same DM
    ev({ user: 'U0SOMEONE', channel: 'D0OTHER', text: 'let me in' }),
    ev({ subtype: 'message_changed' }),
  ];
  const logs = [];
  const b = createBridge(d, { fetcher: slack.fetcher, WS: fakeWS(msgs, acks), log: (...m) => logs.push(m.join(' ')), sleep: async () => {} });
  await b.run({ once: true });
  assert.deepEqual(acks, msgs.map((m) => m.envelope_id).filter(Boolean), 'every envelope is acked, the refused ones too');
  const jobs = queued(d);
  assert.equal(jobs.length, 1, 'one turn, from the owner, once');
  assert.deepEqual([jobs[0].skill, jobs[0].args.text, jobs[0].reply_to, jobs[0].source], ['message', 'move my 3pm', `slack:${DM}`, 'slack']);
  assert.equal(readFileSync(path.join(d, '.kernel', 'slack-dm-channel'), 'utf8').trim(), `${OWNER} ${DM}`, 'the DM is remembered for deliveries, with whose it is');
  assert.ok(logs.some((l) => /drop message from U0SOMEONE/.test(l)), 'a stranger is logged');
  assert.ok(!logs.some((l) => /B1|Your call/.test(l)), 'bot posts are routine and are not');
  assert.ok(slack.calls.every(([m, , auth]) => m !== 'apps.connections.open' || auth === 'Bearer xapp-1-good'), 'the socket opens with the app-level token');
  assert.deepEqual(classifyJob(jobs[0]), { actor_class: 'auto', actor_id: 'slack:inbound', trigger_kind: 'inbound' }, 'the ledger files it as an inbound turn');
});

test('the bridge takes only slack: records, only the owner\'s, and leaves Telegram\'s alone', async () => {
  const d = box();
  writeFileSync(path.join(d, '.kernel', 'slack-dm-channel'), `${OWNER} ${DM}\n`);
  putRecord(d, '1-reply.json', { chat_id: `slack:${DM}`, text: 'Done: **moved** to 4pm.', job: 'a' });
  putRecord(d, '2-brief.json', { chat_id: `slack:${OWNER}`, text: 'Your morning brief', job: 'b' });
  putRecord(d, '3-foreign.json', { chat_id: 'slack:C0GENERAL', text: 'must never be posted', job: 'c' });
  putRecord(d, '4-telegram.json', { chat_id: 4242, text: 'a Telegram reply', job: 'd' });
  putRecord(d, '5-telegram.json', { chat_id: '4242', text: 'a Telegram brief', job: 'e' });
  const slack = fakeSlack();
  const logs = [];
  const b = createBridge(d, { fetcher: slack.fetcher, WS: fakeWS([], []), log: (...m) => logs.push(m.join(' ')) });
  await b.run({ once: true });
  assert.deepEqual(slack.posts().map((p) => [p.channel, p.text]), [[DM, 'Done: *moved* to 4pm.'], [DM, 'Your morning brief']], 'both owner records reach the DM, as mrkdwn');
  assert.ok(slack.calls.filter(([m]) => m === 'chat.postMessage').every(([, , auth]) => auth === 'Bearer xoxb-good'), 'posts use the bot token, never the app token');
  assert.deepEqual(listOutbox(d), ['4-telegram.json', '5-telegram.json'], 'sent and foreign Slack records are gone; Telegram\'s are untouched');
  assert.ok(logs.some((l) => /drop outbound for C0GENERAL/.test(l)));
});

test('a delivery before the owner has ever written posts to their user id, and learns the DM from Slack\'s answer', async () => {
  const d = box();
  putRecord(d, 'brief.json', { chat_id: `slack:${OWNER}`, text: 'Your morning brief', job: 'b' });
  putRecord(d, 'guess.json', { chat_id: `slack:${DM}`, text: 'a DM id nobody has shown to be the owner\'s', job: 'c' });
  const slack = fakeSlack();
  const b = createBridge(d, { fetcher: slack.fetcher, WS: fakeWS([], []), log: quiet });
  await b.outboundLoop({ once: true });
  assert.equal(slack.posts()[0].channel, OWNER, 'no DM known yet: posted to the owner\'s user id (their DM with the bot)');
  assert.equal(b.ownerDm, DM, 'and the DM Slack answered with is now known');
  assert.ok(existsSync(path.join(d, '.kernel', 'slack-dm-channel')));
});

test('a DM learned for a previous owner is not an allowed target for the new one', async () => {
  const d = box();
  writeFileSync(path.join(d, '.kernel', 'slack-dm-channel'), `U0PREVIOUS ${DM}\n`);
  putRecord(d, 'old.json', { chat_id: `slack:${DM}`, text: 'meant for the previous owner', job: 'a' });
  const slack = fakeSlack();
  const b = createBridge(d, { fetcher: slack.fetcher, WS: fakeWS([], []), log: quiet });
  await b.run({ once: true });
  assert.equal(b.ownerDm, null);
  assert.equal(slack.posts().length, 0, 'nothing posted');
  assert.deepEqual(listOutbox(d), [], 'dropped as foreign');
});

test('a refused bot token backs off, keeps the reply, and a corrected token sends it without a restart', async () => {
  const d = box();
  putRecord(d, 'r.json', { chat_id: `slack:${OWNER}`, text: 'kept until it can go', job: 'a' });
  const slack = fakeSlack({ 'chat.postMessage': (body, auth) => (auth === 'Bearer xoxb-good' ? { ok: true, channel: DM } : { ok: false, error: 'invalid_auth' }) });
  writeFileSync(path.join(d, 'secrets', 'slack_bot_token'), 'xoxb-revoked\n');
  const waits = [];
  const logs = [];
  let b;
  const sleep = async (ms) => {
    waits.push(ms);
    if (waits.length === 3) writeFileSync(path.join(d, 'secrets', 'slack_bot_token'), 'xoxb-good\n');   // the owner pastes a new one
    if (!listOutbox(d).length) rmSync(path.join(d, 'secrets', 'slack_bot_token'));                     // sent: end the loop
  };
  b = createBridge(d, { fetcher: slack.fetcher, WS: fakeWS([], []), log: (...m) => logs.push(m.join(' ')), sleep, pollMs: 1 });
  await b.outboundLoop();
  assert.deepEqual(waits.slice(0, 3), [TOKEN_BACKOFF_FIRST_MS, TOKEN_BACKOFF_FIRST_MS * 2, TOKEN_BACKOFF_FIRST_MS * 4], 'backs off 5 s, doubling');
  assert.equal(slack.posts().length, 4, 'one try per wait, never a burst');
  assert.deepEqual(listOutbox(d), [], 'sent once the token was fixed');
  assert.ok(logs.some((l) => /picked up new Slack tokens/.test(l)));
  assert.ok(logs.some((l) => /works again after 3 refused attempts/.test(l)));
  assert.match(b.stopped, /secrets are gone/, 'removing the secrets stops the bridge');
});

test('a refused app-level token backs off and is re-read; a closed socket reconnects', async () => {
  const d = box();
  writeFileSync(path.join(d, 'secrets', 'slack_app_token'), 'xapp-revoked\n');
  let opens = 0;
  const slack = fakeSlack({ 'apps.connections.open': (b, auth) => { opens++; return auth === 'Bearer xapp-1-good' ? { ok: true, url: 'wss://fake' } : { ok: false, error: 'invalid_auth' }; } });
  const waits = [];
  const sleep = async (ms) => {
    waits.push(ms);
    if (waits.length === 2) writeFileSync(path.join(d, 'secrets', 'slack_app_token'), 'xapp-1-good\n');
    if (opens >= 5) rmSync(path.join(d, 'secrets', 'slack_app_token'));   // enough: disconnect ends the loop
  };
  const b = createBridge(d, { fetcher: slack.fetcher, WS: fakeWS([{ type: 'hello' }], []), log: quiet, sleep });
  await b.inboundLoop();
  assert.deepEqual(waits.slice(0, 2), [TOKEN_BACKOFF_FIRST_MS, TOKEN_BACKOFF_FIRST_MS * 2], 'refusals back off');
  assert.ok(opens >= 5, `each socket that ended was reopened (${opens} opens)`);
  assert.ok(waits.slice(2).every((ms) => ms <= 2000), 'a normal disconnect reconnects promptly, not on the refusal schedule');
  assert.match(b.stopped, /secrets are gone/);
});

test('move-in mode: nothing is read or sent, and the record is kept', async () => {
  const d = box({ ownership: { adopted: true, moving_in: true } });
  putRecord(d, 'r.json', { chat_id: `slack:${OWNER}`, text: 'must not go', job: 'a' });
  const slack = fakeSlack();
  const b = createBridge(d, { fetcher: slack.fetcher, WS: fakeWS([ev({ text: 'hello' })], []), log: quiet });
  await b.run({ once: true });
  assert.equal(slack.calls.length, 0, 'Slack was never called');
  assert.deepEqual(listOutbox(d), ['r.json']);
  assert.equal(queued(d).length, 0);
  assert.match(b.stopped, /move-in mode/);
});

test('without its three secrets the bridge does not run', async () => {
  const d = box({ secrets: false });
  const slack = fakeSlack();
  assert.match(await createBridge(d, { fetcher: slack.fetcher, log: quiet }).run({ once: true }), /not configured/);
  assert.equal(slack.calls.length, 0);
  const r = spawn(process.execPath, [path.join(import.meta.dirname, 'slack-dm.mjs'), d], { stdio: 'ignore' });
  assert.equal(await new Promise((res) => r.on('exit', res)), 1, 'the entrypoint refuses');
});

// ---- the primary channel: where scheduled deliveries go ------------------------

test('deliveries go to Telegram unless the owner chose Slack AND Slack is configured', () => {
  const d = box({ secrets: false });
  assert.equal(deliveryTarget(d), '', 'no channel: no delivery');
  writeFileSync(path.join(d, 'secrets', 'telegram_chat_id'), '4242\n');
  assert.equal(deliveryTarget(d), '4242', 'Telegram, as before');
  writeFileSync(path.join(d, '.kernel', 'primary-channel'), 'slack\n');
  assert.equal(primaryChannel(d), 'telegram', 'Slack chosen but not configured: still Telegram');
  assert.equal(deliveryTarget(d), '4242');
  for (const [f, v] of [['slack_app_token', 'xapp-1'], ['slack_bot_token', 'xoxb-1'], ['slack_owner_user', 'not-an-id']]) writeFileSync(path.join(d, 'secrets', f), v);
  assert.equal(slackConfigured(d), false, 'a malformed owner id is not a configured Slack');
  writeFileSync(path.join(d, 'secrets', 'slack_owner_user'), OWNER);
  assert.equal(deliveryTarget(d), `slack:${OWNER}`, 'Slack chosen and configured: the owner\'s DM');
  assert.ok(isSlackTarget(deliveryTarget(d)));
  writeFileSync(path.join(d, '.kernel', 'primary-channel'), 'telegram\n');
  assert.equal(deliveryTarget(d), '4242', 'and back');
  rmSync(path.join(d, '.kernel', 'primary-channel'));
  assert.equal(deliveryTarget(d), '4242', 'absent setting: Telegram');
});

test('every machinery notifier takes its target from deliveryTarget, never the Telegram file', () => {
  for (const f of ['cron/scheduler.mjs', 'box/health-check.mjs', 'box/custody-watch.mjs', 'comms/google-rekey-ping.mjs']) {
    const src = readFileSync(path.join(ENGINE, f), 'utf8');
    assert.match(src, /deliveryTarget\((stateDir|dir)\)/, `${f} asks deliveryTarget`);
    assert.doesNotMatch(src, /telegram_chat_id/, `${f} does not read the Telegram chat itself`);
  }
});

test('kernel: a Slack turn\'s reply lands in the outbox addressed back to the DM', () => {
  const d = box();
  execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: d });
  execFileSync('node', [path.join(ENGINE, 'kernel', 'enqueue.mjs'), d, 'daily', '--source=cron', `--reply-to=slack:${OWNER}`]);
  execFileSync('node', [KERNEL, d, '--once', '--dry-run']);
  const files = listOutbox(d);
  assert.equal(files.length, 1);
  const rec = JSON.parse(readFileSync(path.join(outboxDir(d), files[0]), 'utf8'));
  assert.equal(rec.chat_id, `slack:${OWNER}`, 'the channel tag survives the kernel, so the Slack bridge (and only it) takes it');
});

test('a custody note follows the primary channel', async () => {
  const d = box();
  writeFileSync(path.join(d, 'secrets', 'telegram_chat_id'), '4242');
  writeFileSync(path.join(d, '.kernel', 'primary-channel'), 'slack');
  const { run } = await import('../box/custody-watch.mjs');
  run(d, { now: new Date('2026-10-28T00:00:00Z') });                       // seeds the baseline
  writeFileSync(path.join(d, 'ownership.json'), JSON.stringify({ owner: 'org', owner_slug: 'acme' }));
  assert.equal(run(d, { now: new Date('2026-10-28T00:01:00Z') }).events.length, 1);
  const recs = listOutbox(d).map((f) => JSON.parse(readFileSync(path.join(outboxDir(d), f), 'utf8')));
  assert.equal(recs.length, 1, 'one note');
  assert.equal(recs[0].chat_id, `slack:${OWNER}`, 'routed to Slack, not Telegram');
});

// ---- start-comms: started when configured, once, and never in move-in mode -----

function commsWithFakeNode(dir) {
  const bin = tmpDir('slackdm-node-');
  const rec = path.join(bin, 'launched.log');
  writeFileSync(path.join(bin, 'node'), `#!/usr/bin/env bash\ncase "$1" in\n  */comms/slack-dm.mjs) echo slack-dm >> "${rec}"; exec -a crads-fake-slack sleep 30 ;;\n  */comms/telegram.mjs) echo telegram >> "${rec}"; exec -a crads-fake-telegram sleep 30 ;;\n  */kernel/kernel.mjs) echo kernel >> "${rec}"; exec -a crads-fake-kernel sleep 30 ;;\nesac\nexec "${process.execPath}" "$@"\n`);
  chmodSync(path.join(bin, 'node'), 0o755);
  writeFileSync(path.join(dir, 'secrets', 'remote_control_disabled'), '');   // not what this test is about
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const launched = () => (existsSync(rec) ? readFileSync(rec, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { launched, run: () => execFileSync('bash', [COMMS, dir], { env, encoding: 'utf8' }) };
}
const waitFor = (fn, k = 60) => { for (let i = 0; i < k && !fn(); i++) execFileSync('sleep', ['0.05']); return fn(); };
const killPids = (d) => { for (const f of ['kernel.pid', 'slack-dm.pid', 'telegram.pid']) { const pf = path.join(d, '.kernel', f); if (existsSync(pf)) { try { process.kill(Number(readFileSync(pf, 'utf8')), 'SIGKILL'); } catch { /* gone */ } } } };

test('start-comms: Slack configured and no Telegram starts the bridge and the kernel, once; no secrets starts neither', () => {
  const d = box();
  const c = commsWithFakeNode(d);
  try {
    c.run();
    assert.ok(waitFor(() => c.launched().includes('slack-dm') && c.launched().includes('kernel')), `launched: ${c.launched()}`);
    assert.ok(!c.launched().includes('telegram'), 'Telegram is not connected, so its bridge is not started');
    c.run();
    assert.equal(c.launched().filter((l) => l === 'slack-dm').length, 1, 'not started twice by the next supervisor pass');
    assert.equal(c.launched().filter((l) => l === 'kernel').length, 1);
    // disconnected: the next pass stops it
    const pid = Number(readFileSync(path.join(d, '.kernel', 'slack-dm.pid'), 'utf8'));
    rmSync(path.join(d, 'secrets', 'slack_bot_token'));
    c.run();
    assert.ok(waitFor(() => { try { process.kill(pid, 0); return readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] === 'Z'; } catch { return true; } }), 'stopped once the secrets are gone');
  } finally { killPids(d); }

  const none = box({ secrets: false });
  const c2 = commsWithFakeNode(none);
  try { c2.run(); execFileSync('sleep', ['0.3']); assert.deepEqual(c2.launched(), [], 'a box without Slack starts nothing new'); } finally { killPids(none); }

  const moving = box({ ownership: { adopted: true, moving_in: true } });
  const c3 = commsWithFakeNode(moving);
  try { c3.run(); execFileSync('sleep', ['0.3']); assert.deepEqual(c3.launched(), [], 'move-in mode starts nothing'); } finally { killPids(moving); }
});
