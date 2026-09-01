---
name: plan-week
title: "Plan your week"   # human name shown on the Skills page (2026-08-09 audit R6); the slash id stays as a chip
description: Monday goal-setter. SETS this week's 3 to 5 concrete outcomes (Mon to Fri) and writes them to wiki/this-week.md, the surface the daily brief reads and the close-of-day checks against. The planning yang to /weekly's review yin. Run at the start of the week.
category: briefing        # Skills-page grouping (briefing|capture|comms|box|org|other), wire vocabulary, not copy
generic: true        # config-driven; no client-specific values in this file
reads_profile:
  - identity.timezone
  - identity.user_short
  - accounts.tasks
  - accounts.calendar.calendar_id
  - business.quarter_goal
  - priorities.source
  - models.strategy
reads:
  - wiki/this-week.md            # last week's goals, for carry-over
  - wiki/daily/*-weekly.md       # most recent /weekly review, seeds next week's focus
  - wiki/priorities.md           # whatever priorities.source names
  - wiki/projects/*/README.md
writes:
  - wiki/this-week.md            # this week's goals (overwrite), on confirm
---

# Skill: /plan-week  (generic)

Set the week before it sets you. Decide the 3–5 outcomes that, if done by Friday, mean the week moved, and write them where the morning brief will read them every day. **Everything client-specific comes from `/state/profile.yaml` + the client wiki, this skill hard-codes nothing about any person.** Run on `profile.models.strategy` (deep-reasoning slot, this is a thinking task, not a sweep).

> **Why this exists.** The morning brief (`/daily`) and the end-of-day check both *reference* "this week's goals", but without this skill, nothing ever **sets** them. This is the setter. It writes `wiki/this-week.md`; `/daily` reads it; the close-of-day checks progress against it. That's the loop.

## 0. Timing
Best run Monday morning (or the client's week-start). Read today's date in `profile.identity.timezone`.
- If it's mid-week, say so and offer to set goals for the **remainder** of the week rather than pretending it's Monday.
- Respect `profile.cadence.quiet_hours` if invoked proactively by cron, propose, don't interrupt.

## 1. Look back one week (carry-over)
- Read `wiki/this-week.md` if it exists, these were *last* week's goals. For each, ask the client (or infer from completed tasks / the weekly review): **hit, missed, or partial?**
- Missed goals that still matter → offer to carry over. Name them explicitly as carry-overs (a goal slipping two weeks running is a signal, flag it).
- If a `/weekly` review note exists (`wiki/daily/{date}-weekly.md`, most recent), read its **"Next week's focus"**, that's the seed for this week. Don't re-derive from scratch if the review already proposed it.

## 2. Pull the longer arc (so the week ladders up)
Read `profile.priorities.source` and `profile.business.quarter_goal`. Every weekly goal must trace to one of them. A weekly goal that ladders up to nothing is busywork, surface it and ask whether it belongs.

## 3. Check the week's real capacity
Read `profile.accounts.calendar.calendar_id` for Mon–Fri in `profile.identity.timezone`. Count the genuinely free blocks. If tasks are enabled (`profile.accounts.tasks`), pull what's already due this week.
- **Don't set 5 ambitious goals into a week with four days of back-to-back meetings.** Match the number and size of goals to the time that actually exists. Say the capacity read out loud.

## 4. Set this week's goals (the core)
Propose **3 goals, max 5**. Each goal is:
- an **outcome**, not an activity, verifiable as done/not-done by Friday ("Send the Henderson proposal", not "work on proposals");
- tied to a named priority or the quarter goal;
- sized to fit the capacity from §3.

Present them, then **work with the client to adjust**, cut, sharpen, reorder, add. This is interactive; don't just dump a list and write it. At most **one stretch goal** (the "if the week goes well" one), mark it as such so a hard week doesn't read as failure.

## 5. (Optional, light) Anchor each goal to a day + first action
For each goal, ask for or suggest: the single next action that starts it, and which day it lands. Keep this light, the point is to set direction, not to over-plan a rigid schedule. Skip if the client just wants the outcomes.

## 6. Write the surface
On confirm, write `wiki/this-week.md` (overwrite, it holds the *current* week only; the previous week's record lives in its `/weekly` note). Use this exact structure so `/daily` and the close-of-day routine can parse it predictably:

```
# This Week: week of {Monday date} ({user_short})

## Goals (Mon–Fri)
1. [outcome], ladders to: [priority / quarter goal]
2. [outcome], ladders to: [...]
3. [outcome], ladders to: [...]
[4–5 optional]

## Stretch (only if it goes well)
- [outcome]   ← omit the section if none

## Carried over from last week
- [outcome] (slipped {N} week(s))   ← omit the section if none

## First actions
- {goal 1} → {action}, {day}
- ...

_Set {date} via /plan-week_
```

If `profile.accounts.tasks.enabled`, offer (don't auto-do) to push the first actions as tasks to `profile.accounts.tasks.provider` with this-week due dates.

## 7. Output to the client
```
## Week set: week of {date} ({user_short})

**This week's goals:**
1. [outcome]
2. [outcome]
3. [outcome]

**Stretch:** [outcome / none]
**Carried over:** [outcome / none]
**Capacity read:** [N free blocks, goals sized to fit]

Saved to wiki/this-week.md, your morning brief will pick these up from tomorrow.
```
Scannable. No prose paragraphs.

## Rules
- **Outcomes, not activities.** If a goal can't be marked done/not-done on Friday, it's not a goal, rewrite it.
- **3 is the target, 5 is the ceiling.** More than 5 means none of them are real priorities.
- **Every goal ladders up.** No orphan goals, each ties to `priorities.source` or `quarter_goal`, or gets questioned.
- **Match goals to real capacity**, a calendar-blind goal list sets the client up to fail.
- **One stretch goal maximum**, clearly marked, so a normal week still counts as a win.
- **Carry-overs get named**, not silently re-added, a goal slipping repeatedly is information.
- Read-only on calendar/tasks unless the client explicitly asks for a change.
- If a source returns nothing, say so, never fabricate a goal to fill the list.

## Integration (how the loop closes)
- `wiki/this-week.md` is the operational weekly surface. **`/daily` should read it** as "this week's goals" (alongside `priorities.source` for the longer arc), and the end-of-day / debrief routine should check the day's progress against it.
- `/weekly` (the retrospective) runs at week-end and proposes next week's focus → that focus is the seed `/plan-week` picks up in §1. The two skills are a pair: `/weekly` closes, `/plan-week` opens.

---

### Genericisation notes (delete once stable)
Built generic from the start (no Sam-coupled original). Config dependencies:
| Concern | Reads from |
|---|---|
| timezone / week-start | `profile.identity.timezone` |
| first-person framing | `profile.identity.user_short` |
| longer-arc priorities + quarter goal | `profile.priorities.source` + `profile.business.quarter_goal` |
| capacity read | `profile.accounts.calendar.calendar_id` |
| task push | `profile.accounts.tasks.enabled` / `.provider` |
| deep-reasoning model | `profile.models.strategy` |
| proactive-run quiet hours | `profile.cadence.quiet_hours` |

## Summary line (run history)

End your final reply with a `## Summary` section containing ONE plain sentence of outcome. It becomes this run's line in the member's app (run history); without it the last output line is used.
