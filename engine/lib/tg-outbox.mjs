// tg-outbox.mjs — the Telegram outbound queue (spec §7 tg-outbox + §3.P6.C3/C4 + §3.P6.X).
// Every Telegram send goes through here with target_chat_id + canary_tag. The §0.4 allowlist
// (client's-own brief/reminder) sends immediately; everything else is STAGED (disposition
// 'staged') and released ONLY by approve() -> exactly one send to the client's own allowed_chat
// (never another client's). Default-deny, made auditable + isolation-checkable.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { nowISO } from './clock.mjs';
import { isAutoSendAllowed } from './comms.mjs';

const OUT = (s) => path.join(s, 'state', 'tg-outbox.json');

export function readOutbox(stateDir) { try { return JSON.parse(readFileSync(OUT(stateDir), 'utf8')); } catch { return { rows: [] }; } }
function write(stateDir, o) { mkdirSync(path.dirname(OUT(stateDir)), { recursive: true }); writeFileSync(OUT(stateDir), JSON.stringify(o, null, 2) + '\n'); }

// Stage a telegram send. allowlisted brief/reminder -> sent now; else -> staged (default-deny).
export function stage(stateDir, comm) {
  const o = readOutbox(stateDir);
  const auto = isAutoSendAllowed({ channel: 'telegram', recipient_class: comm.recipient_class, comm_type: comm.comm_type });
  o.rows.push({
    comm_id: comm.comm_id, comm_type: comm.comm_type, target_chat_id: comm.target_chat_id,
    canary_tag: comm.canary || null, text: comm.text || '', staged_at: nowISO(stateDir),
    disposition: auto ? 'sent' : 'staged', sent_at: auto ? nowISO(stateDir) : null,
  });
  write(stateDir, o);
  return auto ? 'sent' : 'staged';
}

// Approve a staged send -> exactly one transition to 'sent' (idempotent: already-sent is a no-op).
export function approve(stateDir, comm_id) {
  const o = readOutbox(stateDir);
  const row = o.rows.find((r) => r.comm_id === comm_id);
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.disposition === 'sent') return { ok: true, already: true };
  row.disposition = 'sent'; row.sent_at = nowISO(stateDir); row.approved = true;
  write(stateDir, o);
  return { ok: true };
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(readOutbox(process.argv[2] || '.'), null, 2));
