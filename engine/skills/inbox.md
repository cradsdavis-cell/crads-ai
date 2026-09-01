---
name: inbox
title: "Inbox triage"   # human name shown on the Skills page (2026-08-09 audit R6); the slash id stays as a chip
description: Triage unread inbox into buckets: open-loop (reply/FYI, leave unread) / mark-read (legit, no action) / archive (junk). Read-only on open-loops; bulk-confirm before any label writes.
category: comms           # Skills-page grouping (briefing|capture|comms|box|org|other), wire vocabulary, not copy
generic: true        # config-driven; no client-specific values in this file
reads_profile:
  - identity.user_short
  - identity.timezone
  - accounts.inbox_triage.forwarding_mailbox
  - accounts.tasks
  - priorities.source
  - classifications
  - inbox.buckets
  - inbox.cap
reads:
  - priorities.source        # client state path
  - decisions log (client state)
writes:
  - inbox labels (UNREAD / archive), only after confirm
---

# Skill: /inbox  (generic)

Triage unread inbox in buckets. Reply-owed and active-context threads stay unread and surface. Legit FYI gets marked read. Junk gets archived. Bulk-confirm before any writes. **Everything client-specific comes from `/state/profile.yaml`, this skill hard-codes nothing about any person, label, or address.**

> **Mail source (architecture, D3).** This product does NOT read the client's Gmail API. The client auto-forwards mail to an operator-owned mailbox, `profile.accounts.inbox_triage.forwarding_mailbox`. All reads + label writes target THAT mailbox. There is no per-client custom-label classifier; buckets are config-driven (`profile.inbox.buckets`).

## Trigger
- `/inbox`, full triage pass
- `/inbox --dry-run`, surface proposed buckets, skip the confirm/write step (trust-building mode)
- Chained from the morning brief (`/daily`) when inbox triage is wanted

## 1. Pull all unread in the forwarding mailbox
Search the mailbox at `profile.accounts.inbox_triage.forwarding_mailbox` for `is:unread in:inbox`, page_size 50. Paginate up to the email cap (`profile.inbox.cap`, default 100).
If more than the cap returned: process the first `cap`, surface footer `⚠ N more unread beyond the {cap}-email cap, run /inbox again after this round.`
*(If `accounts.inbox_triage.enabled` is false, skip, say so, don't invent.)*

## 2. Batch-read content
Batch-read the message IDs (max 50/call). Extract per email:
- sender (name + email) + sender domain
- subject, date (in `profile.identity.timezone`)
- body snippet (~500 chars)
- thread-state, was the last message in the thread from the client or the other party?

## 3. Load open-loop state (read-only context)
Single pass, memoise per run:
- **Contacts / classifications**, match sender name/email/domain against `profile.classifications` (this is what tells the assistant who matters and how to act).
- **Tasks**, if `profile.accounts.tasks.enabled`, pull active tasks from the configured provider; capture content + description for subject/body overlap.
- **Priorities**, read `profile.priorities.source` (within client state) for the current focus.
- **Decisions**, recent decisions log entries (last ~14 days) from client state.

## 4. Bucket each email
Apply rules in order. First match wins. **Tie-break bias:** between open-loop and mark-read → open-loop. Between mark-read and archive → mark-read. False reads cost less than false archives.

Buckets + their match rules are config-driven (`profile.inbox.buckets`). Default scheme:

**Open loop** (NO WRITE, surfaces as REPLY or FLAG):
- Sender matches a `profile.classifications` entry whose category is reply-worthy (e.g. enquiry, booked client, active supplier)
- Subject/body overlaps an active task (sender name OR domain OR distinctive subject token)
- Subject/body overlaps a decision from the last 14 days
- Body contains a direct ask aimed at the client (`?` near end of paragraph, "could you", "would you", "let me know", "what do you think")

Sub-classify open-loops:
- **REPLY**, last message in thread is from the other party AND body contains an ask
- **FLAG**, otherwise (FYI worth knowing, no reply owed)

**Mark as read** (WRITE: remove `UNREAD`, keep in inbox):
- Matches a `profile.classifications` entry whose category is informational with no ask (confirmations, receipts, auto-acks, FYI from a low-priority category)
- Client-side reply already exists within the last 14d covering the latest message

**Archive** (WRITE: remove `UNREAD` + `INBOX`):
- `List-Unsubscribe` header present AND sender not in a `profile.classifications` known category
- Aggressive marketing patterns in subject ("limited time", "% off", "unsubscribe to stop", "act now")
- Auto-reply patterns: subject contains "out of office", "auto-reply", "do not reply"

**Hold** (NO WRITE, ambiguous, surface for client):
- No rule matched
- Open-loop signal AND archive signal conflict

## 5. Surface bulk diff
```
## Inbox triage: N unread ({user_short})

**Open loops** ({{count}})  ← read-only, no write
  REPLY ({{m}}):
    · [date] [sender], "[subject]"
      → [why open-loop: classification / task-match / ask-detected]
  FLAG ({{m}}):
    · [date] [sender], "[subject]"
      → [FYI context]

**Mark as read** ({{count}})  ← WRITE: -UNREAD
  · [date] [sender], "[subject]"
    → [why safe: confirmation / low-priority FYI]

**Archive** ({{count}})  ← WRITE: -UNREAD -INBOX
  · [date] [sender], "[subject]"
    → [why junk: List-Unsubscribe + unknown sender, marketing pattern]

**Hold** ({{count}})  ← no write, decide later
  · [date] [sender], "[subject]"
    → [why ambiguous]

Apply writes? (y = both / m = mark-read only / a = archive only / skip / edit: <indices to drop, e.g. m3 a1>)
```

## 6. Confirm
- `y`, apply all proposed writes (mark-read + archive batches)
- `m`, mark-as-read only, skip archives
- `a`, archive only, skip mark-as-read
- `skip`, no writes, log triage only
- `edit: m3, a1`, drop those indices from their batches; apply remainder
- `--dry-run` at trigger time → skip this step entirely (surface buckets, log no writes)

This is the `profile.comms.outbound_policy: propose-confirm` contract (D4) applied to label writes, nothing changes without explicit approval.

## 7. Apply writes
At most 2 batched label calls against the forwarding mailbox:
1. **Mark-as-read batch:** remove `UNREAD`
2. **Archive batch:** remove `UNREAD` + `INBOX`
Skip a call if its bucket is empty.

## 8. One-line summary
```
Triaged N. Open loops: {{count}} ({{m}} reply / {{m}} flag). Marked read: {{count}}. Archived: {{count}}. Hold: {{count}}.
```

## Rules
- **Read-only on open-loops + holds.** No label changes to those buckets, ever.
- **Always bulk-confirm before writes.** Propose-then-confirm; no silent writes (`profile.comms.outbound_policy`).
- **Conservative on archive.** When in doubt between mark-read and archive, default to mark-read. False archives = lost email; false mark-reads = visible + recoverable.
- **Touch only `UNREAD` + `INBOX`.** Never invent custom labels.
- **Cap at `profile.inbox.cap`.** If backlog exceeds, process the first `cap` + surface footer.
- **Idempotent.** Re-running after a confirmed pass produces no diff, handled emails are no longer unread.
- **Classification bias.** A sender matching a high-priority `profile.classifications` category beats any other signal, if they're here, it's open-loop, even if the body reads as FYI.
- If a source returns nothing, say so, never fabricate.

---

### Genericisation notes (delete once stable)
Lifted from the Sam-coupled original → now config:
| Was hard-coded | Now reads from |
|---|---|
| a hard-coded mailbox / `is:unread in:inbox` on one Gmail | `profile.accounts.inbox_triage.forwarding_mailbox` (forwarding-mailbox model, D3) |
| `AEST` | `profile.identity.timezone` |
| 9 custom Gmail labels (Pipeline / Applications / Network / PhD / Wildly-Calm / Personal / Noise / USYD-Admin / `?Review`) | dropped: Sam-specific; replaced by `profile.classifications` categories |
| Apps Script classifier + Override Sheet additions (Step 8) | dropped: Sam-specific; no per-client custom classifier in this product |
| `notes/people/` tier scan (core/live/warm) | `profile.classifications` (match → category → action) |
| `notes/applications/` stage scan + org/contact slugs | dropped: Sam-specific; generic equivalent = a `profile.classifications` "booked_client"/"supplier" category |
| Leads Sheet `Leads!A2:M50` active rows | `profile.classifications` + `profile.priorities.source` |
| `decisions/log.md` tail | recent decisions in client state |
| `mcp__todoist__find-tasks` | `profile.accounts.tasks` (provider-agnostic) |
| `notes/_layers/6-goals.md` priorities | `profile.priorities.source` |
| 100-email hard cap | `profile.inbox.cap` |
| PhD-label / Matt-Clara-RECS open-loop rule | dropped: Sam-specific |

## Summary line (run history)

End your final reply with a `## Summary` section containing ONE plain sentence of outcome. It becomes this run's line in the member's app (run history); without it the last output line is used.
