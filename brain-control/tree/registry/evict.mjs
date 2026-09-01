// evict.mjs · the registry half of EVICT (Mountain model, 2026-08-04): the
// rock's right to end an anchor tie for non-payment or disruption. Nothing is
// destroyed — the row closes (status left + key_dates.left) and stays as
// history; the box re-anchors to the Mountain on its own side (evict-apply.sh
// via the inbox notice, delivered BEFORE the row closes because push-down
// refuses non-active rows: the order is load-bearing and lives in
// orchestrator/evict-member.mjs).
//
// Same write discipline as set-field.mjs: touch the exact lines meant, leave
// every other byte alone (the 2026-08-03 live-cert lesson).
import { setScalar } from './set-field.mjs';

export function evictRow(text, { date, how, mineral } = {}) {
  const d = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('evictRow needs date: YYYY-MM-DD');
  // rows carry trailing comments on field lines (the template ships them);
  // match the value, not the whole line
  const status = (String(text).match(/^status:\s*"?([a-z]+)"?/m) || [, ''])[1];
  if (!status) throw new Error('row has no top-level status line; refusing to guess');
  if (status === 'left') throw new Error('already left: nothing to evict');
  let after = setScalar(text, 'status', 'left');
  // key_dates.left is nested (two-space indent); only that exact line moves
  if (/^ {2}left:.*$/m.test(after)) after = after.replace(/^ {2}left:.*$/m, `  left: "${d}"`);
  // The tombstone (run-6 audit, 2026-08-17): a closed row must say HOW the
  // membership ended and what the rock knows happened to the mineral, or the
  // panel is left to render "no record of whether their mineral still exists"
  // for every ended row alike. Evict never destroys, so the default states it.
  after = setScalar(after, 'left_how', String(how || 'evicted'));
  after = setScalar(after, 'left_mineral', String(mineral || 're-anchored to crads-ai; member-held, nothing destroyed'));
  return after;
}
