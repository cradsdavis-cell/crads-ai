#!/usr/bin/env bash
# patch-update-gate-host.sh: bring an EXISTING member server in line with trap 82
# (run as ROOT on the host). New servers get this from cloud-init; a server born
# before 2026-11-03 still pulls new software on every start, so a crash or a
# reboot is a silent update.
#
# What it changes: one systemd drop-in that replaces the unconditional
# `docker pull` with a pull gated on the member's update-requested flag
# (/state/.kernel/update-requested, left by the app's Update button). Every other
# ExecStartPre line is kept as it was. Nothing restarts: the drop-in takes effect
# at the next start, and the box keeps running meanwhile.
#
#   sudo bash patch-update-gate-host.sh            # dry run: prints the drop-in
#   sudo bash patch-update-gate-host.sh --apply    # writes it + daemon-reload
#
# Reversible: rm /etc/systemd/system/ai-os.service.d/zz-update-gate.conf, then
# systemctl daemon-reload.
set -euo pipefail
# AIOS_PATCH_TEST points the script at a fixture directory (tests only).
T=${AIOS_PATCH_TEST:-}
[ -n "$T" ] || [ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
UNIT=$T/etc/systemd/system/ai-os.service
DROPIN_DIR=$T/etc/systemd/system/ai-os.service.d
DROPIN="$DROPIN_DIR/zz-update-gate.conf"
[ -f "$UNIT" ] || { echo "no $UNIT here: not a Crads-AI member server"; exit 1; }

PULL=$(grep -E '^ExecStartPre=-?/usr/bin/docker pull ' "$UNIT" | head -1 || true)
[ -n "$PULL" ] || { echo "no unconditional docker pull in $UNIT: nothing to patch (already gated, or a different unit)"; exit 0; }
IMAGE=${PULL##* }
# Where the box's /state lives on this host: /state on a dedicated server, the
# brain folder on an adopted one. Read off the unit's own -v mount.
STATE_HOST=$(grep -oE -- '-v [^ :]+:/state( |$)' "$UNIT" | head -1 | sed -E 's/^-v ([^:]+):\/state.*/\1/')
[ -n "$STATE_HOST" ] || { echo "cannot find the /state mount in $UNIT"; exit 1; }

{
  echo '# trap 82 (2026-11-03): pull new software only when the member pressed Update.'
  echo '# Written by patch-update-gate-host.sh; remove this file to undo.'
  echo '[Service]'
  echo 'ExecStartPre='
  grep -E '^ExecStartPre=' "$UNIT" | while IFS= read -r line; do
    if [ "$line" = "$PULL" ]; then
      echo "ExecStartPre=-/bin/sh -c 'F=$STATE_HOST/.kernel/update-requested;[ -e \$\$F ]&&/usr/bin/docker pull $IMAGE&&rm \$\$F'"
    else
      echo "$line"
    fi
  done
} > "${TMPDIR:-/tmp}/zz-update-gate.conf.$$"

if [ "${1:-}" != "--apply" ]; then
  echo "DRY RUN. Would write $DROPIN:"; echo; cat "${TMPDIR:-/tmp}/zz-update-gate.conf.$$"; rm -f "${TMPDIR:-/tmp}/zz-update-gate.conf.$$"
  echo; echo "Re-run with --apply to write it."
  exit 0
fi
mkdir -p "$DROPIN_DIR"
install -m 0644 "${TMPDIR:-/tmp}/zz-update-gate.conf.$$" "$DROPIN"; rm -f "${TMPDIR:-/tmp}/zz-update-gate.conf.$$"
[ -n "$T" ] || systemctl daemon-reload
echo "OK: $DROPIN written. Takes effect at the next start; nothing was restarted."
