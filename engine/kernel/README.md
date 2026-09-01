# Kernel — the per-instance single writer

Implements decisions **D9** (concurrency/persistence) for one client instance. The kernel is the **only process that commits** to the client's git-backed state. Every interface (Telegram, cron, dashboard) *enqueues a job*; the kernel drains the queue serially and commits each result. Concurrency at the edges, serialisation at the write — see [`../../docs/concurrency.md`](../../docs/concurrency.md).

## Run

```bash
# enqueue a job (what the Telegram / cron adapters do under the hood)
node enqueue.mjs <state-dir> daily '{}' --source=cron

# drain once and exit (cron-friendly + used by tests)
node kernel.mjs <state-dir> --once --dry-run

# run as a daemon (polls; needed for live Telegram concurrency)
node kernel.mjs <state-dir>
```

`--dry-run` makes the runner produce deterministic output instead of invoking Claude Code — so the spine is testable with no auth and no subscription usage. Drop it to go live.

## How it works

1. `ensureDirs` + `ensureRepo` + `.gitignore` (ignores `.kernel/`, `secrets/`, `.claude-auth/`).
2. **Lock:** defer if `human-lock` exists (operator editing in VS Code); else take the kernel lock (stale-pid aware).
3. **Drain FIFO:** for each job → `runSkill` → `commitAll` → move to `done/` (failures → `failed/`).
4. **Sync:** if anything committed, `pull --rebase` → `push` with retry (skipped until a GitHub remote is wired).
5. Release lock. (Daemon mode loops on `KERNEL_POLL_MS`.)

## Runtime (decisions D2)

LIVE jobs shell out to **Claude Code headless** (`claude -p`) in the state dir, authed with the **client's own Claude subscription** via an isolated `CLAUDE_CONFIG_DIR=<state>/.claude-auth`. Not the Agent SDK, not pay-as-you-go. *(ToS of automated subscription use is being verified — see D2.)*

## Durability / idempotency

- Jobs are files; enqueue is atomic (temp + rename); the queue survives restarts.
- A crash loses at most the in-flight job; the rest replay.
- Job id in the commit message; `done/` + `failed/` are the audit trail.

## Not yet built

- Real `claude -p` wiring exercised end-to-end (currently dry-run tested).
- Interface adapters (Telegram/cron/dashboard) that call `enqueue`.
- Operator-branch merge strategy (v0 uses lock-and-defer).
