#!/usr/bin/env node
// delete-box.mjs — right-to-erasure for ONE client box (spec §3.P6.X deletion, gate G6).
//
// Removes a single client's entire box (filesystem + git repo) so that NOTHING of theirs
// survives anywhere, while leaving every OTHER client's box byte-identical — and records an
// operator-side tombstone so the erasure is auditable (no silent drop). The deletion ledger
// lives in the OPERATOR cockpit, NEVER inside a client box, and carries no client PII beyond
// the opaque client_id + canary (so the tombstone itself cannot re-leak the deleted data).
//
//   node delete-box.mjs <box_base> <client_id> <ops_ledger_path> [--canary=X] [--reason="..."]
import { rmSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';

export function deleteBox(boxBase, clientId, opsLedgerPath, { reason = 'client right-to-erasure request', canary = null, ts = null } = {}) {
  if (!existsSync(boxBase)) return { ok: false, reason: 'box-not-found', client_id: clientId };
  rmSync(boxBase, { recursive: true, force: true });           // erase fs + the box's own git repo
  const removed = !existsSync(boxBase);
  // operator-side audit tombstone (append-only; no PII beyond opaque id + canary).
  mkdirSync(path.dirname(opsLedgerPath), { recursive: true });
  const row = { kind: 'deletion', client_id: clientId, removed, canary, reason, recorded_marker: ts };
  appendFileSync(opsLedgerPath, JSON.stringify(row) + '\n');
  return { ok: removed, ...row };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [boxBase, clientId, opsLedger] = process.argv.slice(2);
  const canary = (process.argv.find((a) => a.startsWith('--canary=')) || '').split('=')[1] || null;
  const reason = (process.argv.find((a) => a.startsWith('--reason=')) || '').split('=')[1] || undefined;
  console.log(JSON.stringify(deleteBox(boxBase, clientId, opsLedger, { canary, reason }), null, 2));
}
