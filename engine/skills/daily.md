---
name: daily
title: "Daily brief"   # human name shown on the Skills page (2026-08-09 audit R6); the slash id stays as a chip
description: Morning prioritisation brief. Pulls today's tasks + calendar, classifies events from the client's profile, picks the top 3, surfaces what's at risk.
category: briefing        # Skills-page grouping (briefing|capture|comms|box|org|other), wire vocabulary, not copy
generic: true        # config-driven; no client-specific values in this file
reads_profile:
  - identity.timezone
  - identity.user_short
  - accounts.calendar.calendar_id
  - accounts.tasks
  - priorities.source
  - classifications
reads:
  - wiki/this-week.md            # this week's goals, set by /plan-week
  - wiki/priorities.md           # whatever priorities.source names
---

# Skill: /daily  (generic)

Morning brief. Pull what's on today, decide what matters, start clear. **Everything client-specific comes from `/state/profile.yaml`, this skill hard-codes nothing about any person.** Compare against the original Sam-coupled version to see what was lifted out.

## 1. Pull today's tasks
If `profile.accounts.tasks.enabled`, query the configured provider (`profile.accounts.tasks.provider`) for tasks due today + overdue. Group by project. Flag overdue, high-priority, and deadline-today.
*(If tasks disabled, skip, say so, don't invent.)*

## 2. Pull today's calendar + classify events
Read `profile.accounts.calendar.calendar_id` for today, in `profile.identity.timezone`.

**Classify each event using `profile.classifications`** (not a hard-coded table). For each event, find the first classification whose `match` patterns hit the title / attendees / domain, and tag it with that entry's `badge` + `action`. Events matching nothing → `📅 General`.

Output each event as:
```
- 13:00–14:00, Coffee with the Hendersons
  💍 Enquiry → Reply within 24h, hot leads go cold fast. Draft via /followup.
```

## 3. Check against this week's goals + current priorities
First read `wiki/this-week.md` (set by `/plan-week`), **this week's goals** are the operational focus the day should move. Then read `profile.priorities.source` for the longer-arc priorities + quarter goal. Weight the day toward this week's goals first, the longer arc second. If a focus argument was passed to the skill, weight toward that.
*(If `wiki/this-week.md` is missing or wasn't set this week, say so and fall back to `priorities.source`, suggest running `/plan-week` to set the week.)*

## 4. Decide the top 3
Pick the 3 highest-leverage actions. Filter: *"If {user_short} does only these 3 today, does the day move the needle?"* Tie each back to a weekly goal (`wiki/this-week.md`) or a priority. Don't pad, if only 2 matter, say 2.

## 5. Flag what's at risk
- Overdue-but-still-relevant tasks
- Anything in `profile.business.busy_seasons` that's live (e.g. enquiry-spike season → "stay on top of replies")
- Stale items the assistant has been tracking

## 6. Output
```
## Daily Brief: {date} ({user_short})

### Calendar
- ...

### Tasks
**Overdue:** ...   **Due today:** ...

### Top 3 for Today
1. [action], [why / which priority]
2. ...

### Flags
- ...
```
Write this brief to `wiki/daily-brief.md` (overwrite, the latest brief, for the record + the dashboard). Scannable. No prose paragraphs.

## Rules
- If a source returns nothing, say so, never fabricate.
- Read-only on calendar/tasks unless the client explicitly asks for a change.
- Connect the top 3 to this week's goals (`wiki/this-week.md`) or `profile.priorities.source` every time.
- Respect `profile.cadence.quiet_hours` if invoked proactively by cron.

---

### Genericisation notes (delete once stable)
Lifted from the Sam-coupled original → now config:
| Was hard-coded | Now reads from |
|---|---|
| a hard-coded calendar address | `profile.accounts.calendar.calendar_id` |
| `AEST` | `profile.identity.timezone` |
| a personal classifier table (named senders + keywords) | `profile.classifications` |
| `notes/_layers/6-goals.md` | `profile.priorities.source` |
| PhD-runway / LinkedIn-rot flags | dropped (Sam-specific); generic equivalent = `business.busy_seasons` |
| Layer-7 marker regen | dropped from generic; a client wiki has no Layer 7 |

## Summary line (run history)

End your final reply with a `## Summary` section containing ONE plain sentence of outcome. It becomes this run's line in the member's app (run history); without it the last output line is used.
