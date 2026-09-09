#!/usr/bin/env bash
# box-up.sh — bring ONE pebble mineral to life (reusable for every pebble). Health-check, start the
# Brain Cockpit (live graph), report what's connected vs pending, then drop the pebble into Claude
# for /onboard. Auth is isolated to the mineral (its own Claude account). Re-runnable.
#
#   engine/box-up.sh <boxDir>
set -euo pipefail
BOX="$(cd "${1:?usage: box-up.sh <boxDir>}" && pwd)"
ENGINE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"        # .../ai-os/engine
PORT="${COCKPIT_PORT:-7780}"
export CLAUDE_CONFIG_DIR="$BOX/.claude-auth"                   # her account, not the operator's
export GH_CONFIG_DIR="$BOX/.kernel/gh"                         # pebble's GitHub auth — persisted, gitignored (.kernel/)

# ---- first-run scaffold (fresh/empty mineral, e.g. a freshly-shipped image volume) ----
# Idempotent: only creates what's missing, so an existing pebble mineral is untouched.
mkdir -p "$BOX/wiki/people" "$BOX/secrets" "$BOX/.claude-auth" "$BOX/.kernel"
[ -f "$BOX/profile.yaml" ]          || cp "$ENGINE/../config/profile.schema.yaml" "$BOX/profile.yaml" 2>/dev/null || true
[ -f "$BOX/onboarding-state.json" ] || node "$ENGINE/onboarding/init-state.mjs" "$BOX" >/dev/null 2>&1 || true
[ -f "$BOX/wiki/priorities.md" ]    || printf '# Priorities — what matters now\n_(populated by /onboard)_\n' > "$BOX/wiki/priorities.md"
node "$ENGINE/appshell/seed-pages.mjs" "$BOX" >/dev/null 2>&1 || true   # L3 app-shell surface + L2 ownership record (idempotent, never overwrites)
# Record WHO holds this mineral (2026-08-12; local-only since the self-host
# strip 2026-09-01). seed-pages writes the holder; mineral-arm upgrades the flat
# record to the nested shape identityFacts() reads, mints the serial and the
# owner grant, and stamps the box's own name. It makes no network call: the
# central directory it once armed a leg for is deleted. Idempotent, honest when
# it cannot act, never fatal to boot.
node "$ENGINE/box/mineral-arm.mjs" "$BOX" || true
# (The anchor-claim, tie-claim and accept-proofs/mirror boot steps went with the
# self-host strip 2026-09-01: all four spoke to the central directory, which is
# deleted. Wiring to a rock is a local act now, and ownership.json needs no
# mirror because there is nothing left to mirror it to.)

# ---- born named (2026-08-14, docs/naming.md) --------------------------------
# The name the person typed at the door rides in on AIOS_BOX_NAME. Write it once,
# only if this mineral has no name yet: a later Rename or a conversational rename
# must never be clobbered by the stale value baked into cloud-init at stamp time.
# name-set.mjs writes BOTH files (box-name + profile.yaml identity.assistant_name),
# so the two can never diverge from birth.
if [ -n "${AIOS_BOX_NAME:-}" ] && [ ! -s "$BOX/box-name" ]; then
  node "$ENGINE/box/name-set.mjs" "$BOX" "$AIOS_BOX_NAME" >/dev/null 2>&1 || true
fi

# ---- one-name migration (2026-08-09, one-shot): the mineral label and the assistant's
#      name collapsed into ONE name. Where a mineral carried both and they diverged, the
#      mineral name (set deliberately via Rename) wins and lands in profile.yaml; from
#      then on box-rename and /onboard write BOTH files, so they stay equal. Marker-
#      gated so a later conversational rename is never clobbered by a stale box-name.
if [ -f "$BOX/box-name" ] && [ ! -f "$BOX/.kernel/name-migrated" ]; then
  BN="$(head -c 60 "$BOX/box-name" 2>/dev/null | tr -d '\n' || true)"
  AN="$(grep -oP 'assistant_name:\s*"\K[^"]+' "$BOX/profile.yaml" 2>/dev/null || true)"
  if [ -n "$BN" ] && [ "$BN" != "$AN" ]; then
    node "$ENGINE/box/name-set.mjs" "$BOX" "$BN" >/dev/null 2>&1 || true
  fi
  touch "$BOX/.kernel/name-migrated" 2>/dev/null || true
fi

# ---- the folder Claude Code opens (R18, 2026-08-23) ---------------------------
# SSH lands every face in the box root, and inside it one entry is named after
# the mineral and points at the brain root (here: the box root itself, so the
# link is `<name> -> .`). The chosen name lands in $BOX/open-folder for the app
# and the Help copy. Idempotent; a real directory of that name is never touched.
node "$ENGINE/lib/open-folder.mjs" "$BOX" >/dev/null 2>&1 || true

# ---- mineral machinery comes from the IMAGE, not from cloud-init ----------------
# These scripts (org-sync, heartbeat-push, org-brain-wire; evict-apply,
# re-anchor-apply and transfer-accept left with the tie machinery on
# 2026-09-09) used to be baked into each member's user-data
# at stamp time, and that cost twice:
#
#   1. THEY FROZE. Nothing rewrites a file written once into user-data, so every
#      machinery fix reached new minerals only. On 2026-08-05 a full day of fixes
#      could not have reached a single mineral that already existed.
#   2. THEY FILLED THE PAYLOAD. Hetzner caps user-data at 32768 B and these are
#      31.5 KB of source; a routine stamp died at 31814 B and NO new member could
#      be created on any rock until this moved.
#
# None of them carries per-member templating, so they are product code and belong
# in the image. Installing on every start is what un-freezes the fleet: a fix
# ships with the nightly auto-update like everything else. Compare-then-copy so
# an unchanged script is not rewritten on every boot.
install_box_scripts() {
  [ -d "$ENGINE/box" ] || return 0
  mkdir -p "$BOX"
  for src in "$ENGINE"/box/*.sh; do
    [ -f "$src" ] || continue
    dst="$BOX/$(basename "$src")"
    if ! cmp -s "$src" "$dst"; then
      cp "$src" "$dst" && chmod +x "$dst"
    fi
  done
}
install_box_scripts

# ---- derive the member door from the roster, every boot ----------------------
# device-sync.mjs is the single writer of <state>/ssh/member/authorized_keys,
# which sshd serves via AuthorizedKeysCommand and which cloud-init has already
# made the ONLY authority for member SSH (61-aios-roster-only.conf). Until the
# self-host strip it was driven by enrol-sync, or by org-sync's own call. Both
# are gone for an org-less box: enrol-sync was deleted 2026-09-01, and org-sync
# exits at "not an org-managed box" many lines before it would reach device-sync.
# So nothing re-derived the door, and a self-hosted box booted healthy with
# member SSH shut (test-mineral-4, 2026-09-01). Boot is the right home for it:
# it is local, idempotent, and belongs to no org.
#
# Never fatal. syncKeys refuses to write an empty door over a non-empty one, so
# the worst case is the door it already had.
if [ -f "$ENGINE/devices/device-sync.mjs" ]; then
  node "$ENGINE/devices/device-sync.mjs" "$BOX" || \
    echo "device-sync failed; leaving the existing door untouched rather than guessing."
fi

# ---- seed the pre-baked Claude Code plugins into a fresh mineral (idempotent; never touches credentials) ----
TEMPLATE="${CLAUDE_PLUGIN_TEMPLATE:-/opt/claude-plugins-template}"
if [ -d "$TEMPLATE/plugins" ] && [ ! -d "$BOX/.claude-auth/plugins" ]; then
  cp -a "$TEMPLATE/plugins" "$BOX/.claude-auth/plugins"
  # the template's plugin state files carry absolute paths (built at /state/.claude-auth);
  # rewrite to THIS mineral's path so plugins resolve wherever the mineral is mounted.
  [ "$BOX/.claude-auth" != "/state/.claude-auth" ] && \
    find "$BOX/.claude-auth/plugins" -name '*.json' -exec sed -i "s#/state/.claude-auth#$BOX/.claude-auth#g" {} + 2>/dev/null || true
  if [ -f "$BOX/.claude-auth/settings.json" ]; then
    node -e 'const fs=require("fs");const d=process.env.D,t=process.env.T;const a=JSON.parse(fs.readFileSync(d+"/settings.json"));const b=JSON.parse(fs.readFileSync(t+"/settings.json"));a.enabledPlugins={...(b.enabledPlugins||{}),...(a.enabledPlugins||{})};a.extraKnownMarketplaces={...(b.extraKnownMarketplaces||{}),...(a.extraKnownMarketplaces||{})};fs.writeFileSync(d+"/settings.json",JSON.stringify(a,null,2));' D="$BOX/.claude-auth" T="$TEMPLATE" 2>/dev/null || true
  else
    cp "$TEMPLATE/settings.json" "$BOX/.claude-auth/settings.json" 2>/dev/null || true
  fi
fi

# ---- make the mineral a versioned git repo (the pebble's "brain") with credentials git-ignored ----
# The brain repo can be pushed to the pebble's OWN remote (model b), so .claude-auth (OAuth token),
# secrets/ (passwords) and .kernel/ (machine state) must NEVER be committed. Write the ignore
# BEFORE the first commit, or commit-on-exit would leak credentials into the pushed history.
# Seeded from engine/lib/brain-ignore.txt, the one file that holds this list
# (2026-08-20 audit). The three entries written here before that omitted .env and
# *.key, and .env is where ORG_PULL_TOKEN lives, so the very first commit this
# script makes below could track a credential that connect-github then pushed.
# APPEND, never overwrite: a member may have added entries of their own.
BRAIN_IGNORE="${AIOS_BRAIN_IGNORE:-$ENGINE/lib/brain-ignore.txt}"
touch "$BOX/.gitignore"
if [ -r "$BRAIN_IGNORE" ]; then
  grep -q 'never version these' "$BOX/.gitignore" 2>/dev/null || \
    printf '%s\n' '# credentials + machine state: never version these (the brain repo may be pushed to a remote)' >> "$BOX/.gitignore"
  while IFS= read -r _pat; do
    [ -n "$_pat" ] || continue
    grep -qxF -- "$_pat" "$BOX/.gitignore" || printf '%s\n' "$_pat" >> "$BOX/.gitignore"
  done < <(sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$BRAIN_IGNORE" | grep -v '^[[:space:]]*$')
else
  # Fail loud rather than seeding an empty ignore: an unprotected first commit is
  # exactly the state this list exists to prevent.
  echo "box-up: WARNING never-commit list unreadable at $BRAIN_IGNORE; seeding the credential floor only" >&2
  for _pat in '.env' '.env.*' 'secrets/' '*.key' '*.pem' '.ssh/' 'ssh/' '.claude-auth/' '.kernel/' '.mcp.json'; do
    grep -qxF -- "$_pat" "$BOX/.gitignore" || printf '%s\n' "$_pat" >> "$BOX/.gitignore"
  done
fi
if [ "$(git -C "$BOX" rev-parse --show-toplevel 2>/dev/null)" != "$BOX" ]; then
  git -C "$BOX" init -q >/dev/null 2>&1 || true
  git -C "$BOX" add -A >/dev/null 2>&1 || true
  git -C "$BOX" -c user.name='AI OS kernel' -c user.email='kernel@ai-os.local' \
      commit -q -m "init: brain scaffold" >/dev/null 2>&1 || true
fi

# ---- device roster: adopt any key installed before the roster existed, then derive
#      the keys file sshd serves. Idempotent, and the ONLY writer of ssh/member/. ----
node "$ENGINE/devices/roster-cli.mjs" "$BOX" adopt >/dev/null 2>&1 || true

# ---- initialise the kernel + sync the engine skills into the mineral so /capture, /daily, /followup,
#      /inbox, /onboard, /weekly are available to the pebble. DRY_RUN = no Claude, no token cost. ----
DRY_RUN=1 node "$ENGINE/kernel/kernel.mjs" "$BOX" --once >/dev/null 2>&1 || true

NAME="$(grep -oP 'user_short:\s*"\K[^"]+' "$BOX/profile.yaml" 2>/dev/null || true)"
ASSIST="$(grep -oP 'assistant_name:\s*"\K[^"]+' "$BOX/profile.yaml" 2>/dev/null || true)"
b(){ printf '\033[1m%s\033[0m\n' "$*"; }; mut(){ printf '\033[2m%s\033[0m\n' "$*"; }
ok(){ printf '  \033[32m✓\033[0m %s\n' "$*"; }; pend(){ printf '  \033[33m•\033[0m %s\n' "$*"; }

clear 2>/dev/null || true
# Before onboarding, profile.yaml has no name yet — avoid the "your's AI OS" grammar glitch.
if [ -n "$NAME" ]; then b "  ${ASSIST:-Your assistant} — ${NAME}'s AI OS"
else b "  ${ASSIST:-Your AI OS}"; fi
mut "  box: $BOX"
echo

# ---- health ----
b "Checking your mineral…"
[ "$(git -C "$BOX" rev-parse --show-toplevel 2>/dev/null)" = "$BOX" ] && ok "brain repo ready" || pend "brain repo missing"
[ -f "$BOX/profile.yaml" ] && ok "profile loaded" || pend "profile missing"
# `layers` since the 8-layer rewrite of /onboard, `modules` on older brains. Reading
# only the old key made every current mineral report "(0 modules)" on every boot.
MODS=$(node -e "try{const o=require('$BOX/onboarding-state.json');console.log(Object.keys(o.layers||o.modules||{}).length)}catch(e){console.log(0)}")
ok "onboarding interview scaffolded ($MODS layers)"
command -v claude >/dev/null && ok "Claude Code installed" || pend "Claude Code not found"
# Account-aware, but NEVER fatal (Sam, 2026-07-30: "we should be able to use any
# account, a user might want to change accounts").
#
# This used to `exit 1` on the operator account. box-up.sh is the container's
# entrypoint, so that exit killed the container, systemd restarted it five seconds
# later under Restart=always, and it failed again. brain-2 did that 106 times on
# 2026-07-30. The only SSH door into a mineral runs THROUGH this container, so the mineral
# locked everyone out of itself, including the remedy this very block printed, and
# recovery needed Hetzner rescue mode. It also only ran at boot, so the brick landed
# hours after the sign-in that caused it and looked identical to a deleted container.
#
# The leak this guarded against is real, and it is still caught, by SHOWING which
# account is signed in here and in the app's Connections row. Visibility catches a
# wrong account; killing the machine just hides it behind a mineral nobody can reach.
#
# Note the old `|| echo NOT-SIGNED-IN`: box-account exits 3 on the operator account,
# so the echo APPENDED to the real output and ACCT became two lines, which is why the
# fatal message read "OPERATOR (<operator-email> NOT-SIGNED-IN)".
ACCT="$(node "$ENGINE/ops/box-account.mjs" "$BOX" 2>/dev/null)" || true
[ -n "$ACCT" ] || ACCT=NOT-SIGNED-IN
case "$ACCT" in
  OK:*)        ok "signed in as ${ACCT#OK:}"; SIGNED=1 ;;
  OPERATOR:*)  pend "signed in as ${ACCT#OPERATOR:} (the Crads AI operator account). Expected on a test mineral; on a pebble's mineral, sign in as them."; SIGNED=1 ;;
  UNKNOWN)     pend "signed in (account unverified)"; SIGNED=1 ;;
  *)           pend "not signed in yet: run  claude  here and sign in"; SIGNED=0 ;;
esac
if [ -s "$BOX/secrets/telegram_bot_token" ] && [ -s "$BOX/secrets/telegram_chat_id" ]; then ok "Telegram connected"; else pend "Telegram — run  connect-telegram  to talk to it from your phone"; fi
echo

# ---- cockpit (background — the live brain-graph dashboard) ----
node "$ENGINE/cockpit/box-cockpit.mjs" "$BOX" >/dev/null 2>&1 || true
node "$ENGINE/cockpit/serve-cockpit.mjs" "$BOX" "$PORT" >"$BOX/.kernel/cockpit.log" 2>&1 &
SVPID=$!

# ---- comms: kernel daemon + Telegram bridge — only if the pebble connected Telegram ----
bash "$ENGINE/start-comms.sh" "$BOX" 2>/dev/null || true

# ---- browser VS Code (code-server) — legacy interface, off on minerals stamped after 2026-08-05 ----
# Sam's ruling 2026-08-05: the way into a mineral is the Crads-AI app and Claude Code over SSH.
# A browser door on a public hostname guarded by ONE shared 24-char password, with no MFA, no
# rotation verb and no lockout, was a second way in that nobody is meant to use, and it granted a
# container terminal to whoever held that one string.
#
# The flag DEFAULTS TO ON when absent, and that direction is deliberate. This script ships in the
# image, so every existing mineral runs the new copy the moment it takes a :v2 update. Old-era pebble
# minerals reach their mineral through exactly this door and are hands-off per Sam's
# 2026-07-28 ruling, so a default-off would have cut a live pebble's access from an image bump they
# never asked for. New provisioning stages BROWSER_IDE=off explicitly; a mineral that has never heard
# of the flag keeps working exactly as it did.
IDE_PORT="${IDE_PORT:-7781}"
CSPID=""; CS_PW=""
if [ "${BROWSER_IDE:-on}" = "off" ]; then
  mut "browser IDE off (app-first): reach this mineral with the Crads-AI app or Claude Code over SSH"
elif command -v code-server >/dev/null 2>&1; then
  PWF="$BOX/secrets/code-server-password"   # stable per-box password (gitignored), persisted across restarts
  # First boot: honour a provisioner-supplied PASSWORD (managed provisioning sets a known one so it
  # can hand it to the pebble) — otherwise generate a random one. Persisted either way.
  if [ ! -f "$PWF" ]; then
    if [ -n "${PASSWORD:-}" ]; then printf '%s' "$PASSWORD" > "$PWF"
    else head -c 18 /dev/urandom | base64 | tr -d '/+=' > "$PWF"; fi
    chmod 600 "$PWF"
  fi
  CS_PW="$(cat "$PWF")"
  # The container runs as an arbitrary host uid with no home dir, so code-server can't write its
  # config to ~/.config. Give it a writable HOME + user-data-dir inside the mineral (.kernel = gitignored).
  CS_HOME="$BOX/.kernel/cs-home"; mkdir -p "$CS_HOME"
  # Seed sane VS Code defaults so the mineral opens TRUSTED (Workspace Trust off → extensions fully
  # active, no "do you trust this folder?" dialog, no Restricted Mode) and skips the Welcome tab.
  # It's the pebble's own brain, so trusting it is correct. The pebble can change these later.
  CS_USER_DIR="$BOX/.kernel/cs-data/User"; mkdir -p "$CS_USER_DIR"
  [ -f "$CS_USER_DIR/settings.json" ] || printf '%s\n' '{' \
    '  "security.workspace.trust.enabled": false,' \
    '  "workbench.startupEditor": "none",' \
    '  "telemetry.telemetryLevel": "off"' \
    '}' > "$CS_USER_DIR/settings.json"
  HOME="$CS_HOME" PASSWORD="$CS_PW" code-server \
    --bind-addr "0.0.0.0:$IDE_PORT" --auth password \
    --user-data-dir "$BOX/.kernel/cs-data" \
    --extensions-dir "${CODE_SERVER_EXTENSIONS_DIR:-/opt/vscode-extensions}" \
    --disable-telemetry --disable-update-check \
    "$BOX" >"$BOX/.kernel/code-server.log" 2>&1 &
  CSPID=$!
fi

# commit-on-exit: the browser session = the container's lifetime, so persist the brain when it stops.
commit_brain(){
  if [ -n "$(git -C "$BOX" status --porcelain 2>/dev/null)" ]; then
    git -C "$BOX" add -A
    git -C "$BOX" -c user.name='AI OS kernel' -c user.email='kernel@ai-os.local' \
        commit -q -m "session $(date +%Y-%m-%d): brain update" 2>/dev/null || true
  fi
  # offsite backup: push to the pebble's OWN remote, if they connected one via `connect-github`.
  git -C "$BOX" remote get-url origin >/dev/null 2>&1 && \
    git -C "$BOX" push -q origin HEAD 2>/dev/null || true
}
# ---- optional per-box cadence (OFF by default — opt-in via profile.cadence.enabled: true) ----
# Each scheduled job shells `claude -p` on the PEBBLE's own subscription (spends their tokens), so
# it stays off until explicitly enabled. Jobs DRAFT, never auto-send (engine default-deny outbound).
CADENCE_LIVE=0
CAD_ON="$(node -e 'try{const y=require("fs").readFileSync(process.argv[1],"utf8");const m=y.split(/\ncadence:/)[1]||"";process.stdout.write(/^\s*enabled:\s*true/m.test(m)?"1":"0")}catch(e){process.stdout.write("0")}' "$BOX/profile.yaml" 2>/dev/null || echo 0)"
# The scheduler ALWAYS runs (D49 + D51): with profile cadence off it still fires the base jobs —
# the hourly heartbeat (the stall board's churn signal) and the ~2-min org-sync that completes a
# member's invite enrolment on an idle, never-logged-into mineral. Skill cadence stays gated inside
# scheduler.mjs on profile.cadence.enabled. Replaces the old crontab path (`command -v cron` was
# invisible on the mineral user's PATH, so the crontab never installed and cadence silently never ran).
node "$ENGINE/cron/scheduler.mjs" "$BOX" >"$BOX/.kernel/cadence.log" 2>&1 &
SCHEDPID=$!
[ "$CAD_ON" = "1" ] && CADENCE_LIVE=1

cleanup(){ commit_brain; kill "$SVPID" ${CSPID:+"$CSPID"} ${SCHEDPID:+"$SCHEDPID"} 2>/dev/null || true
  for pf in "$BOX"/.kernel/kernel.pid "$BOX"/.kernel/telegram.pid; do [ -f "$pf" ] && kill "$(cat "$pf" 2>/dev/null)" 2>/dev/null; rm -f "$pf"; done
  rm -f "$BOX/.kernel/human-lock" 2>/dev/null || true; }
trap cleanup EXIT
# No cadence → hold the human-lock for the session. Safe alongside the always-on scheduler: the
# base jobs (heartbeat/org-sync/backup) exec directly and never touch the kernel, so the lock only
# gates skill drains. WITH cadence on an always-on mineral the lock would block scheduled jobs forever,
# so let them run (and clear any stale lock from a previous no-cadence boot).
if [ "$CADENCE_LIVE" = 1 ]; then
  rm -f "$BOX/.kernel/human-lock" 2>/dev/null || true
else
  : > "$BOX/.kernel/human-lock"
fi
sleep 1

# ---- banner ----
echo
if [ -n "$CSPID" ]; then
  b "Your workspace is live — full VS Code in your browser:"
  printf '  \033[36mhttp://localhost:%s\033[0m\n' "$IDE_PORT"
  printf '  password: \033[1m%s\033[0m  ' "$CS_PW"; mut "(your browser will remember it)"
  echo
  b "Your Brain Cockpit (the live brain graph):"
  printf '  \033[36mhttp://localhost:%s/\033[0m  ' "$IDE_PORT/proxy/$PORT"; mut "(same login; the live map of your brain)"
  echo
  if [ "$SIGNED" = 0 ]; then
    b "In VS Code: open a Terminal, sign into YOUR Claude account, then type  /onboard"
    mut "  The Claude panel + plugins are already installed — only the login is yours to do."
  else
    b "In VS Code: open a Terminal and type  /onboard  to start (or resume)."
  fi
  echo
  mut "  Back up to your own GitHub (optional):  press Connect GitHub in the app, or run  connect-github  here."
  mut "  Talk to it from your phone (optional):   run  connect-telegram  in a Terminal."
  [ "$CADENCE_LIVE" = 1 ] && mut "  Cadence: ON — scheduled jobs are running (they draft, never auto-send)." \
                          || mut "  Cadence: off (enable per profile.cadence.enabled to schedule jobs)."
  echo; mut "  Leave this running; stop the mineral when you're done. Your brain auto-saves."
  wait "$CSPID"
elif [ "${BROWSER_IDE:-on}" = "off" ]; then
  # App-first box: no browser IDE, so THIS script must still block forever.
  #
  # box-up.sh is the container entrypoint and the unit is Restart=always, so an exit
  # here is not "the session ended", it is a restart loop. The old shape tied the
  # container's life to code-server (`wait "$CSPID"`), and the fallback below runs
  # `claude` interactively, which on a headless mineral returns at once. Either would have
  # bricked every app-first mineral the same way brain-2 bricked on 2026-07-30: the only SSH
  # door runs THROUGH this container, so a mineral that cannot stay up cannot be reached to
  # be fixed, and recovery needed Hetzner rescue mode.
  #
  # Nothing is in the foreground now by design, so hold it open explicitly. Background
  # services (cockpit, scheduler, comms) keep running; the EXIT trap still commits the
  # brain on `docker stop`.
  b "This mineral is app-first. Open it with the Crads-AI app, or Claude Code over SSH."
  mut "  There is no browser login and no password: your device key is the way in."
  [ "$SIGNED" = 0 ] && mut "  Not signed in yet: open a terminal here and run  claude" || true
  [ "$CADENCE_LIVE" = 1 ] && mut "  Cadence: ON (jobs draft, never auto-send)." \
                          || mut "  Cadence: off (enable per profile.cadence.enabled)."
  echo; mut "  Leave this running; stop the mineral when you're done. Your brain auto-saves."
  sleep infinity
else
  # fallback (host-native, no code-server): terminal Claude as before
  b "Your Brain Cockpit:"; printf '  \033[36mhttp://localhost:%s\033[0m\n' "$PORT"; echo
  if [ "$SIGNED" = 0 ]; then b "Sign into your Claude account when prompted, then type  /onboard"
  else b "Type  /onboard  to start (or resume)."; fi
  echo; cd "$BOX"; claude || true
fi
