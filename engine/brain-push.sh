#!/usr/bin/env bash
# brain-push.sh — push the member's brain to THEIR OWN private repo, unattended.
#
#   bash engine/brain-push.sh [state-dir]      (cadence: scheduler fires it at 03:50)
#
# WHY THIS EXISTS (Sam's ruling 2026-07-30). The brain repo has always been the
# member's backup, and own-brain (D58 P3) wires it to their own private GitHub. But
# the only thing that ever pushed it was the Crads-AI app on open (brain-push.mjs:
# "a box that is never opened simply syncs next time it is"). So the backup was only
# as fresh as the last time someone opened an app.
#
# That also silently defeated engine/backup.mjs, which every night encrypts exactly
# the things that die with the VM (the client's Claude OAuth, secrets/, .kernel/gh,
# .mcp.json) and writes the blob into <state>/backups/ *specifically so it rides the
# brain-repo push*. Unpushed, the backup of what-dies-with-the-VM died with the VM.
# This closes that: 03:40 makes the snapshot, 03:50 sends it off the box.
#
# SAFETY: this pushes to a member's own GitHub with nobody watching, so it REFUSES
# unless the protective .gitignore is intact. own-brain writes a superset ignore
# before it ever runs `git add`, but a repo wired by some older path, or an ignore
# a member edited, must not be discovered by leaking a credential to GitHub. Missing
# guard means no push, and the reason lands in the heartbeat rather than in silence.
set -uo pipefail
STATE="${1:-${STATE_DIR:-/state}}"
BR="$STATE/brain"; [ -d "$BR" ] || BR="$STATE"
LOG="$STATE/cockpit/brain-push.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG" 2>/dev/null || true; }

cd "$BR" 2>/dev/null || { say "no brain dir at $BR"; exit 0; }
git rev-parse --git-dir >/dev/null 2>&1 || { say "not a git repo: $BR"; exit 0; }

# Not owned yet (own-brain never ran) is not a failure: there is nowhere to push.
REMOTE="$(git remote get-url origin 2>/dev/null || true)"
[ -n "$REMOTE" ] || { say "no origin remote: brain not connected to a repo yet"; exit 0; }

# The guard. The required set used to be four entries written out here, and
# connect-github.sh, box-up.sh, kernel.mjs, own-brain.mjs and org-brain-wire.sh
# each carried a different one. On 2026-08-20 the two that run on EVERY box (the
# kernel and box-up) turned out to omit .env and *.key entirely, which is where
# ORG_PULL_TOKEN lives, so the list now comes from ONE file that all of them
# read. Only the block above its second header is a refusal reason: widening
# that block turns off nightly backups on every box whose ignore file predates
# the widening, so new entries go below it. See engine/lib/brain-ignore.txt.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IGNORE_LIST="${AIOS_BRAIN_IGNORE:-$HERE/lib/brain-ignore.txt}"
brain_ignores()  { sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$IGNORE_LIST" | grep -v '^[[:space:]]*$' || true; }
brain_required() { awk '/^# --- repaired/{exit} !/^#/ && NF {print}' "$IGNORE_LIST"; }
if [ ! -r "$IGNORE_LIST" ]; then
  # Fail closed. This job is the one that carries data off the box, and without
  # the list it cannot show that a credential would stay on it.
  say "REFUSED: cannot read the never-commit list at $IGNORE_LIST"
  exit 1
fi
MISSING=""
while IFS= read -r pat; do
  grep -qxF -- "$pat" .gitignore 2>/dev/null || grep -qxF -- "$pat/" .gitignore 2>/dev/null || MISSING="$MISSING $pat"
done < <(brain_required)
if [ -n "$MISSING" ]; then
  say "REFUSED: .gitignore is missing protective entries:$MISSING (run own-brain again to restore it)"
  # A refusal is a FAILURE, not a quiet success. The scheduler classifies this
  # job purely by exit code, so exiting 0 wrote status:"ok" into the run ledger
  # and the member's Cadence row read "last: ok" for a backup that refused to
  # run. This is the one job that carries data off the box.
  exit 1
fi

# Belt and braces: gitignore cannot untrack. If any of these ever got committed,
# shed them from the index before pushing rather than pushing them again.
# Derived from the same list, never spelled out a second time: strip a trailing
# slash and every entry is a valid pathspec, and --ignore-unmatch swallows the
# ones this box does not have.
while IFS= read -r p; do
  p="${p%/}"
  git ls-files --error-unmatch -- "$p" >/dev/null 2>&1 && git rm -r --cached -q --ignore-unmatch -- "$p" && say "untracked $p"
done < <(brain_ignores)

git add -A
if git diff --cached --quiet 2>/dev/null; then
  say "nothing to commit; checking for unpushed commits"
else
  git -c user.name=box -c user.email=box@local commit -q -m "sync: nightly backup $(date -u +%Y-%m-%d)" || true
fi

# A branch with no upstream makes a bare `git push` fail ("no upstream branch"),
# which is exactly the state a freshly wired repo can be in. Set it on the way
# rather than failing every night until a human notices. Found by test, 2026-07-30.
if git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
  OUT="$(git push -q 2>&1)"; RC=$?
else
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
  OUT="$(git push -q -u origin "$BRANCH" 2>&1)"; RC=$?
  [ $RC -eq 0 ] && say "set upstream to origin/$BRANCH"
fi
if [ $RC -eq 0 ]; then say "pushed to ${REMOTE%%\?*}"; else say "push failed: $(printf '%s' "$OUT" | tail -1)"; fi
# Same reason as the refusal above: a failed push must reach the run ledger as a
# failure. The earlier exits stay 0 on purpose — "no brain dir", "not a git
# repo" and "no origin remote" all mean own-brain has not run yet, so there is
# nowhere to push and nothing has gone wrong.
exit $RC
