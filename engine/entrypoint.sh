#!/usr/bin/env bash
# AI OS container entrypoint — dispatches the instance's mode.
# All state (incl. the Claude subscription auth at /state/.claude-auth) is the
# mounted volume, so it persists across container runs (decisions D2 + D7).
set -euo pipefail
mkdir -p "${CLAUDE_CONFIG_DIR:-/state/.claude-auth}"
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
