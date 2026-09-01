// comms.mjs — the Comms Ledger (spec §7 + §3.P1 + §0.4 gated-vs-auto-send law).
// Append-only, git-tracked. One 'draft' row at draft-time (BEFORE the gate), then a
// 'gate' row, then a 'send' row ONLY if the gate allowed it. The §0.4 allowlist is the
// ONLY thing that may auto-send: the client's-own-Telegram brief/reminder. EVERY email
// and EVERY third-party message is gated (drafted, NOT sent) -> default-deny (G1).
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { nowISO } from './clock.mjs';

const LEDGER = (s) => path.join(s, 'state', 'comms-ledger.jsonl');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function readComms(stateDir) {
  const p = LEDGER(stateDir);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function append(stateDir, row) {
  const p = LEDGER(stateDir);
  mkdirSync(path.dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify({ ts: nowISO(stateDir), ...row }) + '\n');
}

// §0.4 auto-send allowlist: client's-own-Telegram brief/reminder ONLY.
// Machine-readable in engine/policy.json since 2026-07-14 (the second-brain's shared-policy
// pattern: edit the JSON, not this code). The literals below are the fail-safe fallback —
// a missing/corrupt policy file degrades to exactly this behaviour, never to open.
const POLICY = (() => {
  try { return JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'policy.json'), 'utf8')); }
  catch { return {}; }
})();
const AUTO = POLICY.auto_send || {};
const AUTO_CHANNELS = Array.isArray(AUTO.channels) && AUTO.channels.length ? AUTO.channels : ['telegram'];
const AUTO_RECIPIENTS = Array.isArray(AUTO.recipient_classes) && AUTO.recipient_classes.length ? AUTO.recipient_classes : ['client_self'];
const AUTO_TYPES = Array.isArray(AUTO.comm_types) && AUTO.comm_types.length ? AUTO.comm_types : ['brief', 'reminder'];
export function isAutoSendAllowed(comm) {
  return AUTO_CHANNELS.includes(comm.channel) && AUTO_RECIPIENTS.includes(comm.recipient_class) && AUTO_TYPES.includes(comm.comm_type);
}

// route a telegram comm through the tg-outbox (target = the client's own allowed_chat_id).
async function routeTelegram(stateDir, comm) {
  try {
    const { stage } = await import('./tg-outbox.mjs');
    const chat = (() => { try { return readFileSync(path.join(stateDir, 'secrets', 'telegram_chat_id'), 'utf8').trim(); } catch { return 'self'; } })();
    const canary = (() => { try { return readFileSync(path.join(stateDir, '.kernel', 'canary'), 'utf8').trim(); } catch { return null; } })();
    stage(stateDir, { comm_id: comm.comm_id, comm_type: comm.comm_type, recipient_class: comm.recipient_class, target_chat_id: chat, canary, text: comm.body || '' });
  } catch {}
}

// Emit a comm: draft -> gate -> (send iff allowlisted). Returns the disposition.
// IDEMPOTENT on comm_id (spec §3.P4.IDEM): a re-emit of the SAME comm_id with the SAME body is a
// no-op — it returns the prior disposition without appending (so a re-fired cron does not re-draft
// or re-send the same logical brief). A re-emit with a CHANGED body is a genuine update: a new
// 'draft' row is appended carrying `supersedes` = the prior body_sha256 (append-only history kept).
export function emit(stateDir, comm) {
  const fired_at = nowISO(stateDir);
  const body_sha256 = sha256(comm.body || '');
  const priorDrafts = readComms(stateDir).filter((r) => r.comm_id === comm.comm_id && r.kind === 'draft');
  if (priorDrafts.length) {
    const last = priorDrafts[priorDrafts.length - 1];
    if (last.body_sha256 === body_sha256) {
      // already drafted, content unchanged -> idempotent no-op. Report the existing disposition.
      return readComms(stateDir).some((r) => r.comm_id === comm.comm_id && r.kind === 'send') ? 'auto_sent' : 'gated_no_send';
    }
  }
  const supersedes = priorDrafts.length ? priorDrafts[priorDrafts.length - 1].body_sha256 : null;
  append(stateDir, { kind: 'draft', comm_id: comm.comm_id, comm_type: comm.comm_type, channel: comm.channel, recipient_class: comm.recipient_class, trigger: comm.trigger || null, fired_at, subject: comm.subject || null, body: comm.body || '', body_sha256, supersedes });
  if (comm.channel === 'telegram') routeTelegram(stateDir, comm);   // tg-outbox enforces auto vs staged
  if (isAutoSendAllowed(comm)) {
    append(stateDir, { kind: 'gate', comm_id: comm.comm_id, decision: 'auto', decided_by: 'allowlist:§0.4', decided_at: fired_at });
    append(stateDir, { kind: 'send', comm_id: comm.comm_id, sent_at: fired_at, transport_status: 'sent', via: comm.channel });
    return 'auto_sent';
  }
  // DEFAULT-DENY: drafted + staged, NOT sent. Released only by a later Approve.
  append(stateDir, { kind: 'gate', comm_id: comm.comm_id, decision: 'gated', decided_by: 'default-deny', decided_at: fired_at });
  return 'gated_no_send';
}

// Fold the ledger into per-comm lifecycle (a derived projection).
export function foldComms(stateDir) {
  const out = {};
  for (const r of readComms(stateDir)) {
    out[r.comm_id] ||= { comm_id: r.comm_id, drafted: false, gate: null, sent: false };
    if (r.kind === 'draft') { out[r.comm_id].drafted = true; out[r.comm_id].comm_type = r.comm_type; out[r.comm_id].channel = r.channel; out[r.comm_id].recipient_class = r.recipient_class; }
    else if (r.kind === 'gate') out[r.comm_id].gate = r.decision;
    else if (r.kind === 'send') out[r.comm_id].sent = true;
  }
  return out;
}

// Deterministic onboarding comms (C1 proposal + C2 welcome) from the brain — client-facing
// EMAILS, so they are gated (drafted, never auto-sent). Personalised from brain facts.
export function emitOnboardingComms(stateDir) {
  const profile = (() => { try { return readFileSync(path.join(stateDir, 'profile.yaml'), 'utf8'); } catch { return ''; } })();
  const brain = (() => { try { return JSON.parse(readFileSync(path.join(stateDir, 'brain', '.index.json'), 'utf8')); } catch { return null; } })();
  if (!brain) return 0;
  const first = (profile.match(/user_short:\s*"([^"]+)"/) || [, 'there'])[1];
  const biz = (profile.match(/voice_note:.*runs ([^(]+) \(/) || [, 'your business'])[1].trim();
  const pain1 = (brain.facts.find((f) => f.type === 'pain') || {}).statement || 'your top priority';
  const client_id = path.basename(path.dirname(stateDir));
  const c1 = {
    comm_id: `${client_id}:C1:proposal`, comm_type: 'proposal_summary', channel: 'email', recipient_class: 'client',
    trigger: { kind: 'state', detected: 'prospect->proposed' }, subject: `Your AI OS — proposal`,
    body: `Hi ${first},\n\nThanks for the chat. The thing you flagged as hurting most — ${pain1} — is exactly what we'll fix first. Over four blocks (Setup, Make-it-yours, Connect, Run-your-week) I'll build you an assistant that drafts those replies for you so they go out same-day.\n\nThe Coaching Block is $1,000.\n\nIf you're happy, reply and I'll send your first session time.\n\n— Sam`,
  };
  const c2 = {
    comm_id: `${client_id}:C2:welcome`, comm_type: 'welcome', channel: 'email', recipient_class: 'client',
    trigger: { kind: 'state', detected: 'won->onboarding' }, subject: `Welcome — your first session`,
    body: `Hi ${first},\n\nWelcome aboard. Your first session (Pack 0 — Setup) is booked. One small thing before then: log in to your assistant and say hello so I know it's reached you.\n\nTalk soon,\nSam`,
  };
  emit(stateDir, c1);
  emit(stateDir, c2);
  return 2;
}
