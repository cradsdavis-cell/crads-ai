#!/usr/bin/env bash
# provision-rock.sh <slug> <deployment.yaml> — stand up THE ROCK (factory + control
# brain) for a deployment. The one-time chicken-and-egg stamp: run it from an operator
# machine; after this the rock stamps its own pebbles (D2).
#
# Creates: a Cloudflare named tunnel + DNS (<slug>.<domain from deployment.yaml>), a
# read-only deploy key on the brain repo (registered via the GitHub API), and a Hetzner
# VM whose cloud-init stages deployment.yaml, clones the brain, pulls the ROCK image,
# and boots it (boot-rock.sh entrypoint). No inbound ports.
#
#   export HCLOUD_TOKEN=... CF_API_TOKEN=... GITHUB_TOKEN=...   (or .env.local)
#   AIOS_IMAGE=ghcr.io/<you>/ai-os-parent:v2 ./provision-rock.sh rock ./staging.deployment.yaml
#
# The Cloudflare Access block below IS here, and is vestigial: since Sam's 2026-08-05
# ruling this script routes the hostname at http_status:404, so no browser door exists
# to gate. It is kept so a future browser surface is gated on its first day. "Password
# only" has not described a rock stamped by this script since that ruling (trap 31).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../managed/lib.sh"
PDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SLUG="${1:-}"; DEPLOY_SRC="${2:-}"
[ -n "$SLUG" ] && [ -f "${DEPLOY_SRC:-}" ] || die "usage: provision-rock.sh <slug> <deployment.yaml>"
valid_slug "$SLUG" || die "slug must be DNS-safe: lowercase letters/digits/hyphens, 2-32 chars"
need curl; need jq; need python3; need ssh-keygen; need base64
reqenv HCLOUD_TOKEN CF_API_TOKEN GITHUB_TOKEN

# ---- preflight: is this checkout what shipped? ------------------------------
# Same gate provision-pebble.sh has carried since the brainiac stale-stamp; the
# rock path never got it, and on 2026-08-06 that stamped a rock from a tree 33
# commits behind — from BEFORE the 2026-08-05 browser-door-shut ruling, so the
# box published code-server behind one shared password on a surface the ruling
# had closed. A rock is a fleet's control plane: it is the LAST box that may
# render from a stale tree. Runs before anything is created, so a stale tree
# costs a message rather than an organisation's anchor.
preflight_checkout_current "$PDIR"

mkdir -p "$STATE_DIR"
STATE="$STATE_DIR/rock-$SLUG.env"
[ -f "$STATE" ] && die "rock '$SLUG' already provisioned ($STATE). Deprovision first to rebuild."

# ---- read the deployment file (flat YAML, same no-dep readers as boot-rock) ----
# `|| true`: an ABSENT key must read as empty, not kill the script — under
# `set -eo pipefail` grep's exit 1 propagates out of the pipeline, and the
# optional reads (brain_seed, org_handle, org_display) made every wizard stamp
# whose deployment.yaml lacked them die silently right after "deployment.yaml
# written" (run-6 audit, 2026-08-17). Required keys still die, loudly, on the
# [ -n ... ] || die that follows each of them.
dget(){ { grep -oP "^$1:\\s*\"?\\K[^\"#]*" "$DEPLOY_SRC" 2>/dev/null | head -1 | sed 's/[[:space:]]*$//'; } || true; }
DEPLOYMENT_NAME="$(dget deployment_name)"; [ -n "$DEPLOYMENT_NAME" ] || die "$DEPLOY_SRC has no deployment_name"
DOMAIN="$(dget domain)";                   [ -n "$DOMAIN" ]          || die "$DEPLOY_SRC has no domain"
BRAIN_REPO="$(dget brain_repo)";           [ -n "$BRAIN_REPO" ]      || die "$DEPLOY_SRC has no brain_repo"
# Normalize to the git@ form the box's deploy-key clone requires (2026-07-20
# e2e finding: a bare owner/repo reached cloud-init verbatim and git treated it
# as a local path, so the rock never booted). Accept owner/repo, https, git@.
case "$BRAIN_REPO" in
  git@github.com:*) ;;
  https://github.com/*) BRAIN_REPO="git@github.com:${BRAIN_REPO#https://github.com/}"; BRAIN_REPO="${BRAIN_REPO%.git}.git";;
  */*) BRAIN_REPO="git@github.com:${BRAIN_REPO%.git}.git";;
  *) die "brain_repo '$BRAIN_REPO' is not owner/repo, https://github.com/..., or git@github.com:...";;
esac
BRAIN_ROOT="$(dget brain_root)"; BRAIN_ROOT="${BRAIN_ROOT:-/state/brain}"
# repo "owner/name" out of either git@github.com:o/r.git or https://github.com/o/r
REPO_PATH="$(printf '%s' "$BRAIN_REPO" | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')"

# ---- brain_seed: template (ownership ruling 2026-08-09) ---------------------
# "The github repo should be their own off the bat. Crads AI should not own
# anyone's backups." In template mode brain_repo names the PRODUCT TEMPLATE,
# not the organisation's repo: cloud-init clones it read-only, strips its
# history, and the brain is reborn on the box with NO remote — the owner
# connects a GitHub account their organisation owns (connect-github) and that
# is the only offsite copy that ever exists. Consequences here: no deploy key
# is registered on anything (the clone rides the same read token cloud-init
# already carries for the image pull, and the re-init wipes it with the .git),
# and the unarmed factory env carries no GH_OWNER, because the platform's
# account must never be the default home for an organisation's artefacts.
BRAIN_SEED="$(dget brain_seed)"
ORG_HANDLE="$(dget org_handle)"; ORG_HANDLE="${ORG_HANDLE:-$SLUG}"
ORG_DISPLAY="$(dget org_display | tr -cd 'A-Za-z0-9 .-' | cut -c1-48)"; ORG_DISPLAY="${ORG_DISPLAY:-$DEPLOYMENT_NAME}"

# The rock's tunnel lives on the DEPLOYMENT's domain, which may differ from the
# operator's lib.sh env; override for this run.
ROOT_DOMAIN="$DOMAIN"; CF_ZONE_NAME="$DOMAIN"
IMAGE="${AIOS_IMAGE:?set AIOS_IMAGE to the rock image (e.g. ghcr.io/<you>/crads-rock:v2) — refusing a default so a pebble image can never become a rock}"
case "$IMAGE" in *crads-rock*|*ai-os-parent*) : ;; *) die "AIOS_IMAGE ($IMAGE) is not a rock image (crads-rock, or the legacy ai-os-parent alias)" ;; esac
HOSTNAME="$SLUG.$ROOT_DOMAIN"; SRVNAME="aios-$SLUG"

say "${c_bold}Provisioning ROCK '$SLUG' for deployment '$DEPLOYMENT_NAME'${c_off}"
say "${c_dim}  url → https://$HOSTNAME · image $IMAGE · brain $REPO_PATH → $BRAIN_ROOT${c_off}"
say ""

step "Resolving Cloudflare account + zone"
cf_resolve_ids
ok "account $CF_ACCOUNT_ID · zone $CF_ZONE_NAME ($CF_ZONE_ID)"

# ---- deploy key: mint + register read-only on the brain repo ----
# Template mode registers NOTHING: the keypair is still minted (the cloud-init
# render expects a key file) but never reaches GitHub, the clone goes over
# https with the read token already in cloud-init for the image pull, and the
# seed block deletes the key file with the template's .git. Zero GitHub API
# writes per customer rock.
KEYD="$(mktemp -d)"; chmod 700 "$KEYD"
ssh-keygen -q -t ed25519 -N '' -C "aios-rock-$SLUG" -f "$KEYD/brain_deploy"
DK_ID=""
if [ "$BRAIN_SEED" = "template" ]; then
  step "Brain seed: template mode — no deploy key, no org repo anywhere off-box"
  # Same rule as the GHCR token above: no platform PAT in a URL that lands on
  # customer metal and stays in /var/lib/cloud. The product template repo is
  # public, so an anonymous clone works; a scoped token is used only if one was
  # deliberately staged.
  if [ -n "${GHCR_PULL:-}" ]; then
    BRAIN_REPO="https://x-access-token:${GHCR_PULL}@github.com/$REPO_PATH.git"
  else
    BRAIN_REPO="https://github.com/$REPO_PATH.git"
  fi
  ok "template clone rides the read token; the brain is reborn on the box with no remote"
else
  step "Minting a read-only deploy key for $REPO_PATH"
  DK_RESP="$(curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" -H "Content-Type: application/json" \
    -X POST "https://api.github.com/repos/$REPO_PATH/keys" \
    --data "$(jq -n --arg t "aios-rock-$SLUG (read-only)" --rawfile k "$KEYD/brain_deploy.pub" '{title:$t, key:$k, read_only:true}')")"
  DK_ID="$(echo "$DK_RESP" | jq -r '.id // empty')"
  [ -n "$DK_ID" ] || die "deploy-key registration failed: $(echo "$DK_RESP" | jq -r '.message // "unknown"')"
  ok "deploy key $DK_ID registered (read-only)"
fi

cleanup_partial(){
  [ -f "$STATE" ] && return 0
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
  [ -n "${DK_ID:-}" ] && curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" -X DELETE "https://api.github.com/repos/$REPO_PATH/keys/$DK_ID" >/dev/null 2>&1 || true
  rm -rf "$KEYD"
}
trap cleanup_partial EXIT

PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"

step "Creating Cloudflare tunnel"
TUNNEL_ID="$(cf_call "create tunnel" -X POST "$CF_API/accounts/$CF_ACCOUNT_ID/cfd_tunnel" \
  --data "$(jq -n --arg n "aios-$SLUG" '{name:$n, config_src:"cloudflare"}')" | jq -r '.id')"
[ -n "$TUNNEL_ID" ] && [ "$TUNNEL_ID" != "null" ] || die "tunnel id missing from create response"
ok "tunnel $TUNNEL_ID"


TUNNEL_TOKEN="$(cf_call "get tunnel token" "$CF_API/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token" | jq -r '.')"
[ -n "$TUNNEL_TOKEN" ] && [ "$TUNNEL_TOKEN" != "null" ] || die "tunnel token missing"

# App-first (Sam, 2026-08-05): the hostname routes NOTHING. See the member path in
# provisioning/managed/provision-pebble.sh for the full reasoning. The Access block
# below is kept because it costs nothing and is defence in depth for anything that
# might later be served here, but it is no longer the only thing standing between a
# guessed hostname and a container terminal.
step "Routing $HOSTNAME → nothing (app-first: no browser door)"
cf_call "set ingress" -X PUT "$CF_API/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
  --data "$(jq -n '{config:{ingress:[{service:"http_status:404"}]}}')" >/dev/null
ok "ingress set (no public surface)"

RECORD_ID="$(cf_call "create DNS record" -X POST "$CF_API/zones/$CF_ZONE_ID/dns_records" \
  --data "$(jq -n --arg h "$HOSTNAME" --arg c "$TUNNEL_ID.cfargotunnel.com" \
    '{type:"CNAME", name:$h, content:$c, proxied:true, ttl:1}')" | jq -r '.id')"
ok "DNS CNAME $HOSTNAME"

# ---- Cloudflare Access: email-gate the rock hostname to the operators (Step 6 / D51) ----
# So "log in as rock" via the browser is gated to the operator emails, not just the
# code-server password. SSH/app access is already key-gated (aios-op). Mirrors the member-box
# Access block in the brain-template repo's factory/stamp-pebble.sh, scoped to the
# deployment's operator_emails list. THAT IS A DIFFERENT REPO: a fix to one of these two
# copies is not a fix to the other, and trap 31's repair landed there on 2026-08-10 and
# left this copy asserting an exposure that had not existed since 2026-08-05.
# Guarded: warns (never fails) if CF ids or emails are absent.
step "Email-gating $HOSTNAME (Cloudflare Access → operators)"
# Was an inline awk one-liner until 2026-08-25. It disagreed with boot-rock.sh's
# reader about the same file (single quotes survived, the inline form read as
# empty, trailing comments and CRLF rode into the address), and the branch below
# only warns when the list is EMPTY — never when it is WRONG. So a malformed
# address built an Access policy that matched no human while the stamp still
# printed `ok ... gated to:`. lib.sh's operator_emails_from is that extraction at
# parity with boot-rock, with every entry validated; anything it drops it names
# on stderr. See provisioning/managed/operator-emails.test.mjs.
OPERATOR_EMAILS="$(operator_emails_from "$DEPLOY_SRC")"
# Raw `cf` (not cf_call, which DIES on success:false): an Access hiccup must warn, never abort a stamp.
if [ -n "$CF_ACCOUNT_ID" ] && [ -n "$OPERATOR_EMAILS" ]; then
  # Keep the WHOLE response. Reading only the id turned every possible failure into one
  # indistinguishable "could not create" that named no cause, which is how the account-wide
  # `access.api.error.not_enabled` stayed invisible from the day this block was written
  # until 2026-08-25: no rock has ever had one of these apps (trap 31).
  ACCESS_RESP="$(cf -X POST "$CF_API/accounts/$CF_ACCOUNT_ID/access/apps" \
    --data "$(jq -n --arg n "org-$SLUG" --arg d "$HOSTNAME" '{name:$n, domain:$d, type:"self_hosted", session_duration:"24h"}')" 2>/dev/null || true)"
  ACCESS_APP_ID="$(printf '%s' "$ACCESS_RESP" | jq -r '.result.id // empty' 2>/dev/null || true)"
  if [ -n "$ACCESS_APP_ID" ] && [ "$ACCESS_APP_ID" != "null" ]; then
    INCLUDE="$(printf '%s\n' $OPERATOR_EMAILS | jq -R 'select(length>0)|{email:{email:.}}' | jq -s '.')"
    cf -X POST "$CF_API/accounts/$CF_ACCOUNT_ID/access/apps/$ACCESS_APP_ID/policies" \
      --data "$(jq -n --arg n "operators-$SLUG" --argjson inc "$INCLUDE" '{name:$n, decision:"allow", include:$inc}')" >/dev/null 2>&1
    ok "Access app $ACCESS_APP_ID gated to: $(printf '%s ' $OPERATOR_EMAILS)"
  else
    # LOUD (warn: red, stderr), because a stamp that believes it is email-gating and is
    # not should surface rather than degrade quietly. Say what the API actually said, and
    # do NOT assert an exposure the current design removed: this hostname routes nothing.
    ACCESS_ERR="$(printf '%s' "$ACCESS_RESP" | jq -r '.errors[0].message // empty' 2>/dev/null || true)"
    warn "no Cloudflare Access app for $SLUG (${ACCESS_ERR:-no message from the API})."
    warn "  Harmless today: $HOSTNAME deliberately routes nothing (http_status:404) and the"
    warn "  rock is reached through the app over SSH. It matters the day a browser surface"
    warn "  is served here, so the gate has to exist BEFORE that day, not after it."
  fi
else
  if [ -z "$OPERATOR_EMAILS" ]; then
    ACCESS_SKIP="no operator_emails: list in $DEPLOY_SRC"
  else
    ACCESS_SKIP="no CF_ACCOUNT_ID"
  fi
  warn "no Access app for $SLUG ($ACCESS_SKIP)."
  warn "  Harmless today ($HOSTNAME routes nothing); required before any browser surface."
fi

# ---- render cloud-init (python: multi-line-safe; temp file deleted on exit) ----
CI_FILE="$(mktemp)"; chmod 600 "$CI_FILE"
trap 'rm -f "$CI_FILE"; cleanup_partial' EXIT
# The factory tokens: NONE, ever (self-host strip 2026-09-01, hardening the
# brokered ruling of 2026-08-04). A rock is a community hub with no metal: it
# never receives a Hetzner or Cloudflare credential and cannot create a pebble.
# The AIOS_STAGE_PLATFORM_TOKENS escape hatch that used to stage the operator's
# live HCLOUD + CF + GITHUB tokens onto a platform-owned rock is gone with the
# hosted platform itself. The staged env carries configuration only.
# the pebble image is the pebble edition of whichever rock image runs here,
# across both name families (canonical crads-*, legacy ai-os-*)
PEBBLE_IMAGE="${IMAGE/ai-os-parent/ai-os-member}"; PEBBLE_IMAGE="${PEBBLE_IMAGE/crads-rock/crads-pebble}"

# THE GHCR READ TOKEN, GATED THE SAME WAY (2026-08-20 audit).
#
# This was `GHCR_PULL_TOKEN="${GHCR_PULL_TOKEN:-$GITHUB_TOKEN}"`, evaluated
# OUTSIDE the branch below, so the customer path that had just carefully staged
# no platform credential handed the platform's own GitHub PAT over anyway: into
# the rendered cloud-init, into /var/lib/cloud on the box, and into
# /root/.docker/config.json where docker login leaves it base64 for good. No
# scoped GHCR_PULL_TOKEN exists in the operator env, so the fallback WAS the
# behaviour, on every customer rock. That PAT carries repo and delete_repo: it
# registers deploy keys and creates repos elsewhere in this same script.
#
# It buys nothing. The product images are PUBLIC on GHCR (verified 2026-08-20:
# crads-rock, crads-pebble, crads-base and ai-os-member all return a manifest to
# an anonymous token), and the template already treats the login as optional
# because "the pull is the real gate". So the customer path now sends no token
# at all, and only a platform-owned rock (the same flag that gates the factory
# env) may carry one.
GHCR_PULL="${GHCR_PULL_TOKEN:-}"
[ -n "$GHCR_PULL" ] || say "  ${c_dim}no GHCR token staged: the product images are public, and no platform credential goes on customer metal${c_off}"
GH_OWNER="${REPO_PATH%%/*}"
# In template mode REPO_PATH names the PRODUCT TEMPLATE's owner, which must
# never become the default home for an organisation's artefacts: the org sets
# its own GH_OWNER when it connects GitHub and arms its factory.
#
# BUT ONLY WHEN NO PLATFORM TOKEN IS STAGED. This blanking used to run above the
# branch, so a template-seeded rock stamped WITH platform tokens got
# GITHUB_TOKEN=<platform> and GH_OWNER="", a token with no owner. Every consumer
# needs the pair, so the factory read as unarmed while carrying a live
# credential, and the stamp died at a guard naming a variable rather than a
# cause. That is what test-org-4 hit on 2026-08-10. If the platform is
# deliberately arming its own metal, it stages a COHERENT pair; the ownership
# ruling is about customer rocks, which take the branch below.
# The ONLY path. No credential of any kind, and no GH_OWNER in template mode:
# the rock's owner connects GitHub themselves, which brain-template's
# factory/org-github.mjs reads as the last rung of the credential chain. A rock
# holds no Hetzner or Cloudflare token, so it can never create a pebble.
[ "$BRAIN_SEED" = "template" ] && GH_OWNER=""
say "  ${c_dim}no platform tokens staged (self-host strip): a rock carries configuration only, never a hosting credential${c_off}"
FACTORY_ENV_B64="$(printf 'GH_OWNER=%s\nCF_TUNNEL_ROOT_DOMAIN=%s\nPEBBLE_IMAGE=%s\n' \
  "$GH_OWNER" "$ROOT_DOMAIN" "$PEBBLE_IMAGE" | base64 -w0)"

TPL="$PDIR/cloud-init.rock.template.yaml" DEPLOY_SRC="$DEPLOY_SRC" KEY_FILE="$KEYD/brain_deploy" \
CI_OUT="$CI_FILE" IDE_PASSWORD="$PASSWORD" TUNNEL_TOKEN="$TUNNEL_TOKEN" IMAGE="$IMAGE" \
BRAIN_REPO="$BRAIN_REPO" BRAIN_ROOT="$BRAIN_ROOT" GHCR_PULL_TOKEN="$GHCR_PULL" \
FACTORY_ENV_B64="$FACTORY_ENV_B64" OPERATOR_PUBKEY="${OPERATOR_PUBKEY:-}" SSH_RULE="$([ -n "${OPERATOR_SSH_KEY_NAME:-}" ] && echo 'ufw allow 22/tcp' || echo '/bin/true')" \
BRAIN_SEED_MODE="${BRAIN_SEED:-repo}" ORG_DISPLAY="$ORG_DISPLAY" ORG_HANDLE="$ORG_HANDLE" \
python3 - <<'PY'
import base64, os
e = os.environ
t = open(e['TPL']).read()
key = open(e['KEY_FILE']).read().rstrip('\n')
key_block = '\n'.join('      ' + l for l in key.split('\n'))
t = t.replace('      __BRAIN_DEPLOY_KEY__', key_block)
t = t.replace('__DEPLOYMENT_YAML_B64__', base64.b64encode(open(e['DEPLOY_SRC'],'rb').read()).decode())
for k in ('IDE_PASSWORD','TUNNEL_TOKEN','IMAGE','BRAIN_REPO','BRAIN_ROOT','GHCR_PULL_TOKEN','FACTORY_ENV_B64'):
    t = t.replace('__'+k+'__', e[k])
t = t.replace('__SSH_FIREWALL_RULE__', e.get('SSH_RULE','/bin/true'))
# OPERATOR_PUBKEY MAY CARRY MORE THAN ONE KEY, newline-separated (finding 98,
# 2026-08-13). A rock created by the platform owner's own email is keyed to that
# person's laptop and NOTHING else, because the keypair is minted on the laptop
# and the private half never leaves it. That is the right property for the owner
# and the wrong one for the broker: the brokered stamp is the only way a rock can
# create a member, it runs from the VPS, and it therefore could not reach such a
# rock at all. It failed with "ssh refused this box", which reads as a host-key
# fault and is not one.
#
# ORDER IS LOAD-BEARING. The founder seed further down this template does
# `head -n1 /home/aios-op/.ssh/authorized_keys` to decide who to write into
# people/founder.yaml, so the HUMAN's key must stay first. Put the platform key
# second and the roster still names the person, not Crads-AI.
op_keys = [k.strip() for k in e.get('OPERATOR_PUBKEY','').split('\n') if k.strip()]
if not op_keys:
    op_keys = ['ssh-ed25519 AAAA-no-operator-key-staged disabled']
t = t.replace('      - __OPERATOR_PUBKEY__', '\n'.join('      - ' + k for k in op_keys))
t = t.replace('__OPERATOR_PUBKEY__', op_keys[0])   # any other use stays single-valued
# template-seed mode (ownership ruling 2026-08-09): the brain is reborn on the
# box with no remote; these drive the re-init block + the rendered CLAUDE.md
t = t.replace('__BRAIN_SEED_MODE__', e.get('BRAIN_SEED_MODE','repo'))
t = t.replace('__ORG_DISPLAY__', e.get('ORG_DISPLAY',''))
t = t.replace('__ORG_HANDLE__', e.get('ORG_HANDLE',''))
assert '__' + 'BRAIN_DEPLOY_KEY' + '__' not in t
open(e['CI_OUT'],'w').write(t)
print(len(t))
PY
CI_BYTES="$(wc -c < "$CI_FILE")"
[ "$CI_BYTES" -le 31000 ] || die "rendered cloud-init is ${CI_BYTES} B (>31 KiB cap)"
ok "cloud-init rendered (${CI_BYTES} B of 32768)"
rm -rf "$KEYD"   # private key now lives only in the rendered temp file

# ---- Hetzner: create the VM (capacity-fallback walk, same as members) ----
if [ -n "$SERVER_TYPE" ] && [ -n "$HCLOUD_LOCATION" ]; then CANDS="$SERVER_TYPE:$HCLOUD_LOCATION"; else CANDS="$HCLOUD_CANDIDATES"; fi
SERVER_ID=""; CHOSEN=""
for cand in $CANDS; do
  ST="${cand%%:*}"; LOC="${cand##*:}"
  step "Creating Hetzner $ST in $LOC"
  BODY="$(jq -n --arg name "$SRVNAME" --arg st "$ST" --arg loc "$LOC" \
    --arg slug "$SLUG" --arg dep "$DEPLOYMENT_NAME" --rawfile ud "$CI_FILE" '{
      name:$name, server_type:$st, image:"ubuntu-24.04", location:$loc,
      start_after_create:true, public_net:{enable_ipv4:true, enable_ipv6:true},
      user_data:$ud, labels:{product:"ai-os", role:"rock", deployment:$dep, pebble:$slug}
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
[ -n "$SERVER_ID" ] || die "no capacity for any candidate."

step "Waiting for the VM to boot"
hc_wait_running "$SERVER_ID"
IP="$SERVER_IPV4"
ok "running at $IP"

{
  echo "SLUG=\"$SLUG\""
  echo "ROLE=\"rock\""
  echo "DEPLOYMENT=\"$DEPLOYMENT_NAME\""
  echo "HOSTNAME=\"$HOSTNAME\""
  echo "SERVER_ID=\"$SERVER_ID\""
  echo "SERVER_SPEC=\"$CHOSEN\""
  echo "SERVER_IP=\"$IP\""
  echo "TUNNEL_ID=\"$TUNNEL_ID\""
  echo "RECORD_ID=\"$RECORD_ID\""
  echo "DEPLOY_KEY_ID=\"$DK_ID\""
  echo "BRAIN_REPO=\"$REPO_PATH\""
  echo "CF_ACCOUNT_ID=\"$CF_ACCOUNT_ID\""
  echo "CF_ZONE_ID=\"$CF_ZONE_ID\""
} > "$STATE"
trap 'rm -f "$CI_FILE"' EXIT

step "Waiting for the rock to come online (first boot pulls the image — up to ~12 min)"
# AIOS_READY_USER: a rock's door is aios-op. With AIOS_READY_SSH_KEY this proves
# the CONTAINER answers (ForceCommand lands inside it); without one it proves
# the tunnel is up, which is all anyone can honestly claim from outside.
READY_STATE="$(AIOS_READY_USER=aios-op wait_for_box "$HOSTNAME" "$IP" 90 || true)"
say ""
if [ "$READY_STATE" = "live" ] || [ "$READY_STATE" = "reachable" ]; then
  ok "rock is $READY_STATE"
else
  # A box that never answered is NOT a successful build, and the caller is the
  # only thing standing between that and a stranger being told their
  # rock is ready. fulfil-arrivals' buildRock reads the exit code alone:
  # on 0 it posts done/100, emails "Open it: https://<slug>...", writes the
  # durable built: marker that blocks a retry under the same name, and creates
  # the subscription. provision-pebble.sh (the pebble path) settled this on
  # 2026-07-20 — "Callers must see a non-zero exit either way" — and this path
  # kept falling through. Same failure, same exit code, same recoverable advice.
  printf '  %s⚠ the rock never served (last status above). The VM + tunnel + DNS exist and the org brain is seeded.%s\n' "$c_red" "$c_off"
  printf '  %s  If it is just a slow image pull, the URL may still come up shortly. Otherwise: check the box\n' "$c_dim"
  printf '    (systemctl status ai-os; journalctl -u ai-os) or deprovision-rock.sh and re-run.%s\n' "$c_off"
  exit 9
fi

say ""
say "${c_bold}──────────────── the rock ────────────────${c_off}"
say "  URL:      ${c_blue}https://$HOSTNAME${c_off}"
say "  Password: ${c_bold}$PASSWORD${c_off}"
say "${c_bold}────────────────────────────────────────────${c_off}"
say "  ${c_dim}Next: open it, sign into the deployment's Claude account (staging: yours, past the loud warning),${c_off}"
say "  ${c_dim}stage the factory tokens (/state/secrets/provisioning.env.local), then stamp a pebble from the box.${c_off}"
say "  ${c_dim}Teardown: delete server $SERVER_ID + tunnel $TUNNEL_ID + DNS $RECORD_ID + deploy key $DK_ID (no script yet — deliberate).${c_off}"
