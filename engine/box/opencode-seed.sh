#!/usr/bin/env bash
# opencode-seed.sh: seed the pre-baked OpenCode plugins into a mineral's INTERACTIVE config.
# Idempotent; never touches a sign-in. Called by engine/box-up.sh (pebble) and
# provisioning/rock/boot-rock.sh (rock): ONE script, because the Claude equivalent is
# hand-copied between those two files and hand copies are how this repo's lists drift.
#
#   usage: opencode-seed.sh <authRoot>        e.g. /state/.opencode-auth
#
# WHAT IS SEEDED: <authRoot>/config  (superpowers, GSD Core, skill-creator: the three plugins
# the Claude image bakes, in their OpenCode form) and <authRoot>/cache (the installed plugin
# packages, so first use needs no network).
# WHAT IS NOT: <authRoot>/data (the member's sign-in) and <authRoot>/headless. Unattended
# turns read ONLY headless, which stays empty on purpose: see isolationEnv in
# engine/kernel/lib/harness/opencode.mjs for the config-merge finding behind that split.
set -u
ROOT="${1:?usage: opencode-seed.sh <authRoot>}"
TEMPLATE="${OPENCODE_PLUGIN_TEMPLATE:-/opt/opencode-template}"
[ -d "$TEMPLATE/config/opencode" ] || exit 0          # image without the bake: nothing to do
[ -d "$ROOT/config/opencode" ] && exit 0              # already seeded: a member's edits are theirs
mkdir -p "$ROOT"
cp -a "$TEMPLATE/config" "$ROOT/config" || exit 0
[ -d "$TEMPLATE/cache" ] && [ ! -d "$ROOT/cache" ] && cp -a "$TEMPLATE/cache" "$ROOT/cache"
# GSD writes its absolute install path into a few hundred files, and the bake ran at
# /state/.opencode-auth. Rewrite to THIS mineral's path when it is mounted elsewhere.
# Text files only (-I): the plugin cache holds binaries.
if [ "$ROOT" != "/state/.opencode-auth" ]; then
  grep -rlIZ -- '/state/.opencode-auth' "$ROOT/config" "$ROOT/cache" 2>/dev/null \
    | xargs -0 -r sed -i "s#/state/.opencode-auth#$ROOT#g" 2>/dev/null || true
fi
exit 0
