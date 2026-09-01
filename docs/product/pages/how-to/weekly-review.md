---
title: Close the week honestly
summary: Install the Sunday review that reads the week against what you said you would do, and names what stalled.
audience: pebble
access: public
mode: how-to
installs: weekly-review
order: 50
pins: engine/skills/weekly.md
reviewed: 2026-08-25
---

The other half of the loop. Sunday at 17:00, before the week is over and while it
is still recoverable.

## What it does

Your assistant reads the week: what you logged, how your projects actually moved,
which actions and decisions have gone stale, and what next week needs. Then it
sets the focus.

The useful part is not the summary. It is the **stale** list. Decisions you made
and never acted on, actions that have been open for three weeks, projects you have
not touched since you told it they mattered. Nobody keeps that list themselves,
which is exactly why it accumulates.

"Stale" is not a feeling here; it has numbers. A project with no activity for
seven days or more. A next action unchanged for five. Decisions logged and never
acted on. And at two weeks of zero activity it stops hinting and asks outright
whether the project is still alive, which is a question worth being asked by
something that will not soften it.

## What it actually reads

Four things, and it lints first: a structural check of your brain (dead links,
contradictions, stale pages) runs before the review, so the reading happens on
a brain that holds together. Then it reads the week's log, every active project
page (did it move, is the next action still valid, is anything blocked on
someone else), your tasks (completed against overdue), and the week's session
notes.

The session notes earn their place. Anything that recurs across three or more
sessions gets proposed for its own page or task, presented as a batch you pick
from, never auto-captured. A theme you circled three times in a week is trying
to become a thing; the review is where it gets the chance.

## The focus it sets

The review ends by setting next week up: one primary focus, three key moves,
and exactly one thing to let go of.

The three key moves are concrete actions, never project names. "Send the
proposal" is a move; "the proposal project" is a status. And the let-go-of is
always exactly one, deliberately, because one forces a real prioritisation
call and a list of three casualties is just tidying.

## Install it

**Your assistant**, then **Skills**:

```json
{
  "weekly": {
    "enabled": true,
    "deliver": true,
    "schedule": { "kind": "times", "days": ["sun"], "times": ["17:00"] }
  }
}
```

## Why Sunday at 17:00

Late enough that the week is genuinely over. Early enough that you can act on it
before Monday, which is the difference between a review and a post-mortem.

If Sunday evening is protected time for you, and it should be, move it to Friday
afternoon instead. The clean pairing is that the review happens before
[the plan](/docs/plan-the-week), whichever days those land on. Everything else
is preference.

## What to do when it is uncomfortable

It will sometimes tell you that the thing you said was your priority has not moved
in a fortnight. That is the review working. Two honest responses, and only one of
them is a lie:

- change what you are doing, or
- change what you said your priority was.

Deciding a goal is no longer yours is a legitimate answer and your assistant will
write that down without editorialising. Leaving it on the list untouched for two
months is the option that quietly costs you something, because every brief for
those two months measures you against a thing you had already abandoned.

## The pair

| | When | What |
|---|---|---|
| **plan the week** | Monday 08:00 | sets the outcomes |
| **the weekly review** | Sunday 17:00 | reads what happened against them |

Install both and you have a loop. Install neither and your assistant is a very
well-informed calendar.

At the end it offers to save the review as a note, and that note is not a
keepsake. It is exactly what Monday's planner reads as its seed: the "next
week's focus" you agreed on Sunday becomes the starting proposal on Monday
morning. Skip the save and Monday starts from scratch.
