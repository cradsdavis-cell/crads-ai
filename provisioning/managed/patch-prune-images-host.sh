#!/usr/bin/env bash
# patch-prune-images-host.sh: bring an EXISTING member server in line with trap 83
# (run as ROOT on the host). Every pull of a new version leaves the previous one on
# disk, untagged, and nothing ever removed it: about 3 GB per update, so a 75 GB
# server filled up in two months. New servers prune on every start (cloud-init);
# a server born before 2026-11-06 needs this once.
#
# What it does:
#   1. one systemd drop-in that adds `docker image prune -f` to the start steps, so
#      every future start clears the versions the last pull left behind;
#   2. with --apply, one prune right now (before anything is written), with the
#      disk use before and after.
# Dangling images only: anything tagged (the version about to run) or used by a
# container is never touched. Nothing restarts; the box keeps running.
#
#   sudo bash patch-prune-images-host.sh            # dry run: what it would write and free
#   sudo bash patch-prune-images-host.sh --apply    # writes it, daemon-reload, prunes now
#
# Reversible: rm /etc/systemd/system/ai-os.service.d/zzz-prune-images.conf, then
# systemctl daemon-reload. (The images it removed are re-downloadable from GHCR.)
#
# Dedicated servers only. An adopted box (/state is a folder on the owner's own
# server) is refused: a prune there would also clear the owner's own images.
#
# A FULL DISK (2026-11-11, a member's server at 100%): the apply prunes FIRST and
# only then writes the drop-in, and nothing goes through a temp file, because on a
# full disk any write before the prune fails and the cleanup never runs.
#
# DOCKER 29 HIDES THEM: on the containerd image store (the default for a fresh
# Docker 29 install, which is what cloud-init installs) a plain `docker images`
# does NOT list the old versions. They show only with `docker images -a` or
# `--filter dangling=true`, named <untagged>, not <none>. A member who checked
# `docker images` saw one image and (rightly, per the instructions) stopped.
# Judge by `docker system df` (RECLAIMABLE), never by the plain list.
set -euo pipefail
# AIOS_PATCH_TEST points the script at a fixture directory and skips docker (tests only).
T=${AIOS_PATCH_TEST:-}
[ -n "$T" ] || [ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
UNIT=$T/etc/systemd/system/ai-os.service
DROPIN_DIR=$T/etc/systemd/system/ai-os.service.d
# zzz- sorts after zz-update-gate.conf, which resets ExecStartPre= and would
# otherwise wipe a line added before it.
DROPIN="$DROPIN_DIR/zzz-prune-images.conf"
[ -f "$UNIT" ] || { echo "no $UNIT here: not a Crads-AI member server"; exit 1; }
grep -qE -- '-v /state:/state( |$)' "$UNIT" || { echo "this is an adopted box (/state is not /state on the host): not pruning the owner's server"; exit 1; }

if grep -qE '^ExecStartPre=-?/usr/bin/docker image prune' "$UNIT" "$DROPIN_DIR"/*.conf 2>/dev/null; then
  ALREADY=1
else
  ALREADY=
fi

# Written straight to stdout or the drop-in, never via a temp file (see A FULL DISK).
dropin_body(){
  echo '# trap 83 (2026-11-06): clear the untagged versions each pull leaves behind.'
  echo '# Written by patch-prune-images-host.sh; remove this file to undo.'
  echo '[Service]'
  echo 'ExecStartPre=-/usr/bin/docker image prune -f'
}

if [ "${1:-}" != "--apply" ]; then
  echo "DRY RUN."
  if [ -n "$ALREADY" ]; then echo "The start steps already prune: nothing to write."; else echo "Would write $DROPIN:"; echo; dropin_body; fi
  if [ -z "$T" ]; then
    echo; echo "Old versions a prune would remove now (Docker 29 calls them <untagged>):"; docker images --filter dangling=true
    echo; docker system df
  fi
  echo; echo "Re-run with --apply to prune now and write it."
  exit 0
fi

# Prune FIRST: on a full disk nothing below can be written until this frees space.
if [ -z "$T" ]; then
  echo "Before:"; df -h /
  docker image prune -f
  echo; echo "After:"; df -h /; echo
fi
if [ -z "$ALREADY" ]; then
  mkdir -p "$DROPIN_DIR"
  dropin_body > "$DROPIN"
  chmod 0644 "$DROPIN"
  [ -n "$T" ] || systemctl daemon-reload
  echo "OK: $DROPIN written. Every start from now on clears old versions."
else
  echo "The start steps already prune: nothing written."
fi
