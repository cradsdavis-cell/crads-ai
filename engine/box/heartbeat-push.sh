#!/usr/bin/env bash
# heartbeat-push.sh: push THIS box's metadata heartbeat UP to every rock that
# holds a heartbeat-<slug> repo for it (D49; panel iteration 2 R9). The exact
# reverse of org-sync.sh: org-sync PULLS content down (member-read); this PUSHES
# metadata up (member-write). Only the filtered /state/cockpit/heartbeat.json
# ever leaves, NEVER heartbeat-full.json, never any wiki content. The member's
# sharing toggles have already filtered it. There is no read path from the rock
# into this box; this is the box choosing to hand out its own status.
#
# ONE REPO PER ROCK (R9, 2026-08-23). The anchor's pipe is the legacy
# /state/heartbeat.conf + /state/secrets/heartbeat_deploy_key, seeded at stamp
# time. Every JOINED rock gets the same mechanism as a conf under
# /state/heartbeat.d/<rock>.conf, delivered down that rock's inbox and installed
# by org-sync.sh. Each conf is pushed in its own subshell: one rock refusing the
# push (key revoked, repo gone, tie ended) never stops the others. The SAME
# filtered heartbeat.json goes to every rock; the floor is the floor.
#
# Conf vars (all confs): ORG_GH_OWNER, SLUG; optional KEY (path to the deploy
# key for that rock), optional HEARTBEAT_REMOTE_URL (overrides the derived URL).
set -uo pipefail
BOX="${1:-${STATE_DIR:-/state}}"
HB="$BOX/cockpit/heartbeat.json"                 # the filtered heartbeat (what the member permitted)
OUT="$BOX/.heartbeat-out"                        # one working clone per rock: $OUT/<rock>
log(){ printf '[heartbeat-push] %s\n' "$*"; }

# Collect the confs first so "nothing to do" is a clean exit 0 even before the
# emitter has run.
confs=()
[ -f "$BOX/heartbeat.conf" ] && confs+=("anchor:$BOX/heartbeat.conf")
if [ -d "$BOX/heartbeat.d" ]; then
  for f in "$BOX/heartbeat.d"/*.conf; do
    [ -f "$f" ] || continue
    rock="$(basename "$f" .conf)"
    case "$rock" in
      anchor) log "heartbeat.d/anchor.conf is reserved for the stamp-time conf; skipping."; continue;;
      *[!A-Za-z0-9._-]*|.*) log "ignoring heartbeat.d/$rock.conf (bad rock name)."; continue;;
    esac
    confs+=("$rock:$f")
  done
fi
[ "${#confs[@]}" -gt 0 ] || exit 0               # not an org-managed box
[ -f "$HB" ] || { log "no heartbeat.json yet (emitter has not run)"; exit 0; }

# Keep the working clones out of the member's own committed brain.
touch "$BOX/.gitignore"; grep -qxF '.heartbeat-out/' "$BOX/.gitignore" || echo '.heartbeat-out/' >> "$BOX/.gitignore"

# Pre-R9 boxes kept the anchor's clone AT $OUT. Move it under $OUT/anchor once
# so the per-rock layout holds without a re-clone.
if [ -d "$OUT/.git" ]; then
  mv "$OUT" "$OUT.migrate" && mkdir -p "$OUT" && mv "$OUT.migrate" "$OUT/anchor"
fi
mkdir -p "$OUT"

# push_one <rock> <conf>: runs in a subshell (see the loop) so a failure is
# contained to this rock. Exit 0 = pushed or nothing to push; 1 = this rock
# refused (logged, never fatal to the run).
push_one() {
  local rock="$1" conf="$2" work="$OUT/$1"
  local ORG_GH_OWNER="" SLUG="" KEY="" HEARTBEAT_REMOTE_URL=""
  . "$conf"                                       # ORG_GH_OWNER, SLUG (+ KEY, HEARTBEAT_REMOTE_URL)
  [ -n "$ORG_GH_OWNER" ] && [ -n "$SLUG" ] || { log "$rock: conf lacks ORG_GH_OWNER or SLUG; skipping."; return 0; }
  if [ -z "$KEY" ]; then
    if [ "$rock" = anchor ]; then KEY="$BOX/secrets/heartbeat_deploy_key"; else KEY="$BOX/secrets/heartbeat_deploy_key.$rock"; fi
  fi
  [ -f "$KEY" ] || { log "$rock: no write key at $KEY (membership may be closed); skipping."; return 0; }

  # ssh:// dodges the image's global git@github.com -> https rewrite.
  local URL="${HEARTBEAT_REMOTE_URL:-ssh://git@github.com/$ORG_GH_OWNER/heartbeat-$SLUG.git}"
  export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

  if [ -d "$work/.git" ]; then
    git -C "$work" pull --ff-only origin main 2>/dev/null || true
  else
    git clone --depth 1 "$URL" "$work" 2>/dev/null || { log "$rock: clone denied (membership closed?). skipping."; return 1; }
  fi

  cp "$HB" "$work/heartbeat.json"                 # ONLY the filtered heartbeat leaves the box
  git -C "$work" add heartbeat.json || return 1
  if [ -z "$(git -C "$work" status --porcelain -- heartbeat.json)" ]; then log "$rock: no change."; return 0; fi
  git -C "$work" -c user.name=member -c user.email=box@member.local commit -qm "heartbeat $(date -u +%FT%TZ)" || return 1
  git -C "$work" push -q origin main 2>/dev/null || { log "$rock: push denied (membership closed?)."; return 1; }
  log "$rock: pushed."
}

# Two confs that resolve to the same repo (a joined-rock conf delivered for the
# rock that already anchors this box) push once, under the first name seen.
seen_urls=" "
ok=0; failed=0
for entry in "${confs[@]}"; do
  rock="${entry%%:*}"; conf="${entry#*:}"
  url="$(ORG_GH_OWNER=""; SLUG=""; HEARTBEAT_REMOTE_URL=""; . "$conf" 2>/dev/null; printf '%s' "${HEARTBEAT_REMOTE_URL:-ssh://git@github.com/${ORG_GH_OWNER:-}/heartbeat-${SLUG:-}.git}")"
  case "$seen_urls" in *" $url "*) log "$rock: same repo as an earlier conf; skipping."; continue;; esac
  seen_urls="$seen_urls$url "
  if ( push_one "$rock" "$conf" ); then ok=$((ok+1)); else failed=$((failed+1)); fi
done
[ "$failed" -gt 0 ] && log "$ok rock(s) fine, $failed refused."
exit 0
