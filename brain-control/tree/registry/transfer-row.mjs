// transfer-row.mjs · T2.3: the ownership POINTER MOVE executor for a registry
// row. Consent (both owners, via the requests engine) has already happened by
// the time this runs; here the flip is GUARDED: the incoming owner must hold an
// edge on the box BEFORE the move (no absentee owners, checked pre-flip, not
// just post-hoc), D60 holds for any owning org, and a no-op move is refused so
// choreography bugs surface instead of silently "succeeding".
// Pure: no fs, no network. Consumers rewrite the YAML from the returned row.
import { normalizeRow, validateRow } from './normalize-row.mjs';

const SLUG_OK = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function transferRowOwner(row = {}, newOwner = '', opts = {}) {
  if (!newOwner || (newOwner !== 'member' && !SLUG_OK.test(newOwner))) {
    throw new Error(`new owner must be 'member' or an org slug (got "${newOwner}")`);
  }
  const n = normalizeRow(row, opts);
  if (n.owner === newOwner) throw new Error(`already owned by '${newOwner}' (no-op transfer refused)`);
  if (newOwner !== 'member') {
    const edges = new Set([n.anchor, ...n.memberships].filter(Boolean));
    if (!edges.has(newOwner)) {
      throw new Error(`edge required: '${newOwner}' holds no edge on this box (must be the anchor or a membership before it can own)`);
    }
    if (n.managed_by === 'member') {
      throw new Error(`managed_by 'member' is illegal on an org-owned box: change management before transferring to '${newOwner}' (D60)`);
    }
  }
  const out = { ...n, owner: newOwner };
  const problems = validateRow(out);
  if (problems.length) throw new Error(`transfer would leave an invalid row: ${problems.join(' | ')}`);
  return out;
}
