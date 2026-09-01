#!/usr/bin/env node
// google-rekey-ping.mjs: watches the member's Google key and speaks ONLY when
// it actually dies.
//
// History: born 2026-08-17 as a day-6 clock nudge, when the wizard left the
// member's OAuth app in Testing mode and Google killed the refresh token every
// 7 days. Sam's ruling 2026-08-24 (docs/design-google-byo-connect.md § the
// sign-in that stays): the wizard now walks the member to PUBLISH their own
// app (External + In Production), where Google issues refresh tokens with no
// scheduled death — so no clock can know when a key dies any more, and a
// clock-based ping would false-alarm every Production key at day 7. This is
// now a LIVE probe: every ~6h it asks Google's token endpoint for a refresh
// with the credential file's own embedded client, and only a definitive
// invalid_grant is treated as death. On death: ONE Telegram message, a
// dead-marker file for the status row (mcp-connect.mjs reads it), then
// silence. A re-key moves keyed_at, which retires the marker and the ledger
// slot for free, so nothing ever repeats.
//
// Network: unlike the day-6 version, this DOES reach Google — a single form
// POST to the token endpoint recorded in the credential file. A transient
// network or server error is never death; only invalid_grant is.
//
// Delivery is the box's own outbox (<state>/.kernel/outbox/), flushed by the
// telegram adapter. A box with no Google key exits silently — the scheduler
// runs this hourly and almost every run must cost nothing (the 6h throttle
// keeps the probe itself rare).
//
//   node google-rekey-ping.mjs <state-dir>
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const stateDir = path.resolve(process.argv[2] || '/state');
const OAUTH_F = path.join(stateDir, '.kernel', 'mcp-oauth.json');
const LEDGER_F = path.join(stateDir, '.kernel', 'google-rekey-ping.json');
const DEAD_F = path.join(stateDir, '.kernel', 'google-key-dead.json');   // read by mcp-connect.mjs status
const OUTBOX = path.join(stateDir, '.kernel', 'outbox');
const CHAT_F = path.join(stateDir, 'secrets', 'telegram_chat_id');

const PROBE_EVERY = 6 * 3600e3;   // the scheduler fires hourly; probe Google every 6h

const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(0); };
const rd = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };

const g = rd(OAUTH_F, {}).google;
if (!g || g.provider !== 'google-byo' || !g.keyed_at || !g.creds_file) out({ ok: true, sent: null, why: 'no google key' });

// the workspace-mcp credential file embeds everything a refresh needs
const creds = rd(g.creds_file, {});
if (!creds.refresh_token || !creds.client_id || !creds.client_secret || !creds.token_uri) {
  out({ ok: true, sent: null, why: 'credential file incomplete' });
}

const now = Date.now();
const ledger = rd(LEDGER_F, {});
// a re-key moves keyed_at, which makes this a fresh ledger entry automatically
const slot = ledger.keyed_at === g.keyed_at ? ledger : { keyed_at: g.keyed_at };
if (slot.checked_at && now - slot.checked_at < PROBE_EVERY) out({ ok: true, sent: null, why: 'not due' });

let res;
try {
  res = await fetch(creds.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id, client_secret: creds.client_secret,
      refresh_token: creds.refresh_token, grant_type: 'refresh_token',
    }),
  });
} catch {
  // unreachable is not dead; try again next window
  slot.checked_at = now;
  writeFileSync(LEDGER_F, JSON.stringify(slot, null, 2) + '\n');
  out({ ok: true, sent: null, why: 'google unreachable' });
}

slot.checked_at = now;

let dead = false;
if (!res.ok) {
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON error page: not definitive */ }
  dead = body.error === 'invalid_grant';
}

if (!dead) {
  // alive (or an indefinite error): make sure no stale marker keeps the row red
  try { const m = rd(DEAD_F, null); if (m) unlinkSync(DEAD_F); } catch { /* already gone */ }
  writeFileSync(LEDGER_F, JSON.stringify(slot, null, 2) + '\n');
  out({ ok: true, sent: null, why: res.ok ? 'key alive' : `indefinite error http ${res.status}` });
}

// invalid_grant: the key is definitively dead. Mark it for the status row,
// tell the member once, and go quiet until keyed_at moves.
writeFileSync(DEAD_F, JSON.stringify({ keyed_at: g.keyed_at, dead_at: now }, null, 2) + '\n');

let chatId = '';
try { chatId = readFileSync(CHAT_F, 'utf8').trim(); } catch { /* no telegram link */ }
if (!chatId || slot.dead_sent_at) {
  writeFileSync(LEDGER_F, JSON.stringify(slot, null, 2) + '\n');
  out({ ok: true, sent: null, why: chatId ? 'dead, already told' : 'dead, no telegram link' });
}

mkdirSync(OUTBOX, { recursive: true });
writeFileSync(path.join(OUTBOX, `google-rekey-dead-${g.keyed_at}.json`),
  JSON.stringify({ chat_id: chatId, text: 'Your Google sign-in has stopped working (Google dropped the key), so your scheduled jobs cannot reach Gmail or Calendar until you sign in again. Two clicks in your Crads-AI app: Connections, then Google, then Sign in.' }) + '\n');
slot.dead_sent_at = now;
writeFileSync(LEDGER_F, JSON.stringify(slot, null, 2) + '\n');
out({ ok: true, sent: 'dead' });
