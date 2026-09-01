#!/usr/bin/env bash
# vendor-brain-control.sh: stage the rock brain's CONTROL PLANE into the build
# context so it bakes into the rock image.
#
# WHY THIS EXISTS (2026-08-26). A rock's reconcile machinery (control/,
# orchestrator/) lives inside the ORGANISATION'S OWN brain repo, by the
# ownership ruling of 2026-08-09: "the github repo should be their own off the
# bat, Crads AI should not own anyone's backups." Rocks stamped in template
# mode have their .git stripped and re-inited on the box, so that machinery has
# no remote and CANNOT be updated. Every rock-side product change was therefore
# unreachable on every rock already in the field, forever.
#
# The fix is the pattern rock-machinery/ already uses and states in its own
# README: "one machinery home, always... versioned and rolled back with the
# image tag." Bake the control plane into the image; boot-rock.sh syncs it into
# the brain at container start. "Update and restart" then updates it, which is
# the button an operator already has.
#
# The SOURCE OF TRUTH stays brain-template: that is where the machinery is
# authored and where its tests live. This only vendors a copy for the bake, and
# the copy is never committed to ai-os (see .gitignore).
#
#   scripts/vendor-brain-control.sh
#   BRAIN_CONTROL_SRC=/path/to/brain-template scripts/vendor-brain-control.sh
#
# The env override takes a local checkout instead of cloning: needed offline,
# in tests, and to bake an unreleased machinery change.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# BRAIN_CONTROL_OUT lets tests vendor into scratch space instead of the build
# context, so running the suite never leaves the repo dirty.
OUT="${BRAIN_CONTROL_OUT:-$HERE/brain-control}"
REPO="${BRAIN_CONTROL_REPO:-https://github.com/cradsdavis-cell/brain-template.git}"
REF="${BRAIN_CONTROL_REF:-main}"

# WHAT IS PRODUCT, AND AT WHAT GRANULARITY. Everything else in a brain (notes,
# decisions, org-policy, their own skills-library and packs) belongs to the
# organisation and is never touched.
#
# control/ and orchestrator/ are machinery end to end, so they come whole.
#
# registry/ and factory/ are NOT: registry/ also holds members/, the member rows
# themselves, which are the most irreplaceable thing on the box. So those two are
# taken FILE BY FILE (*.mjs only) and their data subdirectories are never in the
# vendored tree at all. That is the safety property: a directory that is not
# vendored cannot be overwritten by the overlay, no matter what boot does.
#
# They are here because control/ imports them (registry/normalize-row.mjs,
# registry/membership.mjs, factory/org-github.mjs and five more). Vendoring the
# importers without the imported is how a rock boots into a module-resolution
# error and stops reconciling, silently.
DIRS="control orchestrator"
FILE_DIRS="registry factory"

# What must exist for the vendored copy to be worth baking. A rock that boots
# with a half-vendored control plane is worse than one that boots with its old
# one, so this refuses loudly rather than shipping a hole.
REQUIRED="control/reconcile-all.mjs control/catalog-reconcile.mjs control/catalog-lib.mjs orchestrator/push-down.mjs"

say(){ printf '[vendor-brain-control] %s\n' "$*"; }

WORK=""
cleanup(){ if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf -- "$WORK"; fi; return 0; }
trap cleanup EXIT

if [ -n "${BRAIN_CONTROL_SRC:-}" ]; then
  SRC="$BRAIN_CONTROL_SRC"
  [ -d "$SRC" ] || { say "ERROR: BRAIN_CONTROL_SRC=$SRC is not a directory"; exit 1; }
  SHA="$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo 'local-checkout')"
  # NEVER the local path: SOURCE.txt is committed and bakes into the image, and
  # an operator's home directory is exactly what clean-gate's personal wall
  # exists to keep out of baked code. The canonical name, always.
  ORIGIN="$REPO"
  say "using local checkout $SRC at $SHA (recorded as $REPO)"
else
  WORK="$(mktemp -d)"
  say "cloning $REPO ($REF)"
  git clone --depth 1 --branch "$REF" --quiet "$REPO" "$WORK/bt"
  SRC="$WORK/bt"
  SHA="$(git -C "$SRC" rev-parse HEAD)"
  ORIGIN="$REPO@$REF"
fi

# BUILD ASIDE, SWAP ON SUCCESS. The first cut wiped $OUT and then validated, so
# any failed vendor (a bad ref, a half checkout, a test pointing at a stub
# source) DESTROYED a previously good tree and left the build context with
# whatever it had managed to copy. Caught by a docker build that baked exactly
# one file. Now nothing touches $OUT until the finished tree has passed every
# check below, so a failed run leaves the last good one exactly where it was.
STAGE="$OUT.staging.$$"
rm -rf -- "$STAGE"
stage_cleanup(){ if [ -d "$STAGE" ]; then rm -rf -- "$STAGE"; fi; return 0; }
trap 'cleanup; stage_cleanup' EXIT
# tree/ is an OVERLAY: boot copies it onto the brain with `cp -a tree/. $BRAIN_ROOT/`,
# which merges directories and overwrites files but never deletes. Anything not in
# here is therefore untouchable by the sync, which is the whole safety argument.
mkdir -p "$STAGE/tree"
for d in $DIRS; do
  [ -d "$SRC/$d" ] || { say "ERROR: $ORIGIN has no $d/"; exit 1; }
  cp -a "$SRC/$d" "$STAGE/tree/$d"
done
for d in $FILE_DIRS; do
  [ -d "$SRC/$d" ] || { say "ERROR: $ORIGIN has no $d/"; exit 1; }
  mkdir -p "$STAGE/tree/$d"
  # -maxdepth 1: top-level modules only, so a data subdirectory (registry/members)
  # is never even looked at, let alone copied.
  find "$SRC/$d" -maxdepth 1 -type f -name '*.mjs' -exec cp -a {} "$STAGE/tree/$d/" \;
done

# Tests live beside the machinery in brain-template and must not bake: they are
# not product, they pull in fixtures, and clean-gate would have to reason about
# every one of them.
find "$STAGE" -name '*.test.mjs' -delete

for f in $REQUIRED; do
  [ -f "$STAGE/tree/$f" ] || { say "ERROR: vendored copy is missing $f; refusing to bake a half control plane"; exit 1; }
done

# Belt and braces on the one thing that would actually lose data.
if [ -e "$STAGE/tree/registry/members" ]; then
  say "ERROR: member rows reached the vendored tree; refusing to bake something that could overwrite them"
  exit 1
fi

# Read at boot to decide whether the baked copy is newer than what is on the
# brain, and printed in the boot log so a support session can tell in one line
# which machinery a rock is actually running.
{
  echo "repo: $ORIGIN"
  echo "sha: $SHA"
  echo "dirs: $DIRS"
  echo "file_dirs: $FILE_DIRS"
} > "$STAGE/SOURCE.txt"

# Every check passed: this tree is now the one. Swap it in, old one last.
rm -rf -- "$OUT"
mv -- "$STAGE" "$OUT"
say "vendored $(find "$OUT" -type f | wc -l) files from $ORIGIN at ${SHA:0:12}"
