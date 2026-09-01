#!/usr/bin/env bash
# start-comms.sh — idempotently start the kernel daemon + Telegram bridge for a box, but ONLY if
# the client has connected Telegram (token + chat id present). Called by box-up at session start
# and by connect-telegram right after linking, so Telegram goes live without a restart.
#
# The kernel daemon drains the queue (runs the `message` skill on the client's own Claude auth →
# writes a draft reply to the outbox); the bridge long-polls Telegram and flushes those replies
# with Approve/Deny. No open ports.
set -euo pipefail
BOX="$(cd "${1:?usage: start-comms.sh <box>}" && pwd)"
ENGINE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export CLAUDE_CONFIG_DIR="$BOX/.claude-auth"

# BOOT RECONCILIATION. A token revoked on this box must not come back, whatever put
# it there: a hand restore from a snapshot (docs/box-restore-runbook.md is a manual
# openssl-and-untar, there is no restore code to hook), or any other stale copy.
# box-up.sh:224 calls this on every boot, so this is the one gate every route back
# in has to pass. Uses the same check-revoked verb the connect paths call, so the
# three surfaces cannot disagree about what counts as revoked.
#
# FAILS CLOSED, but not the same way the connect gate does. Connect refuses a
# fresh paste; nothing has been written yet, so refusing costs the person one
# retry. Here the credentials already exist and are what the box is running on,
# so a crash or empty output from the check (node missing, the script throwing)
# is treated as "cannot confirm", not as "clean" and not as "revoked": deleting a
# working credential on a guess would strand a member over a transient fault, so
# the safe move is to leave the files alone and start nothing that depends on
# them this boot, and let the next boot's reconciliation try again.
if [ -s "$BOX/secrets/telegram_bot_token" ] && [ -s "$BOX/secrets/telegram_revoked" ]; then
  CHECK_OUT="$(base64 -w0 < "$BOX/secrets/telegram_bot_token" \
    | node "$ENGINE/comms/telegram-link.mjs" "$BOX" check-revoked 2>/dev/null)" || CHECK_OUT=""
  case "$CHECK_OUT" in
    *'"revoked":true'*)
      rm -f "$BOX/secrets/telegram_bot_token" "$BOX/secrets/telegram_chat_id"
      ;;
    *'"revoked":false'*)
      ;;
    *)
      exit 0   # indeterminate: leave the credentials in place, start nothing this boot
      ;;
  esac
fi

# Telegram not connected → nothing to start.
[ -s "$BOX/secrets/telegram_bot_token" ] && [ -s "$BOX/secrets/telegram_chat_id" ] || exit 0
mkdir -p "$BOX/.kernel"

alive(){ local pf="$1"; [ -f "$pf" ] && kill -0 "$(cat "$pf" 2>/dev/null)" 2>/dev/null; }
launch(){ # name  script
  local pf="$BOX/.kernel/$1.pid"
  alive "$pf" && return 0
  nohup node "$2" "$BOX" >"$BOX/.kernel/$1.log" 2>&1 &
  echo $! > "$pf"
}
launch kernel   "$ENGINE/kernel/kernel.mjs"      # daemon: drains message + cadence jobs
launch telegram "$ENGINE/comms/telegram.mjs"     # bridge: long-poll + flush replies
