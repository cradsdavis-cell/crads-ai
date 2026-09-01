#!/bin/bash
# aios-host-update: root-side applier for SIGNED host-script bundles (D55).
#
# The problem it solves: cloud-init runs ONCE, so host-side files (enter-aios,
# sshd config, the systemd unit) are frozen at provision time — the in-band SSH
# channel force-lands inside the container and can never touch them. This agent
# is the one sanctioned path from "fix authored in the repo" to "fix applied on
# an already-provisioned host", without ever handing the container root.
#
# Trust chain (every link matters):
#   * Bundles ride the CONTAINER IMAGE at /app/host-updates/current.tar.gz(.sig)
#     — they arrive only when the box restarts onto a new image, which is the
#     org's own consented action (panel box-refresh, or a reboot).
#   * This script (root, via a systemd timer) copies the pair OUT of the
#     container with `docker cp`, then verifies the signature with
#     `ssh-keygen -Y verify` against /etc/ai-os/host-update-signers — a
#     ROOT-OWNED file baked by cloud-init. The container can stage bytes, but it
#     can never make root run anything unsigned: /state and the image are both
#     untrusted input here.
#   * The channel ships DISARMED: the signers file is comment-only until a real
#     signer line is committed to the cloud-init templates. No signer, no-op.
#   * Versions are monotonic integers (bundle file VERSION); an applied or older
#     version never re-applies, so a stale image can't roll a host back.
#
# The AIOS_HU_* env overrides exist for tests only (no docker, no real /etc).
# This file is the CANONICAL copy; both cloud-init templates embed it verbatim
# at /usr/local/bin/aios-host-update (host-update.test.mjs enforces the match).
set -euo pipefail
SIGNERS="${AIOS_HU_SIGNERS:-/etc/ai-os/host-update-signers}"
SRC="${AIOS_HU_SRC:-}"
VERSION_FILE="${AIOS_HU_VERSION_FILE:-/var/lib/ai-os/host-update.version}"
LOG="${AIOS_HU_LOG:-/var/log/ai-os-host-update.log}"
CONTAINER="${AIOS_HU_CONTAINER:-ai-os}"

log(){ printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }

# Disarmed until a real (non-comment) signer line exists.
grep -qE '^[^#[:space:]]' "$SIGNERS" 2>/dev/null || exit 0

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
if [ -n "$SRC" ]; then
  cp "$SRC/current.tar.gz" "$WORK/" 2>/dev/null || exit 0
  cp "$SRC/current.tar.gz.sig" "$WORK/" 2>/dev/null || { log "bundle present but no signature; refusing"; exit 1; }
else
  # box down or image ships no bundle: quiet no-op, the next tick retries
  docker cp "$CONTAINER:/app/host-updates/current.tar.gz" "$WORK/" 2>/dev/null || exit 0
  docker cp "$CONTAINER:/app/host-updates/current.tar.gz.sig" "$WORK/" 2>/dev/null || { log "bundle present but no signature; refusing"; exit 1; }
fi

# Signature FIRST: nothing from the bundle is parsed, unpacked or run before this.
if ! ssh-keygen -Y verify -f "$SIGNERS" -I updates@ai-os -n aios-host-update \
     -s "$WORK/current.tar.gz.sig" < "$WORK/current.tar.gz" >/dev/null 2>&1; then
  log "SIGNATURE REFUSED for current.tar.gz; not applying"
  exit 1
fi

mkdir -p "$WORK/unpack"
tar -xzf "$WORK/current.tar.gz" -C "$WORK/unpack" --no-same-owner
VER="$(cat "$WORK/unpack/VERSION" 2>/dev/null || true)"
case "$VER" in ''|*[!0-9]*) log "bundle has no numeric VERSION; refusing"; exit 1 ;; esac
CUR="$(cat "$VERSION_FILE" 2>/dev/null || echo 0)"
case "$CUR" in ''|*[!0-9]*) CUR=0 ;; esac
[ "$VER" -gt "$CUR" ] || exit 0
[ -f "$WORK/unpack/apply.sh" ] || { log "bundle v$VER has no apply.sh; refusing"; exit 1; }

log "applying host-update v$VER (was v$CUR)"
if (cd "$WORK/unpack" && bash ./apply.sh >> "$LOG" 2>&1); then
  mkdir -p "$(dirname "$VERSION_FILE")"
  printf '%s\n' "$VER" > "$VERSION_FILE"
  log "host-update v$VER applied"
else
  log "host-update v$VER FAILED (apply.sh non-zero); will retry next run"
  exit 1
fi
