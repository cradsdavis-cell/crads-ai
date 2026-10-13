#!/usr/bin/env bash
# image-smoke.sh: prove one platform of a member (pebble) image is really that
# platform, and that its tools start. Run against each arch a release publishes.
#
#   bash scripts/image-smoke.sh ghcr.io/cradsdavis-cell/crads-pebble:sha-<commit> linux/arm64
#
# WHY AN ELF CHECK AND NOT JUST "IT RUNS" (2026-10-13, Arm default): CI builds
# arm64 under QEMU on an amd64 runner, where an amd64 binary that slipped into
# the arm64 image would ALSO run (natively), so "claude --version works" proves
# nothing about the architecture there. Each native binary a mineral depends on
# is therefore read for its ELF machine field, which cannot lie. On a native
# host (the Hetzner Arm drill) the version calls are the second, independent
# proof.
# Structural only: no copied output strings are matched (trap 6).
set -euo pipefail
IMAGE="${1:?usage: image-smoke.sh <image> [linux/amd64|linux/arm64]}"
PLATFORM="${2:-linux/amd64}"
case "$PLATFORM" in
  linux/arm64) WANT=aarch64 ;;
  linux/amd64) WANT=x86_64 ;;
  *) echo "image-smoke: unsupported platform $PLATFORM" >&2; exit 2 ;;
esac

docker run --rm --platform "$PLATFORM" --entrypoint sh -e WANT="$WANT" "$IMAGE" -c '
set -e
[ "$(uname -m)" = "$WANT" ] || { echo "uname says $(uname -m), wanted $WANT"; exit 1; }
echo "uname $WANT: OK"
# The native binaries a mineral cannot work without. Globs resolve the
# versioned and per-platform directory names without pinning them here.
set -- \
  "$(readlink -f "$(command -v node)")" \
  "$(readlink -f "$(command -v claude)")" \
  "$(readlink -f "$(command -v gh)")" \
  "$(readlink -f "$(command -v python3)")" \
  "$(readlink -f /opt/gws/bin/python3)" \
  /usr/lib/openssh/sftp-server \
  $(ls -d /opt/code-server-*/lib/node 2>/dev/null) \
  $(ls -d /usr/local/lib/node_modules/opencode-ai/node_modules/opencode-linux-*/bin/opencode 2>/dev/null)
# node -e puts the first extra argument at argv[1], not argv[2]; Set drops
# the python3 that two paths resolve to.
node -e "
const fs = require(\"fs\");
const M = { 62: \"x86_64\", 183: \"aarch64\" };
let bad = 0, n = 0;
for (const f of [...new Set(process.argv.slice(1))]) {
  if (!f) continue;
  const h = Buffer.alloc(20);
  const fd = fs.openSync(f, \"r\"); fs.readSync(fd, h, 0, 20, 0); fs.closeSync(fd);
  if (h.readUInt32BE(0) !== 0x7f454c46) { console.log(\"not ELF (skipped): \" + f); continue; }
  const m = M[h.readUInt16LE(18)] || (\"machine \" + h.readUInt16LE(18));
  n++;
  if (m !== process.env.WANT) { bad++; console.log(\"WRONG ARCH \" + m + \": \" + f); }
  else console.log(\"elf \" + m + \": \" + f);
}
if (n < 7) { console.log(\"only \" + n + \" native binaries found; the image layout moved, update this list\"); process.exit(1); }
process.exit(bad ? 1 : 0);
" "$@"
claude --version >/dev/null && echo "claude starts: OK"
opencode --version >/dev/null && echo "opencode starts: OK"
code-server --version >/dev/null && echo "code-server starts: OK"
gh --version >/dev/null && echo "gh starts: OK"
/opt/gws/bin/workspace-mcp --help >/dev/null && echo "workspace-mcp starts: OK"
[ -f /opt/opencode-template/config/opencode/opencode.json ] && echo "opencode template baked: OK"
[ -d /opt/claude-plugins-template ] && echo "claude plugin template baked: OK"
test ! -e /app/provisioning && echo "no factory: OK"
'
echo "image-smoke: $IMAGE ($PLATFORM) passed"
