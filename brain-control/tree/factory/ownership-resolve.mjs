#!/usr/bin/env node
// ownership-resolve.mjs · resolve a box's ownership record at stamp time.
// Pure + testable: no fs, no network. factory/stamp-pebble.sh shells out to it.
// Usage: node factory/ownership-resolve.mjs --policy-default <member|org> \
//          [--owner <member|org>] [--owner-org <slug>] [--managed-by <member|org|crads-ai>] [--machinery-by crads-ai]
// Prints one-line JSON {tier,owner,owner_slug,managed_by,machinery_by} on stdout (exit 0),
// or a message on stderr (exit 1) if a value is invalid or the invariant breaks.

const OWNERS = new Set(['member', 'org']);
const MANAGERS = new Set(['member', 'org', 'crads-ai']);

export function resolveOwnership({ policyDefault = '', owner = '', ownerOrg = '', managedBy = '', machineryBy = '', anchorOrg = '' } = {}) {
  const o = owner || policyDefault || 'member';
  if (!OWNERS.has(o)) throw new Error(`owner must be member|org (got "${o}")`);
  const m = managedBy || 'org';
  if (!MANAGERS.has(m)) throw new Error(`managed_by must be member|org|crads-ai (got "${m}")`);
  const mach = machineryBy || 'crads-ai';
  if (mach !== 'crads-ai') throw new Error(`machinery_by must be crads-ai (got "${mach}")`);
  if (o === 'org' && m === 'member') {
    throw new Error('owner:org requires managed_by != member (a member never manages an org-owned box)');
  }
  // The OWNER POINTER (reconciliation 2026-07-28): who owns the box, named.
  // member-owned carries an empty pointer; org-owned records the owning org's
  // slug (at stamp that is the stamping org; transfer moves it later). No
  // anonymous org owner: an org-owned box must name its org.
  const owner_slug = o === 'org' ? String(ownerOrg || '').trim() : '';
  if (o === 'org' && !owner_slug) {
    throw new Error('owner:org requires --owner-org <slug> (the owning org must be named)');
  }
  // UNIFORM ANCHOR RULE (Mountain model, 2026-08-04): every box has exactly one
  // anchor; there is no anchorless state. At stamp time the anchor IS the stamping
  // org. A box with no org context (self-serve, post-eviction) anchors to the
  // Mountain: 'crads-ai' is the fallback, never empty.
  const anchor = String(anchorOrg || '').trim() || 'crads-ai';
  return { tier: 'pebble', owner: o, owner_slug, managed_by: m, machinery_by: mach, anchor };
}

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}

// CLI only when invoked directly (the test imports resolveOwnership instead).
if (process.argv[1] && process.argv[1].endsWith('ownership-resolve.mjs')) {
  try {
    const rec = resolveOwnership({
      policyDefault: argOf('--policy-default'),
      owner: argOf('--owner'),
      ownerOrg: argOf('--owner-org'),
      managedBy: argOf('--managed-by'),
      machineryBy: argOf('--machinery-by'),
      anchorOrg: argOf('--anchor'),
    });
    process.stdout.write(JSON.stringify(rec) + '\n');
  } catch (e) {
    process.stderr.write(String(e.message || e) + '\n');
    process.exit(1);
  }
}
