#!/usr/bin/env bash
# pebble-seed.sh <outdir> — assemble the brain a Mountain-built pebble is born with.
#
# Until 2026-08-17 the only caller that ever set SEED_DIR was the retired
# rock-side factory (brain-template/factory/stamp-pebble.sh), so every pebble
# built on the one build path (spec docs/superpowers/specs/2026-08-14-one-build-path.md)
# booted with an EMPTY scaffold: no CLAUDE.md contract, no
# wiki/system/membership.md, no first-conversation script, no starter skills,
# no lineage.json (trap 53). provision-pebble.sh calls this when SEED_DIR is
# unset, so a pebble is born with its brain regardless of initiator.
#
# Inputs (env):
#   PEBBLE_TEMPLATE_DIR  template checkout (default $HOME/brain-template/pebble-template)
#   AIOS_ANCHOR_ORG      rock handle when anchored at birth; empty = solo
#   CLIENT_NAME          the member's name as the initiator gave it (PEBBLE_NAME accepted)
#   AIOS_BOX_NAME        the name typed at the door. Solo builds carry it; a
#                        rock-anchored build deliberately does not (born
#                        nameless, onboarding asks — ruling 2026-08-16).
#
# Ownership language is MEMBER-SIDE ONLY. The org-owned variants are never
# shipped from here: rock-owned pebbles are a held-open decision (one-build-path
# spec, "Deferred, deliberately"), and per Sam 2026-08-17 the ownership/context
# answers stay member-side until that positioning pass happens.
#
# The seed carries NO ownership.json: first boot writes it (holder_email from
# AIOS_OWNER_EMAIL via /etc/ai-os/env), and the anchor claim flips its anchor.
# Seeding one here would fight the box's own record.
set -euo pipefail
die(){ printf 'ERROR: %s\n' "$*" >&2; exit 1; }

OUT="${1:-}"
[ -n "$OUT" ] && [ -d "$OUT" ] || die "usage: pebble-seed.sh <existing-empty-outdir>"

TPL="${PEBBLE_TEMPLATE_DIR:-$HOME/brain-template/pebble-template}"
[ -d "$TPL" ] || die "pebble template not found: $TPL (point PEBBLE_TEMPLATE_DIR at a brain-template checkout's pebble-template/)"
[ -f "$TPL/profile.yaml" ] || die "$TPL has no profile.yaml; not a pebble template"
[ -f "$TPL/CLAUDE.md" ]    || die "$TPL has no CLAUDE.md; not a pebble template"

cp -a "$TPL/." "$OUT/"

# Skills live where Claude Code discovers them, once (live-cert 2026-08-03:
# shipping them twice rode the same 32 KiB user-data budget for nothing).
mkdir -p "$OUT/.claude/skills"
for sk in "$OUT"/skills/*.md; do
  [ -f "$sk" ] || continue
  n="$(basename "$sk" .md)"
  mkdir -p "$OUT/.claude/skills/$n"
  cp "$sk" "$OUT/.claude/skills/$n/SKILL.md"
done
rm -rf "$OUT/skills"
# box/ machinery ships in the member image (engine/box/); nothing reads /state/box.
rm -rf "$OUT/box"

# --- pick the ownership/context variant ---
ANCHOR="${AIOS_ANCHOR_ORG:-}"
if [ -n "$ANCHOR" ]; then
  # Anchored at birth: the member files as written. ORG_NAME renders as the
  # rock's HANDLE ("acme"): the display name does not travel with the build
  # request yet, and the vocabulary pass is deferred (one-build-path spec).
  ORG_NAME="$ANCHOR"
else
  # Solo: the org-centric pages would be false, so the template ships solo
  # variants. Their absence means this checkout predates them: refuse rather
  # than seed a solo box with pages about an org it does not have.
  [ -f "$OUT/CLAUDE-solo.md" ] && [ -f "$OUT/wiki/system/membership-solo.md" ] \
    || die "$TPL has no solo variants (CLAUDE-solo.md + wiki/system/membership-solo.md): update the brain-template checkout"
  mv "$OUT/CLAUDE-solo.md" "$OUT/CLAUDE.md"
  mv "$OUT/wiki/system/membership-solo.md" "$OUT/wiki/system/membership.md"
  ORG_NAME="Crads-AI"
fi
rm -f "$OUT/CLAUDE-org-owned.md" "$OUT/CLAUDE-solo.md" \
      "$OUT/wiki/system/membership-org-owned.md" "$OUT/wiki/system/membership-solo.md"

# --- lineage: the frozen birth record (schema = brain-template factory/lineage.mjs) ---
printf '{"origin":"%s","stamped_by":"%s","born":"%s","framework_imprint":"","reframes":[]}\n' \
  "$([ -n "$ANCHOR" ] && echo stamped || echo self)" "$ANCHOR" "$(date +%F)" > "$OUT/lineage.json"

# --- render the tokens (the closed set pinned by brain-template
#     tests/pebble-template-variants.test.mjs; adding one there must add it here) ---
NAME="${CLIENT_NAME:-${PEBBLE_NAME:-}}"
SHORT="${NAME%% *}"
ASSIST="${AIOS_BOX_NAME:-}"
# The box's name IS the assistant's name (docs/naming.md). Nameless is a real
# state: CLAUDE.md's first-conversation line gets an instruction instead.
ASSIST_MD="${ASSIST:-no name yet: invite them to choose one}"
AI_LINE="I disclose AI authorship where a human would assume a human wrote it."
# Names arrive from the door as free text; neutralise sed's specials (&, |, \).
sedq(){ printf '%s' "$1" | sed 's/[&|\\]/\\&/g'; }
NAME="$(sedq "$NAME")"; SHORT="$(sedq "$SHORT")"
ASSIST="$(sedq "$ASSIST")"; ASSIST_MD="$(sedq "$ASSIST_MD")"
while IFS= read -r -d '' f; do
  sed -i \
    -e "s|{{ORG_NAME}}|$ORG_NAME|g" \
    -e "s|{{PULSE_NAME}}|Pulse|g" \
    -e "s|{{AREAS_LABEL}}|Areas|g" \
    -e "s|{{EXPERTS_LABEL}}|Experts|g" \
    -e "s|{{OUTBOUND_POLICY}}|propose-confirm|g" \
    -e "s|{{AI_DISCLOSURE_LINE}}|$AI_LINE|g" \
    -e "s|{{AI_DISCLOSURE}}|true|g" \
    -e "s|{{QUIET_HOURS}}|21:00-06:30|g" \
    -e "s|{{TIMEZONE}}|Australia/Sydney|g" \
    -e "s|{{USER_NAME}}|$NAME|g" \
    -e "s|{{USER_SHORT}}|$SHORT|g" \
    -e "s|{{PROVIDER}}||g" \
    -e "s|{{INBOX_MODE}}|forwarding|g" \
    -e "s|{{SEND_AS}}||g" \
    "$f"
done < <(find "$OUT" -type f \( -name '*.md' -o -name '*.yaml' \) -print0)
sed -i "s|{{ASSISTANT_NAME}}|$ASSIST|g" "$OUT/profile.yaml"
find "$OUT" -type f -name '*.md' -print0 | xargs -0 sed -i "s|{{ASSISTANT_NAME}}|$ASSIST_MD|g"

# A token this script does not know about must never reach a member's box.
LEFT="$(grep -rlE '\{\{[A-Z_]+\}\}' "$OUT" || true)"
[ -z "$LEFT" ] || die "unrendered template tokens remain in: $LEFT (teach pebble-seed.sh the new token)"

echo "seed assembled: $([ -n "$ANCHOR" ] && echo "anchored to $ANCHOR" || echo solo)${NAME:+ · $NAME}"
