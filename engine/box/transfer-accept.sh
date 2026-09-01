#!/usr/bin/env bash
# transfer-accept.sh — the member-run mechanical leg of transfer-to-org (D60 O5b).
# Delivered to the box via the inbox by transfer-invite; the member's APP runs it
# after recording consent. CONSENT IS NOT THIS SCRIPT (Harriet's audit 2026-08-19,
# point 3): a support session lands on this box as the same unix user, so a
# script here can never tell the member from a visitor, and the old header said
# as much ("not a security boundary"). The consent that counts is the member's
# own sign-in, recorded at the directory by the app (POST /transfer-consent);
# what the app hands this script is the RECEIPT ($2), and this script refuses to
# touch anything without one. The org's completer checks the same record before
# it flips owner, so a receipt forged here buys nothing. What protects the
# member: their own pre-existing repo lives under their own GitHub and is never
# touched (fresh-custody freezes it); what protects the org: its repo + revocable
# keys.
#
# ORDER IS LOAD-BEARING: mint key -> conf -> wire script -> PUBLIC key up via the
# heartbeat repo -> flip ownership.json -> publish the ACCEPTED marker (post-flip,
# a second heartbeat commit). The org's complete leg requires the marker, not just
# the pubkey, so completion can never outrun the flip (2026-07-25 gate, finding 4).
# A crash between flip and marker self-heals: re-running lands in the recovery
# branch below and publishes the marker. A failed pubkey push means no flip.
# The PRIVATE key never leaves the box.
set -euo pipefail
BOX="${1:-${STATE_DIR:-/state}}"
RECEIPT="${2:-${TRANSFER_CONSENT_RECEIPT:-}}"
INV="$BOX/org-inbox/transfer/to-org.json"
# Which invitation is being accepted. A bare {"accepted":<date>} receipt was
# REUSABLE: the org's completer only tested that the file existed and nothing
# ever deletes it, so after a full round trip a LATER transfer-to-org could
# complete on this same receipt with the member never asked again. Naming the
# invitation is what makes consent non-transferable between transfers.
invited_date(){ node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).invited||""))}catch{}' "$INV" 2>/dev/null || true; }
log(){ printf '[transfer-accept] %s\n' "$*"; }

# --- guards, all before any mutation ---
[ -f "$INV" ] || { log "no transfer invitation from your rock. Nothing to accept."; exit 0; }
case "$RECEIPT" in
  ????????????????????????????????) [ -z "$(printf %s "$RECEIPT" | tr -d '0-9a-f')" ] || RECEIPT="" ;;
  *) RECEIPT="" ;;
esac
[ -n "$RECEIPT" ] || { log "REFUSED: accepting a transfer needs your own sign-in. Press Accept in your Crads-AI app (it records your consent at the directory and passes the receipt here). Running this script by hand, or from a support session, is not consent. Nothing changed."; exit 1; }
[ -f "$BOX/heartbeat.conf" ] && [ -f "$BOX/secrets/heartbeat_deploy_key" ] \
  || { log "this box has no heartbeat channel (not rock-managed); transfer-to-org needs one. Ask your rock."; exit 0; }
. "$BOX/org-inbox.conf"   # ORG_GH_OWNER, SLUG (factory-seeded, non-secret)

# --- heartbeat working clone (read/write; the one repo this box can write) ---
WORK="$BOX/.transfer-out"
touch "$BOX/.gitignore"; grep -qxF '.transfer-out/' "$BOX/.gitignore" || echo '.transfer-out/' >> "$BOX/.gitignore"
URL="${HEARTBEAT_REMOTE_URL:-ssh://git@github.com/$ORG_GH_OWNER/heartbeat-$SLUG.git}"
export GIT_SSH_COMMAND="ssh -i $BOX/secrets/heartbeat_deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
hb_sync(){
  if [ -d "$WORK/.git" ]; then
    git -C "$WORK" remote set-url origin "$URL"
    git -C "$WORK" pull -q --ff-only origin main
  else
    git clone -q "$URL" "$WORK"
  fi
}
hb_publish(){ # hb_publish <src> <dest-rel> <msg>  (stages transfer/ ONLY: nothing else may ride)
  mkdir -p "$WORK/transfer"
  cp "$1" "$WORK/transfer/$2"
  git -C "$WORK" add transfer
  if [ -n "$(git -C "$WORK" status --porcelain -- transfer)" ]; then
    git -C "$WORK" -c user.name=member -c user.email=box@member.local commit -qm "$3"
  fi
  git -C "$WORK" push -q origin main
}

# --- recovery branch: already flipped (a crash landed between flip and marker) ---
if ! node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(o.owner==="member"?0:1)}catch{process.exit(1)}' "$BOX/ownership.json"; then
  hb_sync
  if git -C "$WORK" cat-file -e "main:transfer/accepted.json" 2>/dev/null; then
    log "already accepted (this box is already rock-owned)."
  else
    T="$(mktemp)"; printf '{"accepted":"%s","invited":"%s","consent":"%s"}\n' "$(date +%F)" "$(invited_date)" "$RECEIPT" > "$T"
    hb_publish "$T" "accepted.json" "transfer-accept: confirmed for $SLUG"
    rm -f "$T"
    log "already flipped; the acceptance marker is now published (recovered)."
  fi
  exit 0
fi

# --- 1. mint the deploy keypair ON the box (idempotent: keep an existing key) ---
KEY="$BOX/secrets/org_brain_deploy_key"
if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -N '' -C "$SLUG-brain" -f "$KEY" >/dev/null
  chmod 600 "$KEY"
  log "deploy key minted on this box (the private half never leaves it)"
fi

# --- 2. org-brain.conf + the wire script (org-brain-wire runs on the org-sync cadence) ---
printf 'ORG_GH_OWNER=%s\nSLUG=%s\n' "$ORG_GH_OWNER" "$SLUG" > "$BOX/org-brain.conf"
cp "$BOX/org-inbox/transfer/org-brain-wire.sh" "$BOX/org-brain-wire.sh"; chmod +x "$BOX/org-brain-wire.sh"
log "org wiring staged (conf + wire script)"

# --- 3. publish the PUBLIC half up via the heartbeat repo ---
hb_sync
hb_publish "$KEY.pub" "org_brain_deploy_key.pub" "transfer-accept: public key for $SLUG-brain"
log "public key published to the rock (heartbeat channel)"

# --- 4. flip ownership: this arms org-brain-wire on the next sync pass ---
# T2.3: the flip records the owner POINTER too (owner_slug from the invitation's
# org_slug, falling back to the GitHub owner), so ownership.json names its org.
node -e 'const fs=require("fs");const p=process.argv[1];const inv=process.argv[2];const fb=process.argv[3];const o=JSON.parse(fs.readFileSync(p,"utf8"));o.owner="org";let s="";try{s=JSON.parse(fs.readFileSync(inv,"utf8")).org_slug||""}catch{};o.owner_slug=s||fb||"";fs.writeFileSync(p,JSON.stringify(o)+"\n")' "$BOX/ownership.json" "$INV" "$ORG_GH_OWNER"

# --- 5. the ACCEPTED marker, post-flip: completion requires this, not just the key ---
T="$(mktemp)"; printf '{"accepted":"%s","invited":"%s","consent":"%s"}\n' "$(date +%F)" "$(invited_date)" "$RECEIPT" > "$T"
hb_publish "$T" "accepted.json" "transfer-accept: confirmed for $SLUG"
rm -f "$T"
log "accepted: this box's brain is now the rock's. Wiring completes on the next sync; pushes begin once the rock registers the key (transfer-org-complete)."
