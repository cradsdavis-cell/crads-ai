#!/usr/bin/env bash
# embed-enter-aios.sh: write provisioning/host/enter-aios into the rock cloud-init
# template as a gz+b64 write_files entry (R18, 2026-08-23).
#
# WHY A BLOB, NOT A SPLICE. The pebble template carries a #__HOST_SCRIPTS__ marker
# that provision-pebble.sh fills at render time from provisioning/host/. The rock
# template is rendered in TWO places, provision-rock.sh and the desktop app
# (wizard/engine.mjs renderCloudInit, with the template shipped as an app asset
# and no provisioning/host/ beside it), so a render-time splice would need the
# app bundle to change too. Committing the compressed text keeps both renderers
# untouched, keeps the rock inside Hetzner's 32 KiB user-data cap (the plain
# text no longer fits: the rendered template sits near 30 KB), and
# enter-aios-parity.test.mjs decodes the blob and fails the suite if it ever
# differs from provisioning/host/enter-aios.
#
#   bash provisioning/rock/embed-enter-aios.sh      # after editing provisioning/host/enter-aios
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/../host/enter-aios"
TPL="$HERE/cloud-init.rock.template.yaml"
[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }
BLOB="$(gzip -9nc "$SRC" | base64 -w 0)"
BLOB="$BLOB" python3 - "$TPL" <<'PY'
import os, re, sys
p = sys.argv[1]
t = open(p).read()
entry = (
    "  - path: /usr/local/bin/enter-aios\n"
    "    permissions: '0755'\n"
    "    encoding: gz+b64\n"
    "    content: " + os.environ['BLOB'] + "\n"
)
pat = re.compile(r"  - path: /usr/local/bin/enter-aios\n    permissions: '0755'\n    encoding: gz\+b64\n    content: \S+\n")
if not pat.search(t):
    sys.exit("template has no gz+b64 enter-aios entry to replace; add the entry shape first")
t = pat.sub(lambda _m: entry, t, count=1)
open(p, 'w').write(t)
print(f"embedded {len(os.environ['BLOB'])} B of gz+b64 enter-aios into {p}")
PY
