#!/usr/bin/env bash
# test-rock.sh — the OBSERVABLE end-to-end test of the rock lifecycle.
#
# Runs the whole loop with evidence at every layer, so a failure says WHERE and shows the
# logs, instead of a black-box URL check:
#
#   phase 0  preflight     all four planes clean (VM / tunnel / DNS / deploy keys) — the
#                          codified lesson of the 2026-07-19 debris hunt
#   phase 1  stamp         via the WIZARD (headless answers), not by hand: tests the product
#   phase 2  external      URL serves login; Hetzner says running; tunnel has a connection
#   phase 3  internal      over break-glass SSH (staging only): cloud-init result, container
#                          up, boot banner, machinery link, deployment parsed, factory
#                          tokens staged 0600, brain cloned
#   phase 4  verdict       PASS/FAIL table; on any FAIL, dumps the relevant remote logs
#
# Usage:  AIOS_TEST_DESTROY=1 ./test-rock.sh     # tear down an existing rock first
#         ./test-rock.sh --probe-only            # phases 2-3 against the live rock
# Requires: .env.local tokens, GITHUB_TOKEN, and the aios-staging-ops key (Hetzner + ~/.ssh).
set -uo pipefail
PDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# THE REFUSAL COMES FIRST, before lib.sh loads a single credential.
#
# lib.sh reads the real tokens out of .env.local as a side effect of being
# sourced, so having it above the guard meant an unarmed run pulled live Hetzner,
# Cloudflare and GitHub credentials into its environment before anything decided
# it was allowed to run. On a checkout without that file it was worse than
# pointless: lib.sh bailed first and the script exited having printed nothing at
# all, so live-guard.test.mjs saw empty output instead of REFUSED and went red on
# CI while staying green on the one box that has the secrets.
#
# Phase 0 below runs deprovision-rock.sh with AIOS_CONFIRM_DESTROY pre-set, which
# satisfies its typed confirmation non-interactively. SLUG defaults to the generic
# "rock" and STATE_DIR is the SHARED live state dir, so a stale state file or an
# exported AIOS_TEST_SLUG naming a live rock tears that rock down with nothing
# typed (2026-08-20 audit). That is the damage this refusal stands in front of.
. "$PDIR/../../harness/lib/live-guard.sh"
aios_require_live_arming "test-rock.sh" "tears down and re-stamps a real rock: Hetzner VM, Cloudflare tunnel and DNS, and GitHub deploy keys"

. "$PDIR/../managed/lib.sh"   # NB: lib.sh sets its own HERE; use PDIR for our paths
SLUG="${AIOS_TEST_SLUG:-rock}"
OPS_KEY="$HOME/.ssh/aios_staging_ops"
SSHO=(-i "$OPS_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 -o BatchMode=yes)

PASS=(); FAIL=()
p(){ PASS+=("$1"); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
f(){ FAIL+=("$1"); printf '  \033[31mFAIL\033[0m %s%s\n' "$1" "${2:+ — $2}"; }
hdr(){ printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

PROBE_ONLY=0; [ "${1:-}" = "--probe-only" ] && PROBE_ONLY=1

if [ "$PROBE_ONLY" = 0 ]; then
  # ---------------- phase 0: preflight, all planes clean ----------------
  hdr "phase 0 · preflight (clean slate on all four planes)"
  cf_resolve_ids 2>/dev/null || true
  if [ -f "$STATE_DIR/rock-$SLUG.env" ]; then
    if [ "${AIOS_TEST_DESTROY:-0}" = 1 ]; then
      AIOS_CONFIRM_DESTROY="$SLUG" "$PDIR/deprovision-rock.sh" "$SLUG" || { f "teardown of existing rock"; exit 1; }
      p "existing rock torn down"
    else f "state file exists (set AIOS_TEST_DESTROY=1 to recycle)"; exit 1; fi
  fi
  N=$(hc "$HC_API/servers?name=aios-$SLUG" | jq '.servers | length'); [ "$N" = 0 ] && p "no VM named aios-$SLUG" || { f "VM plane dirty ($N)"; exit 1; }
  N=$(cf "$CF_API/accounts/$CF_ACCOUNT_ID/cfd_tunnel?name=aios-$SLUG&is_deleted=false" | jq '.result | length'); [ "$N" = 0 ] && p "no tunnel" || { f "tunnel plane dirty ($N)"; exit 1; }
  N=$(cf "$CF_API/zones/$CF_ZONE_ID/dns_records?name=$SLUG.$CF_ZONE_NAME" | jq '.result | length'); [ "$N" = 0 ] && p "no DNS record" || { f "DNS plane dirty ($N)"; exit 1; }
  RP="$(printf '%s' "${AIOS_SETUP_BRAIN_REPO:?need AIOS_SETUP_BRAIN_REPO}" | sed -E 's#^git@github.com:##; s#\.git$##')"
  N=$(curl -s -H "Authorization: Bearer $GITHUB_TOKEN" "https://api.github.com/repos/$RP/keys" | jq 'length'); [ "$N" = 0 ] && p "no stale deploy keys" || printf '  \033[33mnote\033[0m %s stale deploy key(s) on %s (tolerated)\n' "$N" "$RP"

  # ---------------- phase 1: stamp via the wizard ----------------
  hdr "phase 1 · stamp through the wizard (headless)"
  OPERATOR_SSH_KEY_NAME="${OPERATOR_SSH_KEY_NAME:-aios-staging-ops}" "$PDIR/../../wizard/aios-setup.sh" || { f "wizard run"; exit 1; }
  p "wizard completed"
fi

[ -f "$STATE_DIR/rock-$SLUG.env" ] || { f "no state file after stamp"; exit 1; }
. "$STATE_DIR/rock-$SLUG.env"

# ---------------- phase 2: external probes ----------------
hdr "phase 2 · external (URL, Hetzner, tunnel)"
CODE="$(url_status "https://$HOSTNAME/")"
if ! { [ "$CODE" = 200 ] || [ "$CODE" = 302 ]; }; then
  # operator-side resolvers go stale after create/delete cycles of the same hostname
  # (negative cache). Distinguish "box down" from "my resolver lies": ask 1.1.1.1 directly.
  EDGE="$(dig +short "$HOSTNAME" @1.1.1.1 2>/dev/null | grep -E '^[0-9.]+$' | head -1)"
  [ -n "$EDGE" ] && CODE="$(curl -s -o /dev/null -w '%{http_code}' --resolve "$HOSTNAME:443:$EDGE" "https://$HOSTNAME/" 2>/dev/null)(edge-direct)"
fi
case "$CODE" in 200*|302*) p "https://$HOSTNAME serves ($CODE)";; *) f "URL" "$CODE";; esac
ST=$(hc "$HC_API/servers/$SERVER_ID" | jq -r '.server.status'); [ "$ST" = running ] && p "VM running" || f "VM status" "$ST"
TC=$(cf "$CF_API/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID" | jq -r '.result.status'); [ "$TC" = healthy ] && p "tunnel healthy" || f "tunnel status" "$TC"

# ---------------- phase 3: internal probes (break-glass SSH) ----------------
hdr "phase 3 · internal (SSH into $SERVER_IP)"
if ssh "${SSHO[@]}" "root@$SERVER_IP" true 2>/dev/null; then
  p "SSH reachable (break-glass)"
  R(){ ssh "${SSHO[@]}" "root@$SERVER_IP" "$1" 2>/dev/null; }
  CI=$(R "cloud-init status 2>/dev/null | head -1"); echo "$CI" | grep -q done && p "cloud-init done" || f "cloud-init" "${CI:-unreachable}"
  R "docker ps --format '{{.Names}} {{.Status}}' | grep -q '^ai-os Up'" && p "container up" || f "container" "$(R "docker ps -a --format '{{.Names}} {{.Status}}' | head -2")"
  LOGS="$(R "docker logs ai-os 2>&1 | head -60")"
  # Same contract line the CI smoke reads, not a second copy of the banner prose
  # (2026-08-20 audit, trap 5: a smoke exists in ONE place). boot-rock.sh prints
  # AIOS-BOOT-OK immediately before the code-server handoff, carrying the staged
  # deployment name, so one grep proves the boot ran to the end with the right
  # config. The banner above it is display copy and free to be reworded.
  echo "$LOGS" | grep -q "AIOS-BOOT-OK rock deployment="  && p "boot reached the handoff (deployment parsed)" || f "boot banner"
  echo "$LOGS" | grep -q "machinery linked"           && p "machinery linked"                || f "machinery link"
  R "docker exec ai-os sh -c 'test -f /app/provisioning/managed/.env.local'" && p "factory tokens visible to lib.sh (in-container)" || f "factory tokens" "lib.sh path unreadable in container"
  # code-server's own startup wording is a third-party string and drifts on
  # upgrade; the contract line above already proves we reached the exec.
  echo "$LOGS" | grep -q "AIOS-BOOT-OK rock .* ide="      && p "code-server handoff reached"     || f "code-server"
  PERM=$(R "stat -c %a /state/secrets/provisioning.env.local 2>/dev/null"); [ "$PERM" = 600 ] && p "factory env staged (0600)" || f "factory env" "perm=${PERM:-missing}"
  R "test -d /state/brain/.git && test -f /state/brain/CLAUDE.md && test -f /state/brain/org-policy.yaml" && p "brain cloned + identity present" || f "brain" "$(R "ls /state/brain | head -3 | tr '\n' ' '")"
  R "test -f /state/deployment.yaml" && p "deployment.yaml staged" || f "deployment.yaml"
  if [ "${#FAIL[@]}" -gt 0 ]; then
    hdr "evidence · docker logs (tail)"; R "docker logs ai-os 2>&1 | tail -40"
    hdr "evidence · cloud-init (tail)";  R "tail -30 /var/log/cloud-init-output.log"
  fi
else
  f "SSH" "unreachable (was OPERATOR_SSH_KEY_NAME set at stamp?)"
fi

# ---------------- verdict ----------------
hdr "verdict"
printf '  %d pass · %d fail\n' "${#PASS[@]}" "${#FAIL[@]}"
[ "${#FAIL[@]}" = 0 ] && { printf '  \033[32mALL GREEN\033[0m — https://%s\n' "$HOSTNAME"; exit 0; }
printf '  \033[31mFAILURES:\033[0m %s\n' "${FAIL[*]}"; exit 1
