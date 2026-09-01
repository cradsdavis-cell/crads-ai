# strip-cloud-init-comments.awk: drop the documentation from a rendered cloud-init.
#
# cloud-init.template.yaml carries ~4.5 KiB of `#` prose explaining WHY each
# stanza is shaped the way it is. Every byte of it rides to the box inside
# Hetzner's 32 KiB user-data cap, competing with the member's seeded brain.
# On 2026-08-03 a live stamp blew the cap at 37923 B after the tunnel and DNS
# had already been created, and had to be rolled back. On 2026-08-14 two
# sessions each added ONE line to /etc/ai-os/env; each parent passed the size
# guard on its own (19 B and 2 B of headroom) and the MERGE was 35 B over.
# Trimming prose to buy room is not a repeatable move, so the prose stops
# travelling instead: it stays in git and gets stripped at render time.
#
# What survives, and why:
#   - `#cloud-config`      the first line IS the format declaration. Lose it and
#                          Hetzner hands the VM a file cloud-init will not parse.
#   - `#__..__` markers    provision-pebble.sh splices the host scripts and the
#                          brain seed onto these lines with awk. Strip them and
#                          the box boots with no enter-aios and no brain.
#   - anything inside a    a `content: |` comment is FILE CONTENT on the box, not
#     block scalar         documentation: /etc/ai-os/host-update-signers is an
#                          allowed_signers file whose comments tell an operator
#                          how to arm the update channel, the ai-os.service unit
#                          carries its own, and the runcmd `- |` blocks are shell
#                          scripts whose comments explain a live lockout. A block
#                          scalar is anything indented deeper than the line that
#                          opened it, so this needs no per-stanza list.
#
# Comment-only lines are dropped whole; trailing comments (`package_upgrade:
# false  # keep first boot fast`) are left alone, because telling a value from a
# `#` inside one is a YAML-parser's job, not a regex's.
#
# Single source of truth: provision-pebble.sh renders through this file and
# cloud-init-size.test.mjs measures through it, so the guard can never be
# measuring a payload different from the one that ships.

BEGIN { blk = -1 }

{
  match($0, /^ */); ind = RLENGTH

  # Inside a block scalar: reproduce verbatim until something dedents past the
  # line that opened it. Blank lines belong to the block (they are legal
  # content), so they do not end it.
  if (blk >= 0) {
    if ($0 ~ /^[ \t]*$/ || ind > blk) { print; next }
    blk = -1
  }

  if (NR == 1 || $0 ~ /^#cloud-config[ \t]*$/) { print; next }
  if ($0 ~ /^[ \t]*#__[A-Za-z0-9_]+__[ \t]*$/) { print; next }
  if ($0 ~ /^[ \t]*#/) { next }

  # `key: |`, `key: >-`, `- |`, `- >2` … all open a block scalar at this indent.
  if ($0 ~ /(:|^[ \t]*-)[ \t]*[|>][-+]?[0-9]*[ \t]*$/) blk = ind

  print
}
