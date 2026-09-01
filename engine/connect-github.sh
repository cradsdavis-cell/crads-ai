#!/usr/bin/env bash
# connect-github — back your brain up to YOUR OWN private GitHub repo.
#
# One-time: authorizes your GitHub (a one-time code you approve in your browser),
# creates a PRIVATE repo from your box, and pushes. After this, every session
# pushes there automatically. Your data, your account — if the VM ever dies, your
# whole brain is safe in a repo only you own.
#
#   connect-github            # creates a repo named 'ai-os-brain'
#   connect-github my-brain   # custom repo name
set -euo pipefail

# $0 is /usr/local/bin/connect-github, a symlink into /app/engine (both
# Dockerfiles), so resolve it before looking for a sibling. HOISTED to the top
# 2026-08-20: it used to be computed inside the sign-in branch, and the guard
# below needs it on every path, including the ones that skip sign-in.
HERE="$(dirname "$(readlink -f "$0")")"
IGNORE_LIST="${AIOS_BRAIN_IGNORE:-$HERE/lib/brain-ignore.txt}"

# WHICH DIRECTORY IS THE BRAIN. On a ROCK it is /state/brain (org-policy.yaml
# marks it); on a member box it is /state. Since 2026-08-09 a self-serve rock's
# brain is born with no remote, so this script is the only way it ever gets an
# offsite copy.
#
# THE BUG THIS REPLACES (2026-08-10, found by Sam running it on test-org-4): the
# rock branch was guarded by `[ -z "${STATE_DIR:-}" ]` with the note "STATE_DIR
# still wins". STATE_DIR is exported on every box, and on a rock it is /state, so
# the guard was never false and the rock branch was dead code. connect-github
# therefore ran against /state, which is not a git repository, and the failure
# it produced told the owner to `git init` the wrong directory.
#
# So the marker decides, and STATE_DIR only wins when it points at something that
# is actually a brain. An explicit AIOS_BRAIN_ROOT beats both (it is what the
# panel resolves from deployment.yaml, for a box whose brain has been relocated).
if [ -n "${AIOS_BRAIN_ROOT:-}" ]; then
  BOX="$AIOS_BRAIN_ROOT"
elif [ -n "${STATE_DIR:-}" ] && [ -f "$STATE_DIR/org-policy.yaml" ]; then
  BOX="$STATE_DIR"
elif [ -f /state/brain/org-policy.yaml ]; then
  BOX=/state/brain
else
  BOX="${STATE_DIR:-/state}"
fi
# On a rock the gh auth must live OUTSIDE the repo it pushes: a token inside the
# brain tree is one `git add -A` away from being the thing it uploads.
case "$BOX" in /state/brain|*/brain) export GH_CONFIG_DIR="${GH_CONFIG_DIR:-/state/.kernel/gh}" ;; esac
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-$BOX/.kernel/gh}"   # persisted in the box (gitignored)
command -v gh >/dev/null || { echo "GitHub CLI isn't available in this box."; exit 1; }
[ -d "$BOX" ] || { echo "There is no brain at $BOX to back up."; exit 1; }
cd "$BOX"

# A brain that is not a git repository yet becomes one, rather than ending in an
# instruction to go and type `git init` somewhere. The kernel normally does this
# at first boot; a brain reborn on the box has been seen without it.
git rev-parse --git-dir >/dev/null 2>&1 || {
  echo "Setting up version history for your brain…"
  git init -q -b main
}

# ---------------------------------------------------------------- THE GUARD
#
# WHAT WENT WRONG (found 2026-08-20). This script pushed the member's brain with
# NONE of the protections engine/brain-push.sh applies to the same tree.
# brain-push REFUSES unless the protective .gitignore is intact and runs an
# untrack pass first; connect-github had no ignore check, no untrack pass and no
# history check. It is also the script that CREATES the remote, so the FIRST
# upload of a brain went out unguarded, and the nightly job then refused on the
# very tree this script had already published. That asymmetry is the whole bug:
# the careful job was guarding a door the careless job had already walked through.
#
# The exposure was concrete, not theoretical. The kernel commits with a blind
# `git add -A` (engine/kernel/lib/git.mjs) under an ignore set that lists only
# .kernel/ secrets/ .claude-auth* .claude/ .mcp.json cockpit/ org/
# (engine/kernel/kernel.mjs), and box-up.sh seeds only .claude-auth/ secrets/
# .kernel/. NEITHER writes .env or *.key, and <brainRoot>/.env is where
# ORG_PULL_TOKEN lives. So a brain could TRACK .env, and this script shipped that
# history to GitHub.
#
# Three legs, and the order is load-bearing:
#
#   1. REPAIR the ignore file to the canonical set (engine/lib/brain-ignore.txt),
#      then VERIFY it took. Repairing is right here and refusing is right in
#      brain-push: this script is interactive, a person ran it or pressed the
#      button and is watching, whereas brain-push runs at 03:50 with nobody to
#      tell. Repairing here is also what stops the nightly refusing forever after.
#   2. UNTRACK whatever is already in the index. gitignore cannot untrack.
#   3. HISTORY. This is the leg brain-push does not have and cannot have. A
#      `git rm --cached` sheds a file from the NEXT commit, not from the commit
#      that already holds it, and `git push` uploads the whole history. On a
#      FIRST connect nothing has left the box yet, so the fix is free: keep the
#      old history on the box under a rescue branch and start the pushed branch
#      from one clean orphan commit. That is engine/box/org-brain-wire.sh's
#      2026-07-25 ruling ("pre-wire commits never leave the box"), minus its
#      `rm -rf .git`: the member's history is theirs, so it is kept on the box,
#      it is just not published. Content loss: none, the files stay on disk.
#      Once a remote already HAS the history, rewriting it locally fixes nothing
#      (the copy on GitHub is what is exposed), so that path warns and tells the
#      owner the two things that actually help: rotate, then delete the repo.

# One glob per line, '#' comments, blanks skipped.
brain_ignores()  { sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$IGNORE_LIST" | grep -v '^[[:space:]]*$' || true; }
# Everything above the second header: the credential-shaped floor brain-push.sh
# refuses without. Kept narrow on purpose (see the file's own header).
brain_required() { awk '/^# --- repaired/{exit} !/^#/ && NF {print}' "$IGNORE_LIST"; }

# Paths that must never appear in a pushed history. Derived from the ignore set,
# never listed a second time: strip a trailing '/' and every entry is a valid git
# pathspec, and --ignore-unmatch swallows the ones this box does not have.
brain_guard() {
  MODE="$1"           # first-connect | already-connected
  ENTRY=""; MISSING=""; DIRTY=""

  if [ ! -r "$IGNORE_LIST" ]; then
    echo "Stopping before anything is pushed: the never-commit list is missing" >&2
    echo "  ($IGNORE_LIST)" >&2
    echo "so this box cannot show that your credentials would stay off GitHub." >&2
    exit 1
  fi

  # 1. repair, then verify. Appending is idempotent and never removes a line the
  #    member added themselves.
  touch .gitignore
  while IFS= read -r ENTRY; do
    grep -qxF -- "$ENTRY" .gitignore || printf '%s\n' "$ENTRY" >> .gitignore
  done < <(brain_ignores)
  while IFS= read -r ENTRY; do
    grep -qxF -- "$ENTRY" .gitignore || MISSING="$MISSING $ENTRY"
  done < <(brain_required)
  if [ -n "$MISSING" ]; then
    echo "Stopping before anything is pushed: $BOX/.gitignore could not be repaired" >&2
    echo "and is still missing:$MISSING" >&2
    echo "Nothing was created and nothing was uploaded." >&2
    exit 1
  fi

  # 2. untrack anything already staged or committed into the index
  while IFS= read -r ENTRY; do
    git rm -r -q --cached --ignore-unmatch -- "${ENTRY%/}" >/dev/null 2>&1 || true
  done < <(brain_ignores)

  # 3. history. HEAD-only on purpose: `git push -u origin HEAD` publishes HEAD's
  #    history and nothing else, so --all would count a rescue branch from an
  #    earlier run and rewrite for nothing.
  if git rev-parse --verify -q HEAD >/dev/null 2>&1; then
    while IFS= read -r ENTRY; do
      [ -n "$(git log --format=%H -1 -- "${ENTRY%/}" 2>/dev/null || true)" ] && DIRTY="$DIRTY ${ENTRY%/}"
    done < <(brain_ignores)
  fi

  if [ -n "$DIRTY" ] && [ "$MODE" = "first-connect" ]; then
    KEEP="pre-connect-$(date -u +%Y%m%d-%H%M%S)"
    BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
    [ "$BRANCH" = "HEAD" ] && BRANCH=main
    echo "Your brain's history has credentials in it:$DIRTY"
    echo "Those must not go to GitHub, so the backup starts from a clean snapshot."
    echo "Nothing is deleted: every file stays on your box, and the old history"
    echo "stays here too, on a branch called $KEEP that is never pushed."
    git branch -f "$KEEP" HEAD
    git checkout -q --orphan __connect_fresh
    git rm -r -q --cached . >/dev/null 2>&1 || true
    git add -A
    git -c user.name=box -c user.email=box@local \
        commit -q -m "connect-github: clean snapshot (earlier history kept on the box as $KEEP)"
    git branch -M "$BRANCH"
  elif [ -n "$DIRTY" ]; then
    # The remote already has these commits. Rewriting here would not un-publish
    # them, and refusing would only stop the backup, so say the true thing.
    echo "WARNING: this repo's history already contains:$DIRTY" >&2
    echo "Those were uploaded by an earlier push and are still on GitHub. Rewriting" >&2
    echo "them here would not remove them. Two things actually help, in this order:" >&2
    echo "  1. rotate whatever those files held (a token is only a token until it is revoked)" >&2
    echo "  2. delete the repo on GitHub, then run  connect-github  again for a clean one" >&2
  fi

  # A tree with no commit at all cannot be pushed, and `gh repo create --push`
  # fails on it. The ignore file is correct by here, so making the first commit
  # is safe and is what the member expected pressing the button.
  git rev-parse --verify -q HEAD >/dev/null 2>&1 || {
    git add -A
    git -c user.name=box -c user.email=box@local commit -q -m "connect-github: first snapshot" || true
  }
}

# already connected? guard, then push.
if git remote get-url origin >/dev/null 2>&1; then
  echo "Already backing up to your repo: $(git remote get-url origin)"
  brain_guard already-connected
  git add -A
  git -c user.name=box -c user.email=box@local commit -q -m "sync: connect-github" >/dev/null 2>&1 || true
  git push -u origin HEAD 2>/dev/null && echo "✓ pushed. You're backed up." || echo "Push failed. Run connect-github again, or press Connect GitHub in the app."
  exit 0
fi

echo "Let's connect your GitHub so your brain backs up to an account YOU own."

# NO PROMPTS, NO MENUS. This used to be a bare `gh auth login`, which opens the
# GitHub CLI's interactive picker: "Authenticate Git with your GitHub
# credentials?" and then an arrow-key list. Sam, seeing it on a rock: "pretty
# intimidating for a non-technical user". gh-device-login.mjs runs the same
# device flow the desktop app runs and prints two lines, a URL and a code.
# It no-ops when this box is already signed in.
if ! gh auth status >/dev/null 2>&1; then
  node "$HERE/gh-device-login.mjs" || {
    echo "Sign-in did not finish, so nothing was created. Run connect-github again when you are ready."
    exit 1
  }
fi
gh auth setup-git 2>/dev/null || true

REPO="${1:-ai-os-brain}"
echo

# ADOPT AN EXISTING REPO RATHER THAN FAILING ON IT. `gh repo create` refuses with
# "Name already exists on this account" the second time, which is exactly what a
# retry is: someone who ran this once before, or ran it by hand in a terminal and
# got part-way. The rest of this product treats re-runs as the error-recovery
# contract, and this leg was the one place that punished them.
#
# BUT THE ADOPTION WAS BLIND (found 2026-08-20). The probe was a bare
# `gh repo view "$OWNER/$REPO"`, which answers "does a repo by this name exist",
# and the line printed underneath answered a different question: "Using the
# private repo '$REPO' you already have". Nothing ever read .isPrivate. A member
# who already had a PUBLIC repo called ai-os-brain, or who was handed the name of
# one, got their whole brain pushed into it and a sentence telling them it was
# private. So the probe now asks for the visibility itself, in one call whose
# EXIT CODE still answers existence.
OWNER="$(gh api user -q .login 2>/dev/null || true)"
PRIVATE=""
[ -n "$OWNER" ] && PRIVATE="$(gh api "repos/$OWNER/$REPO" -q .private 2>/dev/null || true)"

if [ "$PRIVATE" = "true" ]; then
  echo "Using the private repo '$REPO' you already have…"
  URL="https://github.com/$OWNER/$REPO.git"
  git remote add origin "$URL" 2>/dev/null || git remote set-url origin "$URL"
  brain_guard first-connect
  git push -u origin HEAD
elif [ -n "$OWNER" ] && gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
  # It exists and it is not readably private. FAIL CLOSED: "false" means public,
  # and an empty answer means this token could not read the visibility, which is
  # not the same as "it is fine". Either way the whole promise of this script is
  # a repo only you own, so the one thing it must not do is guess. There is no
  # override flag by design: the recovery is one word (a different name), and a
  # flag would exist only to let someone type past the screen protecting them.
  echo "Stopping: '$OWNER/$REPO' already exists and is not private." >&2
  echo "Your brain holds your notes and your credentials, so it only ever goes to a" >&2
  echo "private repo. Two ways on:" >&2
  echo "  * pick another name:   connect-github my-brain" >&2
  echo "  * or make $OWNER/$REPO private in GitHub's settings, then run this again" >&2
  exit 1
else
  echo "Creating your private repo '$REPO' and pushing your brain…"
  brain_guard first-connect
  gh repo create "$REPO" --private --source="$BOX" --remote=origin --push
fi
echo
echo "✓ Done. Your brain is backed up to your private GitHub repo '$REPO'."
echo "  It pushes there automatically at the end of every session."
