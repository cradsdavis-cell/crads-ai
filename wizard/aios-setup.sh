#!/usr/bin/env bash
# aios-setup: the Practice Partner setup wizard (MVP, D33/D36).
#
# This is the thing a rock downloads and runs on THEIR machine. It asks about the
# org, walks them through creating their own cloud accounts + tokens (BYO always, D34),
# writes the staged deployment.yaml, and stamps their rock box. Credentials go straight
# from the operator to their own cloud accounts and their new box; they never touch
# crads-ai (D33). The wizard is a skin over the proven seam: deployment.yaml +
# provisioning/rock/provision-rock.sh.
#
#   Interactive:      ./wizard/aios-setup.sh
#   Non-interactive:  every prompt reads an AIOS_SETUP_* env override first (used by the
#                     test harness; also the path to an eventual answers-file mode)
#
# MVP scope: CLI prompts. The downloadable signed app is the productised wrapper around
# exactly this flow; the questions and the order ARE the product spec for it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

b(){ printf '\033[1m%s\033[0m\n' "$*"; }
mut(){ printf '\033[2m%s\033[0m\n' "$*"; }
ok(){ printf '  \033[32m+\033[0m %s\n' "$*"; }
die(){ printf '\033[31mx %s\033[0m\n' "$*" >&2; exit 1; }

# ask VAR "prompt" "default" [secret] — env override AIOS_SETUP_<VAR> wins (non-interactive)
ask(){
  local var="$1" prompt="$2" def="${3:-}" secret="${4:-}" ov val
  ov="AIOS_SETUP_$var"
  if [ -n "${!ov:-}" ]; then printf -v "$var" '%s' "${!ov}"; return 0; fi
  [ -t 0 ] || die "no terminal and no \$$ov set (non-interactive runs must provide every AIOS_SETUP_* answer)"
  if [ "$secret" = secret ]; then read -r -s -p "  $prompt: " val; echo
  else read -r -p "  $prompt${def:+ [$def]}: " val; fi
  printf -v "$var" '%s' "${val:-$def}"
}

clear 2>/dev/null || true
b "Practice Partner — rock setup"
mut "  This wizard stands up YOUR rock's rock box: the control brain that"
mut "  creates and updates your members' AI assistants. Everything runs on accounts"
mut "  YOU own. Your credentials never leave this machine except to your own providers."
echo

# ============================ 1. Your rock ============================
b "1/5  Your rock"
ask ORG_NAME   "Rock handle (short slug, e.g. acme-collab)"
printf '%s' "$ORG_NAME" | grep -Eq '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$' || die "use a DNS-safe slug: lowercase letters/digits/hyphens"
ask OPERATORS  "Operator email(s), comma-separated (who administers the fleet)"
# ONE NAME (2026-08-14, docs/naming.md). This used to ask for a separate persona
# ("What should the rock brain be called", default "Foreman") on top of the
# handle, so a rock ended up with two names and its Overview led with the one
# nobody chose. The rock's assistant is called what the rock is called.
ask ORG_DISPLAY_NAME "Rock name, as people should read it (e.g. Acme CoLab)" "$ORG_NAME"
PERSONA="$ORG_DISPLAY_NAME"
ask DOMAIN     "Your domain (members get <name>.<domain>)"
ask REGION     "Default region for member boxes: hel1 (EU) or sin (APAC)" "hel1"
echo

# ============================ 2. Member features ==============================
b "2/5  What your members' boxes include"
mut "  Every box ships the CORE bundle (second brain, daily/weekly cadence skills,"
mut "  email+calendar connect, dashboard). These are the opt-in extras (a fixed menu,"
mut "  so every fleet stays one product):"
ask FEAT_TELEGRAM "Enable the Telegram + cadence pack for members? (yes/no)" "yes"
ask FEAT_VOICE    "Enable the voice-agent pack? (yes/no)" "no"
ask OUTBOUND      "Outbound policy (propose-confirm = assistant drafts, human sends)" "propose-confirm"
echo

# ============================ 3. Your accounts ================================
b "3/5  Your cloud accounts (you own these; ~15 min if starting from zero)"
mut "  a) Hetzner (runs the machines, ~9 EUR/mo per box):"
mut "     console.hetzner.cloud -> sign up -> New project -> Security -> API tokens ->"
mut "     Generate (Read & Write). Paste it below."
ask HCLOUD_TOKEN "Hetzner API token" "" secret
mut "  b) Cloudflare (your domain, tunnels, access): dash.cloudflare.com -> add your"
mut "     domain -> My Profile -> API Tokens -> Create -> 'Edit zone DNS' template +"
mut "     Account:Cloudflare Tunnel:Edit, scoped to your zone."
ask CF_API_TOKEN "Cloudflare API token" "" secret
mut "  c) GitHub (holds your org's brain + content, private): github.com -> new account"
mut "     or org -> Settings -> Developer settings -> Fine-grained token: repo admin on"
mut "     your org's repos."
ask GITHUB_TOKEN "GitHub token" "" secret
BRAIN_REPO="${AIOS_SETUP_BRAIN_REPO:-}"
if [ -z "$BRAIN_REPO" ] && [ -t 0 ]; then
  read -r -p "  Brain repo (blank = auto: <you>/$ORG_NAME-brain, created + seeded): " BRAIN_REPO
fi
if [ -z "$BRAIN_REPO" ]; then
  GH_BODY="$(mktemp)"
  GH_CODE="$(curl -s -o "$GH_BODY" -w '%{http_code}' -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user || echo 000)"
  if [ "$GH_CODE" != 200 ]; then
    rm -f "$GH_BODY"
    die "GitHub rejected the token while auto-naming your brain repo (HTTP $GH_CODE).
  Common causes: the token was pasted with a stray space or newline; it expired; or a
  fine-grained token whose resource owner is not your account. Re-check step 3c and retry."
  fi
  GH_LOGIN="$(grep '"login"' "$GH_BODY" | head -1 | cut -d'"' -f4)"; rm -f "$GH_BODY"
  [ -n "$GH_LOGIN" ] || die "could not read your GitHub username from the token response"
  BRAIN_REPO="git@github.com:$GH_LOGIN/$ORG_NAME-brain.git"
  ok "brain repo auto-named: $GH_LOGIN/$ORG_NAME-brain"
fi
echo

# ============================ 4. Verify access ================================
b "4/5  Checking your credentials (read-only pings)"
curl -sf -H "Authorization: Bearer $HCLOUD_TOKEN" https://api.hetzner.cloud/v1/locations >/dev/null || die "Hetzner token failed a read ping"
ok "Hetzner token works"
CFV="$(curl -sf -H "Authorization: Bearer $CF_API_TOKEN" "https://api.cloudflare.com/client/v4/zones?name=$DOMAIN")" || die "Cloudflare token failed"
echo "$CFV" | grep -q '"name":"'"$DOMAIN"'"' || die "Cloudflare token works but cannot see zone $DOMAIN (is the domain on this account, token scoped to it?)"
ok "Cloudflare token sees $DOMAIN"
RP="$(printf '%s' "$BRAIN_REPO" | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')"
# Exists-check must be redirect-proof: a renamed repo leaves a 301 stub at the old name that a
# plain GET "sees", but every write (deploy key, push) then fails "Moved Permanently". Compare
# the CANONICAL full_name; a redirect stub counts as missing (creating at the name breaks the
# redirect). And an existing-but-EMPTY repo (a stub from an earlier run) still needs seeding —
# parity with the js engine (2026-07-24 e2e finding: a rock booted with an unclonable brain).
# || true: under set -euo pipefail a 404 (repo does not exist yet, curl -f exits 22) would
# otherwise kill the wizard HERE, silently — making the create-fresh-repo branch below
# unreachable. Found 2026-07-24: every brand-new org stamp died at this line.
RCANON="$(curl -sfL -H "Authorization: Bearer $GITHUB_TOKEN" "https://api.github.com/repos/$RP" 2>/dev/null | grep -o '"full_name": *"[^"]*"' | head -1 | sed 's/.*: *"//; s/"$//' || true)"
NEED_SEED=""
if [ "$(printf '%s' "$RCANON" | tr 'A-Z' 'a-z')" = "$(printf '%s' "$RP" | tr 'A-Z' 'a-z')" ]; then
  HC="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $GITHUB_TOKEN" "https://api.github.com/repos/$RP/commits?per_page=1")"
  if [ "$HC" = "409" ]; then
    mut "  brain repo $RP exists but is EMPTY (a stub from an earlier run); seeding it"
    NEED_SEED=1
  else
    ok "GitHub token sees $RP"
  fi
else
  [ -n "$RCANON" ] && mut "  $RP is a rename redirect to $RCANON; creating a fresh repo at the expected name" \
                   || mut "  brain repo $RP does not exist yet; creating it from the template"
  curl -sf -H "Authorization: Bearer $GITHUB_TOKEN" -H "Content-Type: application/json" \
    -X POST https://api.github.com/user/repos \
    --data "{\"name\":\"${RP#*/}\",\"private\":true,\"description\":\"$ORG_NAME rock brain (created by the setup wizard)\"}" >/dev/null \
    || die "could not create $RP (token needs repo-create permission)"
  NEED_SEED=1
fi
if [ -n "$NEED_SEED" ]; then
  # Seed from the canonical generic template REPO (parity with the js engine;
  # 2026-07-20 e2e finding: the old default, a local ~/ic-brain, silently seeded
  # new orgs with the pre-D42 IC instance). AIOS_TEMPLATE_DIR remains a dev override.
  if [ -n "${AIOS_TEMPLATE_DIR:-}" ]; then
    TDIR="$AIOS_TEMPLATE_DIR"
    [ -d "$TDIR" ] || die "no brain template at $TDIR (unset AIOS_TEMPLATE_DIR to use the template repo)"
  else
    TREPO="${AIOS_TEMPLATE_REPO:-cradsdavis-cell/brain-template}"
    TDIR="$(mktemp -d)/tpl"
    git -c credential.helper='!f(){ echo username=x-access-token; echo password=$GITHUB_TOKEN; };f'       clone -q --depth 1 "https://github.com/$TREPO.git" "$TDIR"       || die "cannot clone template repo $TREPO (set AIOS_TEMPLATE_REPO, or AIOS_TEMPLATE_DIR for a local template)"
  fi
  SW="$(mktemp -d)"; cp -r "$TDIR/." "$SW/"; rm -rf "$SW/.git"
  # Compose the org policy with the SAME builder the js engine uses (2026-07-20
  # e2e finding: seeding the blank template left org.name empty, and a rock
  # with an empty policy cannot stamp members). Answers come from AIOS_SETUP_*
  # env where provided; core identity from the resolved prompts; sane defaults.
  ENGINE="$REPO/wizard/engine.mjs" OUT="$SW/org-policy.yaml" \
  ORG_NAME="$ORG_NAME" ORG_DISPLAY_NAME="${ORG_DISPLAY_NAME:-$ORG_NAME}" \
  DOMAIN="$DOMAIN" PERSONA="${PERSONA:-${ORG_DISPLAY_NAME:-$ORG_NAME}}" REGION="${REGION:-hel1}" \
  OUTBOUND="${OUTBOUND:-propose}" OPERATORS_RESOLVED="${OPERATORS:-}" \
  node --input-type=module -e '
    const {buildOrgPolicyYaml, splitList} = await import(process.env.ENGINE);
    const e = process.env;
    const g = (k, d) => e["AIOS_SETUP_" + k] ?? d;
    const yn = (k, d) => { const v = String(g(k, d)).toLowerCase(); return v.startsWith("y") || v === "true" || v === "1"; };
    const mw = (k, d, m) => { const v = String(g(k, d)).toLowerCase(); return m[v] ?? v; };
    const y = buildOrgPolicyYaml({
      name: e.ORG_NAME, displayName: e.ORG_DISPLAY_NAME, domain: e.DOMAIN, persona: e.PERSONA,
      areasLabel: g("VOCAB_AREAS_LABEL", "Areas"), areas: splitList(g("VOCAB_AREAS", "")),
      expertsLabel: g("VOCAB_EXPERTS_LABEL", "Experts"), experts: [],
      tiers: splitList(g("VOCAB_TIERS", "")),
      pulseEnabled: yn("PULSE_ENABLED", "yes"), pulseName: "Pulse", pulseLanding: "notes/pulse/",
      heartbeats: mw("HEARTBEATS", "minimal", { yes: "minimal", "true": "minimal", no: "off", "false": "off" }),
      region: e.REGION, dropsDirect: yn("DROPS_DIRECT", "yes"),
      accessSsh: yn("ACCESS_SSH", "yes"), accessBrowser: yn("ACCESS_BROWSER", "yes"),
      admins: splitList(g("ROLE_ADMINS", e.OPERATORS_RESOLVED || "")), support: splitList(g("ROLE_SUPPORT", "")),
      contentUpdates: mw("LIFECYCLE_CONTENT", "auto", { yes: "auto", "true": "auto", no: "manual", "false": "manual" }),
      images: mw("LIFECYCLE_IMAGES", "pinned", { yes: "pinned", "true": "pinned", no: "latest", "false": "latest" }),
      leaverDays: String(g("LEAVER_DAYS", "30")),
      outbound: e.OUTBOUND, aiDisclosure: yn("AI_DISCLOSURE", "yes"),
      quietHours: "21:00-06:30", timezone: "Australia/Sydney",
    });
    (await import("node:fs")).writeFileSync(process.env.OUT, y);
  ' || die "could not compose org-policy.yaml"
  if [ -f "$SW/tools/render-identity.mjs" ] && [ -f "$SW/templates/CLAUDE.md.tpl" ]; then
    ( cd "$SW" && node tools/render-identity.mjs --policy org-policy.yaml --tpl templates/CLAUDE.md.tpl --out-dir . ) \
      || die "identity render refused the composed policy"
  fi
  ( cd "$SW" && git init -q && git add -A \
    && git -c user.name="$ORG_NAME setup" -c user.email="setup@local" commit -qm "seed: $ORG_NAME brain (wizard, from template)" \
    && git branch -M main \
    && git -c credential.helper='!f(){ echo username=x-access-token; echo password=$GITHUB_TOKEN; };f' push -q "https://github.com/$RP.git" main )
  rm -rf "$SW"
  ok "brain repo $RP seeded"
fi
echo

# ============================ 5. Stamp ========================================
b "5/5  Standing up your rock box"
WORK="$(mktemp -d)"; chmod 700 "$WORK"
cat > "$WORK/deployment.yaml" <<EOF
deployment_name: $ORG_NAME
operator_emails:
$(printf '%s' "$OPERATORS" | tr ',' '\n' | sed 's/^[[:space:]]*/  - /')
domain: $DOMAIN
brain_repo: $BRAIN_REPO
content_repo: ${AIOS_SETUP_CONTENT_REPO:-}
brain_root: /state/brain
persona_name: $PERSONA
default_region: $REGION
features_telegram: "$FEAT_TELEGRAM"
features_voice: "$FEAT_VOICE"
outbound_policy: "$OUTBOUND"
${AIOS_SETUP_EXTRA_YAML:-}
EOF
ok "deployment.yaml written (staged config; nothing bakes)"
export HCLOUD_TOKEN CF_API_TOKEN GITHUB_TOKEN
# D40: mint the operator's access keypair; the public half provisions onto the box
ssh-keygen -q -t ed25519 -N '' -C "operator-$ORG_NAME" -f "$WORK/access_key"
export OPERATOR_PUBKEY="$(cat "$WORK/access_key.pub")"
AIOS_IMAGE="${AIOS_SETUP_IMAGE:-ghcr.io/cradsdavis-cell/crads-rock:v2}" \
  "$REPO/provisioning/rock/provision-rock.sh" "${AIOS_SETUP_SLUG:-$ORG_NAME}" "$WORK/deployment.yaml"
RC=$?
if [ "$RC" = 0 ]; then
  BOXIP="$(grep -E '^SERVER_IP=' "$REPO/provisioning/managed/state/rock-${AIOS_SETUP_SLUG:-$ORG_NAME}.env" | cut -d'"' -f2)"
  echo "__ACCESS_CONFIG_BEGIN__"
  echo "Host $ORG_NAME-rock"
  echo "  HostName $BOXIP"
  echo "  User aios-op"
  echo "  IdentityFile ~/.ssh/$ORG_NAME-rock.key"
  echo "__ACCESS_CONFIG_END__"
  echo "__ACCESS_KEY_BEGIN__"
  cat "$WORK/access_key"
  echo "__ACCESS_KEY_END__"
fi
rm -rf "$WORK"
exit $RC
