---
title: Action logging (every autonomous write leaves a durable, ordered record)
maturity: shipped-in-engine
---

## What it is

Every write the box makes on its own (a task added, a calendar event moved, a brain page changed) is appended to a durable, chronologically ordered log recording what happened, when, and which job did it. This includes failures, not just successes.

## Why it matters

Once a box can act without a human confirming every single individual step (even inside a propose-confirm model, once a batch is approved), there has to be a record a human can audit afterward. Without it, catching a bad automatic action means noticing its effects downstream, by which point it may have already repeated.

## How to adopt it on this box

- Nothing to build: this already exists, and exceeds the version it was benchmarked against. The engine's action ledger is ULID-ordered (so it sorts correctly even across jobs firing close together), carries a defined schema, and logs failed actions as well as successful ones.
- What's worth confirming per client, rather than building: that the ledger is actually **surfaced** somewhere a human will read it (the weekly review, and eventually the evening digest, see `evening-digest.md`) rather than existing correctly but nobody ever looking at it. A perfect log nobody reads has the same practical effect as no log.

## Signals you need it

- "What did the box do today?" doesn't have a fast, confident answer.
- An automatic action goes wrong more than once before anyone notices the first occurrence.
- A client asks for a change and the honest answer to "did that already happen automatically?" requires guesswork instead of a lookup.
