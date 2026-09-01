#!/usr/bin/env bash
# org-sync.sh · box-side pull of the org push-down inbox. Read-only. Membership-gated.
# The rock WRITES inbox-<slug>; this box only READS it (read-only deploy key).
# There is no path from here back to the rock. Nothing is ever deleted.
set -euo pipefail
BOX="${STATE_DIR:-/state}"

# D60 O2: on an org-OWNED box, (re)wire /state to the org's brain repo. The wire
# script self-guards (conf + key + ownership.json owner==org) and is idempotent,
# so this is a strict no-op on member-owned boxes and on every re-run. Placed
# before the inbox guards: wiring must not depend on the inbox leg.
[ -f "$BOX/org-brain-wire.sh" ] && bash "$BOX/org-brain-wire.sh" "$BOX" || true

CONF="$BOX/org-inbox.conf"       # non-secret: ORG_GH_OWNER + SLUG (+ PULSE_SHEET_ID), seeded by the factory
KEY="$BOX/secrets/org_inbox_deploy_key"   # read-only deploy key (gitignored)
INBOX="$BOX/org-inbox"           # the pulled content (gitignored; never rides the member backup)
log(){ printf '[org-sync] %s\n' "$*"; }

# --- R9: the status pipe to a JOINED rock (panel iteration 2, 2026-08-23) ---------
# A rock that this box joined (not its anchor) gets the same heartbeat mechanism
# as the anchor: its own heartbeat-<slug> repo, a write deploy key, and a conf
# heartbeat-push.sh reads. The rock provisions the repo at join time and delivers
# the two halves down this inbox as heartbeat/conf (the conf text) and
# heartbeat/deploy_key (the private key). They are installed here as
#   /state/heartbeat.d/<rock>.conf            (non-secret)
#   /state/secrets/heartbeat_deploy_key.<rock> (0600)
# where <rock> is ORG_GH_OWNER from the delivered conf, which must be the owner
# of the inbox it arrived in: a rock can open a pipe to itself only.
#
# THE CONF IS NEVER SOURCED AS DELIVERED. inbox-<slug> is rock-writable and
# heartbeat-push.sh sources the conf as shell, so copying it verbatim would hand
# the rock arbitrary code execution as this box's user (the evict-script lesson,
# below). The three permitted values are picked out by regex, validated, and the
# conf is regenerated from them.
#
# Idempotent: a file is written only when absent or changed. When the membership
# is no longer active the conf and key are REMOVED, which is what stops the push
# (heartbeat-push self-guards on its confs). That is not a deletion of content:
# a conf is plumbing, and the rock ending the tie must end the pipe too.
#
# ONE FUNCTION, EVERY INBOX (2026-08-23). The anchor's inbox and each joined
# rock's inbox under org-inbox.d/ get the same leg. A rock whose channel the
# box CLAIMED itself (tie-claim.mjs minted heartbeat_deploy_key.<rock> and left
# its .pub beside it) needs no delivery: the rock registered the box's public
# half, so the inbox leg is optional there and is skipped rather than letting
# a delivered key overwrite a registered one. The non-active removal applies
# either way: a rock that ended the tie ends the pipe.
install_heartbeat_pipe() {
  local INBOX="$1" ORG_GH_OWNER="$2" STATUS="$3"
  local HBD hb_owner hb_rock hb_slug hb_url hb_conf_new hb_key
  HBD="$BOX/heartbeat.d"
  hb_owner="$(grep -oP '^\s*ORG_GH_OWNER=["'"'"']?\K[A-Za-z0-9-]{1,39}(?=["'"'"']?\s*$)' "$INBOX/heartbeat/conf" 2>/dev/null | head -1 || true)"
  [ -n "$hb_owner" ] || hb_owner="$ORG_GH_OWNER"   # no conf in the inbox: the rock named by THIS inbox
  hb_rock="$hb_owner"
  if [ "$STATUS" = "active" ] && [ -f "$BOX/secrets/heartbeat_deploy_key.$hb_rock.pub" ]; then
    :   # claimed by tie-claim: the box's own key is registered on the rock; nothing to deliver
  elif [ "$STATUS" = "active" ] && [ -f "$INBOX/heartbeat/conf" ] && [ -f "$INBOX/heartbeat/deploy_key" ]; then
    hb_slug="$(grep -oP '^\s*SLUG=["'"'"']?\K[A-Za-z0-9._-]{1,80}(?=["'"'"']?\s*$)' "$INBOX/heartbeat/conf" | head -1 || true)"
    hb_url="$(grep -oP '^\s*HEARTBEAT_REMOTE_URL=["'"'"']?\K[A-Za-z0-9@:/._-]{1,200}(?=["'"'"']?\s*$)' "$INBOX/heartbeat/conf" | head -1 || true)"
    if [ "$hb_owner" != "$ORG_GH_OWNER" ]; then
      log "heartbeat conf names '$hb_owner' but this inbox belongs to '$ORG_GH_OWNER'; refused (a rock can only open a pipe to itself)."
    elif [ -z "$hb_slug" ]; then
      log "heartbeat conf from $hb_owner lacks a usable SLUG; refused."
    elif ! head -1 "$INBOX/heartbeat/deploy_key" | grep -q '^-----BEGIN [A-Z ]*PRIVATE KEY-----$'; then
      log "heartbeat deploy key from $hb_owner is not a private key; refused."
    else
      mkdir -p "$HBD" "$BOX/secrets"
      hb_conf_new="$(printf 'ORG_GH_OWNER=%s\nSLUG=%s\n' "$hb_owner" "$hb_slug"; [ -z "$hb_url" ] || printf 'HEARTBEAT_REMOTE_URL=%s\n' "$hb_url")"
      if ! [ -f "$HBD/$hb_rock.conf" ] || [ "$(cat "$HBD/$hb_rock.conf")" != "$hb_conf_new" ]; then
        printf '%s\n' "$hb_conf_new" > "$HBD/$hb_rock.conf.tmp" && mv "$HBD/$hb_rock.conf.tmp" "$HBD/$hb_rock.conf"
        log "status pipe to $hb_rock: conf installed."
      fi
      hb_key="$BOX/secrets/heartbeat_deploy_key.$hb_rock"
      if ! cmp -s "$INBOX/heartbeat/deploy_key" "$hb_key"; then
        ( umask 077; cp "$INBOX/heartbeat/deploy_key" "$hb_key.tmp" ) && chmod 600 "$hb_key.tmp" && mv "$hb_key.tmp" "$hb_key"
        log "status pipe to $hb_rock: key installed."
      fi
    fi
  elif [ "$STATUS" != "active" ]; then
    if [ -f "$HBD/$hb_rock.conf" ] || [ -f "$BOX/secrets/heartbeat_deploy_key.$hb_rock" ]; then
      rm -f "$HBD/$hb_rock.conf" "$BOX/secrets/heartbeat_deploy_key.$hb_rock"
      rm -rf "$BOX/.heartbeat-out/$hb_rock"        # the gitignored working clone, never content
      log "status pipe to $hb_rock removed (membership is '$STATUS')."
    fi
  fi
}

# seed_pages <inbox> <gh owner> [from]: one function for every inbox (2026-08-23).
# RETIRED LEG (delivery-model step 7c, Part B): the catalogue's own reconcile
# job now stages every entitled kind, pages included, automatically, pickup
# only (a member takes it deliberately; nothing here auto-installs it), so
# nothing writes <inbox>/pages/ any more except a hand-run install-pack.mjs
# (itself deprecated). This leg no longer creates anything new: a page id that
# already carries a dashboard/pages.json manifest entry is repaired (a missing
# file recreated; the manifest itself never touched), and an id with no entry
# is left alone, no file, no manifest entry, for the member to pick up
# deliberately via page-install.mjs instead. Member edits still win, always. A
# page the member deleted (dashboard/pages.deleted.json, written by
# page-delete) is never re-copied. The gh-owner and from arguments below are
# accepted for CLI-shape parity but no longer used: they only ever fed the
# `from:`/title derivation for a BRAND NEW manifest entry, and this leg does
# not create those any more.
seed_pages() {
  local INBOX="$1" ORG_GH_OWNER="$2" FROM="${3:-}"
  if [ -d "$INBOX/pages" ] && command -v node >/dev/null 2>&1; then
    # This script itself is a boot-time COPY sitting at $BOX/org-sync.sh
    # (install_box_scripts in box-up.sh), not at its engine/box/ source path,
    # so it cannot find a sibling appshell/ by relative path. The member
    # image always carries the full engine tree at /app/engine (Dockerfile.member
    # WORKDIR /app + COPY engine/), the same fixed path entrypoint.sh already
    # hardcodes for box-up.sh itself, so that is the one reachable from here.
    local seed_status=0
    node "${AIOS_DIR:-/app}/engine/appshell/seed-org-pages.mjs" \
      "$INBOX/pages" "$BOX/dashboard" "${ORG_GH_OWNER:-}" "$BOX" "$FROM" 2>/dev/null || seed_status=$?
    # Fail-soft by design (org-sync also carries membership, keys and heartbeat
    # legs that must complete regardless), but a silent skip here used to mean
    # every org page on this box stops seeding with no signal. Name it instead.
    [ "$seed_status" -eq 0 ] || log "page seeding did not run for $INBOX (seed-org-pages.mjs exited $seed_status); other org-sync legs continue."
  fi
}

# --- JOINED rocks' inboxes (2026-08-23) -------------------------------------------
# tie-claim.mjs writes /state/org-inbox.d/<owner>.conf (ORG_GH_OWNER, SLUG,
# ORG=<handle>) and /state/secrets/org_inbox_deploy_key.<owner> for every rock
# this box has JOINED. Each one is pulled into /state/org-inbox.d/<owner>/ with
# its own read-only key, under the same MEMBERSHIP gate and the same
# never-delete rule as the anchor's inbox. Runs BEFORE the anchor guards below
# because a box with no anchor can still hold joined ties; each inbox runs in
# its own subshell so a refused clone on one never stops the others or the
# anchor's leg. The confs are box-written but still read by regex, never
# sourced. Anchor-only legs (the member door, evict, re-anchor) do not apply.
touch "$BOX/.gitignore"
grep -qxF 'org-inbox.d/' "$BOX/.gitignore" || echo 'org-inbox.d/' >> "$BOX/.gitignore"

# --- COMMUNITIES: the commons-repo pulls (self-host pivot, 2026-09-01) -----------
# Communities joined via a cradscommons1: bundle live in /state/communities.d/
# and their checkouts land in org-inbox.d/<org>/ exactly like a joined rock's
# inbox, so every pickup surface reads them unchanged. commons-pull.mjs owns
# that sync (URL validation, pinned git transports, size cap, honest
# access-ended surfacing) and marks its conf shims COMMONS=1; the joined-rock
# loop below skips those so the two writers never fight over one directory.
# Runs before the anchor gate on purpose: a box with no anchor (a self-hosted
# mineral) still gets its communities. Fail-soft like every other leg.
if [ -f "${AIOS_DIR:-/app}/engine/community/commons-pull.mjs" ] && command -v node >/dev/null 2>&1; then
  node "${AIOS_DIR:-/app}/engine/community/commons-pull.mjs" "$BOX" || log "commons pull did not complete; other org-sync legs continue."
fi

for jconf in "$BOX"/org-inbox.d/*.conf; do
  [ -f "$jconf" ] || continue
  # a COMMONS=1 conf belongs to commons-pull.mjs above, not to this loop
  grep -qx 'COMMONS=1' "$jconf" 2>/dev/null && continue
  (
    set -euo pipefail
    JOWNER="$(basename "$jconf" .conf)"
    case "$JOWNER" in *[!A-Za-z0-9-]*|-*) log "ignoring org-inbox.d/$JOWNER.conf (bad owner name)."; exit 0;; esac
    JSLUG="$(grep -oP '^SLUG=\K[A-Za-z0-9._-]{1,80}$' "$jconf" | head -1 || true)"
    JORG="$(grep -oP '^ORG=\K[a-z0-9][a-z0-9-]{0,38}$' "$jconf" | head -1 || true)"
    [ -n "$JSLUG" ] || { log "org-inbox.d/$JOWNER.conf has no usable SLUG; skipping."; exit 0; }
    JKEY="$BOX/secrets/org_inbox_deploy_key.$JOWNER"
    [ -f "$JKEY" ] || { log "no read key for $JOWNER; cannot sync that inbox yet."; exit 0; }
    INBOX="$BOX/org-inbox.d/$JOWNER"
    URL="ssh://git@github.com/$JOWNER/inbox-$JSLUG.git"
    export GIT_SSH_COMMAND="ssh -i $JKEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
    if [ -d "$INBOX/.git" ]; then
      git -C "$INBOX" pull --ff-only origin main 2>/dev/null || { log "$JOWNER: pull denied (membership likely closed). keeping existing content."; exit 0; }
    else
      git clone --depth 1 "$URL" "$INBOX" 2>/dev/null || { log "$JOWNER: clone denied (no read access yet). skipping."; exit 0; }
    fi
    STATUS="active"
    [ -f "$INBOX/MEMBERSHIP.yaml" ] && STATUS="$(grep -oP 'status:\s*\K\S+' "$INBOX/MEMBERSHIP.yaml" | head -1 || echo active)"
    install_heartbeat_pipe "$INBOX" "$JOWNER" "$STATUS"
    if [ "$STATUS" != "active" ]; then
      log "$JOWNER: membership is '$STATUS'. no new content installed. existing content kept."
      exit 0
    fi
    seed_pages "$INBOX" "$JOWNER" "${JORG:-$JOWNER}"
    log "$JOWNER: synced. skills: $(ls -1d "$INBOX/skills"/*/ 2>/dev/null | wc -l), packs: $(ls -1 "$INBOX/packs" 2>/dev/null | wc -l), drops: $(ls -1 "$INBOX/drops" 2>/dev/null | wc -l)."
  ) || true
done

[ -f "$CONF" ] || { log "no org-inbox.conf; not an org-managed box. skipping."; exit 0; }
[ -f "$KEY" ]  || { log "no read key; cannot sync (membership may be closed)."; exit 0; }
. "$CONF"                        # sets ORG_GH_OWNER and SLUG

# Keep org content out of the member's own committed brain (the IP boundary).
touch "$BOX/.gitignore"
grep -qxF 'org-inbox/' "$BOX/.gitignore" || echo 'org-inbox/' >> "$BOX/.gitignore"
grep -qxF 'org-inbox.d/' "$BOX/.gitignore" || echo 'org-inbox.d/' >> "$BOX/.gitignore"   # joined rocks' inboxes, same boundary
grep -qxF 'ssh/' "$BOX/.gitignore" || echo 'ssh/' >> "$BOX/.gitignore"   # /state/ssh = derived key state, never committed

# ssh:// scheme dodges the image's global 'git@github.com:' -> https rewrite.
URL="ssh://git@github.com/$ORG_GH_OWNER/inbox-$SLUG.git"
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

if [ -d "$INBOX/.git" ]; then
  git -C "$INBOX" pull --ff-only origin main 2>/dev/null || { log "pull denied (membership likely closed). keeping existing content."; exit 0; }
else
  git clone --depth 1 "$URL" "$INBOX" 2>/dev/null || { log "clone denied (no read access). skipping."; exit 0; }
fi

# Membership gate: only install NEW content while active. Never delete on close.
STATUS="active"
[ -f "$INBOX/MEMBERSHIP.yaml" ] && STATUS="$(grep -oP 'status:\s*\K\S+' "$INBOX/MEMBERSHIP.yaml" | head -1 || echo active)"

# --- D51: member device-key install (the admin-first-invite handback lands here) -----
# The rock derives keys/member.authorized_keys in the inbox from the APPROVED public
# keys in its registry (registry/members/keys/<slug>.yaml), gated by a two-party
# fingerprint approval. This box installs them into the /state/ssh/member path the host
# sshd serves via AuthorizedKeysCommand (D46). DERIVE-NOT-COMMIT: recomputed every sync,
# never git-committed. This is ALSO the off-switch and so runs BEFORE the content gate: a
# non-active member — or an empty/absent key file — truncates to zero keys, and sshd then
# rejects the login (the key IS the door; ufw is host-level and not ours to touch here).
# Nothing in the member's own brain is ever deleted; only the derived door key drops.
MSSH="$BOX/ssh/member"; MAUTH="$MSSH/authorized_keys"; MSRC="$INBOX/keys/member.authorized_keys"
mkdir -p "$MSSH"
# TWO WRITERS, ONE FILE: this used to rebuild authorized_keys from the org's
# approved-key list every two minutes, while engine/devices/device-sync.mjs
# (which calls itself THE SINGLE WRITER) rebuilt the same file from the member's
# device roster. They clobbered each other on a fixed cadence. Proven live
# 2026-08-04: enrolling a device locked the member out at once, and sixty seconds
# later this script handed access back and dropped the new device. The dangerous
# direction is revoke, where a stolen laptop's key came back within two minutes,
# and it silently killed live support grants too.
#
# The authorities are now separated instead of racing: the MEMBER owns which
# devices are enrolled (the roster), the ORG owns whether the door opens at all
# (pause/leave/revoke push an EMPTY key file, which device-sync reads as a gate).
# So this script no longer writes the file; it asks the single writer to re-derive.
if [ -x /app/engine/devices/device-sync.mjs ] || [ -f /app/engine/devices/device-sync.mjs ]; then
  if node /app/engine/devices/device-sync.mjs "$BOX" >/dev/null 2>&1; then
    mkeys=$(grep -c '^ssh-ed25519 ' "$MAUTH" 2>/dev/null || echo 0)
    [ "$mkeys" -gt 0 ] && log "member door re-derived from the roster: $mkeys key(s)." \
      || log "member SSH door closed (status=$STATUS, roster gated shut)."
  else
    log "device-sync failed; leaving the existing door untouched rather than guessing."
  fi
else
  # Older image with no device-sync: keep the previous behaviour rather than
  # leaving a box with no door at all. Such a box has no roster to conflict with.
  : > "$MAUTH.tmp"; mkeys=0
  if [ "$STATUS" = "active" ] && [ -f "$MSRC" ]; then
    while IFS= read -r kline || [ -n "$kline" ]; do
      case "$kline" in ''|\#*) continue;; esac
      if printf '%s\n' "$kline" | grep -qE '^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9@._ -]{1,64})?$'; then
        printf '%s\n' "$kline" >> "$MAUTH.tmp"; mkeys=$((mkeys+1))
      else log "rejected a malformed member key line."; fi
    done < "$MSRC"
  fi
  mv "$MAUTH.tmp" "$MAUTH"; chmod 600 "$MAUTH" 2>/dev/null || true
  [ "$mkeys" -gt 0 ] && log "member device keys installed: $mkeys (pre-roster image)." || log "member SSH door closed (status=$STATUS, keys=0)."
fi

install_heartbeat_pipe "$INBOX" "$ORG_GH_OWNER" "$STATUS"

if [ "$STATUS" != "active" ]; then
  log "membership is '$STATUS'. no new content installed. existing content kept."
  exit 0
fi

SKILLS="$BOX/.claude/skills"; mkdir -p "$SKILLS"

# ALWAYS PICKUP, NEVER AUTO (one-inbox spec 2026-08-17 § 5; Sam's ruling 17 Aug).
#
# This block used to COPY every skills/<id>/ package out of the inbox and into
# .claude/skills, so anything the rock pushed was running on the member's box
# without the member doing anything. That is what the ruling removes: an offer
# now waits until they pick it up (member verb skill-install), and $INBOX is the
# staging area it waits in. There is nothing to copy here, because the git mirror
# this script already maintains IS the staging.
#
# Deliberately NOT a deletion of anything already installed. Packages copied out
# by older engines keep their .origin.json and keep working; what stops is new
# ones arriving pre-installed. The one client-visible consequence is that a rock
# can no longer put a skill on a member's box for them, which is the point.
#
# Pages, context and prompts below are untouched: they are inert content that
# nothing executes, and they only reach the inbox at all once a pack is picked
# up, so the pickup gate already covers them.

# Legacy pack format (pre-D49: pack.yaml + skills/*.md) auto-installed too, and
# goes the same way for the same reason. A legacy pack still in an inbox is
# staged like anything else; skill-install reads both layouts.
seed_pages "$INBOX" "${ORG_GH_OWNER:-}" ""

# The catalog-requests.json prune that lived here went with F3 of panel
# iteration 2 (2026-08-23): one-inbox made pickup local, so nothing writes the
# queue and there was nothing left to drop.

# Drops stay readable in-place under $INBOX/drops (the assistant reads them there).
log "synced. skills: $(ls -1d "$INBOX/skills"/*/ 2>/dev/null | wc -l), packs: $(ls -1 "$INBOX/packs" 2>/dev/null | wc -l), drops: $(ls -1 "$INBOX/drops" 2>/dev/null | wc -l)."
# Re-anchor (option c, 2026-07-28): a delivered notice means the anchor moved;
# the box re-mints its own credential and swaps channels. Mechanical (consent
# already happened in the requests engine), fail-soft, idempotent.
# The script itself arrives WITH the notice down the inbox (the transfer-invite
# pattern; the cloud-init seed has no room and old boxes need it delivered too).
# Evict (Mountain model, 2026-08-04): the anchor rock ended the tie. Nothing is
# destroyed — the apply flips this box's own anchor record to the Mountain and
# keeps the notice visible, so the person's screen says WHO ended it and why
# rather than looking like an outage.
# The apply script is always the IMAGE-TRUSTED copy, never the delivered one.
# inbox-<slug> is rock-writable, so running the script it ships would hand the
# rock arbitrary code execution as this box's user, reaching /state/secrets,
# /state/.claude-auth and the member's own brain. box-up.sh installs
# $BOX/evict-apply.sh from the image on every start, and it reads the notice
# copied just above. A delivered script is now only a trigger, never code.
if [ -f "$INBOX/evict/notice.json" ]; then
  mkdir -p "$BOX/org-inbox/evict"
  cp "$INBOX/evict/notice.json" "$BOX/org-inbox/evict/notice.json" 2>/dev/null || true
  if [ -f "$BOX/evict-apply.sh" ]; then
    bash "$BOX/evict-apply.sh" "$BOX" || true
  else
    log "evict notice delivered but this image has no evict-apply.sh; skipping (update the box image)."
  fi
fi

# Image-trusted apply, same reasoning as the evict leg above.
if [ -f "$INBOX/re-anchor/notice.json" ]; then
  mkdir -p "$BOX/org-inbox/re-anchor"
  cp "$INBOX/re-anchor/notice.json" "$BOX/org-inbox/re-anchor/notice.json" 2>/dev/null || true
  if [ -f "$BOX/re-anchor-apply.sh" ]; then
    bash "$BOX/re-anchor-apply.sh" "$BOX" || true
  else
    log "re-anchor notice delivered but this image has no re-anchor-apply.sh; skipping (update the box image)."
  fi
fi
