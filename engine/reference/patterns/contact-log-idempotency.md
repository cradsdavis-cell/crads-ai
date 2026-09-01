---
title: Contact-log idempotency (don't duplicate a log entry on retry)
maturity: assistant-can-adopt-now
---

## What it is

Before a skill appends a new line to a running log (a contact history on a customer page, an activity log on a project), it first checks whether an equivalent entry for the same date and the same action already exists, and skips the append if so. This makes any skill that writes to a log safe to re-run without corrupting the log's meaning.

## Why it matters

Any skill that can be re-run (retried after a failure, accidentally triggered twice, resumed after an interrupted session) will otherwise duplicate its own log entries. A log padded with near-identical duplicate lines stops being trustworthy: neither a human nor another skill reading it for context can tell what actually happened versus what simply got logged twice by accident.

## How to adopt it on this box

- No generic engine skill writes repeatedly to one log yet, but any bespoke per-client skill that will (a lead-tracking log, a review-request tracker, a booking-follow-up log) should build this in from day one rather than retrofitting it after the first duplicate shows up.
- Use a small, fixed vocabulary of operation phrases per log (e.g. "first enquiry", "quote sent", "booking confirmed", "follow-up sent") so the dedupe check is a simple match: same date + same operation + same subject already exists → skip; otherwise → append.
- If a log needs a second, genuinely distinct entry on the same day (two different customers quoted the same day, say), that's fine. The dedupe check is about *duplicate* entries, not about capping entries per day.

## Signals you need it

- A log shows multiple near-identical lines for the same day.
- A skill's retry after a crash or a re-run produces visible duplicate entries.
- Someone reading a log for context can't tell how many times something actually happened versus how many times it got recorded.
