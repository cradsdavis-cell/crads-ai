---
name: followup
title: "Follow-ups"   # human name shown on the Skills page (2026-08-09 audit R6); the slash id stays as a chip
description: Scan for open loops (overdue tasks, unanswered messages from key contacts, stale project actions, pending commitments) and surface what's slipping before it becomes a problem. Read-only; surfacing, not acting.
category: comms           # Skills-page grouping (briefing|capture|comms|box|org|other) — wire vocabulary, not copy
generic: true        # config-driven; no client-specific values in this file
reads_profile:
  - identity.timezone
  - identity.user_short
  - accounts.tasks
  - accounts.inbox_triage
  - accounts.messaging
  - classifications
  - cadence.quiet_hours
reads:
  - logs/cron/followup.md
  - wiki/projects/         # client wiki project pages (Next Actions sections)
  - wiki/people/           # client wiki people pages (open threads)
writes:
  - logs/cron/followup.md  # run log only — never creates tasks or sends
---

# Skill: /followup  (generic)

The thing that kills momentum isn't starting — it's not following through. This skill finds what's slipping. **Everything client-specific comes from `/state/profile.yaml` — this skill hard-codes nothing about any person, contact, or project.**

## Trigger
User invokes `/followup` — optionally scoped: `/followup tasks`, `/followup messages`, `/followup projects`, `/followup all`. Default scope: all. If a scope is given, only scan that scope.

## 0. Read the last-run log
Read `logs/cron/followup.md` — note the last-run timestamp, what was found, and what's still unresolved. Use it to:
- Detect items open across multiple runs (escalate stale loops)
- Avoid re-surfacing items just actioned
- Spot what's new since last run

## 1. Overdue + at-risk tasks
If `profile.accounts.tasks.enabled`, query the configured provider (`profile.accounts.tasks.provider`) for overdue + floating tasks. Flag:
- Overdue tasks still relevant
- High-priority tasks with no due date (floating — danger zone)
- Tasks untouched >5 days on active projects
*(If tasks disabled, skip — say so, don't invent.)*

## 2. Unanswered messages (inbox)
If `profile.accounts.inbox_triage.enabled`, scan the configured source. Per decisions D3, v1 reads the **forwarding mailbox** (`profile.accounts.inbox_triage.forwarding_mailbox`) — NOT the client's own inbox API — unless `mode: "api"`.

**Who counts as a key contact = `profile.classifications`** (not a hard-coded list). For each classification whose `category` marks it relationship-load-bearing (e.g. `booked_client`, `enquiry`, `supplier`, `personal`), find inbound threads from a sender matching its `match` patterns where the client hasn't replied. Flag:
- Unread threads from key contacts
- Threads the client opened but didn't reply to within ~7 days

Tag each flagged thread with its classification `badge`. Threads matching nothing → skip (noise, not a loop).
*(If inbox triage disabled, skip — say so.)*

## 2.5 Unanswered messages (messaging channels)
Some clients' load-bearing contacts live on chat, not email. For each enabled channel:
- If `profile.accounts.messaging.whatsapp`, enumerate recent chats and check the last 3 days of each key-contact chat (key = matches a `profile.classifications` entry).
- If `profile.accounts.messaging.slack`, scan unread DMs + @-mentions for the same key contacts.

For each, check last-message direction + timestamp. Flag:
- **Inbound unreplied** — they messaged, no reply, >24h old
- **Cold outbound** — client's last message >5 days ago, no response

If a channel is enabled but unreachable, skip that channel and note it in the output (e.g. "WhatsApp scan skipped — bridge unreachable"). Do **not** fail the whole run.
*(If a channel is disabled in profile, skip silently.)*

## 3. Stale project actions (wiki)
Scan the `## Next Actions` (or equivalent) sections of the client's active project pages under `wiki/projects/`. Flag next actions older than ~3 days with no log update since.
*(If the client wiki has no project pages, skip — say so.)*

## 4. People + commitments in limbo
Scan `wiki/people/` for anyone with a recent interaction that hasn't been followed up — an open thread, a promised next step, a reply owed. Surface name + what the open thread is. Cross-reference `profile.classifications` to weight load-bearing relationships first.

## 5. Output
```
## Open Loops — {date} ({user_short})

### Overdue Tasks
- [task] — overdue by [N] days — [project]

### Unanswered Messages (inbox)
- [contact] — [subject/thread] — [N] days ago — [badge]

### Unanswered Messages (messaging)
- [contact] — [last direction + snippet] — [N] days ago — [channel]

### Stale Project Actions
- [project] → [action] — last updated [date]

### People / Commitments in Limbo
- [name] — [open thread / what's owed]

### Recommended Next Step
One thing to close today: [highest-leverage open loop]
```
Scannable. No prose paragraphs. If everything's clean, say so — don't invent loops.

## 6. Write the run log
After presenting output, prepend an entry to `logs/cron/followup.md`, times in `profile.identity.timezone`:
```
## [YYYY-MM-DD HH:MM {tz}] — scope=[scope]
**Open loops found:** [count]
**Closed since last run:** [count]
**Key items:** [3-5 bullets]
**Notable change since last run:** [what moved]
**Recommended next step:** [the one thing]
```
Prune to max 20 entries — drop the oldest.

## Rules
- If a scope argument is given, only scan that scope.
- If a source returns nothing or is disabled, say so — never fabricate.
- **Read-only.** Surface loops; don't create tasks, send messages, or write anything except the run log. The client decides.
- Keep output tight — this is a scan, not a report.
- "Recommended Next Step" is always one thing, not three.
- Respect `profile.cadence.quiet_hours` if invoked proactively by cron.

---

### Genericisation notes (delete once stable)
Lifted from the Sam-coupled original → now config:
| Was hard-coded | Now reads from |
|---|---|
| a hard-coded mailbox (Gmail API scan) | `profile.accounts.inbox_triage.forwarding_mailbox` (D3 forwarding model) |
| `AEST` | `profile.identity.timezone` |
| a personal key-contact list | `profile.classifications` (match patterns + category + badge) |
| a personal WhatsApp key-contact list | `profile.accounts.messaging.whatsapp` + `profile.classifications` |
| Slack IC workspace + hard-coded channel IDs (#help-needed, #opportunities-recommendations) | `profile.accounts.messaging.slack` + `profile.classifications` (generic DM/@-mention scan; IC-specific channel scans dropped — Sam-specific) |
| Todoist MCP calls + LinkedIn-draft-rot flag | `profile.accounts.tasks` (provider-agnostic); LinkedIn-rot dropped — Sam-specific |
| `notes/projects/*/README.md` (named project list) | `wiki/projects/` (whatever the client's wiki holds) |
| `notes/people/` named-person checks | `wiki/people/` + `profile.classifications` |
| Leads Tracker Sheet + `.claude/config/leads-sheet.yaml` + `staleness-thresholds` | dropped — Sam-specific (CRM-as-Sheet); generic equivalent folds into §4 people-in-limbo |
| `[[flows/followup]]`, `notes/areas/pipeline.md` supersession notes | dropped — Sam-specific wiki artefacts |

## Summary line (run history)

End your final reply with a `## Summary` section containing ONE plain sentence of outcome. It becomes this run's line in the member's app (run history); without it the last output line is used.
