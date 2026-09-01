// re-anchor.mjs · T2.4: the anchor move on the REGISTRY PLANE, pure + testable.
// Ruled (three dials + reconciliation): the anchor is ONE movable management
// relationship; re-anchoring moves seat/registry/heartbeats to the new rock by
// two-consent. These are the executor primitives either side's reconcile runs
// after the requests engine says 'accepted' (kind 're-anchor'):
//   exportRowForReAnchor  - old side serialises the governed fields (payload-safe)
//   importReAnchoredRow   - new side lands the row with anchor rewritten; the old
//                           anchor DEMOTES to a community membership (dropping it
//                           is a separate verb); owner pointer untouched (owner
//                           rides ownership, not anchoring); validated pre-write
//   markRowReAnchored     - old side stamps its row left + moved-to (never deleted)
// The box-side heartbeat-channel swap (new heartbeat repo + conf re-point) is
// choreographed OUTSIDE these primitives; see the plan's BLOCKED note.
import { normalizeRow, validateRow } from './normalize-row.mjs';

const GOVERNED = ['slug', 'status', 'owner', 'managed_by', 'anchor', 'memberships', 'tier', 'legacy_level'];

export function exportRowForReAnchor(row = {}, opts = {}) {
  const n = normalizeRow(row, opts);
  const out = {};
  for (const k of GOVERNED) out[k] = n[k];
  return out;
}

export function importReAnchoredRow(fields = {}, { anchorSlug = '' } = {}) {
  if (!fields.slug || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(fields.slug)) {
    throw new Error(`bad slug in re-anchor payload (got "${fields.slug || ''}")`);
  }
  if (!anchorSlug) throw new Error('the importing org must know its own anchor slug');
  // The new anchor claims the row; the OLD anchor stays in memberships (its
  // demotion to community is automatic; dropping it entirely is its own verb).
  const memberships = Array.isArray(fields.memberships) ? fields.memberships.slice() : [];
  const n = normalizeRow({ ...fields, anchor: anchorSlug, memberships }, { anchorSlug });
  const problems = validateRow(n);
  if (problems.length) throw new Error(`re-anchor payload would land an invalid row: ${problems.join(' | ')}`);
  return n;
}

export function markRowReAnchored(row = {}, movedTo = '', date = '') {
  return { ...row, status: 'left', anchor_moved_to: movedTo, anchor_moved: date };
}
