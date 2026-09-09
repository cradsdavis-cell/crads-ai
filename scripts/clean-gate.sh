#!/usr/bin/env bash
# clean-gate.sh: the personal/org-content wall for baked product code.
#
# Scope: the paths that BAKE into the shared product images and must therefore be
# deployment-agnostic and person-free (rock-machinery/, provisioning/rock/, the
# Dockerfiles, docker-bake.hcl). Deliberately NOT the whole repo: docs and the managed
# provisioning defaults live outside the trust claim.
#
# Two marker classes, and the reason this is a wall not a hope:
#   personal  = the operator's identity or private life. Any hit ships an operator's
#               private brain in a client product. Always fatal.
#   org       = a specific deployment's name/domain in product code. Any hit forks the
#               image line the moment deployment #2 exists. Always fatal.
# The lesson behind it (2026-07-17 leak-hunt): a denylist cannot catch UN-ENUMERATED
# proper nouns, so scrub-and-copy from a personal system is banned outright (D29); this
# gate exists to keep the authored module honest, not to launder anything.
#
# Exit 0 = clean. Exit 1 = leak, with every hit printed.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SCOPE=(rock-machinery provisioning/rock provisioning/host-updates Dockerfile.base Dockerfile.member Dockerfile.rock docker-bake.hcl)
# brain-control/ is vendored from brain-template by scripts/vendor-brain-control.sh
# and bakes into the rock image, so it is baked product code and belongs behind
# the same wall as everything else here. Added conditionally because it does not
# exist in a fresh checkout: the workflow vendors BEFORE this runs, and a local
# run without it simply scans one root fewer rather than erroring.
# brain-control/ is vendored from brain-template and bakes into the rock image,
# so it is baked product code. It is scanned SEPARATELY, and only by the personal
# wall, for a reason worth stating rather than burying:
#
# brain-template's machinery used to hardcode https://directory.crads-ai.com
# as its default directory URL. The self-host strip (2026-09-01) neutralised
# every one of those clients — the directory-facing control scripts exit 0
# before dialling — so the string survives only in comments and in unreachable
# reference bodies. That still trips the ORG pattern, which exists so the image
# stays deployment-neutral, and the same reasoning as before applies: those
# bytes already sit on every rock in the field, so baking them leaks nothing.
#
# The PERSONAL wall still applies here absolutely, with no exception. An
# operator's name or home path in baked code is a different class of problem.
VENDORED=()
[ -d brain-control ] && VENDORED=(brain-control)
# ghcr.io/cradsdavis-cell is the accepted PRODUCT registry namespace (the images are the
# operator's product); it is allowed ONLY in that exact form, never bare.
PERSONAL='cradsdavis(?!-cell)|samuel|caradog|coogee|sdav2732|0493 ?302|/home/sam'
ORG='acme-collab|crads-ai\.com|ic-brain|ic-content|ic-inbox'
# credential = a real Google OAuth client id or secret, anywhere in the tree.
# GitHub push protection blocked the first public push of this repository
# (2026-09-09) on exactly this: the desktop client that the private product
# ships as a default. The public copy ships env-only defaults, and this wall
# keeps the next sync from bringing the literal back. Fixture ids in tests
# ("x.apps.googleusercontent.com", "GOCSPX-s") are too short to match.
CRED='GOCSPX-[A-Za-z0-9_-]{20,}|[0-9]{10,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com'

fail=0
scan(){ # $1 label, $2 pattern, $3.. roots
  local hits label="$1" pattern="$2"
  shift 2
  hits="$(grep -rniP --binary-files=without-match --exclude-dir=.git --exclude-dir=node_modules "$pattern" "$@" 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    printf '\033[31mclean-gate FAIL [%s]:\033[0m\n%s\n' "$label" "$hits"
    fail=1
  fi
}
scan personal "$PERSONAL" "${SCOPE[@]}" ${VENDORED[@]+"${VENDORED[@]}"}
scan org "$ORG" "${SCOPE[@]}"
scan credential "$CRED" .

if [ "$fail" = 1 ]; then
  echo "clean-gate: baked product code carries personal or org-specific content. Fix the source; never allowlist a name." >&2
  exit 1
fi
echo "clean-gate: OK (${#SCOPE[@]} authored roots + ${#VENDORED[@]} vendored, zero hits)"
