#!/usr/bin/env node
// catalog-lib.mjs — pure entitlement + rendering rules for the member-facing
// catalog (ai-os spec 2026-08-04 § 7). No filesystem, no git: catalog-reconcile
// (and, until one-inbox retired it, catalog-requests-reconcile) own IO; this
// owns meaning. checkRequest below is kept for the same reason the vocabulary
// is: it is pure, tested, and the shape a future request-style path would want.
//
// catalog/policy.json (org-authored, edited from the app's Catalogue tab):
//   { "defaults": { "audience": "none" },
//     "items": { "deep-research":  { "audience": "tied" },
//                "pricing-review": { "audience": ["alice", "brendan"] } } }
//
// ONE CONTROL, THREE STATES (one-inbox spec 2026-08-17 § 4; Sam's ruling 17 Aug).
// audience: "tied" (everyone tied to this rock) | "none" (authored, offered to
// nobody) | [slugs] (exactly those minerals). Absent item -> defaults.audience.
// Absent policy -> nothing is offered: publishing is the consent (grill
// 2026-08-04), so the safe default is a closed catalogue.
//
// "all" is the pre-one-inbox spelling of "tied" and is accepted forever: live
// rocks have it written into policy.json and a rename must never silently
// un-offer somebody's catalogue. It normalises to "tied" on read, so everything
// downstream sees one value.
//
// A LIST NAMES MINERALS, NOT SEATS. The one-inbox spec first claimed a chosen
// list was a seated-only tier "because a joined member has no slug". That is
// wrong and the code says so: ties are recorded as registry/ties/<slug>.json and
// isEntitled matches on slug, so a list reaches a joined mineral exactly as it
// reaches a hosted one. Which is better than the claim: the control carries no
// seat-versus-tie distinction at all, so there is one audience model rather than
// one with a footnote.
//
// Enforced BOTH at materialisation (a box never even receives metadata it is not
// entitled to) and at pickup (a package that was never offered is not on the
// member's disk to copy).

export function parsePolicy(raw) {
  let p = raw;
  if (typeof raw === 'string') { try { p = JSON.parse(raw); } catch { p = null; } }
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = {};
  const defAud = normAudience((p.defaults || {}).audience, 'none');
  const items = {};
  for (const [id, item] of Object.entries(p.items || {})) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) continue;
    items[id] = { audience: normAudience(item && item.audience, defAud) };
  }
  return { defaults: { audience: defAud }, items };
}

function normAudience(a, fallback) {
  if (a === 'tied' || a === 'all') return 'tied';   // "all" is the legacy spelling; live rocks carry it
  if (a === 'none') return 'none';
  if (Array.isArray(a)) return a.filter((s) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(String(s)));
  return fallback;
}

export function isEntitled(policy, id, slug) {
  const aud = (policy.items[id] || { audience: policy.defaults.audience }).audience;
  if (aud === 'tied') return true;
  if (aud === 'none') return false;
  return aud.includes(slug);   // a slug names a mineral, seated or tied alike
}

// Categories are a fixed platform taxonomy (ai-os spec
// 2026-08-09-pebble-dashboard-audit.md § R7): a manifest must name one of
// these six, and the publish path REFUSES anything else by name instead of
// silently bucketing it as "other". The community pipe (directory
// /community-catalog + the community-catalog-push verb) enforces the same
// list box-side and at the wire; this is the anchored pipe's copy of it.
export const CATEGORIES = ['briefing', 'capture', 'comms', 'box', 'org', 'other'];

// Splits a library into publishable items and named refusals. Absent counts
// as unknown: R7 says the manifest must name a category, so there is no
// default. Refusals carry exactly what the rock needs to fix the manifest:
// the item id, what it declared, and (via CATEGORIES) what is allowed.
//
// A SECOND, distinct refusal reason lives here too (step 2, delivery-model):
// catalog/policy.json (isEntitled) is one flat id namespace across skills,
// prompts, pages, dirs and packs, so two category-valid items sharing an id
// would make one of them silently un-entitleable rather than visibly broken.
// Every copy of a collided id is refused by name, never guessed at, and the
// refusal record carries a `why` so this reason is distinguishable from a
// category refusal. A category refusal above never carries `why`: its shape
// is untouched, byte-identical to before this change.
export function enforceCategories(library) {
  const ok = [], refused = [];
  for (const s of library || []) {
    if (CATEGORIES.includes(s.category)) ok.push(s);
    else refused.push({ id: s.id, kind: s.kind || 'skill', category: String(s.category ?? '') });
  }

  const byId = new Map();
  for (const s of ok) {
    if (!byId.has(s.id)) byId.set(s.id, []);
    byId.get(s.id).push(s);
  }
  const deduped = [];
  for (const entries of byId.values()) {
    if (entries.length < 2) { deduped.push(entries[0]); continue; }
    const kinds = [...new Set(entries.map((e) => e.kind || 'skill'))].sort().join(', ');
    for (const e of entries) {
      refused.push({ id: e.id, kind: e.kind || 'skill', category: e.category,
        why: `duplicate id across kinds: ${kinds}` });
    }
  }

  refused.sort((a, b) => a.id.localeCompare(b.id));
  return { library: deduped, refused };
}

function buildCatalogItem(s) {
  const it = {
    id: s.id, kind: s.kind || 'skill', version: s.version || 0,
    title: s.title || '', description: s.description || '', category: s.category,
    gate: s.gate || '', outbound: s.outbound === true,
  };
  if (s.kind === 'pack') {
    it.fee = Number(s.fee) || 0;
    it.contents = { skills: (s.contents && s.contents.skills) || [],
      files: (s.contents && s.contents.files) || 0, pages: (s.contents && s.contents.pages) || [],
      dirs: (s.contents && s.contents.dirs) || [] };
  }
  return it;
}

// A pack's contents.* entries, pooled from all five keys into one flat list,
// in the exact order engine/ops/skill-scrub.mjs's packAllEntries pools them
// (delivery-model step 1). One pooling helper, read by both the id-matching
// below and the scrub/delivery parity test, so there is one list of "what a
// pack names", not two that could silently drift.
export function packContentEntries(pack) {
  const c = (pack && pack.contents) || {};
  return [
    ...(c.skills || []), ...(c.context || []), ...(c.prompts || []),
    ...(c.pages || []), ...(c.dirs || []),
  ];
}

const ITEM_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

// A pack has no payload of its own (delivery-model 2026-08-26 step 6): it is
// a named bundle of library item ids, and its contents.* lists are id-first,
// path-second. An entry:
//   - containing ".." is a traversal attempt: refused, never resolved.
//   - matching the id shape AND naming a real library item (never a pack;
//     packs cannot bundle a pack) resolves to that item.
//   - matching the id shape but naming nothing real is reported, not
//     silently dropped (a pack.yaml typo must not fail dark).
//   - anything else (not id-shaped at all, e.g. "prompts/kickoff.md") is a
//     pack-relative path: install-pack.mjs still delivers it exactly as it
//     does today, so it is neither expanded nor reported here.
// This is the SAME rule skill-scrub.mjs's pack expansion uses (step 1); see
// tests/pack-content-delivery.test.mjs's scrub/delivery agreement test.
function resolvePackContents(pack, library) {
  const nonPackById = new Map(library.filter((s) => s.kind !== 'pack').map((s) => [s.id, s]));
  const expanded = [];
  const issues = [];
  for (const entry of packContentEntries(pack)) {
    if (typeof entry !== 'string') continue;
    if (entry.includes('..')) { issues.push({ pack: pack.id, entry, reason: 'contents entry escapes the pack dir' }); continue; }
    if (!ITEM_ID_RE.test(entry)) continue;   // a pack-local path, not an id attempt
    const item = nonPackById.get(entry);
    if (!item) { issues.push({ pack: pack.id, entry, reason: 'not a known library id' }); continue; }
    expanded.push(item);
  }
  return { expanded, issues };
}

// The set of ids a pack's contents resolve to, id-first-path-second, against
// a plain list (or Set) of the library's non-pack ids. Exported standalone
// (not just via renderCatalog) so a test can assert this set against an
// independent re-implementation of skill-scrub.mjs's packContentIds without
// needing a full library or policy.
export function packExpandedIds(pack, nonPackLibraryIds) {
  const ids = nonPackLibraryIds instanceof Set ? nonPackLibraryIds : new Set(nonPackLibraryIds);
  return packContentEntries(pack).filter((e) => ITEM_ID_RE.test(e) && ids.has(e));
}

// library: [{ id, kind, version, title, description, category, gate, outbound,
//             fee?, contents? }] — packs carry fee + a contents summary so the
// member's box can render what a pack ships and detect when it has landed.
// Returns the one member's entitled catalog view. Deterministic order (by id)
// so the reconcile's no-change comparison is stable. Expects a library that
// already passed enforceCategories: there is deliberately no category
// fallback here, because "|| 'other'" was the silent bucket R7 refuses.
//
// PACK EXPANSION (delivery-model 2026-08-26, step 6): an entitled pack has
// no payload of its own; it entitles its CONTENTS. Every content id (via
// resolvePackContents above) becomes an ordinary item in `items`, tagged
// `via: '<pack-id>'`, unless the member is ALSO directly entitled to that id
// -- direct entitlement wins (no via tag, no duplicate), because the member
// would keep the item in their own right if the pack were withdrawn. The
// pack row itself is untouched: it stays in `items` purely for grouping.
// `missing` carries every contents.* entry that could not be resolved (a bad
// id, or a traversal attempt), so a broken pack.yaml is visible, not silent.
export function renderCatalog({ policy, library, slug, rock }) {
  const entitled = library.filter((s) => isEntitled(policy, s.id, slug));
  const entitledIds = new Set(entitled.map((s) => s.id));
  const items = entitled.map(buildCatalogItem);
  const seen = new Set(items.map((i) => i.id));
  const missing = [];

  for (const pack of entitled) {
    if (pack.kind !== 'pack') continue;
    const { expanded, issues } = resolvePackContents(pack, library);
    missing.push(...issues);
    for (const item of expanded) {
      if (entitledIds.has(item.id) || seen.has(item.id)) continue;   // direct wins; or already expanded via another pack
      seen.add(item.id);
      const it = buildCatalogItem(item);
      it.via = pack.id;
      items.push(it);
    }
  }

  items.sort((a, b) => a.id.localeCompare(b.id));
  return { rock: rock || '', items, missing };
}

// Fulfilment check for one heartbeat-carried request. Returns { ok } or
// { ok: false, why } — the why is logged, never sent anywhere.
export function checkRequest(policy, library, slug, req) {
  const id = String((req && req.id) || '');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) return { ok: false, why: 'malformed id' };
  const item = library.find((s) => s.id === id);
  if (!item) return { ok: false, why: 'not in the library' };
  if (!isEntitled(policy, id, slug)) return { ok: false, why: 'not entitled (policy re-checked at fulfilment)' };
  return { ok: true, id, version: item.version || 0, kind: item.kind || 'skill' };
}
