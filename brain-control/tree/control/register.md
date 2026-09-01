---
name: register
description: Add or update a member-box registry row from a natural-language update. Metadata only. Shows a diff, waits for y, writes the row, rebuilds the index. Flags the push-down off-switch on a status flip to paused/left.
---

# Skill: /register

Maintain the metadata-only registry. Never write secrets, never read a pebble box.

## Flow
1. Take a member slug + a natural-language update (e.g. "jane01 move to the core tier", "jane paused this month").
2. Read `registry/members/<slug>.yaml` (or start from `registry/members/_TEMPLATE.yaml` if new).
3. Infer the field changes. Allowed fields: display_name, status, provider, cohort, tier, region, add_ons, notes, key_dates. `tier` must be a slug from org-policy `vocabulary.tiers`. Never packs_installed (that is written by install-pack.mjs), never box.* except when the factory writes it at stamp.
4. Show a before/after diff. Wait for explicit `y`.
5. Write the row. Run `node registry/build-index.mjs`.
6. If status changed to `paused` or `left`, print: "Status is now <status>. Run the off-switch to stop push-down and revoke the box read key: `node orchestrator/set-membership.mjs <slug> <status>`." Remember the leaver timeline in org-policy `lifecycle`: nothing is deleted, the tap closes, the box goes with the member.

## Rules
- Diff + confirm on every write. Never silent-write.
- Metadata only. If the update implies member content, refuse and say why.
- One row per member; slug is the key.
