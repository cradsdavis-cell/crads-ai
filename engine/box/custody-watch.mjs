#!/usr/bin/env node
// custody-watch.mjs: the box tells its own member when custody or access moves.
//
// Harriet's audit, 2026-08-19, point 4: "The system detects and blocks
// structurally broken states, but nothing flags a structurally valid change
// that happened without real consent. I'd want to know if my box's status
// changes, not have to go looking for it in a git log." She was right. Every
// custody verb (transfer invite / accept / complete / revoke, evict, re-anchor,
// support grant / revoke, an access grant added or removed) wrote a file and
// told nobody.
//
// This runs ON THE MEMBER'S BOX, on the scheduler's odd beat, and diffs a
// small custody snapshot against the last one it saw:
//   ownership.json      owner · owner_slug · anchor · holder_email · grants[]
//   support/access.json the active support grant (window + key fingerprint)
//   org-inbox/transfer/ to-org.json (invitation in) · to-member.json (grant in)
//   org-inbox/evict/notice.json · org-inbox/re-anchor/notice.json
// Any difference becomes (a) a line in <state>/custody-log.jsonl, the member's
// own history the app renders, and (b) one Telegram message via the box's own
// outbox (<state>/.kernel/outbox/, flushed by the telegram adapter). No token,
// no API, no network here; a box with no Telegram link still gets the log.
//
// It lives on the box, not the rock, on purpose: the rock is the party whose
// actions are being reported, so the report must not depend on the rock
// choosing to send it. The first run seeds the snapshot silently (a fresh box
// has nothing to report), so installing this never produces a false alarm.
//
//   node custody-watch.mjs <state-dir>            # diff + notify
//   node custody-watch.mjs <state-dir> --json     # print the current snapshot
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const stateDir = path.resolve(process.argv[2] || '/state');
const wantJson = process.argv.includes('--json');
const SEEN_F = path.join(stateDir, '.kernel', 'custody-seen.json');
const LOG_F = path.join(stateDir, 'custody-log.jsonl');
const OUTBOX = path.join(stateDir, '.kernel', 'outbox');
const CHAT_F = path.join(stateDir, 'secrets', 'telegram_chat_id');

const rd = (p, d) => { try { return JSON.parse(readFileSync(path.join(stateDir, p), 'utf8')); } catch { return d; } };
const fp = (s) => createHash('sha256').update(String(s || '')).digest('hex').slice(0, 12);

// The snapshot is the whole surface: small, flat, comparable field by field.
export function snapshot(dir = stateDir) {
  const r = (p, d) => { try { return JSON.parse(readFileSync(path.join(dir, p), 'utf8')); } catch { return d; } };
  const own = r('ownership.json', {}) || {};
  const holder = own.holder_email || (own.holder && own.holder.email) || '';
  const grants = (Array.isArray(own.grants) ? own.grants : [])
    .map((g) => `${String(g.email || '').toLowerCase()}:${g.role || 'member'}:${g.status || ''}`)
    .sort();
  const sup = r('support/access.json', {}) || {};
  const g = sup.grant && sup.grant.expires_at && new Date(sup.grant.expires_at) > new Date() ? sup.grant : null;
  const inv = r('org-inbox/transfer/to-org.json', null);
  const grant = r('org-inbox/transfer/to-member.json', null);
  const evict = r('org-inbox/evict/notice.json', null);
  const reanchor = r('org-inbox/re-anchor/notice.json', null);
  return {
    owner: String(own.owner || 'member'),
    owner_slug: String(own.owner_slug || ''),
    anchor: String(own.anchor || ''),
    holder: holder ? String(holder).toLowerCase() : '',
    grants,
    support: g ? `${g.expires_at}:${fp(g.key)}` : '',
    transfer_in: inv ? `to-org:${inv.invited || ''}` : '',
    grant_in: grant ? `to-member:${grant.granted || grant.invited || ''}` : '',
    evict: evict ? `${evict.org || ''}:${evict.date || ''}` : '',
    reanchor: reanchor ? `${reanchor.new_anchor || ''}:${reanchor.date || ''}` : '',
  };
}

// Plain words per field: what changed and what it means, no jargon the member
// has to decode. Each returned string is one event.
export function describe(prev, cur) {
  const ev = [];
  if (prev.owner !== cur.owner) {
    ev.push(cur.owner === 'org'
      ? `OWNERSHIP CHANGED: this mineral is now owned by your rock${cur.owner_slug ? ` (${cur.owner_slug})` : ''}. Its brain syncs to the rock's repo from now on. If you did not accept a transfer in your app, tell Sam immediately.`
      : `OWNERSHIP CHANGED: this mineral is now member-owned (yours). Nobody else can read it.`);
  } else if (prev.owner_slug !== cur.owner_slug && cur.owner === 'org') {
    ev.push(`Owner rock changed: ${prev.owner_slug || '(none)'} -> ${cur.owner_slug || '(none)'}.`);
  }
  if (prev.anchor !== cur.anchor) {
    ev.push(cur.anchor === 'crads-ai'
      ? `Anchor changed: this mineral is no longer anchored to ${prev.anchor || 'a rock'}; it is anchored to Crads-AI (the Mountain) again.`
      : `Anchor changed: this mineral is now anchored to ${cur.anchor}${prev.anchor ? ` (was ${prev.anchor})` : ''}.`);
  }
  if (prev.holder !== cur.holder && (prev.holder || cur.holder)) {
    ev.push(`Holder changed: ${prev.holder || '(none)'} -> ${cur.holder || '(none)'}.`);
  }
  const pg = new Set(prev.grants || []), cg = new Set(cur.grants || []);
  for (const g of cg) if (!pg.has(g)) { const [e, role, st] = g.split(':'); ev.push(`Access grant ${st === 'active' ? 'ACTIVE' : st || 'added'}: ${e} (${role}).`); }
  for (const g of pg) if (!cg.has(g)) { const [e, role] = g.split(':'); ev.push(`Access grant removed: ${e} (${role}).`); }
  if (prev.support !== cur.support) {
    ev.push(cur.support
      ? `SUPPORT ACCESS GRANTED: Crads support can open this mineral until ${cur.support.split(':')[0]}. Revoke any time in your app (Support).`
      : `Support access ended (revoked or expired). Nobody outside your grants can open this mineral.`);
  }
  if (prev.transfer_in !== cur.transfer_in) {
    ev.push(cur.transfer_in
      ? `Your rock has asked to take custody of this mineral (invited ${cur.transfer_in.split(':')[1] || 'today'}). Nothing happens unless you accept in your app.`
      : `The transfer-to-rock invitation was withdrawn or completed.`);
  }
  if (prev.grant_in !== cur.grant_in) {
    ev.push(cur.grant_in
      ? `Your rock offers to hand custody of this mineral to you. Accept in your app when ready.`
      : `The custody-to-you offer was withdrawn or completed.`);
  }
  if (prev.evict !== cur.evict && cur.evict) {
    const [org] = cur.evict.split(':');
    ev.push(`${org || 'Your rock'} ended your membership. Your mineral, brain and seat continue; it re-anchors to Crads-AI.`);
  }
  if (prev.reanchor !== cur.reanchor && cur.reanchor) {
    const [na] = cur.reanchor.split(':');
    ev.push(`Your anchor is moving to ${na || 'a new rock'} (re-anchor notice received).`);
  }
  return ev;
}

export function run(dir = stateDir, { now = new Date(), notify = true } = {}) {
  const seenF = path.join(dir, '.kernel', 'custody-seen.json');
  const logF = path.join(dir, 'custody-log.jsonl');
  const outbox = path.join(dir, '.kernel', 'outbox');
  const chatF = path.join(dir, 'secrets', 'telegram_chat_id');
  const cur = snapshot(dir);
  let prev = null;
  try { prev = JSON.parse(readFileSync(seenF, 'utf8')); } catch { prev = null; }
  mkdirSync(path.dirname(seenF), { recursive: true });
  if (!prev) {
    // first sight: seed silently, log the baseline so the history has a start
    writeFileSync(seenF, JSON.stringify(cur, null, 2) + '\n');
    appendFileSync(logF, JSON.stringify({ at: now.toISOString(), event: 'baseline', owner: cur.owner, anchor: cur.anchor }) + '\n');
    return { ok: true, events: [], seeded: true };
  }
  const events = describe(prev, cur);
  if (!events.length) return { ok: true, events: [] };
  for (const e of events) appendFileSync(logF, JSON.stringify({ at: now.toISOString(), event: e, owner: cur.owner, anchor: cur.anchor }) + '\n');
  writeFileSync(seenF, JSON.stringify(cur, null, 2) + '\n');
  let sent = false;
  if (notify) {
    let chatId = '';
    try { chatId = readFileSync(chatF, 'utf8').trim(); } catch { /* no telegram link */ }
    if (chatId) {
      mkdirSync(outbox, { recursive: true });
      const text = `Custody / access change on your mineral:\n\n${events.map((e) => `• ${e}`).join('\n')}\n\nFull history: your app, Custody log.`;
      writeFileSync(path.join(outbox, `custody-${now.getTime()}.json`), JSON.stringify({ chat_id: chatId, text, job: 'custody-watch' }) + '\n');
      sent = true;
    }
  }
  return { ok: true, events, sent };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (wantJson) { process.stdout.write(JSON.stringify(snapshot(), null, 2) + '\n'); process.exit(0); }
  const r = run();
  process.stdout.write(JSON.stringify(r) + '\n');
}
