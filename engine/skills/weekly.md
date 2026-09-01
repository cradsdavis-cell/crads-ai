---
name: weekly
title: "Weekly review"   # human name shown on the Skills page (2026-08-09 audit R6); the slash id stays as a chip
description: Weekly review. Summarises the week's log, checks project health across active projects, flags stale actions + decisions, sets next week's focus. Run Sunday evening or Monday morning.
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
  - wiki/log.md
  - wiki/projects/*/README.md
  - wiki/decisions/log.md
  - wiki/daily/*-session.md
writes:
  - wiki/daily/{date}-weekly.md   # optional, on confirm
---

# Skill: /weekly  (generic)

Close the week. Know what moved, what didn't, and what next week needs. **Everything client-specific comes from `/state/profile.yaml` + the client wiki, this skill hard-codes nothing about any person.** Run on `profile.models.strategy` (this is the deep-reasoning slot per profile model routing).

## 0. Lint first
Run `/lint deep` if available. Structural issues (orphan pages, dead links, contradictions, stale info) inform the review. Present the output; apply approved fixes before continuing.

## 1. Summarise the week's log
Read `wiki/log.md`. Pull the last 7 days. Summarise what was ingested, captured, researched, decided. Highlight major decisions, new pages, significant captures.

## 2. Review project health
For each README under `wiki/projects/*/` with `status: active`, read it and assess:
- **Momentum**, did it move this week? (check its activity log)
- **Next action**, still valid? overdue?
- **Blockers**, anything waiting on someone else?

Skip `status: archived` projects unless the client reactivates one. Don't hard-code a project list, enumerate from the wiki.

## 3. Tasks week review
If `profile.accounts.tasks.enabled`, query the configured provider (`profile.accounts.tasks.provider`) for:
- Tasks **completed** this week (productivity stats if the provider exposes them).
- Tasks **overdue** from this week.

Flag completed vs missed. *(If tasks disabled, skip, say so, don't invent.)*

## 4. Session-notes sweep
Glob `wiki/daily/{date}-session.md` for the past 7 days. For each, read frontmatter `description`, `## Open Loops at Close`, `## Next Pickup`, and any decision-eligible moments. Aggregate:
- **Unresolved open loops**, items recurring across multiple sessions without closing → candidates to promote to a task or a project README action.
- **Recurring themes**, topics across 3+ sessions → may deserve their own wiki page.
- **Captured-but-uncaptured**, insights worth promoting via `/capture` that never hit the wiki.

For each insight that recurred across ≥3 sessions or is a clear framework/decision, prompt: *"Worth capturing: `{one-line}` → run `/capture`?"* List as a batch; let the client pick. Don't auto-invoke. Don't delete session notes.

## 5. Flag stale or at-risk items
- Projects with no activity for 7+ days
- Next actions unchanged for 5+ days
- People who should have been contacted but weren't (cross-ref `wiki/log.md` + project activity logs)
- Decisions logged but not acted on

## 6. Decisions log check
Read `wiki/decisions/log.md` (if it exists). Any recent decisions that haven't been actioned?

## 7. Draft next week's focus
Read `profile.priorities.source` and `profile.business.quarter_goal`. Based on project health + priorities, propose:
- **Primary focus**, one project or goal to lead with next week
- **Three key moves**, highest-leverage concrete actions across all projects (actions, not project names)
- **One thing to let go of**, exactly one item that's been on the list too long and isn't moving

## 8. Output
```
# Weekly Review: week of {date} ({user_short})

## What moved this week
- ...

## Project health
| Project | Status | Next action | Overdue? |
|---|---|---|---|
...

## Completed tasks
[N completed]

## Session themes + unresolved loops
- ...

## Stale / at-risk
- ...

## Next week's focus
**Primary:** [project / goal]
**Three key moves:**
1. [action]
2. [action]
3. [action]
**Let go of:** [one thing]
```
Scannable. No prose paragraphs.

## 9. Optional: save the review
Ask the client: *"Want me to save this as a weekly note?"* If yes, write to `wiki/daily/{date}-weekly.md`.

## Rules
- Be honest about what didn't move, sugarcoating a weekly review is useless.
- "Three key moves" are concrete actions, not project names.
- "One thing to let go of" is always exactly one, forces a real prioritisation call.
- If a project has had zero activity for 2 weeks, flag it explicitly and ask if it's still active.
- If a source returns nothing, say so, never fabricate.
- Read-only on calendar/tasks/sheets unless the client explicitly asks for a change.

---

### Genericisation notes (delete once stable)
Lifted from the Sam-coupled original → now config:
| Was hard-coded | Now reads from |
|---|---|
| `notes/log.md` | `wiki/log.md` |
| enumerated 6-project README list (short-term-income, long-term-career, wildly-calm, life-admin, australia-goodbye-runway, van) | enumerate `wiki/projects/*/README.md` where `status: active` |
| `notes/daily/*-session.md` | `wiki/daily/*-session.md` |
| `decisions/log.md` | `wiki/decisions/log.md` |
| Todoist-specific MCP tool names | `profile.accounts.tasks.provider` (provider-agnostic) |
| `AEST` | `profile.identity.timezone` |
| "Sam" / first-person framing | `profile.identity.user_short` |
| next-week focus tied to current-priorities | `profile.priorities.source` + `profile.business.quarter_goal` |
| max-effort model assertion | `profile.models.strategy` |
| § 3.5 cash-on-hand (a personal budget-tracking sheet + named inflows) | dropped: operator-specific finance setup; no generic equivalent in v1 (a future `accounts.budget_sheet` field could re-enable) |
| § 3.8 Leads Tracker reconciliation (`leads-sheet.yaml` + Gmail/WhatsApp drift) | dropped: Sam-specific CRM; no generic leads-sheet contract in profile yet |
| § 3.9 Layer 4 (Network) frontmatter regen | dropped: EA-system-specific; a client wiki has no Layer structure |
| § 3.95 coaching health (`/coaching-pipeline`) | dropped: Sam-specific coaching-business skill family |
| § 5.5 refresh `notes/_hot.md` auto-loaded state surface | dropped: EA-system-specific live-state file; a client wiki has none |

## Summary line (run history)

End your final reply with a `## Summary` section containing ONE plain sentence of outcome. It becomes this run's line in the member's app (run history); without it the last output line is used.
