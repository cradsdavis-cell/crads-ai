// membership.mjs · add and drop a row's COMMUNITY ties, in the row's own text.
//
// Why this exists (live cert, 2026-08-03): a registry row's `memberships:` list
// was written once at birth and never touched again. Nothing in either repo
// added to it or removed from it. So late-attach could be requested, accepted,
// cycle-guarded and recorded as an orgedge at the directory while the box's own
// row never learned it had joined; drop-membership had nowhere to write; and
// cross-org transfer was unreachable, because transfer-row refuses an owner
// holding no edge and late-attach was the only way to gain one.
//
// Text-in, text-out, for the same reason set-field.mjs is: a row carries sixty-one
// fields and regenerating one destroys everything the ownership model does not
// happen to model.

const ORG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/* Locate the `memberships:` block: its header line, its items, and the line
   after it. Items may be quoted or bare; the header is preserved byte-for-byte. */
function locate(text) {
  const lines = text.split('\n');
  const head = lines.findIndex((l) => /^memberships:/.test(l));
  if (head === -1) return null;
  let end = head + 1;
  const items = [];
  while (end < lines.length && /^\s+-\s*\S/.test(lines[end])) {
    items.push(lines[end].replace(/^\s+-\s*/, '').trim().replace(/^["']|["']$/g, ''));
    end += 1;
  }
  return { lines, head, end, items, header: lines[head] };
}

export function readMemberships(text) {
  const at = locate(text);
  return at ? at.items : [];
}

/* Rewrite ONLY the block, keeping the header line (and any trailing comment on
   it) exactly, and every line outside the block untouched. */
function rewrite(text, items) {
  const at = locate(text);
  if (!at) throw new Error('this row has no memberships: block');
  const body = items.map((m) => `  - ${m}`);
  return [...at.lines.slice(0, at.head), at.header, ...body, ...at.lines.slice(at.end)].join('\n');
}

export function anchorOf(text) {
  return (text.match(/^anchor:\s*"?([a-z0-9-]+)"?/m) || [])[1] || '';
}

/* Add a COMMUNITY tie. Idempotent: the anchor is already a membership by
   invariant, so re-adding anything present is a no-op, never a duplicate. */
export function addMembership(text, org) {
  if (!ORG_RE.test(String(org ?? ''))) throw new Error(`not an org handle: "${org}"`);
  const items = readMemberships(text);
  if (items.includes(org)) return text;
  return rewrite(text, [...items, org]);
}

/* Drop a COMMUNITY tie. REFUSES to drop the anchor: a box's home ends through
   re-anchor or leaving, never by quietly deleting the edge that carries its
   seat, its registry row and its bill. Idempotent on a tie that is not there. */
export function dropMembership(text, org) {
  if (!ORG_RE.test(String(org ?? ''))) throw new Error(`not an org handle: "${org}"`);
  if (org === anchorOf(text)) {
    throw new Error(`"${org}" is this box's anchor, not a community tie: end it with re-anchor or leave, so the seat and the bill move deliberately`);
  }
  // NO ABSENTEE OWNERS. The anchor check above is not enough: after a cross-org
  // transfer the OWNER is a community org, not the anchor, and dropping that tie
  // strips the owner's only edge. validateRow then reports "absentee owner" on
  // every read, transferRowOwner refuses to move it (it requires an edge
  // pre-flip), and the verb that could repair it is adminOnly on the ANCHOR's
  // rock, which is no longer the owner. So the owning org could be evicted from
  // its own box by the anchor, and neither side could put it back.
  const owner = (text.match(/^owner:\s*"?([a-z0-9-]+)"?/m) || [, 'member'])[1];
  if (owner !== 'member' && owner === org) {
    throw new Error(`"${org}" OWNS this box; dropping its membership would leave an owner with no edge. `
      + 'Transfer ownership first, then end the community tie.');
  }
  const items = readMemberships(text);
  if (!items.includes(org)) return text;
  return rewrite(text, items.filter((m) => m !== org));
}
