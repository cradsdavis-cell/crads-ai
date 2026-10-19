#!/usr/bin/env bash
# start-comms.sh — idempotently start Remote Control (always, unless switched off; see below) and
# the kernel daemon + Telegram bridge, the last two ONLY if the client has connected Telegram (token +
# chat id present). Called by box-up at session start, by the scheduler every two minutes, and by
# connect-telegram right after linking, so Telegram goes live without a restart.
#
# The kernel daemon drains the queue (runs the `message` skill on the client's own Claude auth →
# writes a draft reply to the outbox); the bridge long-polls Telegram and flushes those replies
# with Approve/Deny. No open ports.
set -euo pipefail
BOX="$(cd "${1:?usage: start-comms.sh <box>}" && pwd)"
ENGINE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export CLAUDE_CONFIG_DIR="$BOX/.claude-auth"

# ---- move-in mode (spec 2026-10-17-adopt-existing-server.md § 2) --------------
# An adopted brain whose own host programs still run it: start NOTHING, not
# Remote Control, not the kernel daemon, not the Telegram bridge (the host's own
# bot reader may still be polling the same bot, and two readers steal each
# other's messages). /move-in clears the flag; the scheduler re-runs this every
# two minutes, so comms come up on their own once it is cleared. Same line as in
# box-up.sh and the same test as isMovingIn() in engine/lib/mineral-identity.mjs
# (pinned by engine/move-in-mode.test.mjs).
is_moving_in() { grep -Eq '"moving_in"[[:space:]]*:[[:space:]]*true([^A-Za-z0-9_]|$)' "$1/ownership.json" 2>/dev/null; }
is_moving_in "$BOX" && exit 0

# ---- Remote Control: the assistant from the Claude app on the member's phone ----
# ON BY DEFAULT (Sam, 2026-10-14), off only by secrets/remote_control_disabled (the
# app's Phone card). Spec: docs/superpowers/specs/2026-10-14-remote-control-design.md.
# It sits ABOVE the Telegram gate below, which exits early on a box with no Telegram:
# most members never connect Telegram and must still get their phone.
# Supervision is the same as the bridge's: box-up runs this at every start and the
# scheduler re-runs it every two minutes, so a crash, an "Update and restart", a
# reboot or the ~10-minute network-loss exit all come back on their own.
# `seed` pre-answers the two first-run questions (trust the folder, enable it) in
# .claude-auth/.claude.json; with no TTY Claude Code would otherwise exit
# "Workspace not trusted". stdin is /dev/null, so a question that ever comes back
# ends the launch instead of hanging it, and the status probe reports it.
# setsid makes the server the leader of its own process group, so switching it off
# also stops the phone sessions it spawned.
RC="$ENGINE/comms/remote-control.mjs"
RC_PID="$BOX/.kernel/remote-control.pid"
# Alive means a `claude remote-control` is really running, not that the pidfile names
# a live pid: the pidfile lives on /state and survives a container restart, where pid
# numbers start over, so a stale file can name an unrelated process and silently skip
# the launch; and a server the pidfile lost is adopted, not duplicated (Claude Code
# refuses a second one for the same folder). Both found in the 2026-10-15 live cert.
# The kernel/telegram `alive` below has the stale-pid exposure too; left alone here.
rc_alive(){ node "$RC" "$BOX" alive 2>/dev/null; }
if command -v claude >/dev/null 2>&1 && node "$RC" "$BOX" should-run 2>/dev/null; then
  if ! rc_alive; then
    mkdir -p "$BOX/.kernel"
    node "$RC" "$BOX" seed >/dev/null 2>&1 || true
    RC_DIR="$(node "$RC" "$BOX" folder 2>/dev/null || echo "$BOX")"
    RC_NAME="$(node "$RC" "$BOX" name 2>/dev/null || echo "Crads assistant")"
    SETSID=""; command -v setsid >/dev/null 2>&1 && SETSID="setsid"
    ( cd "$RC_DIR" && exec $SETSID nohup claude remote-control --name "$RC_NAME" --spawn same-dir --capacity 4 \
        </dev/null >"$BOX/.kernel/remote-control.log" 2>&1 ) &
    echo $! > "$RC_PID"
  fi
elif rc_alive; then
  node "$RC" "$BOX" stop >/dev/null 2>&1 || true   # switched off, or signed out: no stale server
fi

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
launch(){ # name  script  [args...]
  local name="$1" script="$2"; shift 2
  local pf="$BOX/.kernel/$name.pid"
  alive "$pf" && return 0
  nohup node "$script" "$BOX" "$@" >"$BOX/.kernel/$name.log" 2>&1 &
  echo $! > "$pf"
}
stop(){ local pf="$BOX/.kernel/$1.pid"; if alive "$pf"; then kill "$(cat "$pf")" 2>/dev/null || true; fi; rm -f "$pf"; }
launch kernel   "$ENGINE/kernel/kernel.mjs"      # daemon: drains message + cadence jobs
# WHO READS THE BOT (adopt spec 2026-10-17 § Telegram). A move-in that carries an
# existing bot over writes `host` into .kernel/telegram-reader (engine/move-in):
# the person's own program on the server keeps answering it, and only one program
# can read a bot's messages (two long-polls steal each other's). So while the
# marker says host, the bridge is not started, and one already running is stopped
# (this runs at every start and every two minutes, so a marker written mid-life
# takes effect within two minutes). The Telegram cutover step removes the marker,
# and the next pass starts Crads-AI's reader.
# SENDING still works in that state (rehearsal T4 finding 6): replies and delivered
# job results reach Telegram only through telegram.mjs's outbox flush, so the same
# file runs as `--send-only`, which drains the outbox and never calls getUpdates.
# Move-in mode starts neither (the gate at the top of this file exits first).
if grep -qx 'host' "$BOX/.kernel/telegram-reader" 2>/dev/null; then
  stop telegram
  launch telegram-send "$ENGINE/comms/telegram.mjs" --send-only   # sender only: never reads the bot
  exit 0
fi
stop telegram-send                                 # one sender: the reader flushes the outbox itself
launch telegram "$ENGINE/comms/telegram.mjs"     # bridge: long-poll + flush replies
