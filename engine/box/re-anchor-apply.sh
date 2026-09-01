#!/usr/bin/env bash
# re-anchor-apply.sh — the BOX-SIDE leg of a re-anchor (ruled option c,
# 2026-07-28): when the anchor moves from rock A to rock B, THIS BOX re-mints
# its own heartbeat credential. The private key never leaves the box; neither
# rock ever touches the other's credentials; the old rock relays only a
# credential-free NOTICE and the new rock receives only the PUBLIC half.
#
# Delivered facts: /state/org-inbox/re-anchor/notice.json
#   { "new_anchor": "<org slug>", "new_gh_owner": "<github owner>", "date": "..." }
# (pushed by the OLD anchor's re-anchor-reconcile down its still-open inbox;
# information only, exactly what the box may know.)
#
# Steps, ORDER LOAD-BEARING (mirrors the certified transfer-accept shape):
#   1. mint a NEW heartbeat keypair (idempotent: keep an existing re-anchor key)
#   2. publish the PUBLIC half + an accepted marker to the OLD heartbeat repo
#      (still writable): the old rock relays it to the new rock via the engine
#   3. rewrite heartbeat.conf to the new owner + swap the key file: from now,
#      heartbeat-push targets the NEW rock's repo, failing SOFT until the new
#      rock registers the key (heartbeat-push already tolerates denied pushes)
# Two-consent already happened in the requests engine (the owner + the new
# rock); executing the swap is mechanical, so this runs on the sync cadence.
set -euo pipefail
BOX="${1:-${STATE_DIR:-/state}}"
NOTICE="$BOX/org-inbox/re-anchor/notice.json"
log(){ printf '[re-anchor-apply] %s\n' "$*"; }

[ -f "$NOTICE" ] || exit 0
[ -f "$BOX/heartbeat.conf" ] || { log "no heartbeat channel; nothing to swap."; exit 0; }
NEW_OWNER="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).new_gh_owner||"")}catch{}' "$NOTICE")"
NEW_ANCHOR="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).new_anchor||"")}catch{}' "$NOTICE")"
[ -n "$NEW_OWNER" ] || { log "notice has no new_gh_owner; refusing to swap blind."; exit 0; }
. "$BOX/heartbeat.conf"   # ORG_GH_OWNER (old), SLUG
if [ "$ORG_GH_OWNER" = "$NEW_OWNER" ]; then log "already on $NEW_OWNER; nothing to do."; exit 0; fi

# 1. mint (the private half never leaves this box)
NK="$BOX/secrets/heartbeat_deploy_key.reanchor"
if [ ! -f "$NK" ]; then
  ssh-keygen -q -t ed25519 -N '' -C "$SLUG-heartbeat-$NEW_ANCHOR" -f "$NK"
  chmod 600 "$NK"
  log "new heartbeat key minted for $NEW_ANCHOR (private half stays here)"
fi

# 2. publish the PUBLIC half via the OLD channel (the one repo this box can write)
WORK="$BOX/.reanchor-out"
touch "$BOX/.gitignore"; grep -qxF '.reanchor-out/' "$BOX/.gitignore" || echo '.reanchor-out/' >> "$BOX/.gitignore"
URL="${HEARTBEAT_REMOTE_URL:-ssh://git@github.com/$ORG_GH_OWNER/heartbeat-$SLUG.git}"
export GIT_SSH_COMMAND="ssh -i $BOX/secrets/heartbeat_deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
if [ -d "$WORK/.git" ]; then git -C "$WORK" pull -q --ff-only origin main 2>/dev/null || true
else git clone -q "$URL" "$WORK" 2>/dev/null || { log "old channel unreachable; will retry next sync."; exit 0; }
fi
mkdir -p "$WORK/re-anchor"
cp "$NK.pub" "$WORK/re-anchor/heartbeat_key.pub"
printf '{"accepted":"%s","new_anchor":"%s"}\n' "$(date -u +%F)" "$NEW_ANCHOR" > "$WORK/re-anchor/accepted.json"
git -C "$WORK" add re-anchor
if [ -n "$(git -C "$WORK" status --porcelain -- re-anchor)" ]; then
  git -C "$WORK" -c user.name=member -c user.email=box@member.local commit -qm "re-anchor: public key for $NEW_ANCHOR"
fi
git -C "$WORK" push -q origin main 2>/dev/null || { log "old channel push denied; will retry next sync."; exit 0; }
log "public key published via the old channel (the old rock relays it onward)"

# 3. switch the channel: new owner + the new key. Fail-soft from here by design.
# RETIRE THE OLD KEY ASIDE, never over the top. The new key is only usable once
# the new rock registers the public half, which requires the OLD rock to relay it
# (step 2 above) and is explicitly fail-soft. If that relay never runs, or the old
# rock is torn down first, overwriting left the box holding a key nobody accepts
# and having destroyed the one that worked: every member-side org action rides
# this single channel, so leave-org, ask-answer and heartbeats all die together
# with no way back. Retiring aside costs one file and keeps a recovery path.
# Same rule vault-crypto.mjs and member-connect.mjs already follow for keys they
# cannot re-mint, and the project's never-delete-archive rule.
OLDK="$BOX/secrets/heartbeat_deploy_key"
if [ -f "$OLDK" ]; then
  cp "$OLDK" "$OLDK.pre-reanchor-$(date -u +%Y%m%d%H%M%S)" 2>/dev/null || true
fi
printf 'ORG_GH_OWNER=%s\nSLUG=%s\n' "$NEW_OWNER" "$SLUG" > "$BOX/heartbeat.conf"
cp "$NK" "$BOX/secrets/heartbeat_deploy_key"
cp "$NK.pub" "$BOX/secrets/heartbeat_deploy_key.pub"
rm -rf "$BOX/.heartbeat-out"   # the push clone still points at the old remote
mv "$NOTICE" "$NOTICE.applied"
log "channel swapped: heartbeats now target $NEW_OWNER/heartbeat-$SLUG (soft-failing until the new rock registers the key)."
