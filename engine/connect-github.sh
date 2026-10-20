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
# Every entry but the last section, which is for adopted brains only.
brain_ignores()  { awk '/^# --- /{s=($0 ~ /adopted brain only/)} !s {sub(/#.*/,""); sub(/[[:space:]]+$/,""); if (length) print}' "$IGNORE_LIST"; }
# Everything above the second header: the credential-shaped floor brain-push.sh
# refuses without. Kept narrow on purpose (see the file's own header).
brain_required() { awk '/^# --- repaired/{exit} !/^#/ && NF {print}' "$IGNORE_LIST"; }
# ADOPTED brains (spec 2026-10-17 § Engine changes) track their own .claude/ and
# cockpit/ on purpose, so for them the repair and untrack set is the credential
# floor only. `is_adopted` is the same line in brain-push.sh, connect-github.sh
# and box-up.sh, and the same test as isAdopted() in engine/lib/mineral-identity.mjs
# (pinned by engine/adopted-brain.test.mjs). Exactly `"adopted": true`; a pebble
# never has it and takes the full list exactly as before. Plain grep, not node:
# with no interpreter on PATH a node test answered "not adopted" and the full
# untrack ran over the person's .claude/ (found by the test rig, 2026-10-18).
is_adopted() { grep -Eq '"adopted"[[:space:]]*:[[:space:]]*true([^A-Za-z0-9_]|$)' "$1/ownership.json" 2>/dev/null; }
brain_ignores_adopted() { awk '/^# --- /{s=($0 ~ /adopted brain, which tracks/)} !s {sub(/#.*/,""); sub(/[[:space:]]+$/,""); if (length) print}' "$IGNORE_LIST"; }
is_adopted "$BOX" && brain_ignores() { brain_ignores_adopted; }
untrack_entry() { local f; f="$(git ls-files -- "$1" 2>/dev/null | grep -vE '\.(example|sample|template)$')"; [ -n "$f" ] || return 1; printf '%s\n' "$f" | git --literal-pathspecs rm -q --cached --ignore-unmatch --pathspec-from-file=-; }

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
    untrack_entry "${ENTRY%/}" >/dev/null 2>&1 || true
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

# ---------------------------------------------------------------- ADOPTED
#
# WHAT WENT WRONG (found 2026-10-20 on the first adopted server). An adopted
# brain is a folder the server's own jobs and the person's own sessions already
# work in, mounted at /state, with ONE .git shared by all of them. Its origin was
# `git@github-brain:<owner>/<repo>.git`, a host alias that exists only in
# the server's ~/.ssh/config, so from inside the mineral `git ls-remote origin`
# answers "Could not resolve hostname". This script saw that an origin existed,
# took the already-connected branch below and never signed in or changed how the
# mineral reaches GitHub. It did run `git add -A` over the whole shared tree and
# commit it as "box": that afternoon, 82 changes and 57 untracked files that were
# other people's work in progress (PDFs, a half-finished download), which the
# server's own jobs would then have pushed. And then the push failed, so nothing
# was connected.
#
# So on an adopted brain this script never stages, commits, untracks or edits
# .gitignore: the tree is not ours to snapshot. It does three things only:
#   1. find out whether the mineral can already use origin (a read, ls-remote);
#   2. if it cannot, sign in and give the MINERAL its own HTTPS way to the same
#      repository: `url.<https>.insteadOf <origin's url>` plus a gh credential
#      helper, both in the mineral's OWN git config ($HOME/.gitconfig, and an
#      adopted container's HOME is <brain>/.kernel/home, which is never committed
#      and which the server's git never reads). The shared .git/config is not
#      touched, so the server keeps its alias. Why a rewrite and not a second
#      remote: the person's own jobs that move into the mineral `git pull origin`,
#      and a second remote would fix only our push, while adding it writes to
#      the shared .git/config. The image already does exactly this for
#      `git@github.com:` (Dockerfile.base); an alias is the case that needs it per
#      repository;
#   3. push the commits that already exist, and only once moving in is finished.
# Which repository the alias means is read from its path and then PROVEN, never
# assumed: GitHub must say it is private and pushable, and it must hold the last
# commit the server fetched from origin. Any doubt stops with nothing written,
# like the private-repo checks below.

is_moving_in() { grep -Eq '"moving_in"[[:space:]]*:[[:space:]]*true([^A-Za-z0-9_]|$)' "$1/ownership.json" 2>/dev/null; }
adopted_stop() {
  printf '%s\n' "$@" >&2
  echo "Nothing was committed or pushed, and your repository's settings are as they were." >&2
  exit 1
}
# A url as it may be shown: credentials in it never reach the screen.
shown() { printf '%s' "$1" | sed -E 's#//[^/@]*@#//#'; }
# Read-only, no prompts, bounded: can this mineral use origin as it is?
origin_reachable() {
  GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10" \
    timeout 45 git ls-remote -q origin >/dev/null 2>&1
}
is_path_remote() { case "$1" in file://*|/*|./*|../*|~*) return 0 ;; esac; return 1; }
# owner/repo from an https://github.com url, an ssh:// url or an scp-style one
# (any host: an alias names GitHub only by what its path says, which is then
# checked). Nothing for anything else.
github_slug_of() {
  local u="$1" p=""
  case "$u" in
    https://github.com/*) p="${u#https://github.com/}" ;;
    ssh://*) p="${u#ssh://}"; p="${p#*/}" ;;
    *://*) return 1 ;;
    *:*) p="${u#*:}" ;;
    *) return 1 ;;
  esac
  p="${p#/}"; p="${p#\~/}"; p="${p%/}"; p="${p%.git}"
  printf '%s\n' "$p" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || return 1
  printf '%s\n' "$p"
}
# The mineral's own git config file, and whether it really is the mineral's:
# under <brain>/.kernel/, which the server never reads and git never commits.
# Anywhere else (this script run by hand on the server itself) a rewrite would
# change how the SERVER reaches origin too, so it is refused.
MINERAL_GITCONFIG="${GIT_CONFIG_GLOBAL:-${HOME:+$HOME/.gitconfig}}"
mineral_scoped() {
  [ -n "$1" ] || return 1
  case "$(readlink -m "$1" 2>/dev/null)" in "$(readlink -m "$BOX/.kernel" 2>/dev/null)"/*) return 0 ;; esac
  return 1
}

adopted_connect() {
  local raw eff branch slug="" tip seen key added="" reach=0
  git rev-parse --git-dir >/dev/null 2>&1 || adopted_stop \
    "Your brain at $BOX is not a git repository, and Crads-AI does not start one in a folder you already had."
  raw="$(git config --get remote.origin.url 2>/dev/null || true)"
  [ -n "$raw" ] || adopted_stop "Your brain has no remote called origin." \
    "Crads-AI backs up to the repository your server already uses, so add one there first, then press Connect GitHub again."
  branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  [ -n "$branch" ] || adopted_stop "Your brain is not on a branch right now (a detached HEAD), so there is nothing to back up yet."
  # The url git would really use from here, this mineral's own rewrites applied.
  eff="$(git remote get-url --push origin 2>/dev/null || printf '%s' "$raw")"

  origin_reachable && reach=1
  if [ "$reach" = 1 ] && ! slug="$(github_slug_of "$eff")"; then
    # Not GitHub, and it already works from in here (a remote the mineral can
    # see). Whose and how private it is, is the person's own choice.
    echo "Your mineral can already reach your repository ($(shown "$raw")) as it is."
  else
    if [ "$reach" = 0 ] && is_path_remote "$raw"; then
      adopted_stop "Your brain's remote is a folder on your server ($(shown "$raw")), which your mineral cannot see," \
        "so Crads-AI cannot back up there. On the server, point origin at a private repository on GitHub, then press Connect GitHub again."
    fi
    slug="$(github_slug_of "$eff" || github_slug_of "$raw" || true)"
    [ -n "$slug" ] || adopted_stop "Crads-AI cannot tell which GitHub repository $(shown "$raw") is."
    mineral_scoped "$MINERAL_GITCONFIG" || adopted_stop \
      "This is not running inside your mineral (its git settings would be ${MINERAL_GITCONFIG:-unset}, which your server reads too)." \
      "Press Connect GitHub in the app instead."

    echo "Your brain pushes to $(shown "$raw"). Signing in to GitHub to give your mineral its own way to the same repository…"
    if ! gh auth status >/dev/null 2>&1; then
      node "$HERE/gh-device-login.mjs" </dev/null || adopted_stop "Sign-in did not finish. Press Connect GitHub again when you are ready."
    fi

    # Proof that the alias means this repository, before anything is written.
    [ "$(gh api "repos/$slug" -q .private 2>/dev/null || true)" = "true" ] || adopted_stop \
      "Stopping: GitHub does not show $slug as a private repository this account can read." \
      "Your brain holds your notes and your credentials, so it only ever goes to a private repo."
    [ "$(gh api "repos/$slug" -q .permissions.push 2>/dev/null || true)" = "true" ] || adopted_stop \
      "Stopping: the GitHub account you signed in with cannot push to $slug."
    tip="$(git rev-parse -q --verify "refs/remotes/origin/$branch" 2>/dev/null || git for-each-ref --count=1 --format='%(objectname)' refs/remotes/origin/ 2>/dev/null || true)"
    [ -n "$tip" ] || adopted_stop \
      "Crads-AI cannot show that $slug is the repository your server pushes to: this brain has no record of anything fetched from origin." \
      "Run  git fetch  in it on the server, then press Connect GitHub again."
    seen="$(gh api "repos/$slug/commits/$tip" -q .sha 2>/dev/null || true)"
    [ "$seen" = "$tip" ] || adopted_stop \
      "Stopping: $slug on GitHub does not have ${tip:0:12}, the last commit your server fetched from origin, so it may not be the same repository."

    # The way in, in the mineral's own config only. The helper names gh's config
    # dir itself: the app's verbs run without box-up's environment.
    local helper="!GH_CONFIG_DIR='$GH_CONFIG_DIR' gh auth git-credential"
    if [ "$(git config --file "$MINERAL_GITCONFIG" --get-all credential.https://github.com.helper 2>/dev/null || true)" != "$(printf '\n%s' "$helper")" ]; then
      git config --file "$MINERAL_GITCONFIG" --unset-all credential.https://github.com.helper 2>/dev/null || true
      git config --file "$MINERAL_GITCONFIG" --add credential.https://github.com.helper ''
      git config --file "$MINERAL_GITCONFIG" --add credential.https://github.com.helper "$helper"
    fi
    if [ "$eff" != "https://github.com/$slug.git" ] && [ "$eff" != "https://github.com/$slug" ]; then
      key="url.https://github.com/$slug.git.insteadOf"
      git config --file "$MINERAL_GITCONFIG" --get-all "$key" 2>/dev/null | grep -qxF -- "$raw" \
        || { git config --file "$MINERAL_GITCONFIG" --add "$key" "$raw"; added=1; }
    fi
    if ! origin_reachable; then
      [ -n "$added" ] && git config --file "$MINERAL_GITCONFIG" --fixed-value --unset "$key" "$raw" 2>/dev/null
      adopted_stop "Signed in, but your mineral still cannot reach $slug over HTTPS, so the new way in was taken out again."
    fi
    echo "✓ Your mineral reaches $slug over HTTPS. Your server's own settings for origin are unchanged."
  fi

  if is_moving_in "$BOX"; then
    echo "You are still moving in, so nothing was pushed. Crads-AI's nightly backup starts from here once you have moved in."
    return 0
  fi
  # The commits that are already there, to the branch they are on. Never a
  # force, never -u (an upstream is written into the shared .git/config).
  if git push -q origin "HEAD:refs/heads/$branch" 2>/dev/null; then
    echo "✓ pushed $branch. You're backed up."
  else
    echo "Not pushed yet: $branch on GitHub has commits this brain does not have. Nothing was overwritten; the nightly backup pushes once they are pulled here."
  fi
}
if is_adopted "$BOX"; then adopted_connect; exit 0; fi

# A brain that is not a git repository yet becomes one, rather than ending in an
# instruction to go and type `git init` somewhere. The kernel normally does this
# at first boot; a brain reborn on the box has been seen without it. (Moved below
# the guard 2026-10-20, so the adopted branch above never starts one.)
git rev-parse --git-dir >/dev/null 2>&1 || {
  echo "Setting up version history for your brain…"
  git init -q -b main
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
