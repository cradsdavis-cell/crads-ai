// mineral-identity.mjs — who this mineral IS, who HOLDS it, and who may REACH
// it (the ownership/access model, 2026-08-10).
//
// THE TWO AXES, and the reason this file exists at all. Before it, a mineral
// recorded ownership as a ROLE with no person in it (`owner: "member"`), so
// "which minerals does this account hold?" was unanswerable from product data:
// keith booted not knowing whose it was, and test-org-4 said it was owned by
// itself. Meanwhile the only other person-shaped record, the SSH device
// roster, answers a different question entirely — which MACHINES may connect,
// not which ACCOUNTS may reach it.
//
//   OWNERSHIP — who holds this mineral and its IP. Exactly one holder: a
//     person, or a rock (a company owning its members' pebbles). Governs
//     custody, transfer, billing, destruction.
//   ACCESS — which accounts may reach it. MANY. Governs day-to-day use,
//     support, and who may enrol a device at all.
//
// Filtering a person's mineral list by OWNERSHIP hides the assistant they use
// every day whenever a company owns it, which is the normal case in the
// Practice Partner model. So the account lists what it can REACH, and shows
// ownership as an attribute.
//
// Identity: a mineral mints a serial once and keeps it forever. Records point
// at the serial, never the address, so a rename, a rebuild or a move to a new
// host cannot orphan them — the same fix the account's permanent id made one
// layer up. The two roles are `owner` and `user`; support borrows the owner's
// identity rather than inventing a permission matrix.
//
// All of it lives in /state/ownership.json, which the D60 charter already
// calls the source of truth for ownership. The directory holds a mirror.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export const MINERAL_ID_RE = /^min_[0-9a-f]{24}$/;
export const ACCOUNT_ID_RE = /^acc_[0-9a-f]{24}$/;
export const ROLES = ['owner', 'user'];

export const newMineralId = () => 'min_' + randomBytes(12).toString('hex');
export const emailHash = (email) => createHash('sha256').update(String(email || '').toLowerCase()).digest('hex');

const fileOf = (stateDir) => path.join(stateDir, 'ownership.json');

export function readOwnership(stateDir) {
  try { return JSON.parse(readFileSync(fileOf(stateDir), 'utf8')); } catch { return {}; }
}

function write(stateDir, rec) {
  try { mkdirSync(stateDir, { recursive: true }); } catch { /* exists */ }
  writeFileSync(fileOf(stateDir), JSON.stringify(rec, null, 2) + '\n');
  return rec;
}

/**
 * The mineral's serial, minted once. Never regenerated: a second serial would
 * present the same mineral as a new one and orphan every record pointing at
 * the first.
 */
export function ensureMineralId(stateDir) {
  const rec = readOwnership(stateDir);
  if (MINERAL_ID_RE.test(String(rec.mineral_id || ''))) return rec.mineral_id;
  rec.mineral_id = newMineralId();
  write(stateDir, rec);
  return rec.mineral_id;
}

const grantOf = (g) => ({
  account_id: String(g.account_id || ''),
  email: String(g.email || '').toLowerCase(),
  role: ROLES.includes(g.role) ? g.role : 'user',
  granted: g.granted || new Date().toISOString().slice(0, 10),
});

/**
 * Record who holds this mineral, and grant them owner access.
 *
 * FIRST CLAIM WINS: an owner already recorded is never silently replaced,
 * because a mineral that can be re-owned by whoever asks last is not owned at
 * all. A deliberate handover uses `transferOwner` below, which is what the
 * transfer machinery calls.
 *
 * `holder` is the person or the org: { account_id?, email?, kind: 'account'|'org', org? }
 */
export function claimOwner(stateDir, holder, { force = false } = {}) {
  const rec = readOwnership(stateDir);
  if (!MINERAL_ID_RE.test(String(rec.mineral_id || ''))) rec.mineral_id = newMineralId();

  const kind = holder.kind === 'org' ? 'org' : 'account';
  const next = kind === 'org'
    ? { kind: 'org', org: String(holder.org || '') }
    : { kind: 'account', account_id: String(holder.account_id || ''), email: String(holder.email || '').toLowerCase() };

  const prev = rec.holder;
  if (prev && !force) {
    const same = prev.kind === next.kind
      && (prev.kind === 'org' ? prev.org === next.org
        : (prev.account_id && prev.account_id === next.account_id) || (!!prev.email && prev.email === next.email));
    if (!same) return { ok: false, reason: 'this mineral already records a different holder; a change of hands is a transfer, not a claim', holder: prev };
    // same holder re-claiming: refresh the fields (an account that has since
    // gained an id, say) but never touch the access list
    rec.holder = { ...prev, ...next };
    write(stateDir, rec);
    return { ok: true, holder: rec.holder, already: true, mineral_id: rec.mineral_id };
  }

  rec.holder = next;
  // The holder always gets owner access; access is a separate list because
  // many accounts may reach one mineral and only one may hold it.
  rec.access = Array.isArray(rec.access) ? rec.access : [];
  if (kind === 'account' && (next.account_id || next.email)) {
    rec.access = rec.access.filter((g) => !sameAccount(g, next));
    rec.access.unshift(grantOf({ account_id: next.account_id, email: next.email, role: 'owner' }));
  }
  write(stateDir, rec);
  return { ok: true, holder: rec.holder, mineral_id: rec.mineral_id };
}

const sameAccount = (a, b) => (
  (a.account_id && b.account_id && a.account_id === b.account_id)
  || (!!a.email && !!b.email && String(a.email).toLowerCase() === String(b.email).toLowerCase())
);

/** Give an account access. Idempotent; re-granting updates the role. */
export function grantAccess(stateDir, grant) {
  const rec = readOwnership(stateDir);
  if (!grant || (!grant.account_id && !grant.email)) return { ok: false, reason: 'a grant needs an account id or an email' };
  if (grant.role && !ROLES.includes(grant.role)) return { ok: false, reason: `role must be one of ${ROLES.join(', ')}` };
  rec.access = Array.isArray(rec.access) ? rec.access : [];
  const g = grantOf(grant);
  const existing = rec.access.find((x) => sameAccount(x, g));
  if (existing) { existing.role = g.role; existing.email = g.email || existing.email; existing.account_id = g.account_id || existing.account_id; }
  else rec.access.push(g);
  write(stateDir, rec);
  return { ok: true, access: rec.access };
}

/**
 * Take access away. The HOLDER's own grant cannot be revoked — losing access
 * to what you own is not a thing this model allows; give it away instead.
 */
export function revokeAccess(stateDir, who) {
  const rec = readOwnership(stateDir);
  rec.access = Array.isArray(rec.access) ? rec.access : [];
  const target = { account_id: String(who.account_id || ''), email: String(who.email || '').toLowerCase() };
  if (rec.holder && rec.holder.kind === 'account' && sameAccount(rec.holder, target)) {
    return { ok: false, reason: 'that account holds this mineral; transfer it rather than removing its access' };
  }
  const before = rec.access.length;
  rec.access = rec.access.filter((g) => !sameAccount(g, target));
  write(stateDir, rec);
  return { ok: true, removed: before - rec.access.length, access: rec.access };
}

/**
 * A deliberate change of hands. The old holder KEEPS user access unless the
 * caller says otherwise: an eviction should not also lock someone out of the
 * machine they are still using while they migrate.
 */
export function transferOwner(stateDir, holder, { keepOldAccess = true } = {}) {
  const rec = readOwnership(stateDir);
  const prev = rec.holder;
  const out = claimOwner(stateDir, holder, { force: true });
  if (!out.ok) return out;
  if (prev && prev.kind === 'account') {
    if (keepOldAccess) {
      grantAccess(stateDir, { account_id: prev.account_id, email: prev.email, role: 'user' });
    } else {
      // claimOwner only rewrites the INCOMING holder's grant, so the outgoing
      // one survives unless it is explicitly removed. A "clean break" that
      // quietly left the old owner with access would be the worst kind of
      // silent failure in this whole model.
      const rec = readOwnership(stateDir);
      rec.access = (rec.access || []).filter((g) => !sameAccount(g, prev));
      write(stateDir, rec);
    }
  }
  return { ...out, previous: prev || null };
}

/** Everything the directory mirror needs, and nothing it does not. */
export function identityFacts(stateDir) {
  const rec = readOwnership(stateDir);
  // ONE FACT, ONE ARRAY. ownership.json carries who may open this mineral in two
  // places: `access` (written at birth, holder + owner row) and `grants` (written
  // by grants-cli when somebody is invited and proves the address). Only `access`
  // reaches the directory, because this is what /mineral-register mirrors, and
  // only the directory's per-account index feeds the account page.
  //
  // So an ACTIVE grant landed on the box, opened the SSH door, mirrored itself
  // into the edge graph, and never appeared on the grantee's "Your minerals"
  // page: the one surface that tells an account what it can reach. Proven
  // 2026-08-11 with two real accounts on qa-rock-a — grant active on the box,
  // edge:<hash>:qa-rock-a:admin present in KV, mineralidx for that account
  // absent, page empty.
  //
  // The grants list stays the record of intent (it holds pending rows, who
  // invited whom and when). This merges the PROVEN ones into the access view at
  // the point every mirror reads, so there is one answer to "who may open this"
  // rather than two that disagree.
  // PENDING RIDES TOO, AND SAYS SO (2026-08-12, Sam's ruling: "I don't want any
  // of this to depend on cron jobs").
  //
  // Until now only ACTIVE grants mirrored, which made the account page wait for
  // this box to wake up, notice a proof and activate it. Sam accepted an
  // invitation, went to his minerals, and saw nothing — correctly, because the
  // box had not run yet. Adding more cadence cannot fix that class: a timer is
  // still a timer.
  //
  // So the directory now gets the INTENT as well as the outcome. It already
  // holds the other half (proof:<org>:<hash>, written the moment somebody signs
  // in at /access), and an invitation plus a proven address is the same test the
  // box makes before it activates. That lets the directory answer "can this
  // account reach this mineral" at read time, with no drain in the path.
  //
  // A pending row is NOT access, and the worker must treat it as access only
  // when it finds a matching proof. It is mirrored so the directory knows an
  // invitation exists, which is precisely what it could not know before.
  //
  // The box remains the authority on who may OPEN it: the ssh door is its own,
  // enforced at connect time, and activation still writes authorized_keys.
  // Nothing here shortcuts that.
  const access = Array.isArray(rec.access) ? [...rec.access] : [];
  const seen = new Set(access.map((a) => String(a && a.email || '').trim().toLowerCase()).filter(Boolean));
  for (const g of Array.isArray(rec.grants) ? rec.grants : []) {
    const e = String(g && g.email || '').trim().toLowerCase();
    if (!e || seen.has(e)) continue;
    if (g.status !== 'active' && g.status !== 'pending') continue;   // revoked stays out
    seen.add(e);
    access.push({ account_id: '', email: e, role: g.role === 'admin' ? 'admin' : 'member',
      status: g.status,
      granted: String(g.activated_at || g.added_at || '').slice(0, 10) });
  }
  return {
    mineral_id: rec.mineral_id || '',
    tier: rec.tier || '',
    anchor: rec.anchor || '',
    holder: rec.holder || null,
    access,
    // legacy role field, still written by the stamp path; kept so a reader can
    // see both what the old model said and what the new one records
    legacy_owner: rec.owner || '',
  };
}

// ---------------------------------------------------------------------------
// What this mineral calls itself (2026-08-10). Every mirror write needs a
// label and a host, and getting them wrong is not cosmetic: the first live
// mirror showed docker container ids ("1c8db1bea6a3") as mineral names,
// because os.hostname() inside a box IS the container id.
//   label — the human name. A pebble's is /state/box-name; a rock's is
//           org-policy.yaml display_name (falling back to org.name).
//   host  — the durable machine handle. org-inbox.conf SLUG where present
//           (survives rebuilds); a rock falls back to its org slug; only then
//           the container hostname, which is at least honest about a machine
//           with no name at all.
export function mineralNames(stateDir, { hostname = () => os.hostname() } = {}) {
  const rd = (p) => { try { return readFileSync(path.join(stateDir, p), 'utf8'); } catch { return ''; } };
  const policy = (() => {
    for (const p of ['brain/org-policy.yaml', 'org-policy.yaml']) { const t = rd(p); if (t) return t; }
    return '';
  })();
  const yamlField = (text, field) => {
    const m = text.match(new RegExp(`^\\s*${field}:\\s*"?([^"\\n#]*)"?`, 'm'));
    return m ? m[1].trim() : '';
  };
  const orgSlug = yamlField(policy, 'name');
  const orgDisplay = yamlField(policy, 'display_name');
  const boxName = rd('box-name').trim();
  const slug = (() => {
    const m = rd('org-inbox.conf').match(/^SLUG=(.*)$/m);
    return m ? m[1].trim() : '';
  })();
  // TIER DECIDES, which is what the comment above has always said and what this
  // line did not do (2026-08-12). `boxName` won unconditionally for both tiers.
  //
  // On a ROCK, /state/box-name holds the ASSISTANT'S persona: the onboard skill
  // writes it there deliberately, alongside identity.assistant_name, and that is
  // correct for what it is. It is not the organisation's name. So a rock created
  // as "QA Harbour Labs" and onboarded with the persona "Foreman" appeared on the
  // operator's minerals table as **Foreman**, while the invitation email its own
  // members received correctly said "set up for you by QA Harbour Labs".
  //
  // Two surfaces, two names, one rock, and the operator got the assistant's.
  const tier = (() => { try { return JSON.parse(rd('ownership.json')).tier || ''; } catch { return ''; } })();
  const label = tier === 'rock'
    ? (orgDisplay || orgSlug || boxName || '')
    : (boxName || orgDisplay || orgSlug || '');
  const host = slug || orgSlug || hostname();
  return { label, host };
}
