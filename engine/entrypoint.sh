#!/usr/bin/env bash
# AI OS container entrypoint — dispatches the instance's mode.
# All state (incl. the Claude subscription auth at /state/.claude-auth) is the
# mounted volume, so it persists across container runs (decisions D2 + D7).
set -euo pipefail
mkdir -p "${CLAUDE_CONFIG_DIR:-/state/.claude-auth}"

# Only the infrastructure resets (Sam's ruling 2026-11-03, trap 82). The container
# is recreated on every start, so anything outside /state is the image again: the
# member's home folder, the tools their assistant installed, temp and working
# files. A member lost a day to that. So the home folder, temp files and the
# member's own install folder live on /state, under .kernel/ (never committed to
# the brain, never in the off-box snapshot). An adopted box already passes
# HOME=/state/.kernel/home; anything else outside /state is moved here.
case "${HOME:-/}" in /state/*) ;; *) export HOME=/state/.kernel/home ;; esac
export TMPDIR="${TMPDIR:-/state/.kernel/tmp}"
case "$TMPDIR" in /state/*) ;; *) export TMPDIR=/state/.kernel/tmp ;; esac
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-$HOME/.local}"
export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$HOME/.local/bin" "$TMPDIR" 2>/dev/null || true
KERNEL=/app/engine/kernel/kernel.mjs
ENQUEUE=/app/engine/kernel/enqueue.mjs

cmd="${1:-help}"; shift || true
case "$cmd" in
  up|onboard) export COCKPIT_HOST=0.0.0.0; exec /app/engine/box-up.sh /state ;;   # THE one command: health-check + cockpit + /onboard, commit-on-exit (cockpit reachable via -p)
  login)    exec claude ;;                              # interactive, once per instance
  run-once) exec node "$KERNEL" /state --once "$@" ;;   # drain queue + exit (cron-friendly)
  kernel)   exec node "$KERNEL" /state "$@" ;;          # long-running daemon
  telegram) exec node /app/engine/comms/telegram.mjs /state ;;   # secondary channel
  enqueue)  exec node "$ENQUEUE" /state "$@" ;;
  claude)   exec claude "$@" ;;
  shell)    exec bash ;;
  help|*)
    echo "AI OS instance. Commands:"
    echo "  up                           THE one command: cockpit + onboarding interview (start here)"
    echo "  login                        interactive Claude subscription login (once)"
    echo "  enqueue <skill> [jsonargs]   queue a job"
    echo "  run-once [--dry-run]         drain the queue once"
    echo "  kernel                       run the kernel daemon"
    echo "  telegram                     run the Telegram adapter (secondary channel)"
    echo "  claude <args> | shell"
    ;;
esac
