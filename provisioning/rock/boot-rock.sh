#!/usr/bin/env bash
# ============================================================================
# boot-rock.sh: container entrypoint for the ai-os ROCK (factory / org
# control brain). This is the rock's equivalent of engine/box-up.sh, but the
# rock is NOT a member box: it never seeds a profile.yaml and never runs the
# PERSON-scope EA bring-up. It DOES get the ORG-scope subset of the engine
# skills synced into its brain (D49: rocks onboard too, at ORG scope; the
# panel's stamp-member gate reads this brain's onboarding-state.json, so
# /onboard must be reachable here). The brain's CONTENT is the deployment's
# own repo at BRAIN_ROOT; the skills are engine-owned and re-synced each boot.
#
# STAGED, NOT BAKED
# -----------------
# The rock IMAGE is generic: nothing org-specific is compiled into it. The
# Dockerfile bakes only a default BRAIN_ROOT (the container-local path where the
# org brain will be mounted). Everything that names a particular deployment
# (IC as deployment #1, Sam's own pebble base as deployment #2, any future org)
# arrives at RUNTIME in /state/deployment.yaml, staged onto the /state volume
# before the container starts. This script reads that file and turns it into
# process env, so the same image boots any deployment.
#
# What we read from /state/deployment.yaml (snake_case keys):
#   deployment_name   the deployment's short name (required)
#   operator_emails   list: humans allowed in via Cloudflare Access; also the
#                     personal Claude accounts that must NOT own this box
#   domain            Cloudflare tunnel root domain
#   brain_repo        git remote for the org brain
#   content_repo      git remote for the shared content channel
#   brain_root        where the org brain lives in-container (default /state/brain)
#   persona_name      the rock brain's persona name
#   default_region    default provisioning region (default hel1)
#
# YAML parsing: the rock image guarantees node + jq, but jq parses JSON only
# and there is no yq / PyYAML / js-yaml anywhere. So we parse the flat YAML with
# a tiny no-dependency node reader (the same pattern registry/build-index.mjs
# uses) and emit shell-escaped `export` lines that we source. No yq assumed.
#
# Then we verify this box is signed into the DEPLOYMENT's own Claude account,
# never an operator's personal account (the cross-identity leak the account
# guard exists to catch), and hand off to code-server (the browser IDE the
# healthcheck probes on :7781) plus the optional org cron.
#
# Fails loud and clear if /state/deployment.yaml is missing: a rock with no
# deployment config is a misconfiguration, not a state to limp along in.
# ============================================================================
set -euo pipefail

STATE_DIR="${STATE_DIR:-/state}"
AIOS_DIR="${AIOS_DIR:-/app}"
DEPLOY_FILE="$STATE_DIR/deployment.yaml"
ROCK_DIR="$STATE_DIR/.rock"                 # rock runtime scratch (not the brain, not committed)
IDE_PORT="${IDE_PORT:-7781}"
GUARD="$AIOS_DIR/engine/ops/box-account.mjs"

# ---- output helpers (mirror box-up.sh) ----
b(){ printf '\033[1m%s\033[0m\n' "$*"; }
mut(){ printf '\033[2m%s\033[0m\n' "$*"; }
ok(){ printf '  \033[32m✓\033[0m %s\n' "$*"; }
pend(){ printf '  \033[33m•\033[0m %s\n' "$*"; }
die(){ printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

mkdir -p "$ROCK_DIR"

# ============================================================================
# 1. deployment.yaml must exist. No config, no boot.
# ============================================================================
if [ ! -f "$DEPLOY_FILE" ]; then
  die "no deployment config at $DEPLOY_FILE

The rock image is generic: the deployment (name, operator emails, domain,
brain repo, brain_root, persona) is staged at runtime, not baked. Stage a
deployment.yaml onto the /state volume before starting this container, e.g.

  $STATE_DIR/deployment.yaml:
    deployment_name: acme
    operator_emails:
      - ops@acme.example
    domain: acme.example.com
    brain_repo: git@github.com:acme/acme-brain.git
    content_repo: git@github.com:acme/acme-content.git
    brain_root: /state/acme-brain
    persona_name: Acme

Refusing to boot without it."
fi

# ============================================================================
# 2. Parse the flat YAML into shell exports (node reader, no yq / PyYAML).
#    node writes single-quote-escaped `export KEY='value'` lines that we source,
#    so values are never eval'd as shell (no injection from deployment.yaml).
# ============================================================================
DEPLOY_ENV="$ROCK_DIR/deployment.env"
set +e
DEPLOYMENT_FILE="$DEPLOY_FILE" DEPLOY_ENV_OUT="$DEPLOY_ENV" node <<'NODE'
const fs = require('node:fs');
const file = process.env.DEPLOYMENT_FILE;
const out = process.env.DEPLOY_ENV_OUT;

let raw;
try { raw = fs.readFileSync(file, 'utf8'); }
catch { console.error('cannot read ' + file); process.exit(2); }

// Tiny flat-YAML reader (same shape as registry/build-index.mjs). Keep the
// deployment.yaml FLAT (top-level scalars + one operator_emails list) so this
// stays correct: deep nesting or anchors would silently misread.
function scalar(key) {
  const m = raw.match(new RegExp('^' + key + ':\\s*"?([^"\\n#]*)"?', 'm'));
  return m ? m[1].trim() : '';
}
function list(key) {
  // inline form:  key: [a, b]
  const inline = raw.match(new RegExp('^' + key + ':\\s*\\[([^\\]]*)\\]', 'm'));
  if (inline) {
    return inline[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  // block form:   key:\n  - a\n  - b
  const block = (raw.split(new RegExp('^' + key + ':\\s*$', 'm'))[1] || '').split(/^\S/m)[0];
  return (block.match(/^\s*-\s*.+$/gm) || [])
    .map((l) => l.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

const name = scalar('deployment_name');
if (!name) { console.error('deployment_name is missing or empty'); process.exit(3); }

const operators = list('operator_emails');
// brain_root: the deployment's staged value wins, else the image's generic
// baked default, else /state/brain. No org-named env is honoured: an image that
// knew about one deployment would not serve the next one.
const brainRoot = scalar('brain_root')
  || process.env.BRAIN_ROOT
  || '/state/brain';
const region = scalar('default_region') || 'hel1';

const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const lines = [];
const emit = (k, v) => { if (v !== '' && v != null) lines.push('export ' + k + '=' + q(v)); };

emit('DEPLOYMENT_NAME', name);
emit('OPERATOR_EMAILS', operators.join(','));
if (operators.length) emit('AIOS_OPERATOR_EMAIL', operators[0]); // the account guard's single-email check
emit('DEPLOYMENT_DOMAIN', scalar('domain'));
emit('BRAIN_REPO', scalar('brain_repo'));
emit('CONTENT_REPO', scalar('content_repo'));
emit('BRAIN_ROOT', brainRoot);
emit('PERSONA_NAME', scalar('persona_name'));
emit('DEFAULT_REGION', region);
emit('ALLOW_OPERATOR_ACCOUNT', scalar('allow_operator_account'));

fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(name);
NODE
PARSE_RC=$?
set -e
case "$PARSE_RC" in
  0) : ;;
  2) die "could not read $DEPLOY_FILE (unreadable or not valid text)." ;;
  3) die "$DEPLOY_FILE has no deployment_name. That key is required (it names the deployment)." ;;
  *) die "failed to parse $DEPLOY_FILE (node exit $PARSE_RC)." ;;
esac

# shellcheck disable=SC1090
. "$DEPLOY_ENV"

# Belt-and-braces defaults if the file omitted them.
BRAIN_ROOT="${BRAIN_ROOT:-/state/brain}"
DEFAULT_REGION="${DEFAULT_REGION:-hel1}"
export BRAIN_ROOT DEFAULT_REGION

# The fleet machinery (agent.js, permissions.mjs, run-job-lib.mjs) roots at
# WIKI_DIR. Point it at the org brain unless the env already set it.
export WIKI_DIR="${WIKI_DIR:-$BRAIN_ROOT}"

# UNIFORM ANCHOR RULE (Mountain model, 2026-08-04): a rock is a box like any
# other and carries the same box-side identity record. owner = the org itself
# (a rock is org-owned by definition); the Mountain operates it and is its
# anchor — rocks anchor to the Mountain, there is no anchorless state. Backstop
# only: a staged record is never overwritten. This record is also the box-side
# answer the app reads to decide which face to show (in-place promotion keeps
# the address and alias; the BOX says what it is, promote ruling § 3).
# holder_email is the ACCOUNT that owns this mineral, written HERE, at birth,
# because nothing else ever wrote it. The ownership/access model says the mineral
# records its holder and grants on its own disk and the directory mirrors it, but
# the birth path was never taught to, so every door-born box came up holderless:
# /app/minerals sat empty for boxes that plainly existed, and nobody could be let
# in by account because grant-is-the-gate and there was no grant to gate on
# (found live 2026-08-11). See docs/design-account-bound-access.md.
#
# The address is the verified submitter's, proven twice before it reaches here:
# the door sends a signed token and the worker takes the email FROM the token
# rather than the form, then writes it into the deployment's operator_emails.
#
# Email, not an acc_ id: the directory already keys account edges by
# sha256(lowercased email), the address survives an account being recreated, and
# the box cannot resolve an acc_ id at boot without calling home.
#
# grants[] starts EMPTY and is NOT managed_by. Management never implies read
# access (a rock manages its members and must never read inside one), so they
# stay separate fields and nothing may promote one into the other.
if [ ! -f "$STATE_DIR/ownership.json" ]; then
  _holder="$(printf '%s' "${AIOS_OPERATOR_EMAIL:-}" | tr 'A-Z' 'a-z' | tr -d '"\\')"
  printf '{\n  "owner": "org",\n  "owner_slug": "%s",\n  "managed_by": "crads-ai",\n  "machinery_by": "crads-ai",\n  "tier": "rock",\n  "anchor": "crads-ai",\n  "holder_email": "%s",\n  "grants": []\n}\n' \
    "$DEPLOYMENT_NAME" "$_holder" > "$STATE_DIR/ownership.json" || true
fi

# WHO HOLDS THIS ROCK, in the shape the rest of the system reads. Written with
# claimOwner rather than by hand: identityFacts() is what enrol-sync gates on
# (`f.mineral_id && f.holder`), and it wants holder as an OBJECT with an
# access[] beside it. A hand-rolled holder_email string satisfies nothing, and
# the failure is silent — the mirror simply never runs, so the owner's minerals,
# devices and account pages stay empty forever with no error anywhere. Found
# exactly that way on a live rock, 2026-08-11.
#
# claimOwner is first-claim-wins and idempotent, so re-running on every boot is
# safe and a box that changed hands is not quietly re-taken.
if [ -n "${AIOS_OPERATOR_EMAIL:-}" ]; then
  AIOS_HOLDER="$AIOS_OPERATOR_EMAIL" node --input-type=module -e '
    import { claimOwner } from "/app/engine/lib/mineral-identity.mjs";
    try { claimOwner("/state", { kind: "account", email: String(process.env.AIOS_HOLDER || "").toLowerCase() }); }
    catch { /* already held: a change of hands is a transfer, not a boot step */ }
  ' >/dev/null 2>&1 || true
fi

# THE THREE FILES ENROL-SYNC NEEDS, or an owner can never add a machine.
# enrol-sync reads all three from /state/secrets and exits silently without them,
# and the middle one is the nastiest: with no box_reg_host it falls back to
# hostname(), which inside the container is a docker id like 45565ac98a4e, so it
# asks the directory about a box that does not exist and reports a cheerful
# "0 added, 0 refused" forever. All three were missing on every rock built before
# this, and had to be written by hand to let an owner in.
mkdir -p "$STATE_DIR/secrets" 2>/dev/null || true
# NO DOMAIN FALLBACK. The deployment's own domain or nothing: this is product
# code baked into a generic image, and defaulting to any particular operator's
# domain would make every box of every deployment claim a name under it. A rock
# whose deployment names no domain writes nothing here, which enrol-sync reports
# honestly, and that is strictly better than registering the wrong host.
if [ -n "${DEPLOYMENT_DOMAIN:-}" ] && [ ! -s "$STATE_DIR/secrets/box_reg_host" ]; then
  printf '%s' "$DEPLOYMENT_NAME.$DEPLOYMENT_DOMAIN" > "$STATE_DIR/secrets/box_reg_host" 2>/dev/null || true
fi
# The box's own token: minted once, kept on its own disk. First token wins the
# name at the directory, so a refresh re-registers and anybody else is refused.
[ -s "$STATE_DIR/secrets/box_directory_token" ] || \
  head -c 32 /dev/urandom | base64 | tr -d '/+=' > "$STATE_DIR/secrets/box_directory_token" 2>/dev/null || true
# owner_e is a HASH: the directory only needs to know whether the account asking
# is the same one, and a hash answers that without the platform holding a list of
# who owns what.
if [ -n "${AIOS_OPERATOR_EMAIL:-}" ] && [ ! -s "$STATE_DIR/secrets/owner_e" ]; then
  printf '%s' "$AIOS_OPERATOR_EMAIL" | tr 'A-Z' 'a-z' | tr -d '\n' \
    | sha256sum | cut -d' ' -f1 | tr -d '\n' > "$STATE_DIR/secrets/owner_e" 2>/dev/null || true
fi
chmod 600 "$STATE_DIR/secrets/box_directory_token" "$STATE_DIR/secrets/owner_e" "$STATE_DIR/secrets/box_reg_host" 2>/dev/null || true

# Claude auth + gh config live on the /state volume (persist across restarts),
# never in the ephemeral baked layers. The container runs as an arbitrary
# non-root uid with no home dir, so every tool needs an explicit config dir.
export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$STATE_DIR/.claude-auth}"
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-$ROCK_DIR/gh}"
mkdir -p "$CLAUDE_CONFIG_DIR" "$GH_CONFIG_DIR" "${AIOS_STATE_DIR:-/state/.factory}"

clear 2>/dev/null || true
b "  ${PERSONA_NAME:-rock brain} :: ${DEPLOYMENT_NAME} (rock / factory)"
mut "  brain:  $BRAIN_ROOT"
mut "  domain: ${DEPLOYMENT_DOMAIN:-(none)}   region: $DEFAULT_REGION"
echo

# ============================================================================
# 3. The org brain must be staged. The rock never scaffolds a member box, so
#    a missing BRAIN_ROOT is a real error, not something to paper over.
# ============================================================================
b "Checking the rock box..."
if [ -d "$BRAIN_ROOT" ]; then ok "org brain present at $BRAIN_ROOT"
else die "org brain not staged at $BRAIN_ROOT.
The rock's identity is the hand-written brain repo ($BRAIN_REPO). Clone or
mount it to $BRAIN_ROOT before boot. The rock does not scaffold one."
fi
command -v claude >/dev/null 2>&1 && ok "Claude Code installed" || pend "Claude Code not found on PATH"

# ---- the folder Claude Code opens (R18, 2026-08-23) ----------------------------
# SSH lands in $STATE_DIR on every face now (enter-aios dropped `-w /state/brain`),
# so one entry in it is named after this rock and points at the brain
# (`$STATE_DIR/<name> -> brain`, relative). The chosen name lands in
# $STATE_DIR/open-folder for the app and the Help copy. Idempotent; a real
# directory of that name is never clobbered. Same module as the pebble's box-up.sh.
if _of="$(node "$AIOS_DIR/engine/lib/open-folder.mjs" "$STATE_DIR" "$BRAIN_ROOT" 2>&1)"; then ok "$_of"
else pend "open-folder link not made (${_of:-no detail}); Claude Code still opens $STATE_DIR"
fi

# ---- machinery: link the BAKED control-plane in as the brain's cockpit ----
# The fleet control-plane (permission gate, dispatcher, git-sync, heartbeat, dashboard) is a
# generic PRODUCT module: authored clean in ai-os, baked into this image, versioned with it, and
# rolled back by pinning the previous image tag. The brain is the DEPLOYMENT's own content.
# Linking the two here is what makes them meet: everything below (WIKI_DIR, the cron lookup at
# $BRAIN_ROOT/cockpit/crontab) resolves through this link.
#
# Why a link and not a copy: one machinery home, always. A brain repo that carried its own
# cockpit/ would shadow the baked one and run an unversioned fork of the control-plane, which is
# exactly the copy-drift the build framework exists to kill. So we refuse to clobber a real
# directory, and say so loudly.
MACHINERY="$AIOS_DIR/rock-machinery"
if [ -d "$MACHINERY" ]; then
  if [ -L "$BRAIN_ROOT/cockpit" ] || [ ! -e "$BRAIN_ROOT/cockpit" ]; then
    ln -sfn "$MACHINERY" "$BRAIN_ROOT/cockpit"
    ok "machinery linked ($MACHINERY -> $BRAIN_ROOT/cockpit)"
  else
    pend "$BRAIN_ROOT/cockpit is a real directory, so the baked machinery is being SHADOWED by a copy in the brain repo. Remove it: the machinery is the image's, not the brain's."
  fi
else
  pend "no baked machinery at $MACHINERY (this image was built without it)"
fi

# ---- skills: sync the ORG-scope engine skills into the brain so Claude Code ----
# discovers them at $BRAIN_ROOT/.claude/skills/<name>/SKILL.md (D49: rocks DO
# onboard, at ORG scope; the panel's stamp-member gate tells the operator to run
# /onboard on this box, so it must actually be here). Same file->dir mapping as
# the member kernel sync (engine/kernel/lib/skills.mjs), engine-owned and
# re-synced every boot, never authored in the brain repo. The PERSON-scope EA
# skills (daily, inbox, followup) stay member-only: they assume a profile.yaml
# and the member's own comms connectors, which the rock never has.
ROCK_SKILLS="${ROCK_SKILLS:-onboard explain capture weekly plan-week write-page}"
SKILLS_SRC="$AIOS_DIR/engine/skills"
SYNCED=""
for s in $ROCK_SKILLS; do
  [ -f "$SKILLS_SRC/$s.md" ] || continue
  if mkdir -p "$BRAIN_ROOT/.claude/skills/$s" 2>/dev/null \
     && cp "$SKILLS_SRC/$s.md" "$BRAIN_ROOT/.claude/skills/$s/SKILL.md" 2>/dev/null; then
    SYNCED="$SYNCED $s"
  fi
done
if [ -n "$SYNCED" ]; then ok "org-scope skills synced:$SYNCED"
else pend "no org-scope skills synced (nothing at $SKILLS_SRC, or brain not writable)"
fi
# Keep the engine-owned copies out of the brain repo's history. gitignore never
# untracks files already committed, so org-authored .claude/ content (rules/,
# config/) is untouched.
if [ -d "$BRAIN_ROOT/.git" ] && ! grep -qsx '\.claude/skills/' "$BRAIN_ROOT/.gitignore" 2>/dev/null; then
  printf '\n# engine-owned, re-synced by boot-rock.sh every boot\n.claude/skills/\n' \
    >> "$BRAIN_ROOT/.gitignore" 2>/dev/null || true
fi

# ---- brain control plane: engine-owned, re-synced every boot ----------------
# The reconcile machinery (control/, orchestrator/) is PRODUCT, but it lives
# inside the ORGANISATION'S OWN brain repo, whose .git is stripped and re-inited
# on the box in template mode (provision-rock.sh, ownership ruling 2026-08-09).
# So it had no remote and could never be updated: every rock-side product change
# was unreachable on every rock already in the field, permanently.
#
# Same answer as the cockpit link above, in that block's own words: "one
# machinery home, always... versioned and rolled back with the image tag."
#
# A COPY, not a symlink, and deliberately: unlike cockpit/, these directories
# already exist as real, git-TRACKED directories on every rock stamped before
# today, and the link path above refuses to clobber a real directory. A symlink
# would therefore skip exactly the rocks that most need the update.
#
# Refuses whole rather than syncing half. A rock that boots on its OLD control
# plane still reconciles; one that boots on half a new one does not.
CTRL_SRC="$AIOS_DIR/brain-control"
CTRL_SYNCED=""
if [ -f "$CTRL_SRC/SOURCE.txt" ] && [ -d "$CTRL_SRC/tree" ]; then
  CTRL_OK=1
  for f in control/reconcile-all.mjs control/catalog-reconcile.mjs orchestrator/push-down.mjs registry/normalize-row.mjs; do
    [ -f "$CTRL_SRC/tree/$f" ] || { CTRL_OK=0; break; }
  done
  # The one thing that would lose something irreplaceable. The vendor script
  # refuses to BUILD such a tree; this refuses to APPLY one, because the image
  # and the script that made it can drift apart.
  [ -e "$CTRL_SRC/tree/registry/members" ] && CTRL_OK=0
  if [ "$CTRL_OK" = 1 ]; then
    # ONE overlay copy. `cp -a tree/. $BRAIN_ROOT/` merges directories and
    # overwrites files, and DELETES NOTHING: anything not in the vendored tree
    # cannot be touched, which is why registry/members and every note, decision
    # and org-authored library entry is safe by construction rather than by a
    # rule someone has to remember.
    if cp -a "$CTRL_SRC/tree/." "$BRAIN_ROOT/" 2>/dev/null; then
      CTRL_SYNCED="control orchestrator"
      CTRL_SHA="$(sed -n 's/^sha: //p' "$CTRL_SRC/SOURCE.txt" 2>/dev/null | cut -c1-12)" || CTRL_SHA=""
      ok "brain control plane synced (${CTRL_SHA:-unknown})"
      cp -a "$CTRL_SRC/SOURCE.txt" "$BRAIN_ROOT/.control-source" 2>/dev/null || true
      # Does the graph actually resolve? control/ imports registry/ and factory/,
      # so a partial or mismatched overlay surfaces HERE rather than at :04, when
      # the reconcile cron would die quietly and a member's offer never land.
      if ! (cd "$BRAIN_ROOT" && node -e 'import("./control/catalog-reconcile.mjs").then(()=>{},e=>{console.error(e.message);process.exit(1)})') >/dev/null 2>&1; then
        pend "the synced control plane does not load on this box; reconcile may not run (report this, with the sha above)"
      fi
    else
      pend "brain control plane NOT synced (brain not writable); this rock keeps the machinery it was born with"
    fi
  else
    pend "baked brain control plane at $CTRL_SRC is unsound; NOT syncing, this rock keeps the machinery it was born with"
  fi
else
  pend "no baked brain control plane at $CTRL_SRC (this image was built without it)"
fi
# Keep the engine-owned copies out of the ORGANISATION'S git history. The kernel
# runs `git add -A` on every drain, so without this the image's own machinery
# would be re-committed into the customer's repo on every boot. gitignore alone
# cannot do it: it never untracks what is already committed, and on every rock
# stamped before today these ARE committed. `git rm -r --cached` unstages them
# and leaves every file on disk, so the running box is untouched either way.
#
# ONLY control/ and orchestrator/, never registry/ or factory/: those two are
# shared with the organisation's own data, and ignoring either would stop member
# rows being backed up. Their .mjs files stay tracked exactly as they are today.
if [ -n "$CTRL_SYNCED" ] && [ -d "$BRAIN_ROOT/.git" ]; then
  for d in $CTRL_SYNCED; do
    if ! grep -qsx "$d/" "$BRAIN_ROOT/.gitignore" 2>/dev/null; then
      printf '\n# engine-owned, re-synced by boot-rock.sh every boot\n%s/\n' "$d" >> "$BRAIN_ROOT/.gitignore" 2>/dev/null || true
    fi
    git -C "$BRAIN_ROOT" rm -r --cached -q --ignore-unmatch "$d" >/dev/null 2>&1 || true
  done
fi

# ---- vendor catalog (D57): pull any skill packages granted to this deployment ----
# into the brain's skills-library (panel Skills tab -> pushable to members).
# Clean no-op unless deployment.yaml has catalog_repo AND the read-only deploy
# key is staged at /state/secrets/catalog_deploy_key. Never fatal at boot.
if node "$AIOS_DIR/engine/ops/catalog-sync.mjs" 2>&1; then :
else pend "vendor catalog sync failed (box still boots; run catalog-sync from the panel to retry)"
fi

# ---- pages (panel iteration 2, R15): the rock gets the same box-hosted app ----
# shell surface a pebble gets: $STATE_DIR/dashboard/{pages.json,pages/*.html}
# seeded from the engine templates. Same call box-up.sh makes. Idempotent and
# non-destructive (only missing files are created; edited pages are never
# overwritten). ownership.json was written above, so the seeder's pebble
# backstop never fires here. Never fatal to boot.
if node "$AIOS_DIR/engine/appshell/seed-pages.mjs" "$STATE_DIR" >/dev/null 2>&1; then ok "pages seeded at $STATE_DIR/dashboard"
else pend "pages not seeded (box still boots; the app seeds on first read)"
fi

# ============================================================================
# 4. Account guard: this box must use the DEPLOYMENT's own Claude account, never
#    an operator's personal login. Reuse engine/ops/box-account.mjs (reads
#    <STATE_DIR>/.claude-auth), then double-check the returned email against the
#    full operator_emails list (box-account only compares the single
#    AIOS_OPERATOR_EMAIL, so this covers a multi-operator deployment).
# ============================================================================
if [ -f "$GUARD" ]; then
  set +e
  ACCT="$(node "$GUARD" "$STATE_DIR" 2>/dev/null)"
  ACCT_RC=$?
  set -e
  case "$ACCT" in
    OK:*)
      ACCT_EMAIL="${ACCT#OK:}"
      # extra guard: reject any operator personal account beyond the first.
      EMAIL_LC="$(printf '%s' "$ACCT_EMAIL" | tr '[:upper:]' '[:lower:]')"
      HIT=""
      if [ -n "${OPERATOR_EMAILS:-}" ]; then
        while IFS= read -r oe; do
          [ -n "$oe" ] || continue
          OE_LC="$(printf '%s' "$oe" | tr '[:upper:]' '[:lower:]')"
          [ "$OE_LC" = "$EMAIL_LC" ] && HIT="$oe"
        done <<EOF
$(printf '%s' "$OPERATOR_EMAILS" | tr ',' '\n')
EOF
      fi
      if [ -n "$HIT" ] && [ "${ALLOW_OPERATOR_ACCOUNT:-}" = "true" ]; then
        pend "STAGING GUARD RELAXATION: signed in as operator $ACCT_EMAIL (allow_operator_account: true). NEVER set this on a production deployment."
        HIT=""
      fi
      if [ -n "$HIT" ]; then
        die "this box is signed in as an OPERATOR account ($ACCT_EMAIL).
It must use ${DEPLOYMENT_NAME}'s OWN Claude account, not an operator's personal
login. Fix: rm -rf $CLAUDE_CONFIG_DIR then sign in as the deployment."
      fi
      ok "signed in as $ACCT_EMAIL"
      ;;
    OPERATOR:*)
      if [ "${ALLOW_OPERATOR_ACCOUNT:-}" = "true" ]; then
        pend "STAGING GUARD RELAXATION: operator account ${ACCT#OPERATOR:} accepted (allow_operator_account: true). NEVER set this on a production deployment."
      else
      die "this box is signed in as the OPERATOR (${ACCT#OPERATOR:}).
It must use ${DEPLOYMENT_NAME}'s OWN Claude account, not an operator's personal
login. Fix: rm -rf $CLAUDE_CONFIG_DIR then sign in as the deployment."
      fi
      ;;
    UNKNOWN)
      pend "signed in (account unverified); confirm it is ${DEPLOYMENT_NAME}'s account" ;;
    *)
      pend "not signed in yet; sign in as ${DEPLOYMENT_NAME} in the IDE terminal (rc $ACCT_RC)" ;;
  esac
else
  pend "account guard not found at $GUARD; skipping the operator-account check"
fi
echo

# ============================================================================
# 5. Factory tokens persistence (conservative fix for the open .env.local
#    question). lib.sh sources /app/provisioning/managed/.env.local from the
#    baked layer, which is ephemeral. If the operator has staged a persisted
#    copy at $STATE_DIR/secrets/provisioning.env.local, link the baked path to
#    it so the factory keeps its Hetzner/Cloudflare tokens across restarts. Pure
#    no-op when that file is absent, so it forces no decision.
# ============================================================================
PERSIST_ENV="$STATE_DIR/secrets/provisioning.env.local"
BAKED_ENV="$AIOS_DIR/provisioning/managed/.env.local"
if [ -f "$PERSIST_ENV" ] && [ ! -e "$BAKED_ENV" ]; then
  mkdir -p "$AIOS_DIR/provisioning/managed" 2>/dev/null || true
  ln -s "$PERSIST_ENV" "$BAKED_ENV" 2>/dev/null && ok "factory tokens linked from $PERSIST_ENV" || true
fi

# ============================================================================
# 6. Seed the pre-baked Claude Code plugins into this box's auth dir (idempotent,
#    never touches credentials). Same step box-up.sh runs, rooted at the rock's
#    CLAUDE_CONFIG_DIR instead of a member box.
# ============================================================================
TEMPLATE="${CLAUDE_PLUGIN_TEMPLATE:-/opt/claude-plugins-template}"
if [ -d "$TEMPLATE/plugins" ] && [ ! -d "$CLAUDE_CONFIG_DIR/plugins" ]; then
  cp -a "$TEMPLATE/plugins" "$CLAUDE_CONFIG_DIR/plugins" 2>/dev/null || true
  # plugin state files carry the build-time path; rewrite to this box's path.
  [ "$CLAUDE_CONFIG_DIR" != "/state/.claude-auth" ] && \
    find "$CLAUDE_CONFIG_DIR/plugins" -name '*.json' \
      -exec sed -i "s#/state/.claude-auth#$CLAUDE_CONFIG_DIR#g" {} + 2>/dev/null || true
  if [ -f "$CLAUDE_CONFIG_DIR/settings.json" ]; then
    node -e 'const fs=require("fs");const d=process.env.D,t=process.env.T;const a=JSON.parse(fs.readFileSync(d+"/settings.json"));const b=JSON.parse(fs.readFileSync(t+"/settings.json"));a.enabledPlugins={...(b.enabledPlugins||{}),...(a.enabledPlugins||{})};a.extraKnownMarketplaces={...(b.extraKnownMarketplaces||{}),...(a.extraKnownMarketplaces||{})};fs.writeFileSync(d+"/settings.json",JSON.stringify(a,null,2));' D="$CLAUDE_CONFIG_DIR" T="$TEMPLATE" 2>/dev/null || true
  else
    cp "$TEMPLATE/settings.json" "$CLAUDE_CONFIG_DIR/settings.json" 2>/dev/null || true
  fi
fi

# ============================================================================
# 7. Optional org cron. The rock has no member-style profile.cadence, so it
#    opts in by PRESENCE of a crontab the brain provides (its fleet installs one
#    at cockpit/crontab or .kernel/crontab). We install and start it with the
#    box env prepended, never generate job content here. Jobs draft, never send.
# ============================================================================
CRON_LIVE=0
CRONTAB_SRC=""
for c in "$BRAIN_ROOT/cockpit/crontab" "$BRAIN_ROOT/.kernel/crontab"; do
  [ -f "$c" ] && { CRONTAB_SRC="$c"; break; }
done
if [ -n "$CRONTAB_SRC" ] && command -v cron >/dev/null 2>&1; then
  {
    printf 'CLAUDE_CONFIG_DIR=%s\nGH_CONFIG_DIR=%s\nWIKI_DIR=%s\nBRAIN_ROOT=%s\n' \
      "$CLAUDE_CONFIG_DIR" "$GH_CONFIG_DIR" "$WIKI_DIR" "$BRAIN_ROOT"
    cat "$CRONTAB_SRC"
  } > "$ROCK_DIR/crontab"
  if crontab "$ROCK_DIR/crontab" 2>/dev/null && cron 2>/dev/null; then
    CRON_LIVE=1
    ok "org cron installed from $CRONTAB_SRC"
  fi
fi
[ "$CRON_LIVE" = 1 ] || mut "  cron: off (drop a crontab at $BRAIN_ROOT/cockpit/crontab to enable)"
echo

# ============================================================================
# 8. Hand off to code-server (the browser IDE the healthcheck probes on :7781),
#    rooted at the org brain. The base image bakes it; if it is missing the image
#    is broken, so fail loud rather than limp on. We exec it as the container's
#    foreground process so tini reaps it and signals propagate cleanly.
# ============================================================================
# ---- cadence: the in-container scheduler, same one the member boxes run -------
# A ROCK HAD NO CADENCE AT ALL. The block above installs a crontab only if the
# brain ships one AND `command -v cron` succeeds, and cron is not on this image's
# PATH (checked on the live rock 2026-08-04), so it never installed: exactly the
# broken system-cron path engine/cron/scheduler.mjs was written to replace on the
# member side. Consequence, verified on a real rock: no scheduler process, no
# cadence.log, and therefore the registry appliers never ran unattended, on the
# one kind of box where control/ actually lives.
#
# Started here, backgrounded, before the code-server handoff execs and takes over
# as PID 1's pebble. Failure to start is not fatal: a box that serves its console
# but misses a cadence tick is recoverable, a box that will not boot is not.
# THE SCHEDULER TAKES THE MINERAL ROOT, NOT THE BRAIN ROOT (fixed 2026-08-11).
# It was handed $BRAIN_ROOT (/state/brain), but every path the jobs resolve off
# that argument is mineral state, not brain content: enrol-sync's token guard is
# $stateDir/secrets/box_directory_token and reconcile sources
# $stateDir/secrets/provisioning.env.local, and boot-rock writes BOTH to
# $STATE_DIR/secrets. So each looked under /state/brain/secrets, found nothing,
# and took its `|| true` branch — no error, no log line, nothing in cadence.log.
# A rock that never registered with the directory looked exactly like a healthy
# rock from inside, which is why this cost a day.
#
# The brain root is NOT lost by this: jobs that need it resolve it themselves
# from /state/deployment.yaml (BR_RESOLVE in scheduler.mjs), so it was never the
# argument's job to carry it.
if [ -f "$AIOS_DIR/engine/cron/scheduler.mjs" ]; then
  AIOS_SCHEDULER_ROLE=rock node "$AIOS_DIR/engine/cron/scheduler.mjs" "$STATE_DIR" >"$ROCK_DIR/cadence.log" 2>&1 &
  ok "cadence scheduler started (base jobs; reconcile runs the registry appliers)"
else
  mut "  cadence: no scheduler in this image; appliers will only run when a human opens the console"
fi

command -v code-server >/dev/null 2>&1 || \
  die "code-server not found; the base image is broken (it should be baked in)."

# Persist a stable IDE password (gitignored scratch, not the brain repo). Honour
# a provisioner-supplied PASSWORD on first boot, else generate a random one.
PWF="$ROCK_DIR/code-server-password"
if [ ! -f "$PWF" ]; then
  if [ -n "${PASSWORD:-}" ]; then printf '%s' "$PASSWORD" > "$PWF"
  else head -c 18 /dev/urandom | base64 | tr -d '/+=' > "$PWF"; fi
  chmod 600 "$PWF"
fi
CS_PW="$(cat "$PWF")"

# code-server needs a writable HOME + user-data-dir (no home for this uid). Seed
# VS Code settings so the brain opens TRUSTED (no Restricted Mode dialog).
CS_HOME="$ROCK_DIR/cs-home"; mkdir -p "$CS_HOME"
CS_USER_DIR="$ROCK_DIR/cs-data/User"; mkdir -p "$CS_USER_DIR"
[ -f "$CS_USER_DIR/settings.json" ] || printf '%s\n' '{' \
  '  "security.workspace.trust.enabled": false,' \
  '  "workbench.startupEditor": "none",' \
  '  "telemetry.telemetryLevel": "off"' \
  '}' > "$CS_USER_DIR/settings.json"

# App-first (Sam, 2026-08-05): an org reaches its rock through the Crads-AI app's org
# face and Claude Code over SSH, not a browser URL and a shared password.
#
# This script EXECS code-server as the container's foreground process, so honouring the
# flag means replacing that process, not just skipping it. An exit here is a restart
# loop under Restart=always, and the only SSH door into the rock runs through this
# container, so a rock that cannot stay up cannot be reached to be repaired (brain-2,
# 2026-07-30, recovered only via Hetzner rescue mode). Hold the foreground open instead.
#
# Absent flag means ON, deliberately: this script ships in the image, so a rock stamped
# before today runs this copy on its next :v2 update and must not lose its console from
# an image bump nobody asked for.
if [ "${BROWSER_IDE:-on}" = "off" ]; then
  b "This rock is app-first. Open it with the Crads-AI app, or Claude Code over SSH."
  mut "  No browser login and no password: the operator's device key is the way in."
  mut "  The tunnel routes nothing to :$IDE_PORT, so there is no public surface here."
  echo
  exec sleep infinity
fi

b "Rock workspace is live. Full VS Code in your browser:"
printf '  \033[36mhttp://localhost:%s\033[0m\n' "$IDE_PORT"
printf '  password: \033[1m%s\033[0m\n' "$CS_PW"
echo
mut "  Reachable in production via the Cloudflare tunnel (${DEPLOYMENT_DOMAIN:-unset}), :$IDE_PORT bound to loopback."
echo

# THE SMOKE CONTRACT (2026-08-20 audit, trap 5). One deliberate machine-readable
# line, emitted immediately before the code-server handoff, so a smoke can assert
# that this rock reached the end of its boot with the deployment it was staged
# with. The CI smoke used to grep the human banner above ("<name> (rock /
# factory)") and a code-server log line, which is exactly what trap 5 forbids:
# "a smoke asserts structural hooks, never copied strings". Rewording the banner,
# or a code-server upgrade changing its startup log, failed every image publish
# while the rock was perfectly healthy, and the same two strings were pinned in a
# second place as well. Display copy above is free to change; THIS line is the
# contract, and changing it means changing the smokes that read it.
printf 'AIOS-BOOT-OK rock deployment=%s brain=%s ide=%s\n' "$DEPLOYMENT_NAME" "$BRAIN_ROOT" "$IDE_PORT"

exec env HOME="$CS_HOME" PASSWORD="$CS_PW" code-server \
  --bind-addr "0.0.0.0:$IDE_PORT" --auth password \
  --user-data-dir "$ROCK_DIR/cs-data" \
  --extensions-dir "${CODE_SERVER_EXTENSIONS_DIR:-/opt/vscode-extensions}" \
  --disable-telemetry --disable-update-check \
  "$BRAIN_ROOT"
