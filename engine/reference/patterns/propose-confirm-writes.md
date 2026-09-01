---
title: Propose-confirm on substantive writes (show before you write, not after)
maturity: assistant-can-adopt-now
---

## What it is

A named, explicit rule (not just a habit that happens to hold today) that any substantive write to durable state (a new claim on a brain page, an outbound message, a price change) is shown to the human before it's written, not written and then announced. "Substantive" means anything carrying a new fact, a framing choice, or a claim someone else will read, not a mechanical, fully-reversible sync.

## Why it matters

Showing a draft before it's committed gives the human a chance to redirect tone, framing, or a factual detail while it's still cheap to change. Once something is written, and especially once it's sent to someone outside the business, a correction is a cleanup and possibly an apology, not a first draft. The gap between "I usually show drafts first" and "this is a named rule" matters because the informal version is exactly what erodes first when a session gets busy.

## How to adopt it on this box

- This overlaps with `comms.outbound_policy: propose-confirm`, which already covers sends. The gap is scope: name the same rule explicitly for brain writes and first-draft content too, not just messages that leave the building.
- Write it as its own short rule referenced by any skill that drafts outbound copy or writes new page content, the same way the outbound policy is already named in the profile. A documentation change, not new code.
- Carve out the genuinely mechanical, idempotent syncs (a log append that's already been shown as a diff, a date-stamp bump) so the rule doesn't become friction on things that don't need a second look. See `contact-log-idempotency.md` for the shape of what's safe to write without a fresh confirm each time.

## Signals you need it

- The assistant edits a page or drafts a message and only mentions it after the fact.
- The client has had to ask "wait, did you already send that?"
- A draft that needed a factual correction only got caught because the client happened to re-read it after it went out.
