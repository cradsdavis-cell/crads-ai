#!/usr/bin/env bash
# deprovision-pebble.sh <slug> [--yes] — tear down ONE managed pebble box.
# Deletes the Hetzner VM (and its /state volume — PERMANENT), the Cloudflare
# tunnel + its DNS record, then archives the local state file.
#
#   ./deprovision-pebble.sh acme          # interactive confirm
#   ./deprovision-pebble.sh acme --yes    # no prompt
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SLUG="${1:-}"; YES="${2:-}"
[ -n "$SLUG" ] || die "usage: deprovision-pebble.sh <slug> [--yes]"
need curl; need jq
reqenv HCLOUD_TOKEN CF_API_TOKEN
STATE="$STATE_DIR/$SLUG.env"
[ -f "$STATE" ] || die "no state for '$SLUG' ($STATE). Nothing to tear down (or already archived)."
# shellcheck disable=SC1090
. "$STATE"

# EVERY field this teardown will need, checked BEFORE the first destructive call.
# Step 1 deletes the VM and steps 2-3 then need Cloudflare ids; under `set -u` a
# state file missing one of them died AFTER the VM was gone, orphaning the DNS
# record, the tunnel and the state file itself. A destructive script has to know
# it can finish before it starts. CF_ZONE_ID/CF_ACCOUNT_ID are recoverable from
# the zone object, so resolve those rather than refusing.
for _f in SERVER_ID RECORD_ID TUNNEL_ID; do
  [ -n "${!_f:-}" ] || die "state file $STATE has no $_f, so this teardown could not finish what it started. Fill it in (or delete the box by hand) rather than running a half teardown."
done
if [ -z "${CF_ZONE_ID:-}" ] || [ -z "${CF_ACCOUNT_ID:-}" ]; then
  cf_resolve_ids
fi

say "${c_bold}Tearing down '$SLUG'${c_off}  ${c_dim}($HOSTNAME · server $SERVER_ID)${c_off}"
if [ "$YES" != "--yes" ]; then
  printf "This PERMANENTLY deletes the VM, DNS and tunnel (the on-box copy of the brain goes with it). A member-owned brain repo on their own GitHub is NOT touched; a rock-owned brain repo stays with the rock. Type the slug to confirm: "
  read -r CONFIRM
  [ "$CONFIRM" = "$SLUG" ] || die "confirmation mismatch — aborted"
fi

# 1. delete the VM first (kills the cloudflared connector so the tunnel can be deleted)
step "Deleting Hetzner server $SERVER_ID"
# A 404 here is AMBIGUOUS: the server may be genuinely gone, or HCLOUD_TOKEN may point at a
# different Hetzner project (tokens are per-project). Reporting "already gone" for the second
# case deleted a live pebble's DNS + tunnel on 2026-08-04. Fail loudly instead.
if hc "$HC_API/servers/$SERVER_ID" >/dev/null 2>&1; then
  hc -X DELETE "$HC_API/servers/$SERVER_ID" >/dev/null && ok "server deleted"
elif [ "${FORCE_MISSING:-}" = "1" ]; then
  say "  ${c_dim}server not visible in this project — continuing (FORCE_MISSING=1)${c_off}"
else
  die "server $SERVER_ID is NOT visible to the current HCLOUD_TOKEN.
  Either it is genuinely deleted, or this token points at a different Hetzner project.
  This script cannot tell those apart, and the DNS + tunnel teardown below is destructive.
  Check:  curl -s -H \"Authorization: Bearer \$HCLOUD_TOKEN\" $HC_API/servers | jq '.servers[].name'
  Old-era pebble boxes live in the legacy project: HCLOUD_TOKEN=\"\$HCLOUD_TOKEN_LEGACY\" $0 $SLUG
  Then re-run with FORCE_MISSING=1 if the server really is gone."
fi

# 2. delete the DNS record (independent; 404 is fine)
step "Deleting DNS record"
cf -X DELETE "$CF_API/zones/$CF_ZONE_ID/dns_records/$RECORD_ID" >/dev/null 2>&1 || true
ok "DNS removed"

# 3. clear tunnel connections, then delete the tunnel (retry once if connections still draining)
step "Deleting Cloudflare tunnel"
sleep 4
cf -X DELETE "$CF_API/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/connections" >/dev/null 2>&1 || true
if ! cf -X DELETE "$CF_API/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID" 2>/dev/null | jq -e '.success==true' >/dev/null 2>&1; then
  sleep 6
  cf -X DELETE "$CF_API/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/connections" >/dev/null 2>&1 || true
  cf -X DELETE "$CF_API/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID" >/dev/null 2>&1 || true
fi
ok "tunnel deleted"

# 4. (The retire-the-public-handle step went with the self-host strip,
# 2026-09-01: the central directory that held route:<org> and the public
# communities board is deleted, so there is no handle record to strand and
# nothing to retire.)

# 5. archive state
mkdir -p "$STATE_DIR/archive"
mv "$STATE" "$STATE_DIR/archive/$SLUG.env"
say ""
ok "torn down. State archived to state/archive/$SLUG.env"
