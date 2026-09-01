#!/bin/bash
# make-bundle.sh <payload-dir> <ed25519-private-key> [outdir]  (D55)
# Builds + signs a host-update bundle. The payload dir must contain:
#   VERSION   a bare positive integer, strictly greater than the last shipped one
#   apply.sh  what root runs on the host, cwd = the unpacked bundle
# Output: <outdir>/current.tar.gz + current.tar.gz.sig (default outdir: ./dist,
# which Dockerfile.rock/.member COPY into the images at /app/host-updates/).
# Signing key: the private half of the signer committed to the cloud-init
# templates' /etc/ai-os/host-update-signers. NEVER commit the private key.
set -euo pipefail
PAYLOAD="${1:?usage: make-bundle.sh <payload-dir> <signing-key> [outdir]}"
KEY="${2:?usage: make-bundle.sh <payload-dir> <signing-key> [outdir]}"
OUT="${3:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dist}"
[ -f "$PAYLOAD/VERSION" ] || { echo "ERROR: $PAYLOAD/VERSION missing"; exit 1; }
[ -f "$PAYLOAD/apply.sh" ] || { echo "ERROR: $PAYLOAD/apply.sh missing"; exit 1; }
VER="$(cat "$PAYLOAD/VERSION")"
case "$VER" in ''|*[!0-9]*) echo "ERROR: VERSION must be a bare positive integer, got '$VER'"; exit 1 ;; esac
mkdir -p "$OUT"
tar -czf "$OUT/current.tar.gz" -C "$PAYLOAD" .
ssh-keygen -Y sign -f "$KEY" -n aios-host-update "$OUT/current.tar.gz"
echo "OK: bundle v$VER -> $OUT/current.tar.gz (+ .sig). Commit both; the next image build ships them."
