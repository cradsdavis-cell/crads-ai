#!/usr/bin/env bash
# org-brain-setup.sh: enrol a member box into an org brain (spec 2026-07-25).
#   org-brain-setup.sh <state-dir> <member-slug> <org-brain-remote-url>
# Idempotent: safe to re-run. Creates the org clone, the config, the personal
# enclave seed, and the CLAUDE.md org-context pointer (marker-guarded).
set -euo pipefail
STATE="${1:?usage: org-brain-setup.sh <state-dir> <slug> <remote-url>}"
SLUG="${2:?missing slug}"
REMOTE="${3:?missing remote url}"

mkdir -p "$STATE/org"
if [ ! -d "$STATE/org/brain/.git" ]; then
  git clone -q "$REMOTE" "$STATE/org/brain"
fi
node -e 'require("fs").writeFileSync(process.argv[3], JSON.stringify({ slug: process.argv[1], remote: process.argv[2] }) + "\n")' "$SLUG" "$REMOTE" "$STATE/org/config.json"

mkdir -p "$STATE/wiki/personal"
if [ ! -f "$STATE/wiki/personal/README.md" ]; then
  cat > "$STATE/wiki/personal/README.md" <<'EOF'
# Personal enclave

Nothing in this folder, and no page carrying `enclave: true` frontmatter, is ever
read by the org-publish job or shared with the org. It stays on this box.
EOF
fi

MARK="<!-- org-brain-context -->"
CM="$STATE/CLAUDE.md"
touch "$CM"
if ! grep -qF "$MARK" "$CM"; then
  cat >> "$CM" <<EOF

$MARK
## Org context

This box belongs to an org. Whole-company context lives in the read-only clone at
\`org/brain/\`: \`members/<slug>/\` holds each member's published extracts, \`entities/\`
holds the hub-merged view per client or project, \`digest/\` holds the daily org digest.
Consult it for anything touching other members' clients, org decisions, or "does anyone
know". Every claim there carries a \`source:\` line naming the box and page it came from.
Personal enclave: \`wiki/personal/\` and \`enclave: true\` pages never leave this box.
EOF
fi
echo "org-brain: $SLUG enrolled -> $REMOTE"
