---
title: Effort routing (match model tier to how much judgement the task needs)
maturity: shipped-in-engine
---

## What it is

How much reasoning effort (and which model) a task gets is matched to how much judgement it actually needs: a fast, cheap tier for high-frequency mechanical work (watching an inbox), a mid tier for normal drafting and conversation, and the expensive, deep-reasoning tier reserved for the handful of tasks where a wrong call is genuinely costly (a weekly strategic review).

## Why it matters

Routing everything through the most expensive setting burns cost and time for no quality gain on mechanical, well-specified work. Routing everything through the cheapest setting under-serves the few decisions that are actually worth getting right, which is the worse failure, because it's invisible until a bad strategic call has already been acted on.

## How to adopt it on this box

- Nothing to build here: this is already implemented via `profile.models.{watcher,brief,chat,strategy}` plus mandatory prompt caching, which gives every client box this tiering out of the box.
- What's worth checking per client rather than building fresh: that any new bespoke skill (built at onboarding or added later) actually gets assigned to the right tier rather than silently inheriting whatever the previous skill used.
- Watch for one specific trap: changing the *model* mid-session breaks the shared cache prefix (expensive), where changing the *effort tier* on the same model does not. Don't conflate the two when tuning cost.

## Signals you need it

- A mechanical daily sweep costs roughly the same as a deep weekly review.
- A client notices the box feels slow on simple, routine things.
- A new bespoke skill was never explicitly assigned a tier and is quietly running on whatever default it inherited.
