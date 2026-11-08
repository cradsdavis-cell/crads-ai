// grants.mjs: the helper-access record and the signed request that adds to it.
//
// Spec: docs/superpowers/specs/2026-11-08-helper-access-design.md.
//
// Support access used to be ONE grant for ONE key (Sam's), capped at 72 hours.
// A Guided Setup client who wants a custom build has to let somebody else in
// (a builder they hired) for weeks, under that person's own name. So:
//
//   * <state>/support/access.json holds a LIST of grants, one per helper, each
//     with its own key, window, purpose and the consent text the member saw.
//     A file still carrying the old single `grant` reads as a one-item list;
//     the next write upgrades it. No migration step to forget.
//   * A helper gets in only through a REQUEST the member approves. The request
//     carries the helper's public key and is signed by the Crads-AI request key
//     (ssh-keygen -Y, namespace crads-helper-request), verified against
//     engine/support/request-signers. The key travels in the request rather
//     than in the image because members update only when they choose to
//     (trap 82): a helper list baked into the image would reach a client late or
//     never.
//   * A request names the ONE mineral it is for (its mineral_id, or its
//     holder's email), is single-use, and expires unanswered after at most
//     7 days. A link sent to one client can never open another client's box.
//
// device-sync.mjs stays the single writer of authorized_keys: it asks this
// module for the live grants and renders one expiry-time line per grant.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PUBKEY_RE, fingerprintOf } from '../devices/roster.mjs';
import { MINERAL_ID_RE, readOwnership } from '../lib/mineral-identity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SIGNERS_FILE = join(HERE, 'request-signers');
export const SUPPORT_PUB = join(HERE, 'crads-support.pub');
export const NAMESPACE = 'crads-helper-request';
export const SIGNER_PRINCIPAL = 'crads-ai';
export const CONSENT_VERSION = '1';
export const MAX_DAYS = 30;
export const MAX_HOURS = 72;
const MAX_ANSWER_WINDOW_MS = 7 * 86400_000;
const CLOCK_SKEW_MS = 10 * 60_000;
const SUPPORT_ID = 'support';

const fileOf = (stateDir) => join(stateDir, 'support', 'access.json');

// ---- the record ------------------------------------------------------------

/** The record, normalised: { grants: [], answered: [], events: [] }. */
export function readRecord(stateDir) {
  let raw = {};
  try { raw = JSON.parse(readFileSync(fileOf(stateDir), 'utf8')) || {}; } catch { raw = {}; }
  const grants = Array.isArray(raw.grants) ? raw.grants.filter((g) => g && g.key && g.expires_at) : [];
  // The pre-list shape: one Crads support grant under `grant`.
  if (raw.grant && raw.grant.key && raw.grant.expires_at && !grants.some((g) => g.id === SUPPORT_ID)) {
    grants.push(supportGrantFrom(raw.grant));
  }
  return {
    grants,
    answered: Array.isArray(raw.answered) ? raw.answered.filter((x) => typeof x === 'string') : [],
    events: Array.isArray(raw.events) ? raw.events : [],
  };
}

export function writeRecord(stateDir, rec) {
  mkdirSync(join(stateDir, 'support'), { recursive: true });
  const out = {
    grants: rec.grants || [],
    answered: (rec.answered || []).slice(-500),
    events: (rec.events || []).slice(-500),
  };
  writeFileSync(fileOf(stateDir), JSON.stringify(out, null, 2) + '\n');
}

const isLive = (g, now) => !!(g && g.key && g.expires_at && new Date(g.expires_at) > now);

/** Every grant whose window is still open. */
export function liveGrants(stateDir, now = new Date()) {
  return readRecord(stateDir).grants.filter((g) => isLive(g, now));
}

function supportGrantFrom(old) {
  return {
    id: SUPPORT_ID, kind: 'support',
    helper: { name: 'Crads AI support', org: 'Crads-AI', email: '' },
    key: old.key, purpose: 'Support', granted_at: old.granted_at || '', expires_at: old.expires_at,
    hours: old.hours || null, consent: null, recorded: false,
  };
}

export function supportKey() {
  try {
    return readFileSync(SUPPORT_PUB, 'utf8').split('\n').find((l) => /^\s*(ssh|ecdsa)-/.test(l))?.trim() || null;
  } catch { return null; }
}

/** The existing one-button Crads support grant, 1 to 72 hours. Replaces any earlier one. */
export function grantSupport(stateDir, hours, now = new Date()) {
  const key = supportKey();
  if (!key) return { ok: false, reason: 'support channel not configured (no key in engine/support/crads-support.pub)' };
  const h = Math.max(1, Math.min(MAX_HOURS, parseInt(hours, 10) || 24));
  const rec = readRecord(stateDir);
  const g = {
    id: SUPPORT_ID, kind: 'support',
    helper: { name: 'Crads AI support', org: 'Crads-AI', email: '' },
    key, purpose: 'Support', granted_at: now.toISOString(),
    expires_at: new Date(now.getTime() + h * 3600_000).toISOString(), hours: h, consent: null,
    recorded: hostRecords(),
  };
  rec.grants = rec.grants.filter((x) => x.id !== SUPPORT_ID).concat(g);
  rec.events.push({ at: g.granted_at, event: 'granted', id: g.id, who: g.helper.name, hours: h, expires_at: g.expires_at });
  writeRecord(stateDir, rec);
  return { ok: true, grant: g };
}

/** End one grant by id, or every grant when id is empty. Expired ones are swept too. */
export function revoke(stateDir, id = '', now = new Date()) {
  const rec = readRecord(stateDir);
  const live = rec.grants.filter((g) => isLive(g, now));
  const ended = id ? live.filter((g) => g.id === id) : live;
  rec.grants = id ? live.filter((g) => g.id !== id) : [];
  for (const g of ended) rec.events.push({ at: now.toISOString(), event: 'revoked', id: g.id, who: g.helper?.name || '' });
  if (!ended.length) rec.events.push({ at: now.toISOString(), event: 'revoke (nothing active)', id: id || '' });
  writeRecord(stateDir, rec);
  return { ok: true, ended };
}

/**
 * Does this server's HOST record helper sessions? enter-aios on a host that
 * records exports AIOS_HOST_RECORDS=1 into every session it opens, so a verb
 * run from the member's own app can tell. Absent on every host born before
 * session records existed (their enter-aios is frozen at provision time).
 */
export function hostRecords(env = process.env) {
  return env.AIOS_HOST_RECORDS === '1';
}

// ---- the request -----------------------------------------------------------

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** request bytes + armored signature -> the shareable code (and link). */
export function encodeRequest(jsonBytes, armoredSig) {
  return `${b64u(jsonBytes)}.${b64u(Buffer.from(armoredSig, 'utf8'))}`;
}
export const linkFor = (code) => `crads-ai://helper/${code}`;

/** Accepts the bare code, the crads-ai://helper/ link, or either with whitespace around it. */
export function decodeRequest(input) {
  const s = String(input || '').trim().replace(/^crads-ai:\/\/helper\//i, '').replace(/\/$/, '');
  const m = s.match(/^([A-Za-z0-9_-]{20,4000})\.([A-Za-z0-9_-]{20,4000})$/);
  if (!m) return null;
  const bytes = unb64u(m[1]);
  const sig = unb64u(m[2]).toString('utf8');
  if (!/^-----BEGIN SSH SIGNATURE-----\n[\s\S]+\n-----END SSH SIGNATURE-----\n?$/.test(sig)) return null;
  return { bytes, sig };
}

const PRINTABLE = /^[^\x00-\x1f\x7f]*$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

/** Shape checks on the parsed request. Returns a reason string, or '' when sound. */
export function shapeProblem(r) {
  if (!r || typeof r !== 'object') return 'the request is not readable';
  if (r.v !== 1) return 'this request was made for a different version of the software';
  if (!/^req_[0-9a-f]{16}$/.test(String(r.id || ''))) return 'the request has no valid id';
  const h = r.helper || {};
  if (typeof h.name !== 'string' || !h.name.trim() || h.name.length > 80 || !PRINTABLE.test(h.name)) return 'the helper has no name';
  if (h.org != null && (typeof h.org !== 'string' || h.org.length > 80 || !PRINTABLE.test(h.org))) return 'the organisation name is not valid';
  if (h.email && !EMAIL_RE.test(String(h.email))) return 'the helper email is not valid';
  if (!PUBKEY_RE.test(String(h.key || '').trim())) return 'the helper key is not a single ssh-ed25519 public key';
  const f = r.for || {};
  if (!f.mineral_id && !f.email) return 'the request does not say which mineral it is for';
  if (f.mineral_id && !MINERAL_ID_RE.test(String(f.mineral_id))) return 'the mineral id in the request is not valid';
  if (f.email && !EMAIL_RE.test(String(f.email))) return 'the member email in the request is not valid';
  const hasDays = r.days != null, hasHours = r.hours != null;
  if (hasDays === hasHours) return 'the request must give either days or hours';
  if (hasDays && !(Number.isInteger(r.days) && r.days >= 1 && r.days <= MAX_DAYS)) return `days must be 1 to ${MAX_DAYS}`;
  if (hasHours && !(Number.isInteger(r.hours) && r.hours >= 1 && r.hours <= MAX_HOURS)) return `hours must be 1 to ${MAX_HOURS}`;
  if (typeof r.purpose !== 'string' || !r.purpose.trim() || r.purpose.length > 300 || !PRINTABLE.test(r.purpose)) return 'the request does not say what the access is for';
  const issued = Date.parse(r.issued_at), by = Date.parse(r.approve_by);
  if (!Number.isFinite(issued) || !Number.isFinite(by)) return 'the request dates are not valid';
  if (by <= issued || by - issued > MAX_ANSWER_WINDOW_MS) return 'the request answer window is not valid';
  return '';
}

/** ssh-keygen -Y verify of the exact bytes against the signers file. */
export function signatureOk(bytes, sig, { signersFile = SIGNERS_FILE, tmp } = {}) {
  let signers = '';
  try { signers = readFileSync(signersFile, 'utf8'); } catch { return { ok: false, reason: 'this software version cannot check helper requests (no signer file)' }; }
  if (!signers.split('\n').some((l) => l.trim() && !l.trim().startsWith('#'))) {
    return { ok: false, reason: 'helper requests are not switched on in this software version' };
  }
  const dir = tmp || join('/tmp', 'crads-req-' + randomBytes(6).toString('hex'));
  mkdirSync(dir, { recursive: true });
  const sigFile = join(dir, 'req.sig');
  try {
    writeFileSync(sigFile, sig.endsWith('\n') ? sig : sig + '\n');
    execFileSync('ssh-keygen', ['-Y', 'verify', '-f', signersFile, '-I', SIGNER_PRINCIPAL, '-n', NAMESPACE, '-s', sigFile],
      { input: bytes, stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'this request is not signed by Crads-AI, or it was changed after signing' };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ }
  }
}

/**
 * Everything a member's approve screen needs to know about a request, or a
 * plain reason it cannot be approved. Never writes.
 */
export function checkRequest(stateDir, input, { now = new Date(), signersFile = SIGNERS_FILE, env = process.env } = {}) {
  const dec = decodeRequest(input);
  if (!dec) return { ok: false, reason: 'that is not a helper request code' };
  const sigCheck = signatureOk(dec.bytes, dec.sig, { signersFile });
  if (!sigCheck.ok) return { ok: false, reason: sigCheck.reason };
  let r;
  try { r = JSON.parse(dec.bytes.toString('utf8')); } catch { return { ok: false, reason: 'the request is not readable' }; }
  const problem = shapeProblem(r);
  if (problem) return { ok: false, reason: problem };
  if (now.getTime() > Date.parse(r.approve_by)) return { ok: false, reason: `this request expired on ${r.approve_by.slice(0, 10)}; ask ${r.helper.name} for a new one` };
  if (Date.parse(r.issued_at) - now.getTime() > CLOCK_SKEW_MS) return { ok: false, reason: 'this request is dated in the future; check this server\'s clock' };
  const own = readOwnership(stateDir);
  if (r.for.mineral_id) {
    if (String(own.mineral_id || '') !== r.for.mineral_id) return { ok: false, reason: 'this request was made for a different mineral' };
  } else {
    const holder = String(own.holder_email || (own.holder && own.holder.email) || '').trim().toLowerCase();
    if (!holder) return { ok: false, reason: 'this mineral has no owner email on record, so a request addressed by email cannot be matched; give the helper your mineral ID from the Help page instead' };
    if (holder !== String(r.for.email).toLowerCase()) return { ok: false, reason: 'this request was made for someone else\'s mineral' };
  }
  const rec = readRecord(stateDir);
  if (rec.answered.includes(r.id)) return { ok: false, reason: 'this request has already been answered on this mineral' };
  const key = String(r.helper.key).trim();
  const ms = r.days != null ? r.days * 86400_000 : r.hours * 3600_000;
  const recorded = hostRecords(env);
  const until = new Date(now.getTime() + ms).toISOString();
  return {
    ok: true,
    request: r,
    view: {
      id: r.id,
      helper: { name: r.helper.name, org: r.helper.org || '', email: r.helper.email || '', fingerprint: fingerprintOf(key) },
      purpose: r.purpose,
      length: r.days != null ? `${r.days} day${r.days === 1 ? '' : 's'}` : `${r.hours} hour${r.hours === 1 ? '' : 's'}`,
      until,
      recorded,
      consent: consentText({ name: r.helper.name, org: r.helper.org || '', until, recorded }),
      consent_version: CONSENT_VERSION,
    },
  };
}

/** Approve: re-checks everything, then writes the grant and marks the request answered. */
export function approveRequest(stateDir, input, opts = {}) {
  const now = opts.now || new Date();
  const c = checkRequest(stateDir, input, { ...opts, now });
  if (!c.ok) return c;
  const r = c.request, v = c.view;
  const rec = readRecord(stateDir);
  const g = {
    id: r.id, kind: 'helper',
    helper: { name: r.helper.name, org: r.helper.org || '', email: r.helper.email || '' },
    key: String(r.helper.key).trim(), purpose: r.purpose,
    granted_at: now.toISOString(), expires_at: v.until,
    consent: { version: CONSENT_VERSION, sha256: createHash('sha256').update(v.consent).digest('hex') },
    recorded: v.recorded,
  };
  // One live grant per helper key: a second request for the same person replaces the first.
  rec.grants = rec.grants.filter((x) => isLive(x, now) && x.key !== g.key).concat(g);
  rec.answered.push(r.id);
  rec.events.push({ at: g.granted_at, event: 'granted', id: g.id, who: g.helper.name, org: g.helper.org,
    purpose: g.purpose, expires_at: g.expires_at, consent: g.consent.version, recorded: g.recorded });
  writeRecord(stateDir, rec);
  return { ok: true, grant: g, view: v };
}

/** Decline: only a genuine request can be declined, so junk cannot fill the record. */
export function declineRequest(stateDir, input, opts = {}) {
  const now = opts.now || new Date();
  const c = checkRequest(stateDir, input, { ...opts, now });
  if (!c.ok) return c;
  const rec = readRecord(stateDir);
  rec.answered.push(c.request.id);
  rec.events.push({ at: now.toISOString(), event: 'declined', id: c.request.id, who: c.request.helper.name });
  writeRecord(stateDir, rec);
  return { ok: true, view: c.view };
}

// ---- consent ---------------------------------------------------------------

const RECORDED = 'Every session they open with this access is recorded on the server, where their access cannot reach it, and you can read it on this page. A record cannot stop someone set on misusing full access, so only let in people you trust.';
const NOT_RECORDED = (name) => `This server was set up before session records existed, so what ${name} runs is not recorded. Their own written account of the work is the record. A new server from the setup wizard records sessions.`;

/** The consent the member sees, filled in. Its sha256 is stored on the grant. */
export function consentText({ name, org, until, recorded }) {
  let t = readFileSync(join(HERE, `consent-v${CONSENT_VERSION}.md`), 'utf8');
  const who = org ? `${name} (${org})` : name;
  const date = new Date(until).toUTCString().replace(/:\d\d GMT$/, ' UTC');
  t = t.replaceAll('{who}', who).replaceAll('{name}', name).replaceAll('{date}', date)
    .replaceAll('{recording}', recorded ? RECORDED : NOT_RECORDED(name));
  return t;
}

/** The public face of a grant: no key material, fingerprint only. */
export function publicGrant(g) {
  return {
    id: g.id, kind: g.kind || 'helper',
    helper: { name: g.helper?.name || '', org: g.helper?.org || '', email: g.helper?.email || '', fingerprint: fingerprintOf(g.key) },
    purpose: g.purpose || '', granted_at: g.granted_at || '', expires_at: g.expires_at,
    consent: g.consent || null, recorded: !!g.recorded,
  };
}

/** For the operator tool and tests: the canonical request bytes. */
export function requestBytes(r) {
  return Buffer.from(JSON.stringify(r), 'utf8');
}
