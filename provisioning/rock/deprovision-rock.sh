#!/usr/bin/env bash
# deprovision-rock.sh <slug> — guarded teardown of a rock box, from its state file.
# Deletes: the Hetzner VM, the Cloudflare tunnel (+connections) and DNS record, and the
# brain repo's read-only deploy key. Archives the state file (never deletes it).
#
# GUARDED (a rock is a fleet's control plane): requires typing the slug back, or, for
# the test harness only, AIOS_CONFIRM_DESTROY=<slug> in the environment.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../managed/lib.sh"

SLUG="${1:-}"; [ -n "$SLUG" ] || die "usage: deprovision-rock.sh <slug>"
STATE="$STATE_DIR/rock-$SLUG.env"
[ -f "$STATE" ] || die "no state at $STATE (nothing to tear down, or already archived)"
. "$STATE"
need curl; need jq
reqenv HCLOUD_TOKEN CF_API_TOKEN GITHUB_TOKEN

say "${c_bold}Tearing down ROCK '$SLUG' (deployment: ${DEPLOYMENT:-?})${c_off}"
say "${c_dim}  VM $SERVER_ID · tunnel $TUNNEL_ID · DNS $RECORD_ID · deploy key ${DEPLOY_KEY_ID:-none} · $HOSTNAME${c_off}"
if [ "${AIOS_CONFIRM_DESTROY:-}" != "$SLUG" ]; then
  [ -t 0 ] || die "non-interactive and AIOS_CONFIRM_DESTROY does not match the slug — refusing"
  read -r -p "  Type the slug to confirm destruction: " ANSWER
  [ "$ANSWER" = "$SLUG" ] || die "confirmation mismatch — nothing touched"
fi

step "Deleting Hetzner server $SERVER_ID"
# A failure here is AMBIGUOUS: the server may be genuinely gone, or HCLOUD_TOKEN
# may point at a different Hetzner project (tokens are per-project), or the call
# may simply have failed. `hc` is curl -fsS, so 401, 403, 404 and a network error
# all exit non-zero and looked identical. Calling that "already gone" and
# carrying on deleted a live pebble's DNS and tunnel on 2026-08-04; the guard
# below was written for the pebble path that day and never ported here, so a
# rock (a whole org's control plane) still had the original behaviour on
# 2026-08-20. Look the server up first and refuse when the answer is unclear.
if hc "$HC_API/servers/$SERVER_ID" >/dev/null 2>&1; then
  hc -X DELETE "$HC_API/servers/$SERVER_ID" >/dev/null && ok "server deleted"
elif [ "${FORCE_MISSING:-}" = "1" ]; then
  say "  ${c_dim}server not visible in this project, continuing (FORCE_MISSING=1)${c_off}"
else
  die "server $SERVER_ID is NOT visible to the current HCLOUD_TOKEN.
  Either it is genuinely deleted, or this token points at a different Hetzner project.
  This script cannot tell those apart, and the DNS + tunnel teardown below is destructive:
  on a rock that takes out a whole org's control plane while the VM keeps running and billing.
  Check:  curl -s -H \"Authorization: Bearer \$HCLOUD_TOKEN\" $HC_API/servers | jq '.servers[].name'
  Old-era boxes live in the legacy project: HCLOUD_TOKEN=\"\$HCLOUD_TOKEN_LEGACY\" $0 $SLUG
  Then re-run with FORCE_MISSING=1 if the server really is gone."
fi

step "Deleting Cloudflare DNS + tunnel"
cf -X DELETE "$CF_API/zones/$CF_ZONE_ID/dns_records/$RECORD_ID" >/dev/null 2>&1 && ok "DNS record deleted" || say "  ${c_dim}record already gone${c_off}"
cf -X DELETE "$CF_API/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/connections" >/dev/null 2>&1 || true
cf -X DELETE "$CF_API/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID" >/dev/null 2>&1 && ok "tunnel deleted" || say "  ${c_dim}tunnel already gone${c_off}"

if [ -n "${DEPLOY_KEY_ID:-}" ] && [ -n "${BRAIN_REPO:-}" ]; then
  step "Revoking deploy key $DEPLOY_KEY_ID on $BRAIN_REPO"
  curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" -X DELETE "https://api.github.com/repos/$BRAIN_REPO/keys/$DEPLOY_KEY_ID" >/dev/null 2>&1 && ok "deploy key revoked" || say "  ${c_dim}key already gone${c_off}"
fi

mv "$STATE" "$STATE.destroyed.$(date +%Y%m%d-%H%M%S)"
ok "state archived (never deleted)"
say "${c_bold}Torn down.${c_off} ${c_dim}The brain repo and all git history are untouched: only infrastructure died.${c_off}"
