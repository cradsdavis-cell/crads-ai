// org-identity.mjs · fill an org's identity into its policy, in the policy's own text.
//
// ONE implementation, deliberately. Two things need it and they live in
// different repos: the cockpit's seed-org-brain (a rock built through the door)
// and, from 2026-08-04, promote (a pebble upgrading itself in place, Sam's
// ruling). A second copy is how registry/normalize-row.mjs and
// registry/membership.mjs ended up disagreeing about the same file for weeks,
// so this lives in brain-template, which both sides already consume: the cockpit
// reads it from its local checkout, a box gets it inside the clone.
//
// Why it matters at all: the template ships org.name and display_name EMPTY and
// marks them REQUIRED. A brain seeded without them is born unable to be a rock.
// stamp-pebble.sh dies "org-policy org.name is empty" so it can never create a
// member, control/broker-register.mjs exits 1 so it never gets a directory route
// and no member can find it, and control/edges-reflect.mjs stays dormant so it
// reflects no edges. All three read exactly these two fields.

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

/* Text-in, text-out, and scoped to the `org:` block on purpose: `name:` appears
   again further down the policy (the Pulse section), and a loose anchor rewrites
   the wrong line. That is the same trap that made extractRow blind to
   memberships, so it is worth the extra few lines here. */
export function fillOrgIdentity(policyText, { handle, display, region } = {}) {
  const text = String(policyText ?? '');
  if (!HANDLE_RE.test(String(handle ?? ''))) {
    throw new Error(`org handle must be a DNS-safe slug (got "${handle ?? ''}")`);
  }
  const orgAt = text.indexOf('\norg:\n');
  if (orgAt === -1) throw new Error('org-policy.yaml has no org: block to fill');

  const head = text.slice(0, orgAt);
  let block = text.slice(orgAt);
  // The org block ends at the next TOP-LEVEL key.
  const nextTop = block.slice(1).search(/\n[a-z_]+:/);
  const tail = nextTop === -1 ? '' : block.slice(1 + nextTop);
  block = nextTop === -1 ? block : block.slice(0, 1 + nextTop);

  // Check the lines EXIST rather than whether the text changed. Comparing
  // before/after conflates "there is nothing to fill" with "it already says
  // exactly this", which made a second fill throw and cost idempotency: promote
  // has to be safe to re-run after a partial failure, and a rename has to work
  // on an already-filled policy.
  if (!/^\s+name:\s*"[^"]*"/m.test(block) || !/^\s+display_name:\s*"[^"]*"/m.test(block)) {
    throw new Error('org: block has no name/display_name lines to fill');
  }
  block = block
    .replace(/^(\s+name:\s*)"[^"]*"/m, `$1${JSON.stringify(handle)}`)
    .replace(/^(\s+display_name:\s*)"[^"]*"/m, `$1${JSON.stringify(display || handle)}`);

  return fillRegion(head + block + tail, region);
}

/* REGION IS TOP-LEVEL, not part of the org: block, which is why it needs its own
   pass and its own anchor (`^region:` with no leading whitespace).

   Why it is filled here at all (2026-08-12, baseline finding 75). The template
   ships `region: ""` and says in a comment that the renderer refuses an empty
   region. render-identity.mjs really does refuse it, line 89 — but the BIRTH path
   never runs the renderer. cloud-init calls fillOrgIdentity and nothing else, so
   the guard is real and simply never reached, and every door-born rock came up
   with region "". That is not cosmetic: the value propagates into the member
   registry, and a pebble stamped from such a rock carries `region: ""` in its own
   row (confirmed on qa-pebble-one, not predicted).

   The box knows the answer already: `deployment.yaml` sits beside the policy
   carrying `default_region`. So this is not a silent default, which the template
   rightly forbids — it is the deployment's own explicit choice, copied into the
   file that the factory and renderer read.

   Only fills an EMPTY region, so an operator's explicit value is never clobbered
   and a re-run (promote, or a repair after a partial seed) is idempotent. */
const REGION_RE = /^[a-z]{2,4}[0-9]{0,2}$/;
export function fillRegion(policyText, region) {
  const text = String(policyText ?? '');
  const want = String(region ?? '').trim();
  if (!want) return text;
  if (!REGION_RE.test(want)) throw new Error(`region must look like hel1 | nbg1 | sin (got "${want}")`);
  // Preserve the rest of the line: the template carries a REQUIRED/EXPLICIT
  // comment there that is the only documentation of what the field accepts.
  return text.replace(/^(region:[ \t]*)"([^"]*)"/m, (m, lead, cur) => (cur.trim() ? m : `${lead}${JSON.stringify(want)}`));
}

/* What the three consumers actually read, so a caller can check its own work
   rather than trusting this function. Mirrors the regex in broker-register.mjs
   and edges-reflect.mjs exactly. */
export function readOrgIdentity(policyText) {
  const text = String(policyText ?? '');
  return {
    name: (text.match(/^\s*name:\s*"?([^"\n#]+)"?/m) || [])[1]?.trim() || '',
    display_name: (text.match(/^\s*display_name:\s*"?([^"\n#]+)"?/m) || [])[1]?.trim() || '',
    // Exposed so a caller can check its own work rather than trusting the fill,
    // which is this file's stated contract for name/display_name too.
    region: (text.match(/^region:[ \t]*"?([^"\n#]*)"?/m) || [])[1]?.trim() || '',
  };
}
