// consent.mjs · T2.5: permission asks + the ownership-riding push gate, pure.
// D60 O6 said "org-owned boxes skip the gate" when org-owned meant OUR org.
// Under the pointer (T1.1) that is only true when the ANCHOR IS the owner:
// pushing to a box owned by the member or by a DIFFERENT org is consent-gated.
// Consent resolution keeps the O6 shape: row field -> policy default -> ALLOW
// (the absent-everything default is load-bearing for live pre-field rows).
import { normalizeRow } from './normalize-row.mjs';

export function pushConsent({ row = {}, anchorSlug = '', policyDefault = '' } = {}) {
  const n = normalizeRow(row, { anchorSlug });
  if (n.owner !== 'member' && n.owner === anchorSlug) {
    return { allowed: true, why: 'the anchor owns this box; owning includes pushing (D60 O6)' };
  }
  let consent = (row.infra_push_consent || '').trim();
  if (consent !== 'true' && consent !== 'false') consent = (policyDefault || '').trim();
  if (consent === 'false') {
    const holder = n.owner === 'member' ? 'the member' : `'${n.owner}'`;
    return { allowed: false, why: `${holder} owns this box and has not consented to pushes (infra_push_consent)` };
  }
  return { allowed: true, why: 'consented (or the inherited allow default)' };
}

// An answered ask (requests engine, kind ask-install|ask-read) lands on the row
// as the grant fields. The OWNER's unilateral flips write the same fields
// directly; this helper is just the reconcile's pen.
export function applyPermissionGrant(row = {}, kind = '', answer = '') {
  const val = answer === 'accepted' ? 'true' : 'false';
  if (kind === 'ask-install') return { ...row, infra_push_consent: val };
  if (kind === 'ask-read') return { ...row, read_consent: val };
  throw new Error(`kind must be ask-install or ask-read (got "${kind}")`);
}
