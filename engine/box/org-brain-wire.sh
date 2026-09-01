#!/usr/bin/env bash
# org-brain-wire.sh — wire an org-OWNED box's /state to the ORG's brain repo (D60 O2).
# Runs on the box (org-sync cadence), idempotent, fail-quiet. It only WIRES:
# origin + repo-local core.sshCommand + the never-commit guard. The engine kernel
# is the sole committer and already syncPushes origin on every commit cycle, so
# once wired, pushes happen with no further machinery.
# Guards: org-brain.conf + deploy key present AND ownership.json owner == org.
# Member-owned boxes are untouched (own-brain.mjs is their path; the org gets nothing).
set -euo pipefail
BOX="${1:-${STATE_DIR:-/state}}"
CONF="$BOX/org-brain.conf"                        # non-secret: ORG_GH_OWNER + SLUG (seeded by the factory)
KEY="$BOX/secrets/org_brain_deploy_key"           # read-WRITE deploy key, scoped to <slug>-brain ONLY
log(){ printf '[org-brain-wire] %s\n' "$*"; }

[ -f "$CONF" ] || exit 0                          # not an org-owned stamp
[ -f "$KEY" ]  || exit 0                          # no key (revoked = org's off-switch)
# Belt and braces: only org-owned. Real JSON parse, not a grep, so compact
# (resolver) and pretty-printed (seed-pages) ownership.json both behave.
node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(o.owner==="org"?0:1)}catch{process.exit(1)}' "$BOX/ownership.json" || exit 0
. "$CONF"                                          # ORG_GH_OWNER, SLUG

# Never-commit guard FIRST (superset of the kernel's ignore set + own-brain's,
# self-sufficient so the guard holds even if the kernel's pass never ran).
touch "$BOX/.gitignore"
for l in '.env' '.env.*' 'secrets/' '*.key' '*.pem' '.ssh/' 'ssh/' '.claude-auth/' '.claude-auth*' 'node_modules/' '.kernel/' '.mcp.json' '.claude/' 'cockpit/' '.heartbeat-out/'; do
  grep -qxF "$l" "$BOX/.gitignore" || echo "$l" >> "$BOX/.gitignore"
done

# Repo + remote (ssh:// dodges the image's git@github.com -> https rewrite).
# ORG_BRAIN_REMOTE_URL override exists for tests (local bare remotes, no network).
URL="${ORG_BRAIN_REMOTE_URL:-ssh://git@github.com/$ORG_GH_OWNER/$SLUG-brain.git}"

# FIRST wire = fresh custody: the org's repo starts at wire time. Pre-wire local
# history (kernel boot commits, made before the guard above existed) may TRACK
# credentials like .env, and a push would carry that history to the org repo;
# it also collides with pull --rebase (untracked-file overwrite). So when origin
# is not yet this URL, re-init history: the working tree (the content) survives,
# pre-wire commits never leave the box. Re-runs see origin already set and skip,
# so post-wire history is preserved. Content loss: none (files stay on disk).
if [ "$(git -C "$BOX" remote get-url origin 2>/dev/null || true)" != "$URL" ]; then
  rm -rf "$BOX/.git"
  git -C "$BOX" init -q -b main
  git -C "$BOX" remote add origin "$URL"
fi
# Untrack audit (belt and braces on re-runs): gitignore cannot untrack, so shed
# credential paths anything may have staged, before the kernel's next add -A.
git -C "$BOX" rm -r -q --cached --ignore-unmatch \
  .env .mcp.json .claude .claude-auth .kernel cockpit secrets ssh .ssh 2>/dev/null || true
git -C "$BOX" config core.sshCommand "ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
log "wired: origin -> $URL (kernel carries pushes)"
