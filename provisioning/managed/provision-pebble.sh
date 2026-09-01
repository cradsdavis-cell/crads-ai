#!/usr/bin/env bash
# provision-pebble.sh <slug> — stand up ONE managed AI OS box for a pebble.
#
# Creates: a Cloudflare named tunnel + DNS route (<slug>.$ROOT_DOMAIN), then a
# Hetzner ARM VM whose cloud-init installs Docker, runs the AI OS image, and
# connects the tunnel. Waits until the HTTPS URL serves, then prints the handoff
# (URL + a one-time password). The pebble opens the URL in any browser — no SSH,
# no install, no IP.
#
#   export HCLOUD_TOKEN=...  CF_API_TOKEN=...
#   ./provision-pebble.sh acme
#
# See README.md for the full env-var list + how to get each token.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SLUG="${1:-}"
[ -n "$SLUG" ] || die "usage: provision-pebble.sh <slug>   (e.g. provision-pebble.sh acme)"
valid_slug "$SLUG" || die "slug must be DNS-safe: lowercase letters/digits/hyphens, 2-32 chars"

# ---- preflight: a member key is only useful if the roster can hold it -------
# (2026-08-03) sshd on a member box reads two key sources: the host's
# /home/member/.ssh/authorized_keys, where the key below lands, and the roster-
# derived /state/ssh/member/authorized_keys, which is the ONLY one the app can
# see. Without the cloud-init seed that copies one into the other at first boot,
# the member's own laptop connects fine and appears nowhere: Devices lists
# nothing, Revoke cannot revoke the one key that works, and the cold tier is
# unreachable. It cannot be repaired from inside the box, because the container
# cannot read /home/member.
#
# This shipped live (brainiac) and the cause was not the pebble path: it was
# WHICH CHECKOUT ran. This script renders the template sitting next to it, so a
# working tree parked on a stale branch quietly stamps pre-fix boxes. Checked
# before anything is created, so a stale tree costs a message, not a VM.
if [ -n "${MEMBER_PUBKEY:-}" ] && ! grep -q '/state/devices' "$HERE/cloud-init.template.yaml"; then
  die "this checkout's cloud-init.template.yaml has no device-roster seed, so a box stamped from it would carry a member key the app can never list or revoke. Provisioning ran from $HERE, which is behind the shipping branch: update that checkout and re-run."
fi

# ---- preflight: is this checkout what shipped? ------------------------------
# The check above names ONE symptom of a stale tree. This one names the disease:
# refuse outright when $HERE does not contain the shipping ref, or has been
# edited in place. It runs before anything is created, so a stale tree costs a
# message rather than a pebble's box. See preflight_checkout_current in lib.sh
# for why the ancestry test runs the direction it does.
preflight_checkout_current "$HERE"

need curl; need jq
reqenv HCLOUD_TOKEN CF_API_TOKEN
mkdir -p "$STATE_DIR"
STATE="$STATE_DIR/$SLUG.env"
[ -f "$STATE" ] && die "pebble '$SLUG' already provisioned ($STATE). Deprovision first to rebuild."

HOSTNAME="$SLUG.$ROOT_DOMAIN"
SRVNAME="aios-$SLUG"
say "${c_bold}Provisioning AI OS box for '$SLUG'${c_off}"
say "${c_dim}  url → https://$HOSTNAME   ·   image $IMAGE${c_off}"
say ""

# ---- default seed: a pebble is born with its brain (one build path; trap 53) ----
# Only the retired rock-side factory ever set SEED_DIR, so every Mountain-built
# pebble (door or rock New Pebble via the cockpit's buildOne) booted with an
# empty scaffold: no CLAUDE.md contract, no membership page, no starter skills,
# no lineage. When the caller brings no seed, assemble the standard one from
# the pebble template. PEBBLE_SEED=none is the explicit opt-out for a
# deliberately bare box; a missing template is a refusal, because a silently
# empty brain is the exact bug this block exists to end. Runs BEFORE anything
# is created, so a refusal costs a message, not a tunnel rollback; the payload
# itself is spliced into cloud-init further down.
SEED_TMP=""
if [ -z "${SEED_DIR:-}" ] && [ "${PEBBLE_SEED:-}" != "none" ]; then
  step "Assembling the default brain seed"
  SEED_TMP="$(mktemp -d)"
  "$HERE/pebble-seed.sh" "$SEED_TMP" || die "pebble-seed.sh refused; nothing was created. Fix the template (or set PEBBLE_SEED=none only if you truly want a box born with an empty brain)."
  SEED_DIR="$SEED_TMP"
  ok "default seed ready ($(du -sh "$SEED_TMP" 2>/dev/null | cut -f1 || echo '?'))"
fi

# ---- resolve Cloudflare ids ----
step "Resolving Cloudflare account + zone"
cf_resolve_ids
ok "account $CF_ACCOUNT_ID · zone $CF_ZONE_NAME ($CF_ZONE_ID)"

# ---- generate the pebble's code-server password (printed once, never stored) ----
PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"

# ---- Cloudflare: create tunnel ----
step "Creating Cloudflare tunnel"
TUNNEL_ID="$(cf_call "create tunnel" -X POST "$CF_API/accounts/$CF_ACCOUNT_ID/cfd_tunnel" \
  --data "$(jq -n --arg n "aios-$SLUG" '{name:$n, config_src:"cloudflare"}')" | jq -r '.id')"
[ -n "$TUNNEL_ID" ] && [ "$TUNNEL_ID" != "null" ] || die "tunnel id missing from create response"
ok "tunnel $TUNNEL_ID"

# best-effort cleanup of partial state if anything below fails before we write $STATE
cleanup_partial(){
  [ -f "$STATE" ] && return 0   # fully provisioned; keep it
  printf '%srolling back partial provision…%s\n' "$c_dim" "$c_off" >&2
  # HC_WAIT_KEEP_SERVER means the boot-wait could not PROVE what happened to the
  # VM (see hc_wait_running). Deleting it here is what destroyed the evidence on
  # 2026-08-12 and turned an unproven "GONE" into a self-confirming one.
  if [ -n "${SERVER_ID:-}" ] && [ "${HC_WAIT_KEEP_SERVER:-}" = "1" ]; then
    printf '%skeeping server %s: the wait could not prove it was gone%s\n' "$c_dim" "$SERVER_ID" "$c_off" >&2
  else
    [ -n "${SERVER_ID:-}" ] && hc -X DELETE "$HC_API/servers/$SERVER_ID" >/dev/null 2>&1 || true
  fi
  [ -n "${RECORD_ID:-}" ] && cf -X DELETE "$CF_API/zones/$CF_ZONE_ID/dns_records/$RECORD_ID" >/dev/null 2>&1 || true
  cf -X DELETE "$CF_API/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/connections" >/dev/null 2>&1 || true
  cf -X DELETE "$CF_API/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID" >/dev/null 2>&1 || true
}
trap cleanup_partial EXIT

# ---- Cloudflare: connector token ----
TUNNEL_TOKEN="$(cf_call "get tunnel token" "$CF_API/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token" | jq -r '.')"
[ -n "$TUNNEL_TOKEN" ] && [ "$TUNNEL_TOKEN" != "null" ] || die "tunnel token missing"

# ---- Cloudflare: ingress (app-first — the hostname routes NOTHING) ----
# Sam, 2026-08-05: the browser door is off. This used to route the public hostname at
# code-server on 7781, whose only gate was one shared 24-char password with no MFA, no
# rotation and no lockout, on a surface that hands out a container terminal.
# The tunnel and the DNS record stay (teardown, the fleet snapshot and any future
# surface all key off them); they simply carry nothing, so the hostname answers 404.
step "Routing $HOSTNAME → nothing (app-first: no browser door)"
cf_call "set ingress" -X PUT "$CF_API/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
  --data "$(jq -n '{config:{ingress:[{service:"http_status:404"}]}}')" >/dev/null
ok "ingress set (no public surface)"

# ---- Cloudflare: DNS CNAME → <tunnel>.cfargotunnel.com (proxied) ----
RECORD_ID="$(cf_call "create DNS record" -X POST "$CF_API/zones/$CF_ZONE_ID/dns_records" \
  --data "$(jq -n --arg h "$HOSTNAME" --arg c "$TUNNEL_ID.cfargotunnel.com" \
    '{type:"CNAME", name:$h, content:$c, proxied:true, ttl:1}')" | jq -r '.id')"
ok "DNS CNAME $HOSTNAME"

# ---- render cloud-init (temp file; deleted on exit) ----
CI_FILE="$(mktemp)"; chmod 600 "$CI_FILE"

# ---- host scripts: readable files in the repo, gz+b64 into user-data ----------
# Live-cert 2026-08-03: aios-host-update (4.2 KiB) and enter-aios (3.2 KiB) were
# inlined verbatim in the template, 7.4 KiB of a 32 KiB budget that a real member
# stamp had already blown. They now live as REVIEWABLE files under
# provisioning/host/ and ride compressed: cloud-init decodes `encoding: gz+b64`
# natively at write_files time, so nothing about boot ORDER changes (no runcmd,
# no image dependency, no fetch) and the scripts stay diffable in git.
host_script_block() {   # <abs-target> <source-file>
  printf '  - path: %s\n    permissions: %s\n    encoding: gz+b64\n    content: %s\n' \
    "$1" "'0755'" "$(gzip -9nc "$2" | base64 -w 0)"
}
HOSTWF="$(mktemp)"
: > "$HOSTWF"
for pair in "/usr/local/bin/aios-host-update:aios-host-update" "/usr/local/bin/enter-aios:enter-aios"; do
  tgt="${pair%%:*}"; src="$HERE/../host/${pair##*:}"
  [ -f "$src" ] || die "missing host script $src (provisioning/host/ must ship with this checkout)"
  host_script_block "$tgt" "$src" >> "$HOSTWF"
done

trap 'rm -f "$CI_FILE"; cleanup_partial' EXIT
# Port 22 opens for the operator break-glass key (Hetzner-registered), a member
# SSH key (D32/D44), OR an invite-pending stamp (D51): the invite box ships with NO
# key, but its door must be reachable for the key that installs after the two-party
# approval — auth still gates on the approved-keys file (empty until approval), so an
# open 22 with no keys authenticates nobody. With none of the three, the box stays
# fully locked (web-console break-glass).
SSH_RULE="/bin/true"
if [ -n "${OPERATOR_SSH_KEY_NAME:-}" ] || [ -n "${MEMBER_PUBKEY:-}" ] || [ -n "${INVITE_PENDING:-}" ]; then SSH_RULE="ufw allow 22/tcp"; fi
# D32/D44: the member's own public key (from their app's Connect step). The sentinel
# default can never authenticate, so boxes stamped without a key have inert SSH stanzas.
MEMBER_KEY_SUB="ssh-ed25519 AAAA-no-member-key-staged disabled"
if [ -n "${MEMBER_PUBKEY:-}" ]; then
  echo "$MEMBER_PUBKEY" | grep -Eq '^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9@._-]{1,64})?$' \
    || die "MEMBER_PUBKEY must be a single ssh-ed25519 public-key line"
  MEMBER_KEY_SUB="$MEMBER_PUBKEY"
fi
# The holder's address, sanitised before it goes anywhere near sed. An email is
# caller-supplied and this substitution uses | as the delimiter, so a value
# containing | or & would rewrite the cloud-init rather than land in it. Emails
# cannot legally contain either, so anything that does is refused outright rather
# than escaped: a rejected build beats a corrupted one. Empty stays empty, which
# seed-pages.mjs treats as honestly holderless.
OWNER_EMAIL_SUB="${AIOS_OWNER_EMAIL:-}"
if [ -n "$OWNER_EMAIL_SUB" ]; then
  printf '%s' "$OWNER_EMAIL_SUB" | grep -Eq '^[^[:space:]|&@]+@[^[:space:]|&@]+\.[^[:space:]|&@]+$' \
    || die "AIOS_OWNER_EMAIL ($OWNER_EMAIL_SUB) is not a plain email address"
fi
# The box's own dialable name, staged because the container cannot derive it:
# os.hostname() in there is the docker id, and registering that would give every
# new device a Host block it cannot connect to (and a fresh directory row on
# every container recreate). engine/box/mineral-arm.mjs writes it to
# secrets/box_reg_host at first boot; without it a pebble registers nothing at
# all, which is how three rocks and no pebbles reached the operator's minerals
# table on 2026-08-12. Shape-checked for the same reason the address above is.
# The rock this pebble is being built for, staged so the box can wire itself to
# it at first boot. Same sed-delimiter reasoning as the address above: a handle
# containing | or & would rewrite the cloud-init, and a rock handle legally
# cannot, so anything that does is refused rather than escaped. Empty is the
# normal case (a self-serve pebble is anchored to the Mountain).
ANCHOR_ORG_SUB="${AIOS_ANCHOR_ORG:-}"
if [ -n "$ANCHOR_ORG_SUB" ]; then
  printf '%s' "$ANCHOR_ORG_SUB" | grep -Eq '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$' \
    || die "AIOS_ANCHOR_ORG ($ANCHOR_ORG_SUB) is not a valid rock handle"
fi
# WHO OWNS THE BOX (2026-08-20 audit, QA finding 188). Two literal words, so
# unlike the address and the handle above there is no sed-delimiter escaping to
# do: anything that is not exactly "org" is refused rather than sanitised.
# Empty is the normal case and means theirs.
#
# org WITHOUT an anchor is refused here, before any metal exists, because it is
# an absentee owner: seed-pages derives owner_slug from AIOS_ANCHOR_ORG, so the
# pair would produce a box owned by nobody in particular. Cheaper to refuse now
# than to discover it on a running machine.
OWNER_SUB="${AIOS_OWNER:-}"
if [ -n "$OWNER_SUB" ]; then
  case "$OWNER_SUB" in
    member|org) : ;;
    *) die "AIOS_OWNER ($OWNER_SUB) must be member or org" ;;
  esac
  if [ "$OWNER_SUB" = org ] && [ -z "$ANCHOR_ORG_SUB" ]; then
    die "AIOS_OWNER=org needs AIOS_ANCHOR_ORG: a rock-owned box with no rock has no owner"
  fi
fi

BOX_HOST_SUB="$HOSTNAME"
printf '%s' "$BOX_HOST_SUB" | grep -Eq '^[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+$' \
  || die "the box hostname ($BOX_HOST_SUB) is not a dotted DNS name; check ROOT_DOMAIN"

# The one name (docs/naming.md), staged the same way and for the same reason as
# the address above: it is caller-supplied and this sed uses | as the delimiter.
# Strip anything that could rewrite the cloud-init rather than land in it, plus
# the quotes and newlines that would break the env file it is written into.
# Empty stays empty, which box-up.sh treats as "not named yet".
BOX_NAME_SUB="$(printf '%s' "${AIOS_BOX_NAME:-}" | tr -d '|&"'"'"'\n\r' | cut -c1-60)"

# ---- the documentation stays in git, not on the wire -------------------------
# Roughly 5 KiB of the template is `#` prose explaining why each stanza is shaped
# the way it is. In the repo that is free; on the wire it is 5 KiB of Hetzner's
# 32 KiB user-data cap that the member's seeded brain needs. 2026-08-14: two
# sessions each added ONE line to /etc/ai-os/env, each passed the size guard
# alone (19 B and 2 B spare), and the merge came out 35 B over, bought back by
# deleting a stale comment, which is not a move that works twice. So the prose
# gets stripped at render time instead. The stripper runs BEFORE substitution, so
# it only ever reads committed bytes, never the password or the tunnel token, and
# it keeps `#cloud-config`, the splice markers, and every comment inside a block
# scalar (those are file content on the box). See strip-cloud-init-comments.awk;
# cloud-init-size.test.mjs measures through the same file.
STRIPPER="$HERE/strip-cloud-init-comments.awk"
[ -f "$STRIPPER" ] || die "missing $STRIPPER (it ships beside the template in provisioning/managed/). Without it the rendered cloud-init carries ~5 KiB of comments and a seeded brain can blow Hetzner's 32 KiB cap on a live stamp."

awk -f "$STRIPPER" "$HERE/cloud-init.template.yaml" \
  | sed -e "s|__PEBBLE_PASSWORD__|$PASSWORD|g" \
    -e "s|__OWNER_EMAIL__|$OWNER_EMAIL_SUB|g" \
    -e "s|__BOX_HOST__|$BOX_HOST_SUB|g" \
    -e "s|__ANCHOR_ORG__|$ANCHOR_ORG_SUB|g" \
    -e "s|__OWNER__|$OWNER_SUB|g" \
    -e "s|__BOX_NAME__|$BOX_NAME_SUB|g" \
    -e "s|__TUNNEL_TOKEN__|$TUNNEL_TOKEN|g" \
    -e "s|__IMAGE__|$IMAGE|g" \
    -e "s|__SSH_FIREWALL_RULE__|$SSH_RULE|g" \
    -e "s|__OWNER_EMAIL__|$OWNER_EMAIL_SUB|g" \
    -e "s|__MEMBER_PUBKEY__|$MEMBER_KEY_SUB|g" \
  | awk -v hw="$HOSTWF" '/#__HOST_SCRIPTS__/ { while((getline l < hw) > 0) print l; next } { print }' > "$CI_FILE"
if [ -n "${MEMBER_PUBKEY:-}" ]; then
  say "${c_dim}  member SSH: enabled (user 'member', key-only, force-lands inside the container at /state)${c_off}"
fi

# ---- optional pre-seeded brain: SEED_DIR (profile.yaml + wiki/) → base64 tarball into /state ----
# Unpacked on first boot BEFORE the service starts, so box-up.sh sees a populated brain instead of
# an empty box. box-up's scaffold is idempotent ([ -f ] guards), so it preserves what we seed.
if [ -n "${SEED_DIR:-}" ]; then
  [ -d "$SEED_DIR" ]              || die "SEED_DIR is not a directory: $SEED_DIR"
  [ -f "$SEED_DIR/profile.yaml" ] || die "SEED_DIR has no profile.yaml (need at least profile.yaml + wiki/): $SEED_DIR"
  step "Seeding brain from $SEED_DIR"
  SEED_WF="$(mktemp)"; SEED_RC="$(mktemp)"
  {
    echo "  - path: /etc/ai-os/seed.tgz.b64"
    echo "    permissions: '0600'"
    echo "    content: |"
    tar cf - -C "$SEED_DIR" . | gzip -9n | base64 -w 512 | sed 's/^/      /'
  } > "$SEED_WF"
  {
    echo "  - base64 -d /etc/ai-os/seed.tgz.b64 | tar xzf - -C /state"
    echo "  - chown -R aios:aios /state"
    echo "  - rm -f /etc/ai-os/seed.tgz.b64"
  } > "$SEED_RC"
  awk -v wf="$SEED_WF" -v rc="$SEED_RC" '
    /#__SEED_WRITE_FILES__/ { while((getline l < wf) > 0) print l; next }
    /#__SEED_RUNCMD__/      { while((getline l < rc) > 0) print l; next }
    { print }
  ' "$CI_FILE" > "$CI_FILE.new" && mv "$CI_FILE.new" "$CI_FILE"
  rm -f "$SEED_WF" "$SEED_RC"
  # Hetzner caps cloud-init user_data at 32 KiB. Fail loud (before creating anything) if we blow it.
  CI_BYTES="$(wc -c < "$CI_FILE")"
  # Live-cert 2026-08-03: this printed a GREEN TICK carrying an over-cap number
  # and then died on the next line, so the operator's log read "✓ seeded
  # (37923 B of 32768)" immediately before a failure. Tick only when it fits,
  # and when it does not, say what actually blew the budget and what to do.
  if [ "$CI_BYTES" -le 31000 ]; then
    ok "brain seeded into cloud-init (${CI_BYTES} B of 32768)"
  else
    SEED_B="$(tar cf - -C "$SEED_DIR" . | gzip -9n | base64 -w 512 | wc -c)"
    warn "cloud-init is ${CI_BYTES} B: the seeded brain is ${SEED_B} B of that, and Hetzner caps user-data at 32768 B."
    die "member cloud-init is ${CI_BYTES} B (cap 32768, budget 31000). The brain seed does not fit. Shrink what the member starts with (pebble-template/wiki + pebble-template/skills are the two big movers; note skills currently ship twice, once under skills/ and again under .claude/skills/), or deliver the wiki after first boot through the member's inbox instead of baking it into cloud-init."
  fi
fi
# the default seed is in the cloud-init payload now; the staging dir is done
[ -n "${SEED_TMP:-}" ] && rm -rf "$SEED_TMP"

# ---- Hetzner: create the VM (walk the capacity-fallback list until one places) ----
if [ -n "$SERVER_TYPE" ] && [ -n "$HCLOUD_LOCATION" ]; then CANDS="$SERVER_TYPE:$HCLOUD_LOCATION"; else CANDS="$HCLOUD_CANDIDATES"; fi
SERVER_ID=""; CHOSEN=""
for cand in $CANDS; do
  ST="${cand%%:*}"; LOC="${cand##*:}"
  step "Creating Hetzner $ST in $LOC"
  BODY="$(jq -n --arg name "$SRVNAME" --arg st "$ST" --arg loc "$LOC" \
    --arg slug "$SLUG" --rawfile ud "$CI_FILE" '{
      name:$name, server_type:$st, image:"ubuntu-24.04", location:$loc,
      start_after_create:true, public_net:{enable_ipv4:true, enable_ipv6:true},
      user_data:$ud, labels:{product:"ai-os", pebble:$slug}
    }')"
  [ -n "${OPERATOR_SSH_KEY_NAME:-}" ] && BODY="$(echo "$BODY" | jq --arg k "$OPERATOR_SSH_KEY_NAME" '. + {ssh_keys:[$k]}')"
  CREATE="$(curl -sS -H "Authorization: Bearer $HCLOUD_TOKEN" -H "Content-Type: application/json" -X POST "$HC_API/servers" --data "$BODY")"
  SERVER_ID="$(echo "$CREATE" | jq -r '.server.id // empty')"
  if [ -n "$SERVER_ID" ]; then CHOSEN="$ST @ $LOC"; ok "server $SERVER_ID ($CHOSEN)"; break; fi
  ECODE="$(echo "$CREATE" | jq -r '.error.code // "unknown"')"
  EMSG="$(echo "$CREATE" | jq -r '.error.message // ""')"
  if [ "$ECODE" = "resource_unavailable" ] || { [ "$ECODE" = "invalid_input" ] && echo "$EMSG" | grep -qi "unsupported location"; }; then
    say "  ${c_dim}$ST @ $LOC unavailable ($ECODE) — trying next${c_off}"
  else
    die "Hetzner create failed ($ST @ $LOC): $ECODE — $EMSG"
  fi
done
[ -n "$SERVER_ID" ] || die "no capacity for any candidate. Try again shortly or set HCLOUD_CANDIDATES / HCLOUD_SERVER_TYPE+HCLOUD_LOCATION."

# ---- poll until running + capture IP ----
step "Waiting for the VM to boot"
hc_wait_running "$SERVER_ID"
IP="$SERVER_IPV4"
ok "running at $IP"

# ---- write durable state (NON-secret ids only; no password, no token) ----
# The TEMPLATE_* lines answer "what stamped this box?", which nothing could
# answer before 2026-08-03: brainiac.env records ids only, so pinning its empty
# device roster to a stale checkout took a live symptom and a bisect. TEMPLATE_
# DIGEST is the authoritative field (the exact template bytes, hashed); the ref
# and sha are the human handles, and TEMPLATE_DIRTY says whether to trust them.
checkout_provenance "$HERE"
{
  echo "SLUG=\"$SLUG\""
  echo "HOSTNAME=\"$HOSTNAME\""
  echo "SERVER_ID=\"$SERVER_ID\""
  echo "SERVER_SPEC=\"$CHOSEN\""
  echo "SERVER_IP=\"$IP\""
  echo "TUNNEL_ID=\"$TUNNEL_ID\""
  echo "RECORD_ID=\"$RECORD_ID\""
  echo "CF_ACCOUNT_ID=\"$CF_ACCOUNT_ID\""
  echo "CF_ZONE_ID=\"$CF_ZONE_ID\""
  echo "IMAGE=\"$IMAGE\""
  echo "TEMPLATE_REF=\"$CHECKOUT_REF\""
  echo "TEMPLATE_SHA=\"$CHECKOUT_SHA\""
  echo "TEMPLATE_DIRTY=\"$CHECKOUT_DIRTY\""
  echo "TEMPLATE_DIGEST=\"$TEMPLATE_DIGEST\""
  echo "TEMPLATE_SOURCE=\"$HERE\""
  echo "STAMPED_AT=\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
} > "$STATE"
trap 'rm -f "$CI_FILE"' EXIT   # state written → stop rolling back on exit

# ---- gate the handoff on the URL actually serving (cloud-init + pull + tunnel) ----
step "Waiting for the workspace to come online (first boot pulls the image — up to ~12 min)"
# Same fix as the rock path (2026-08-09): the old 200/302 probe polled the
# browser door the 2026-08-05 ruling shut, so it could never pass on a box
# stamped after that ruling. A pebble's door user is `member`.
READY_STATE="$(AIOS_READY_USER=member wait_for_box "$HOSTNAME" "$IP" 90 || true)"

say ""
if [ "$READY_STATE" = "live" ] || [ "$READY_STATE" = "reachable" ]; then
  ok "workspace is $READY_STATE"
else
  # Truthful failure (2026-07-20): warn-and-exit-0 here let a crash-looping box
  # report as provisioned (stamp-pebble registered it "active", the wizard said
  # DONE). The infra EXISTS and state is written, so this is recoverable: give
  # it a few minutes, or root-cause on the box (bad image tag was the real one),
  # or deprovision + re-stamp. Callers must see a non-zero exit either way.
  printf '  %s⚠ the workspace never served (last status above). The VM + tunnel + DNS exist and state is written.%s\n' "$c_red" "$c_off"
  printf '  %s  If it is just a slow image pull, the URL may still come up shortly. Otherwise: check the box\n' "$c_dim"
  printf '    (systemctl status ai-os; journalctl -u ai-os) or deprovision-pebble.sh %s and re-stamp.%s\n' "$SLUG" "$c_off"
  exit 9
fi

# ---- render the ready-to-send pebble welcome (gitignored; 0600) ----
WELCOME="$STATE_DIR/$SLUG.welcome.txt"
PEBBLE_NAME="${PEBBLE_NAME:-$SLUG}"
if [ -f "$HERE/pebble-welcome.template.txt" ]; then
  sed -e "s|{{NAME}}|$PEBBLE_NAME|g" -e "s|{{URL}}|https://$HOSTNAME|g" -e "s|{{PASSWORD}}|$PASSWORD|g" \
    "$HERE/pebble-welcome.template.txt" > "$WELCOME"
  chmod 600 "$WELCOME"
fi

# ---- handoff ----
say ""
say "${c_bold}──────────────── send this to $PEBBLE_NAME ────────────────${c_off}"
say "  URL:      ${c_blue}https://$HOSTNAME${c_off}"
say "  Password: ${c_bold}$PASSWORD${c_off}"
say "${c_bold}───────────────────────────────────────────────────────${c_off}"
[ -f "$WELCOME" ] && say "  ${c_dim}Ready-to-send welcome message → ${c_off}state/$SLUG.welcome.txt${c_dim}  (copy/paste or email it; delete after sending)${c_off}"
say "  ${c_dim}Teardown:  ./deprovision-pebble.sh $SLUG${c_off}"
