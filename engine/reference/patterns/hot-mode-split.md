---
title: Hot/mode split (separate "what's live right now" from "what's always true")
maturity: assistant-can-adopt-now
---

## What it is

Two pages instead of one: a fast-changing "state" page (what's actively true this week: in-flight jobs, upcoming dates, anything urgent) and a slow-changing "priorities/goals" page (the standing direction that only shifts occasionally). The fast page gets rewritten wholesale when things change and is kept deliberately short; the slow page is edited rarely and carries more weight per line.

## Why it matters

Without the split, one "priorities" file has to carry both the timeless strategy and this week's urgent list. Every read is either stale (the urgent stuff moved faster than the file did) or bloated (old, resolved detail still sitting next to what actually matters today). It also means every small update risks touching strategic content by accident, and there's no single place to point a "what's going on right now" question at.

## How to adopt it on this box

- Split whatever the current `priorities.source` (or equivalent single file) is into two: a `wiki/state.md` (or similar) capped short, rewritten wholesale on any material change, and the existing `wiki/priorities.md` / `wiki/goals.md` kept for the slower-moving strategy.
- Point `/daily` (and anything else that needs "what's current") at the state page first, the priorities/goals page second for the longer arc.
- When something changes, replace the relevant section of the state page wholesale rather than appending to it. This page should never need archaeology to read.
- Move anything that's resolved or aged out of the state page into the business's history/log rather than leaving it to accumulate.

## Signals you need it

- The one "priorities" file gets edited multiple times a week.
- The assistant can't answer "what's live right now" without reading the whole priorities file and mentally filtering out the old parts.
- The client says "that's not current anymore" about something on the priorities page more than once.
- A page meant to carry long-term direction has started reading like a running log of this week's events.
