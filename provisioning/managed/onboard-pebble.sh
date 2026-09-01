#!/usr/bin/env bash
# onboard-pebble.sh — the one command to set up a new pebble.
#
# Run it, answer two questions. It provisions the pebble's own private AI OS box
# (Hetzner VM + a Cloudflare HTTPS link) and prints a ready-to-send welcome message.
# You send that to the pebble — they just open the URL in a browser. They install
# nothing.
#
#   ./onboard-pebble.sh            # fully interactive
#   ./onboard-pebble.sh acme       # slug given; still asks for the display name
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need curl; need jq
{ [ -n "${HCLOUD_TOKEN:-}" ] && [ -n "${CF_API_TOKEN:-}" ]; } \
  || die "tokens not set — put HCLOUD_TOKEN + CF_API_TOKEN in $HERE/.env.local (see README)."

b(){ printf '\033[1m%s\033[0m\n' "$*"; }; mut(){ printf '\033[2m%s\033[0m\n' "$*"; }

b "AI OS — new pebble setup"
mut "Stands up a private box for one pebble (Hetzner VM + a Cloudflare HTTPS link)."
echo

# 1. short-name / slug (becomes the URL)
SLUG="${1:-}"
while ! valid_slug "${SLUG:-}"; do
  printf 'Pebble short-name (lowercase letters/digits/hyphens — becomes their URL, e.g. "acme"): '
  read -r SLUG || exit 1
done
[ -f "$STATE_DIR/$SLUG.env" ] && die "'$SLUG' already has a box. Pick another name, or ./deprovision-pebble.sh $SLUG first."

# 2. display name for the welcome note
printf "Pebble's first name for the welcome note [%s]: " "$SLUG"; read -r NAME || true
NAME="${NAME:-$SLUG}"

# confirm (it costs money + takes ~10 min)
echo
b "About to provision:"
echo "  pebble:  $NAME"
echo "  url:     https://$SLUG.$ROOT_DOMAIN"
echo "  cost:    ~€8–10/mo (a small VM under your Hetzner account)"
echo "  time:    ~10 min (first boot pulls the ~2 GB workspace image)"
echo
printf 'Go? [y/N]: '; read -r GO || true
case "${GO:-}" in y|Y|yes|YES) ;; *) echo "aborted — nothing created."; exit 0 ;; esac
echo

# provision (PEBBLE_NAME flows into the rendered welcome message)
PEBBLE_NAME="$NAME" "$HERE/provision-pebble.sh" "$SLUG"

# show the welcome so it's ready to copy/send
WELCOME="$STATE_DIR/$SLUG.welcome.txt"
if [ -f "$WELCOME" ]; then
  echo; b "──── copy everything below and send it to $NAME ────"; echo
  cat "$WELCOME"
  echo; b "─────────────────────────────────────────────────────"
  mut "(also saved at state/$SLUG.welcome.txt — delete it once you've sent it)"
fi
