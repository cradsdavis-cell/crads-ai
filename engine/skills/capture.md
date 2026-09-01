---
name: capture
title: "Capture the session"   # human name shown on the Skills page (2026-08-09 audit R6); the slash id stays as a chip
description: End-of-session sweep. Scans the conversation AND any configured capture sources (meetings, comms), diffs against the client's brain + tasks + calendar, proposes the updates that should have been written but weren't, confirms, writes.
category: capture         # Skills-page grouping (briefing|capture|comms|box|org|other) — wire vocabulary, not copy
generic: true        # config-driven; no client-specific values in this file
reads_profile:
  - identity.timezone
  - identity.user_short
  - accounts.calendar.calendar_id
  - accounts.tasks
  - accounts.messaging
  - capture.sources
  - capture.brain_path
  - capture.task_filter
  - classifications
  - comms.outbound_policy
reads:
  - the active conversation / session
  - the client's brain (wiki) under capture.brain_path
  - tasks + calendar + any enabled capture.sources
writes:
  - brain pages, decisions log, session log (confirmed)
  - tasks / calendar (confirmed)
  - per-source sweep state under capture.brain_path
---

# Skill: /capture  (generic)

The session-close sweep. A working block opens with `/session`; `/capture` closes it. Anything the session touched that never reached its home surface lands here. **Everything client-specific comes from `/state/profile.yaml` — this skill hard-codes nothing about any person, account, or tool.**

## Trigger
`/capture` — full sweep across every destination surface + every enabled `capture.sources` input.
`/capture <hint>` — narrow to the hinted material (e.g. `/capture decision`, `/capture pricing framework`).
`/capture <source>` — scope to one configured source by its `name` (e.g. `/capture meetings`), skipping the session-text scan. Useful for batch-processing a backlog.

## Surfaces — where captured material goes
| Surface | What lands here | Gated on |
|---|---|---|
| **Brain (wiki)** | Decisions, insights, frameworks, person/org notes, session outputs, relationship edges | always |
| **Tasks** | New committed next-actions; completions mentioned but not ticked; reschedules | `accounts.tasks.enabled` |
| **Calendar** | Meetings/deadlines/time-blocks scheduled, moved, or cancelled | `accounts.calendar.enabled` |
| **CRM / leads** | Stage flips, next-action changes (propose-only, never silent-write) | client has a leads store |

The brain is the default surface. Tasks / Calendar / CRM are the extensions. **Scan window:** since the last `/capture` close OR the session open, whichever is later. First sweep of the day = full-session scope.

---

## 0. Input sources — scan each enabled `capture.sources`
Before the surface diff, pull raw material from every configured input source. **`profile.capture.sources` is a list** — each entry names a `provider`, what it captures, and its routing defaults. There is NO hard-coded list of meeting tools or chat workspaces; iterate whatever the profile enables. Typical entries:

- a **meeting/transcript source** (`provider: <transcript tool>`) — recorded calls + counterparty-shared transcripts
- a **chat/DM source** (`provider: slack | whatsapp | …`, gated on `accounts.messaging.*`) — active DMs that accumulate context between sessions
- the **conversation itself** — always scanned unless a `<source>` scope was passed

For each enabled source, per item:
1. **Read sweep state** at `capture.brain_path/system/<source>-sweep.md`. Skip items already logged. Missing file → default to a 7-day window.
2. **Pull new items** since last sweep via the source's read tools (read-only — input sources never get written back to).
3. **Filter noise** — drop tutorials, mis-fires, sub-minute recordings, passing mentions with no fact-content.
4. **Classify** each item using `profile.classifications` (first match by name / domain / keyword wins; no match → `📅 General`). This decides the routing.
5. **Contextualise** — read the relevant brain page(s), separate decisions + action items from discussion, link names to brain pages.
6. **Route** per the classification's destinations, then **roll into the Step 2 consolidated diff** as its own block.
7. **Log** one row per processed/skipped item to the source's sweep state file.

**Entity pass (runs inside source + session scans):** for every person / org / project carrying *new* facts, check the brain for a matching page. Exists → propose the field-level delta. Missing + enough context (role + connection + 1–2 facts) → propose a stub. Just a name → ask one clarifying question first. Never overwrite; append or correct named fields only.

**Source failure is non-blocking:** if a source's tools are unreachable or auth-expired, skip that source, note it, and continue the rest of the sweep. Log the failure to `capture.brain_path/system/health-log.md`.

---

## 1. Scan the session + apply the task filter
Read the active session note + conversation context. Classify each candidate by surface. If `<hint>` was given, narrow to it; else surface the top 3–5 candidates per surface and confirm what's in/out before writing. Skip restatements of existing state and hypotheticals.

**Task proposal filter** (apply before any task add reaches the diff). Drop the candidate if any fires:
- it's a watch / monitor / silent-check on a contact → that's CRM state, not a task
- the leads store already covers it (next-action date, scheduled chase, stage flip)
- it's hypothetical / "might want to" — the client didn't commit
- it's a follow-up nudge to someone who owes the client the next reply
- it restates state already in a brain log and has no DO verb
- an existing task already covers it (name-substring match)

A task survives only with **(a)** a DO verb, **(b)** owner = the client, and **(c)** a date or trigger. Honour any per-client overrides in `profile.capture.task_filter`. **Cap: 3 task proposals per source per sweep** — if more clear the filter, rank by priority and note the deferred count.

## 2. Diff each surface, present one consolidated block
Read current state before proposing any write, so each block shows current → proposed:
- **Brain** — grep the decisions log for same-date near-matches; grep concept/research/people paths for near-slug matches (dedup).
- **Tasks** — query the provider scoped to the relevant project; name-substring dedup.
- **Calendar** — `get_events` over the session window + any dates mentioned; don't re-propose changes already pushed mid-session.
- **CRM / leads** — read only if a lead state change is candidate-worthy.

```
Sweep proposal — {date} session ({topic})

BRAIN
  • NEW concept: <path> — frontmatter + relationship edges
  • APPEND decisions log: [{date}] DECISION: … | REASONING: … | CONTEXT: …

TASKS
  • ADD: "…" — {priority} — due {date}   (no duplicates found)

CALENDAR
  • (nothing missed)

CRM
  • PROPOSE lead update: <name> — <change>   (propose-only)

Apply? (y = all / per-surface / skip / edit)
```

## 3. Confirm, then write in dependency order
Per `comms.outbound_policy` (default `propose-confirm`) — **never silent-write; every surface shows its diff.** CRM/leads always needs an explicit per-lead `y` even inside a bulk approval. On `y`, write in this order so downstream reads stay consistent:
1. **Brain pages** — new pages from the client's templates, per the brain's frontmatter rules; bump `updated:` on edits.
2. **Brain index + log** — append new pages to the index; one log line per captured item.
3. **Tasks** → 4. **Calendar** → 5. **CRM proposal** (surface the command, wait for `y`).
6. **Sweep state** — append the per-source rows logged in Step 0.

**Decisions always append to the decisions log** (`[{date}] DECISION: … | REASONING: … | CONTEXT: …`) even when they also get a first-class page (promote if load-bearing). For every new brain page, propose 1–3 typed relationship edges from the brain's vocabulary.

## 4. One-line summary
```
Swept. Brain: 1 concept + 2 decisions. Tasks: 3 added, 1 done.
Calendar: 1 moved. CRM: proposing lead update — <name>.
```

## Rules
- **Never silent-write.** Diff per surface; honour `comms.outbound_policy`.
- **Idempotent.** Re-running in the same session = no duplicate writes; every surface dedups first.
- **Non-destructive.** Never deletes. Archive instead, per the client's deletion policy.
- **Respect mid-session reflexes** — if a change was already pushed live, detect it in the diff and don't re-propose. `/capture` is the safety net, not a replacement.
- **Read-only on input sources** — meetings/comms are pulled, never written back to.
- If a source returns nothing, say so — never fabricate.
- **Failure mode:** if one surface write errors, complete the others, report which succeeded; don't roll back.

---

### Genericisation notes
Lifted from the Sam-coupled original → now config (or dropped):
| Was hard-coded | Now reads from |
|---|---|
| Otter as primary meeting tool + its 4 MCP tools + sweep log | a `profile.capture.sources` entry (`provider`-driven) |
| Slack sweep + hard-coded workspace DM channel IDs | a `profile.capture.sources` entry gated on `accounts.messaging.slack` |
| Granola sweep (already retired) | dropped — Sam-specific |
| 5-type meeting taxonomy (WC / Consulting / Career / PhD / Personal) | `profile.classifications` |
| Named routing targets (`short-term-income`, `wildly-calm`, `long-term-career`, `phd` projects; `matt-cleary`, etc.) | classification routing + `profile.capture.brain_path` |
| WC `_TEMPLATE - Meeting Minutes` Drive doc auto-fill | dropped — Sam-specific (a classification's routing can name a doc template if a client needs one) |
| `notes/` / `decisions/log.md` / `notes/system/*-sweep-log.md` paths | `profile.capture.brain_path` |
| `mcp__todoist__*`, `mcp__otter__*`, `mcp__slack__*` tool names | provider abstraction (`accounts.tasks.provider`, source `provider`) |
| a hard-coded timezone / calendar address | `profile.identity.timezone` / `profile.accounts.calendar.calendar_id` |
| Leads Sheet diff-and-confirm discipline | generic CRM surface + `comms.outbound_policy` |
| `/lead`, `/meeting`, `/thread`, `/morning` skill cross-refs + deep-dive escalation | dropped — depend on Sam's specific skill set |
| memory anchors (`feedback_*`) | dropped — Sam-specific (intent folded into the task filter + rules) |

## Summary line (run history)

End your final reply with a `## Summary` section containing ONE plain sentence of outcome. It becomes this run's line in the member's app (run history); without it the last output line is used.
