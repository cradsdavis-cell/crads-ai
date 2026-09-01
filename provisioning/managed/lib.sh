#!/usr/bin/env bash
# Shared helpers for managed provisioning (Hetzner + Cloudflare).
# Sourced by provision-pebble.sh + deprovision-pebble.sh.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Remembered BEFORE the source, because sourcing overwrites it.
_AIOS_STATE_DIR_ENV="${AIOS_STATE_DIR:-}"

# Auto-load tokens from a gitignored local file so day-to-day is one command (no exporting).
[ -f "$HERE/.env.local" ] && . "$HERE/.env.local"

# Precedence, and it is load-bearing in both directions:
#   exported AIOS_STATE_DIR  >  .env.local  >  $HERE/state
#
# .env.local must be able to set it, or a pinned production checkout
# (pin-prod-checkout.sh) keeps per-box state in its own dir instead of the one
# cockpit/jobs/crads-fleet.mjs reads, and new boxes vanish from the dashboard.
# Resolving this BEFORE the source ignored .env.local entirely.
#
# But an EXPORTED value must still win, and letting .env.local outrank it was
# briefly worse than the bug it fixed (2026-08-03): the rock IMAGE bakes these
# scripts read-only and boot exports AIOS_STATE_DIR=/state/.factory, which a
# staged .env.local would then silently override. It also broke the stop-block
# that keeps provisioning tests off the network — a "safe" run pointed at a temp
# state dir followed .env.local to the real one, found no stop file, and stamped
# a live VM + tunnel + DNS before it was caught. Env beats file, tested both ways.
STATE_DIR="${_AIOS_STATE_DIR_ENV:-${AIOS_STATE_DIR:-$HERE/state}}"
unset _AIOS_STATE_DIR_ENV

# --- tunables (env-overridable) ---
IMAGE="${AIOS_IMAGE:-ghcr.io/cradsdavis-cell/crads-pebble:v2}"   # pebbles default to the pebble image (canonical name 2026-08-09; ai-os-member stays published as an alias for live boxes); the rock stamp passes AIOS_IMAGE=crads-rock. v1 never shipped publicly (2026-07-20 spike: a v1 stamp crash-loops)
# pebble URL = <slug>.$ROOT_DOMAIN. MUST be first-level (one label under the zone apex): Cloudflare
# Universal SSL covers the apex + *.<zone> only, a 3rd-level name (<slug>.pebbles.<zone>) has no
# edge cert (TLS fails). For a namespaced scheme you'd need Cloudflare Advanced Cert Manager.
# No baked org default: the domain is deployment config (.env.local, or DEPLOYMENT_DOMAIN as
# exported by boot-rock.sh from /state/deployment.yaml). Fail loud rather than stamp onto the
# wrong org's zone.
ROOT_DOMAIN="${CF_TUNNEL_ROOT_DOMAIN:-${DEPLOYMENT_DOMAIN:-}}"
CF_ZONE_NAME="${CF_ZONE_NAME:-${DEPLOYMENT_DOMAIN:-}}"          # the Cloudflare zone that owns it
if [ -z "$ROOT_DOMAIN" ] || [ -z "$CF_ZONE_NAME" ]; then
  echo "lib.sh: no deployment domain. Set CF_TUNNEL_ROOT_DOMAIN + CF_ZONE_NAME in .env.local (or stage deployment.yaml so boot-rock exports DEPLOYMENT_DOMAIN)." >&2
  exit 1
fi
HCLOUD_LOCATION="${HCLOUD_LOCATION:-}"                          # pin a location (with HCLOUD_SERVER_TYPE) to skip the fallback list
SERVER_TYPE="${HCLOUD_SERVER_TYPE:-}"                           # pin a type (with HCLOUD_LOCATION) to skip the fallback list
# Capacity-fallback list (type:location), tried in order until one has capacity. Hetzner ARM (cax)
# is frequently "resource_unavailable", so we lead with cheap, reliably-available 8 GB x86 (cx33,
# €8.49) — the image is multi-arch so x86 is equivalent — then fall back through ARM. EU-only.
HCLOUD_CANDIDATES="${HCLOUD_CANDIDATES:-cx33:nbg1 cx33:hel1 cx33:fsn1 cpx32:nbg1 cpx32:hel1 cax21:nbg1 cax21:fsn1 cax21:hel1}"
# Cloudflare's OWN API base. The "client" here is Cloudflare's URL, not our
# box-sense "client", and 2a593f8 (vocab: box-sense client becomes pebble)
# rewrote it to /pebble/v4. Cloudflare then answered every call with
# {"code":10404,"message":"No route for that URI"}, so cf_resolve_ids() died
# first thing and NOTHING could be provisioned, pebble or rock, from 2026-08-10
# until this was found on 2026-08-11 by walking the door as a real user.
# Do not let a vocabulary pass touch third-party URLs.
CF_API="https://api.cloudflare.com/client/v4"
HC_API="https://api.hetzner.cloud/v1"

# --- output ---
c_blue=$'\033[36m'; c_bold=$'\033[1m'; c_dim=$'\033[2m'; c_red=$'\033[31m'; c_grn=$'\033[32m'; c_off=$'\033[0m'
say(){ printf '%s\n' "$*"; }
step(){ printf '%s▸%s %s\n' "$c_blue" "$c_off" "$*"; }
ok(){ printf '  %s✓%s %s\n' "$c_grn" "$c_off" "$*"; }
die(){ printf '%sERROR:%s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }

warn(){ printf '  %s⚠%s %s\n' "$c_red" "$c_off" "$*" >&2; }

need(){ command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1 (install it first)"; }

# --- which checkout is stamping? -------------------------------------------
# provision-pebble.sh renders the template sitting NEXT TO IT, so the identity
# of the checkout is the identity of the box. Two helpers make that visible:
# checkout_provenance records it against the box, preflight_checkout_current
# refuses to stamp from a tree that has fallen behind what shipped.
#
# Both take a directory (default $HERE) and both must survive having no git at
# all: on a rock IMAGE these scripts are baked in read-only with no .git.

sha256_of(){ # sha256_of <file> -> 64 hex, or "unknown"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" 2>/dev/null | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1
  else echo unknown; fi
}

# Sets CHECKOUT_SHA / CHECKOUT_REF / CHECKOUT_DIRTY / TEMPLATE_DIGEST.
# TEMPLATE_DIGEST is the load-bearing one: it pins the exact bytes that were
# rendered, and unlike the git fields it survives the baked-image case. The
# dirty flag ships beside the sha because an uncommitted edit makes the sha a
# claim about bytes that were never used.
checkout_provenance(){
  local dir="${1:-$HERE}"
  CHECKOUT_SHA="unknown"; CHECKOUT_REF="unknown"; CHECKOUT_DIRTY="unknown"
  if git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
    CHECKOUT_SHA="$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo unknown)"
    CHECKOUT_REF="$(git -C "$dir" describe --tags --exact-match HEAD 2>/dev/null \
      || git -C "$dir" symbolic-ref --quiet --short HEAD 2>/dev/null \
      || echo detached)"
    if [ -n "$(git -C "$dir" status --porcelain -- "$dir" 2>/dev/null)" ]; then
      CHECKOUT_DIRTY="yes"
    else
      CHECKOUT_DIRTY="no"
    fi
  fi
  TEMPLATE_DIGEST="$(sha256_of "$dir/cloud-init.template.yaml")"
}

# Refuse to stamp from a checkout that does not CONTAIN the shipping ref.
#
# The direction is the entire point. The intuitive rule — "HEAD must be an
# ancestor-or-equal of shipping" — passes the exact tree that broke brainiac:
# 34b3dfc was a perfectly good ancestor of hardening-loop, just 145 commits
# back. That rule forbids divergence and permits unlimited staleness, and
# staleness was the bug. So the test runs the other way: shipping must be an
# ancestor-or-equal of HEAD. Behind fails, diverged fails, level and ahead pass.
preflight_checkout_current(){
  local dir="${1:-$HERE}"
  local want="${AIOS_REQUIRED_REF:-origin/main}"   # the shipping branch of this repo

  if ! git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
    warn "unpinned stamp: $dir is not a git checkout, so the shipping-ref pin could not be checked (expected on a baked rock image; the template digest still lands in the box's state file)."
    return 0
  fi

  local want_sha head_sha
  want_sha="$(git -C "$dir" rev-parse --verify --quiet "${want}^{commit}" 2>/dev/null || true)"
  if [ -z "$want_sha" ]; then
    die "cannot resolve the shipping ref '$want' in $dir, so staleness cannot be checked, and an unchecked pin is no pin. Fetch it (git -C $dir fetch origin) or point AIOS_REQUIRED_REF at a ref that exists."
  fi
  head_sha="$(git -C "$dir" rev-parse HEAD)"

  local stale="" dirty=""
  git -C "$dir" merge-base --is-ancestor "$want_sha" "$head_sha" 2>/dev/null || stale=1
  if [ -n "$(git -C "$dir" status --porcelain -- "$dir" 2>/dev/null)" ]; then dirty=1; fi
  if [ -z "$stale" ] && [ -z "$dirty" ]; then return 0; fi

  local behind ahead msg=""
  behind="$(git -C "$dir" rev-list --count "$head_sha..$want_sha" 2>/dev/null || echo '?')"
  ahead="$(git -C "$dir" rev-list --count "$want_sha..$head_sha" 2>/dev/null || echo '?')"
  if [ -n "$stale" ]; then
    msg="this checkout is $behind commits behind the shipping ref '$want' ($ahead ahead of it)"
  fi
  if [ -n "$dirty" ]; then
    if [ -n "$msg" ]; then msg="$msg, and has uncommitted changes under $dir"
    else msg="this checkout has uncommitted changes under $dir, so the commit recorded against the box would not describe the bytes that were rendered"
    fi
  fi

  if [ -n "${AIOS_ALLOW_STALE_CHECKOUT:-}" ]; then
    warn "override in effect (AIOS_ALLOW_STALE_CHECKOUT=$AIOS_ALLOW_STALE_CHECKOUT): $msg. Stamping anyway — the box's state file will record what it really got."
    return 0
  fi
  die "$msg.
  Provisioning renders the template sitting next to this script, so a stale or edited tree stamps a box that silently differs from what shipped. That is how brainiac booted with an empty device roster on 2026-08-03: the tree was parked on a feature branch four days behind the fix.
  Update this checkout (production should be a dedicated checkout pinned to the shipping ref, not a dev worktree), or set AIOS_ALLOW_STALE_CHECKOUT=1 if stamping from here is deliberate."
}
reqenv(){ local v; for v in "$@"; do [ -n "${!v:-}" ] || die "missing env var: $v (see provisioning/managed/README.md)"; done; }

# slug must be DNS-safe (it becomes a hostname label)
valid_slug(){ printf '%s' "$1" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'; }

# --- Hetzner Cloud API ---
hc(){ curl -fsS -H "Authorization: Bearer $HCLOUD_TOKEN" -H "Content-Type: application/json" "$@"; }

# Poll a freshly created VM until Hetzner says it is running with an IPv4.
# Sets SERVER_IPV4. Dies (in the caller's shell, so the rollback trap fires) otherwise.
#
# WHY THIS IS NOT `hc` IN A LOOP (2026-08-10). It was, in both provisioners, and
# the loop could not survive a single non-2xx: `hc` is curl -f, so any error
# status exits 22, and under `set -e` that killed the run from inside the command
# substitution on the FIRST poll. The 60x3s retry was dead code for everything
# except "created but not running yet". On 2026-08-10 every server in the project
# was deleted while a rock was building; the VM was created, vanished seconds
# later, and the build died on `curl: (22) The requested URL returned error: 404`
# with no clue what had happened. A rate-limit blip reads exactly the same.
#
# Three behaviours the old loop did not have:
#   TRANSIENT  a network failure or a 5xx/429 is retried, not fatal.
#   GONE       a 404 that repeats is the server being deleted underneath us, and
#              it says so, because that is a different problem from a slow boot.
#   TIMEOUT    running out of attempts is a failure. The old loop fell through to
#              `ok "running at $IP"` with IP still "null" and wrote that to the
#              state file, so an exhausted wait looked like a successful build.
#
# WHY "GONE" NOW NEEDS A PRIOR 200 (2026-08-12). The rule above was written from
# the 2026-08-10 mass-wipe, where the server really had been destroyed, and it
# generalised into "three 404s in six seconds means someone deleted it". That
# killed a healthy build today: `aios-pebble-local-test-1` was created, answered
# 404 on its first three polls, and was declared GONE ~6s after creation. The
# verdict is self-confirming, because the caller's rollback trap then DELETES the
# server, so the evidence that would have settled it is destroyed by the check.
# Two ordinary causes read exactly like a teardown at that timescale: a
# just-created server reading back 404 (this repo already knows the shape, see
# traps.md 9, "never read your own write"), and a create whose async action fails,
# which Hetzner reaps itself. Neither is "the project is being emptied".
#
# So the 404 verdict now splits on whether we ever saw the server at all:
#   SEEN then 404x3  it existed and stopped existing. Decisive, and still the
#                    2026-08-10 message, because that is genuinely what happened.
#   NEVER seen       not proof of anything. 404 is tolerated for the whole wait
#                    (tries*gap, 180s by default, not 6s), and the failure says
#                    the server never became visible and lists the real causes.
#                    HC_WAIT_KEEP_SERVER=1 tells the caller's rollback to LEAVE
#                    the VM alone: never delete on a verdict you could not prove.
hc_wait_running(){
  local id="$1" tries="${2:-60}" gap="${3:-3}"
  local n resp code status ip soft=0 gone=0 seen=0 notfound=0
  SERVER_IPV4=""
  HC_WAIT_KEEP_SERVER=""
  for ((n = 1; n <= tries; n++)); do
    resp="$(curl -sS -m 20 -w '\n%{http_code}' -H "Authorization: Bearer $HCLOUD_TOKEN" \
      -H "Content-Type: application/json" "$HC_API/servers/$id" 2>/dev/null)" || resp=$'\n000'
    code="${resp##*$'\n'}"; resp="${resp%$'\n'*}"
    case "$code" in
      200)
        soft=0; gone=0; seen=1
        status="$(printf '%s' "$resp" | jq -r '.server.status // empty' 2>/dev/null)"
        ip="$(printf '%s' "$resp" | jq -r '.server.public_net.ipv4.ip // empty' 2>/dev/null)"
        if [ "$status" = "running" ] && [ -n "$ip" ] && [ "$ip" != "null" ]; then
          SERVER_IPV4="$ip"; return 0
        fi
        ;;
      404)
        notfound=$((notfound + 1))
        # Only decisive once the server has answered at least once. Before that a
        # 404 is "not visible yet", and it rides the normal wait like a slow boot.
        if [ "$seen" = 1 ]; then
          gone=$((gone + 1))
          [ "$gone" -ge 3 ] && die "server $id is GONE: Hetzner returned it and then answered 404 for it $gone polls running.
  It existed, so this is not a slow boot. Something deleted it underneath this build:
  a concurrent teardown, a console delete, or the whole project being emptied. Check the project before re-running."
        fi
        ;;
      401 | 403)
        die "Hetzner refused the token while waiting on server $id (HTTP $code). Check HCLOUD_TOKEN."
        ;;
      *)
        soft=$((soft + 1))
        [ "$soft" -ge 10 ] && die "Hetzner unreachable while waiting on server $id: $soft consecutive failures, last HTTP $code."
        ;;
    esac
    sleep "$gap"
  done
  if [ "$seen" = 0 ] && [ "$notfound" -gt 0 ]; then
    # Never once returned. Do NOT call this a teardown, and do NOT let the caller
    # roll it back: deleting an unproven server is what destroyed the evidence on
    # 2026-08-12 and made the wrong diagnosis look right.
    HC_WAIT_KEEP_SERVER=1
    die "server $id never became visible: Hetzner answered 404 on $notfound of $tries polls across $((tries * gap))s and never once returned it.
  This is NOT proof that anything deleted it. Both of these read the same way:
    - a just-created server that reads back 404 for longer than the wait allowed;
    - a create whose asynchronous action failed, which Hetzner reaps by itself.
  The VM has been LEFT IN PLACE rather than rolled back, so it can still be looked at:
    curl -s -H \"Authorization: Bearer \$HCLOUD_TOKEN\" $HC_API/servers/$id
  Delete it by hand if it is real and unwanted."
  fi
  die "server $id never reached 'running' with an IPv4 in $((tries * gap))s (last status: ${status:-unknown})."
}

# --- Cloudflare API (every call checks success:true) ---
cf(){ curl -sS -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" "$@"; }
cf_call(){ # cf_call <context> <curl-args...> -> echoes .result, dies on success:false
  local ctx="$1"; shift
  local resp; resp="$(cf "$@")" || die "Cloudflare $ctx: request failed (network)"
  echo "$resp" | jq -e '.success==true' >/dev/null 2>&1 \
    || die "Cloudflare $ctx failed: $(echo "$resp" | jq -c '.errors // .' 2>/dev/null || echo "$resp")"
  echo "$resp" | jq -c '.result'
}

# resolve the zone id + account id from the zone object (one call; needs no account-read scope —
# a DNS/Tunnel-Edit token can't list /accounts, but the zone object carries .account.id).
cf_resolve_ids(){
  local zone; zone="$(cf_call "find zone $CF_ZONE_NAME" "$CF_API/zones?name=$CF_ZONE_NAME")"
  CF_ZONE_ID="${CF_ZONE_ID:-$(echo "$zone" | jq -r '.[0].id')}"
  CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-$(echo "$zone" | jq -r '.[0].account.id')}"
  [ -n "$CF_ZONE_ID" ] && [ "$CF_ZONE_ID" != "null" ] || die "could not resolve zone id for $CF_ZONE_NAME (is it on this Cloudflare account?)"
  [ -n "$CF_ACCOUNT_ID" ] && [ "$CF_ACCOUNT_ID" != "null" ] || die "could not resolve account id from zone $CF_ZONE_NAME"
}

# HTTP status of an https URL, robust to hosts that can't reach Cloudflare's edge directly
# (e.g. IPv6-only egress / resolver quirks): try normally, else resolve an edge IPv4 via DoH.
# Wait for a freshly stamped box to be REACHABLE, and say honestly what that proves.
#
# Until 2026-08-09 both provisioners polled https://<slug>.<domain>/ for 200/302
# — code-server answering. The 2026-08-05 browser-door-shut ruling routes that
# hostname at NOTHING, so it now answers 404 forever: the probe could never
# succeed, burned its full 12 minutes, and exited 9. A HEALTHY rock
# (test-org-2: sshd answering, container up, org brain born on disk) was
# reported to its owner as a failed build. Third consumer of that ruling to be
# found stale, after the rock welcome email and the door copy.
#
# Two layers, because they prove different things and only one needs a key:
#   TUNNEL  any HTTP answer that is not 000/52x/530 means cloudflared is
#           connected and Cloudflare is routing — the VM booted and the tunnel
#           came up. 404 is the CORRECT healthy answer post-door-shut.
#   BOX     with AIOS_READY_SSH_KEY + AIOS_READY_USER, one `true` over ssh. The
#           box's ForceCommand runs it INSIDE the container, so a success is
#           real container liveness, which is what the old probe was really for.
# Without a key the tunnel layer is all we can honestly claim, and the caller is
# told exactly that rather than "live".
#
# 2026-08-12, found on a freshly born rock. The key layer did not ADD a check,
# it REPLACED the working one: the tunnel arm was gated on `[ -z "$key" ]`, so a
# ready-key switched off the only probe that could still answer. It then failed
# for twelve minutes and exited 9 on a box that was healthy the whole time,
# which is the exact failure the comment above says this rewrite fixed.
#
# Why it failed is worth keeping, because it recurs by design: Hetzner REUSES
# IPs. The new box came up on the address a box destroyed an hour earlier had
# held, whose host key was still pinned in the operator's known_hosts, and
# `accept-new` auto-accepts an UNKNOWN host while REFUSING a changed one. So
# every probe returned "Host key verification failed", silently.
#
# Two changes:
#   - the tunnel arm now runs whether or not a key is set. A key upgrades the
#     answer from "reachable" to "live"; it can no longer take the answer away.
#   - the probe stops consulting known_hosts. This is a liveness check that runs
#     `true` and carries no payload, and the thing being proven is that OUR key
#     opens the door, which a host-key pin does not strengthen. Trusting an
#     operator's known_hosts hygiene on a fleet that recycles addresses is what
#     made a healthy box unreachable.
# Echoes: live | reachable | timeout
wait_for_box(){
  local host="$1" ip="${2:-}" tries="${3:-90}" i code seen_tunnel=""
  local key="${AIOS_READY_SSH_KEY:-}" user="${AIOS_READY_USER:-member}"
  for i in $(seq 1 "$tries"); do
    if [ -n "$key" ] && [ -f "$key" ] && [ -n "$ip" ]; then
      if ssh -o BatchMode=yes -o ConnectTimeout=10 \
           -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
           -i "$key" "$user@$ip" true >/dev/null 2>&1; then echo "live"; return 0; fi
    fi
    code="$(url_status "https://$host/")"
    case "$code" in
      000|52[0-9]|530) : ;;                     # tunnel not up yet
      *) seen_tunnel=1
         # No key configured: the tunnel is all we can claim, so claim it now.
         [ -z "$key" ] && { echo "reachable"; return 0; } ;;
    esac
    [ $((i % 5)) -eq 0 ] && printf '  %s…still booting (%s) — %dm elapsed%s\n' "$c_dim" "$code" $((i*8/60)) "$c_off" >&2
    sleep 8
  done
  # A key was configured and ssh never answered, but the tunnel did. That is a
  # weaker proof than "live" and a far better answer than "timeout": the VM
  # booted, cloudflared connected and Cloudflare routed. Report the weaker truth
  # rather than telling an owner their build failed.
  if [ -n "$seen_tunnel" ]; then
    printf '  %s⚠ ssh never answered, but the tunnel did — reporting reachable, not live.%s\n' "$c_dim" "$c_off" >&2
    echo "reachable"; return 0
  fi
  echo "timeout"; return 1
}

url_status(){
  local url="$1" host code ip
  host="$(printf '%s' "$url" | sed -E 's#https?://([^/]+).*#\1#')"
  code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$url" 2>/dev/null || echo 000)"
  if [ "$code" = "000" ]; then
    ip="$(curl -s -m 8 "https://1.1.1.1/dns-query?name=$host&type=A" -H 'accept: application/dns-json' 2>/dev/null | jq -r '.Answer[]?|select(.type==1)|.data' 2>/dev/null | head -1)"
    [ -n "$ip" ] && code="$(curl -s -o /dev/null -m 10 --resolve "$host:443:$ip" -w '%{http_code}' "$url" 2>/dev/null || echo 000)"
  fi
  echo "$code"
}

# ---- operator_emails_from <deployment.yaml> --------------------------------
# Prints one VALIDATED operator email per line; complains to stderr about
# anything it had to drop. Returns 0 even when it finds nothing, because an
# Access hiccup must warn and never abort a stamp (provision-rock.sh § Access).
#
# This replaces a single awk line that had been on the production rock path
# since D51 and that docs/operator-live-test-checklist.md flagged as "the single
# most fragile untested-live piece in the current branch". The 2026-08-25 probe
# found four ways it silently produced a WRONG answer, and the caller only ever
# warned when the list came back EMPTY, so a malformed address sailed through
# into a Cloudflare Access policy, gated the rock to nobody, and still printed
# `ok ... gated to:`. The operator would discover it by being locked out of
# their own box.
#
#   - 'sam@x.com'  single quotes survived, the old gsub only stripped doubles
#   - sam@x.com # primary  the trailing comment rode into the address
#   - CRLF files left a trailing \r glued to the address
#   - operator_emails: [a@x.com, b@y.com]  the inline flow list read as EMPTY,
#     which fell to the warn path and silently downgraded the rock to
#     password-only browser access
#
# PARITY IS THE POINT. deployment.yaml already has a SECOND reader,
# boot-rock.sh's `list()`, and the two disagreed about the same file: `list()`
# strips both quote styles and understands the inline form, the awk did neither.
# So a deployment could boot with AIOS_OPERATOR_EMAIL correct while the Access
# policy built from the same line gated the rock to a garbage address. This
# function is deliberately kept to `list()`'s behaviour rather than made
# cleverer than it: both anchor `operator_emails:` at column zero, matching
# deployment.example.yaml's documented "keep it flat" contract. A nested key
# therefore reads as empty in BOTH readers, which is a loud, consistent warn
# rather than a quiet disagreement. If one reader ever changes, change both.
#
# Validation is the load-bearing half: an address that does not look like one is
# DROPPED and named on stderr, so the failure is loud and the policy is never
# built from a value that matches no human.
operator_emails_from() {
  local src="$1" line
  [ -f "$src" ] || return 0
  # tr first: one place handles CRLF, so no downstream rule has to think about it.
  tr -d '\r' < "$src" | awk '
    # inline flow list: operator_emails: [a@x, b@y]
    /^operator_emails:[[:space:]]*\[/ {
      line = $0
      sub(/^[^[]*\[/, "", line); sub(/\].*$/, "", line)
      n = split(line, parts, ",")
      for (i = 1; i <= n; i++) print parts[i]
      next
    }
    # block list
    /^operator_emails:/ { f = 1; next }
    f && /^[[:space:]]*-[[:space:]]*/ { line = $0; sub(/^[[:space:]]*-[[:space:]]*/, "", line); print line; next }
    f && /^[[:space:]]*$/ { next }
    f { f = 0 }
  ' | while IFS= read -r line; do
    line="${line%%#*}"                                             # trailing comment
    line="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    line="$(printf '%s' "$line" | sed -e "s/^[\"']//" -e "s/[\"']\$//")"   # either quote style
    [ -n "$line" ] || continue
    case "$line" in
      *@*.*) printf '%s\n' "$line" ;;
      *) printf 'WARN: dropping operator_emails entry that is not an address: %s\n' "$line" >&2 ;;
    esac
  done
  return 0
}
