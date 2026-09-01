#!/usr/bin/env bash
# evict-apply.sh — the BOX-SIDE leg of an eviction (Mountain model, 2026-08-04).
# The anchor rock ended the tie; NOTHING on this box is destroyed. Under the
# uniform anchor rule there is no anchorless state, so the box re-anchors to
# the Mountain: its own ownership record flips anchor -> crads-ai, its brain,
# services and personal seat continue exactly as before, and the bill for the
# hosted seat moves to the box's owner (the ruled consequence of leaving).
#
# Delivered facts: /state/org-inbox/evict/notice.json
#   { "org": "<rock slug>", "reason": "<the rock's short why>", "date": "..." }
# The notice stays on disk deliberately: the person's own screen should say WHO
# ended the tie and why (the pause-honesty precedent), never look like an outage.
set -euo pipefail
BOX="${1:-${STATE_DIR:-/state}}"
NOTICE="$BOX/org-inbox/evict/notice.json"
log(){ printf '[evict-apply] %s\n' "$*"; }

[ -f "$NOTICE" ] || exit 0
OWN="$BOX/ownership.json"
[ -f "$OWN" ] || { log "no ownership record; seed-pages will backstop one Mountain-anchored anyway."; exit 0; }

CUR="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).anchor||"")}catch{}' "$OWN")"
if [ "$CUR" = "crads-ai" ]; then log "already Mountain-anchored; nothing to flip."; exit 0; fi

node -e '
const fs = require("fs");
const f = process.argv[1];
const j = JSON.parse(fs.readFileSync(f, "utf8"));
j.anchor = "crads-ai";
fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
' "$OWN"
log "re-anchored to the Mountain (was: ${CUR:-none}). The notice in org-inbox/evict/ says who ended the tie and why."

# STOP TALKING TO THEM. Re-anchoring alone left heartbeat.conf and
# org-inbox.conf in place, so the hourly heartbeat and the two-minute org-sync
# kept running against the repos of the rock that had just ended the
# tie: an evicted member went on sending status metadata to them indefinitely.
# Both jobs self-guard on their own conf and exit 0 without it, so removing the
# confs IS the detach. The NOTICE deliberately stays: the person's own screen
# should still be able to say who ended the tie and why. The brain, the box and
# every skill on it are untouched — eviction ends a membership, not a box.
rm -f "$BOX/heartbeat.conf" "$BOX/org-inbox.conf" "$BOX/org-contact.json" 2>/dev/null || true
rm -f "$BOX/secrets/heartbeat_deploy_key" "$BOX/secrets/org_inbox_deploy_key" 2>/dev/null || true
log "detached: the status updates to that rock stop now. Your box, your brain and your skills are untouched."
