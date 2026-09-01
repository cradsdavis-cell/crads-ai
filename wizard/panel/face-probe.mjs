// face-probe.mjs — the box says what it is (promote ruling § 3, 2026-08-04).
//
// The ~/.ssh alias suffix (-box / -rock) is only the GUESS made at enrolment
// time. In-place promotion changes what a box IS without changing its address
// or its alias, so the app asks each member-alias box for /state/ownership.json
// and believes the answer: tier 'rock' behind a -box alias means BOTH faces
// live there (a promoted rock keeps its owner's personal seat, ruling § 1).
//
// Fail-open by design: no answer, garbage, or an unreachable box leaves the
// alias guess standing — a cold start with every box offline must look exactly
// like today. The probe can only ADD a face, never take one away.

// Transport banners can precede the JSON (the 2026-08-03 member support-access
// bug was parsing a banner as the payload) — and a banner may itself contain
// braces (MOTDs do). So walk forward through candidate opening braces until a
// slice to the LAST closing brace parses; bounded so garbage cannot spin us.
export function parseOwnership(out) {
  const s = String(out || '');
  const end = s.lastIndexOf('}');
  if (end < 0) return null;
  let i = s.indexOf('{');
  for (let n = 0; i >= 0 && i <= end && n < 8; n++, i = s.indexOf('{', i + 1)) {
    try {
      const j = JSON.parse(s.slice(i, end + 1));
      if (j && typeof j === 'object' && !Array.isArray(j)) return j;
    } catch { /* try the next opening brace */ }
  }
  return null;
}

// Ask every member-alias target what it is; return the ones whose box ANSWERED
// tier 'rock'. bridge is runSsh-shaped: (host, command) -> { stdout }.
export async function probePromotedHosts(bridge, targets) {
  const memberish = (targets || []).filter((t) => t && t.kind === 'member');
  const promoted = [];
  await Promise.all(memberish.map(async (t) => {
    try {
      const r = await bridge(t.host, 'cat /state/ownership.json 2>/dev/null');
      const own = parseOwnership(r && r.stdout);
      if (own && own.tier === 'rock') {
        promoted.push({ host: t.host, org: String(own.owner_slug || t.org || '') });
      }
    } catch { /* unreachable: the alias guess stands */ }
  }));
  return promoted;
}
