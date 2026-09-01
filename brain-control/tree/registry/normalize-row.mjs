// normalize-row.mjs · the owner POINTER + migration-on-read for registry rows.
// T1.1 of the productionisation plan (E1), under the 2026-07-28 model
// reconciliation: canonical vocabulary is anchor / memberships / tier(rock|pebble)
// / managed_by, and `owner` becomes a MOVABLE POINTER: 'member' or an org slug.
//
// Pure + testable: no fs, no network, no YAML dependency (same regex-reader
// style as build-index.mjs). Live rows never need hand-editing: normalizeRow is
// the migration, applied on read wherever rows are consumed.
//
// Rules encoded here (rulings 26-28 Jul):
// - owner '' -> 'member'; the binary 'org' -> the anchor org's slug (pointer form).
// - anchor '' -> the org whose registry the row lives in; anchor implies membership.
// - tier '' -> 'pebble'; tier rock|pebble is the STRUCTURAL pair. Any other value
//   is an old membership-level slug (levels killed 2026-07-27): it migrates to
//   `legacy_level` and tier becomes 'pebble'.
// - EDGE-REQUIRED (no absentee owners): an owning org must appear in the box's
//   anchor or memberships.
// - D60 generalised: org-owned (any org) requires managed_by != 'member'.

const TIERS = new Set(['rock', 'pebble']);
// 'invited' is a real lifecycle state, not a typo: stamp-pebble writes it for an
// invite-pending member (D51) and invite-reissue.sh reads it back. It was missing
// here, so EVERY freshly stamped member was reported invalid until they claimed
// ("status 'invited' is not active|paused|left"), which is exactly what a live
// stamp printed on 2026-08-03. A cohort of ten would have shown ten bogus
// findings and no way to tell a real problem from the normal waiting state.
const STATUSES = new Set(['invited', 'active', 'paused', 'left']);
const MANAGERS = new Set(['member', 'org', 'crads-ai']);

export function normalizeRow(row = {}, { anchorSlug = '' } = {}) {
  const out = { ...row };
  // 'org' is the same legacy shorthand in anchor/memberships as in owner: the
  // row template carried it as a literal (T1.6 live-cert finding), and it
  // always means the org whose registry holds the row.
  let anchor = (row.anchor || '').trim() || anchorSlug;
  if (anchor === 'org') anchor = anchorSlug || 'org';
  out.anchor = anchor;

  let memberships = (Array.isArray(row.memberships) ? row.memberships.slice() : [])
    .map((m) => (m === 'org' ? anchorSlug || 'org' : m));
  memberships = memberships.filter((m, i) => memberships.indexOf(m) === i);
  if (anchor && !memberships.includes(anchor)) memberships.unshift(anchor);
  out.memberships = memberships;

  let owner = (row.owner || '').trim() || 'member';
  if (owner === 'org') owner = anchor || 'org';
  out.owner = owner;

  let tier = (row.tier || '').trim();
  let legacy = (row.legacy_level || '').trim();
  if (tier && !TIERS.has(tier)) { legacy = legacy || tier; tier = 'pebble'; }
  out.tier = tier || 'pebble';
  out.legacy_level = legacy;

  out.managed_by = (row.managed_by || '').trim() || 'org';
  out.status = (row.status || '').trim() || 'active';
  return out;
}

export function validateRow(row = {}) {
  const problems = [];
  const owner = row.owner || '';
  if (!owner) problems.push('owner is empty after normalize');
  if (owner !== 'member') {
    const edges = new Set([row.anchor, ...(row.memberships || [])].filter(Boolean));
    if (!edges.has(owner))
      problems.push(`absentee owner: '${owner}' owns this box without an edge (must be the anchor or a membership)`);
    if (row.managed_by === 'member')
      problems.push(`managed_by 'member' is illegal on an org-owned box (owner '${owner}'): D60 invariant 6`);
  }
  if (!TIERS.has(row.tier)) problems.push(`tier '${row.tier}' is not rock|pebble`);
  if (!STATUSES.has(row.status)) problems.push(`status '${row.status}' is not invited|active|paused|left`);
  if (!MANAGERS.has(row.managed_by)) problems.push(`managed_by '${row.managed_by}' is not member|org|crads-ai`);
  if (row.anchor && Array.isArray(row.memberships) && !row.memberships.includes(row.anchor))
    problems.push('anchor missing from memberships (anchor implies membership)');
  return problems;
}

// Extract the governed fields from a row's YAML text (flat regex reader, no deps).
export function extractRow(y = '') {
  const scalar = (key) => {
    const m = y.match(new RegExp(`^${key}:\\s*"?([^"\\n#]*)"?`, 'm'));
    return m ? m[1].trim() : '';
  };
  // The header may carry a trailing comment, and on a real row it always does:
  // _TEMPLATE.yaml ships `memberships:   # orgs this box holds membership in...`
  // and stamp-pebble.sh's seds never strip it. Anchoring on `^key:\s*$` therefore
  // matched NOTHING on every row ever stamped, so extractRow returned [] while
  // membership.mjs (looser `^memberships:`) read the same file correctly: two
  // readers in one directory disagreeing about one file. The visible damage was
  // community ties being invisible to the console and to registry/index.json,
  // and validateRow calling a community owner an absentee (no edge), which is
  // what makes cross-org transfer refuse. Comments are also stripped from each
  // ITEM, since `- beta  # joined 2026-08` is the same trap one line down.
  const list = (key) => {
    const block = (y.split(new RegExp(`^${key}:[ \\t]*(?:#[^\\n]*)?$`, 'm'))[1] || '').split(/^\S/m)[0];
    return (block.match(/^\s*-\s*(.+)$/gm) || [])
      .map((l) => l.replace(/^\s*-\s*/, '').replace(/\s+#.*$/, '').trim())
      .filter(Boolean);
  };
  return {
    slug: scalar('slug'),
    status: scalar('status'),
    owner: scalar('owner'),
    managed_by: scalar('managed_by'),
    anchor: scalar('anchor'),
    memberships: list('memberships'),
    tier: scalar('tier'),
    legacy_level: scalar('legacy_level'),
    infra_push_consent: scalar('infra_push_consent'),
    read_consent: scalar('read_consent'),
    delivery_pause: scalar('delivery_pause'),
  };
}

// ---------------------------------------------------------------- sinks (T1.4)
// The C1 metadata split (system-logic pass 2026-07-27), spoken in reconciliation
// vocabulary: REGISTRY ROW + HEARTBEAT repo belong to the box's ANCHOR, always;
// HOST TELEMETRY (VM-level liveness) belongs to whoever RUNS the box
// (managed_by, resolved to a name: the member, the anchor org, or crads-ai);
// machinery care stays with the platform. Derived from a NORMALIZED row.
export function sinksFor(row = {}) {
  const anchor = row.anchor || '';
  const runner = row.managed_by === 'org' ? anchor : row.managed_by;
  return {
    registry: anchor,
    heartbeat: anchor,
    host_telemetry: runner,
    machinery: row.machinery_by || 'crads-ai',
  };
}
