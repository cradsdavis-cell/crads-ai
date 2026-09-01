---
title: Set the week before it sets itself
summary: Install the Monday goal-setter that writes three to five outcomes where every brief for the rest of the week will read them.
audience: pebble
access: public
mode: how-to
installs: plan-the-week
order: 40
pins: engine/skills/plan-week.md
reviewed: 2026-08-25
---

This is the recipe that makes the others worth having. Without it, your assistant
can tell you what is on and what is slipping, but it has nothing to measure either
against.

## What it does

Monday at 08:00, your assistant works with you to set **three to five concrete
outcomes** for the week, and writes them somewhere durable.

That location matters more than it sounds. [The daily brief](/docs/daily-brief)
reads it. [The follow-up sweep](/docs/chase-replies-owed) reads it. So a Monday
decision about what the week is for quietly changes
what every other recipe tells you for the next five days.

Three to five, and concrete. Not a list of eleven, and not "make progress on the
website". Something that is either true or false by Friday.

Every goal also has to ladder up. Each one must trace to a named priority or the
quarter's goal, and a goal that traces to nothing gets questioned as busywork
rather than written down. At most one goal is a stretch goal, marked as such, so
a hard week where only the core lands still counts as a win.

## What it writes

The week page it produces looks like this, roughly. Details invented:

```
# This week, week of Monday 24 August

## Goals
1. Send the Henderson proposal (ladders to: fill the winter cohort)
2. Publish the pricing page (ladders to: quarter goal)
3. Book the beginner-course venue (ladders to: fill the winter cohort)

## Stretch (only if it goes well)
- Draft the newsletter

## Carried over from last week
- Publish the pricing page (slipped 1 week)

## First actions
- Goal 1 → pull last year's proposal, Tuesday
- Goal 2 → send Rosie the copy, Monday
```

The page holds only the current week. Last week's record does not vanish; it
lives in its review note, written by [the weekly review](/docs/weekly-review).

## What happens to last week

Before proposing anything, it judges last week's goals with you: hit, missed,
or partial. Misses that still matter are carried over by name, with their slip
count showing. And a goal that slips two weeks running is not quietly re-added
a third time; it is flagged as a signal, because repeated slipping is
information: the goal is either mis-sized or not actually yours.

If you ran the weekly review on Sunday, its "next week's focus" seeds Monday's
proposal. The planner does not re-derive the week from scratch when Sunday
already proposed one.

## The capacity read

It reads your Monday-to-Friday calendar, counts the genuinely free blocks, and
sizes the goal count to fit. It will not set five ambitious goals into a week
with four days of back-to-back meetings, and it says the capacity read out
loud, so when it proposes three goals instead of five you can see why.

## Install it

**Your assistant**, then **Skills**. It writes:

```json
{
  "plan-week": {
    "enabled": true,
    "deliver": true,
    "schedule": { "kind": "times", "days": ["mon"], "times": ["08:00"] }
  }
}
```

## It is a conversation, not a report

Unlike the brief or the follow-up sweep, this one needs you. It proposes, based on
what it knows about your goals and what did not finish last week, and you decide.
Ten minutes on a Monday, and it is the ten minutes that the other recipes borrow
their usefulness from.

When you confirm, two small courtesies. If your tasks are connected, it offers
(and only offers, never auto-does) to push each goal's first action as a task
with a due date this week. And if you run it on a Wednesday, it says so and
plans the remainder of the week, rather than pretending it is Monday.

If you ignore it, it will keep proposing and you will keep having a week that
sets itself. That is a real outcome and this page is not going to pretend
otherwise.

## The pair

Two halves of one loop:

| | When | What |
|---|---|---|
| **plan the week** | Monday 08:00 | sets the outcomes |
| [**the weekly review**](/docs/weekly-review) | Sunday 17:00 | reads what happened against them |

Install one without the other and it still works, but the loop does not close.
Planning with no review is optimism, and reviewing with nothing to review against
is a diary.
