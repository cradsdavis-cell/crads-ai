// join-parse.mjs — parse a crads-ai invite fragment for the /join landing page.
// KEEP IN LOCKSTEP with the inline copy in index.html (the page is self-contained
// static HTML behind a strict no-external-deps rule; this module exists so the
// logic is unit-testable). Server-side twin: parseInviteLink in member-connect.mjs.
//
// Fragment format: v1.<org>.<slug>.<b64url("host|sip|user|token")>. The fragment
// never reaches any server (browsers do not send #fragments), so the invite token
// stays client-side on this page by construction.

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
const ORG_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,62}$/;

export function parseJoinFragment(fragment) {
  const raw = String(fragment || '').replace(/^#/, '');
  if (!raw) return { ok: false, reason: 'no invite in the link' };
  const parts = raw.split('.');
  if (parts[0] !== 'v1' || parts.length < 4) return { ok: false, reason: 'not a v1 invite fragment' };
  const org = parts[1], slug = parts[2], b64 = parts.slice(3).join('.');
  if (!ORG_RE.test(org) || !SLUG_RE.test(slug)) return { ok: false, reason: 'invalid org or member name' };
  let decoded;
  try { decoded = typeof atob === 'function'
    ? atob(b64.replace(/-/g, '+').replace(/_/g, '/'))
    : Buffer.from(b64, 'base64url').toString('utf8'); }
  catch { return { ok: false, reason: 'invite payload is not decodable' }; }
  const f = decoded.split('|');
  if (f.length < 4 || !f[0] || !f[3]) return { ok: false, reason: 'invite payload is incomplete' };
  // f[6] = the ANCHOR org, and it is not the same thing as `org` above (finding
  // 136, 2026-08-16). `org` is the STAGING LANE the redeem is brokered through,
  // which fulfil-arrivals sets to `crads-solo` for every invite it mints,
  // anchored or not, because that is where the enrol job holds the pull token.
  // This page used to read that field as "has no organisation, so skip the
  // sign-in step", which silently stripped the sign-in from every rock-anchored
  // pebble. A pebble is solo when it has NO ANCHOR, never because of its lane.
  // Absent on links minted before this change, which is why isSolo below falls
  // back to the old test rather than calling every old link anchored.
  return { ok: true, org, slug, host: f[0], sip: f[1], user: f[2], token: f[3],
    anchor: f[6] || '', appUrl: 'crads-ai://join/' + raw };
}

// Pick the right app download for the visitor's platform.
//
// These are ASSET urls, not the releases page. Every button here used to point at
// /releases/latest, which does two unhelpful things at once: the rolling release is
// a PRERELEASE, and GitHub excludes prereleases from `latest`, so the link 302s to
// the repo's release LIST rather than downloading anything. A member who clicked
// "Download for Mac" landed on a GitHub page holding four files (two of them JSON)
// and had to work out which one was theirs. Naming the asset makes the button do
// what it says. Same reason updater.mjs pins the tag: `latest` is empty here.
const REL = 'https://github.com/cradsdavis-cell/crads-ai-app/releases/download/wizard-app';

export function downloadFor(userAgent, releases = REL) {
  const ua = String(userAgent || '');
  const win = { label: 'Download for Windows', url: releases + '/crads-ai.exe' };
  const mac = { label: 'Download for Mac', url: releases + '/crads-ai-mac.zip' };
  // Phones first: recent iPadOS reports "Mac" in its UA, and a tablet must not be
  // handed a desktop bundle it cannot open.
  if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) {
    return { mobile: true, label: 'Download the app', url: releases + '/crads-ai.exe' };
  }
  if (/Windows/i.test(ua)) return win;
  if (/Mac/i.test(ua)) return mac;
  // Unknown desktop: Windows is the majority platform and the page still offers the
  // other one beside it, so a wrong guess costs one click rather than a dead end.
  return { label: 'Download the app', url: win.url };
}

// Is this pebble genuinely standalone, i.e. is there any organisation for a
// signed token to prove anything to? (finding 136, 2026-08-16.)
//
// A link minted since the anchor joined the payload answers honestly: an anchor
// means anchored, no anchor means solo. Links minted BEFORE it carry no anchor
// field at all, and for those the only signal available is the old lane test —
// so they keep exactly the behaviour they have today rather than every one of
// them suddenly claiming to be anchored.
export function isSolo(inv) {
  if (!inv || !inv.ok) return false;
  if (inv.anchor) return false;              // names an anchor: not solo
  return inv.org === 'crads-solo';           // no anchor: fall back to the lane test
}

// WHICH NAME DOES THE MEMBER READ? (finding 158, 2026-08-16.)
//
// A SECOND question off the same field, and the fourth reader in the
// 135 -> 136 -> 139 chain to answer it with the lane. 136 taught the page to
// consult the anchor to decide WHETHER to name an organisation, and the name it
// then printed was still `org`. Live and verbatim on crads-ai.com the same day:
// "You'll need the Crads-AI app for crads-solo", to a member whose rock is
// qa-r2-gmail. Fixing one reader of a field and shipping it as though the
// problem were closed is the mistake 136 itself was.
//
// WHAT THIS PAGE CAN HONESTLY SAY. The anchor, and only the anchor, because it
// is the one field in the link that names the owning rock. It is a HANDLE
// (`qa-r2-gmail`), not the display name (`QA Run Two Gmail`): the display name
// lives in `route:<org>.org_display` in the directory, and this page resolves
// nothing server-side on purpose ("the invite in the link never leaves it"), so
// the handle is what it has and it does not invent a lookup to improve on it.
// The handle is the fallback the rest of the product already renders:
// samdavis-site api/app/minerals.js and lib/directory.js both print
// `org_display || org`.
//
// The lane is still the right answer in ONE case: an invite minted by a rock's
// own panel carries that rock's handle in the lane and no anchor in the payload.
// With neither, there is nothing to name and nothing is printed.
//
// THIS NEVER GATES THE SIGN-IN STEP. isSolo above answers that, and it stays a
// bare truthiness test on the anchor so it cannot drift from signInRequired() in
// wizard/panel/member-connect.mjs, which is what actually enforces the sign-in.
// Only the printed name is validated, and it fails to nothing rather than to
// something invented: a malformed anchor loses its NAME and keeps its SIGN-IN,
// which is the safe way round. Collapsing the two into one predicate is how 136
// happened in the first place.
export function orgLabel(inv) {
  if (!inv || !inv.ok) return '';
  const name = String(inv.anchor || '') || (isSolo(inv) ? '' : String(inv.org || ''));
  return ORG_RE.test(name) ? name : '';
}
