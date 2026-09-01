# `engine/box/` — the box-side scripts, shipped in the IMAGE

These six scripts run on a member's box: they pull the org inbox, apply an
eviction or a re-anchor, accept a transfer, push a heartbeat, and wire an
org-owned brain.

They used to live in `brain-template/pebble-template/box/` and were baked into
each member's cloud-init at stamp time. That had two costs, and both bit hard on
2026-08-05:

1. **They froze.** Nothing updates a file that was written once into user-data,
   so every machinery fix reached new boxes only. A whole day of fixes (the
   evict detach, the re-anchor guard) could never have reached a single box that
   already existed.
2. **They filled the payload.** Hetzner caps user-data at 32768 B. These scripts
   are 31.5 KB of source, and once compressed they were most of the seed: on
   2026-08-05 a routine stamp died at 31814 B and NO new member could be created
   at all, on any rock.

None of them carries per-member templating — they are invariant product code,
which is exactly what an image is for. `box-up.sh` installs them into the box's
state directory on every start, so a machinery fix now reaches the whole fleet
at the nightly auto-update, and the seed carries only what is genuinely per
member.

The brain template keeps its `pebble-template/box/` directory for a box stamped
before this change; `install_box_scripts` overwrites those copies from here.
