---
title: Self-healing reflexes (a trigger table for in-conversation updates)
maturity: assistant-can-adopt-now
---

## What it is

One short table mapping things that happen in conversation (a new customer named, a decision stated out loud, a price changed, a supplier relationship shifting) to the specific action the assistant takes automatically (create or update a page, append to a decisions log, propose an edit). Without the table, whether a fact gets captured depends on whether the assistant happens to notice mid-conversation.

## Why it matters

A brain should update itself as it hears things, not only during a formal weekly review. Relying on the assistant to "just remember to write it down" means capture quality depends on how much else is going on in that conversation, exactly the condition under which the important stuff gets missed. A named, specific trigger table turns "I should probably note that" into a reflex that fires the same way every time.

## How to adopt it on this box

- Build a short table specific to this business's own vocabulary (pull the categories from `profile.classifications`: what counts as an enquiry, a booked client, a supplier, for this business specifically):
  - a new customer or supplier is named → check for an existing page, create a stub if missing
  - a price or offering changes → update `business.md`'s offerings list + append a log line
  - a decision gets stated ("we're doing X", "not doing Y anymore") → append to the decisions log
  - a relationship changes (a supplier goes quiet, a client becomes a regular) → update the relevant person/org page
- Keep the table to the handful of triggers that actually recur in this business. A generic 20-row table nobody customised to the client is worse than a tight 5-row one that matches how they actually talk.
- Prefer proposing the update over silently writing it, except for genuinely idempotent syncs (see `contact-log-idempotency.md`).

## Signals you need it

- The assistant answers "did we ever decide X" with "I don't see that anywhere" despite the client having said it out loud in an earlier session.
- Customer or supplier pages go stale relative to what's actually been discussed with the assistant.
- Facts only get captured when someone runs a deliberate review, never in the moment they were said.
