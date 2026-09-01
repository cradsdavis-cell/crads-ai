---
name: pulse-rollup
description: Aggregate the shared pulse sheet into a weekly rollup on a rock-wiki page. Reads only the sheet (never a box), joins on the registry, flags active members who have gone silent as retention risks.
---

# Skill: /pulse-rollup

The rock side of the only member-to-org content flow. Read the shared pulse sheet, never a box. The rollup lands on the rock-wiki page named by org-policy `pulse.landing_page` (default `notes/pulse/`).

## Flow
1. Check org-policy `pulse.enabled`. If false, say so and stop.
2. Read the shared pulse sheet (read-only) via the rock's own Workspace MCP, using `ORG_PULSE_SHEET_ID` from `.env`. Columns: [ slug, iso_week, date, shared_text ].
3. Group by slug and by iso_week.
4. Join on `registry/index.json` (by slug). Consider only members with status `active`.
5. Flag retention risks: active members with no share in the last N weeks (default 2). Silence is the retention signal.
6. Write `<pulse.landing_page>/<iso-week>.md` in the rock wiki: who is moving (recent shares + the gist), who is stalled (active but silent, ordered by weeks-since-last-share), and a short facilitator summary.

## Rules
- The ONLY source is the sheet. Never read a pebble box. There is no code path to do so.
- Ignore paused/left members.
- Read-only on the sheet. This skill writes only the rock-wiki rollup page.
