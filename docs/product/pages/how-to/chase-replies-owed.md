---
title: Chase the people who owe you a reply
summary: Install the twice-weekly sweep that surfaces threads going cold before they go dead.
audience: pebble
access: public
mode: how-to
installs: chase-replies-owed
order: 30
pins: engine/skills/followup.md
reviewed: 2026-08-25
---

The expensive failure in most people's week is not a task they forgot. It is a
thread they are waiting on that has quietly stopped, and nobody noticed because
waiting looks exactly like progress until it does not.

## What it does

Twice a week, Tuesday and Thursday at 16:00, your assistant looks for open loops:
overdue tasks, messages from people who matter that nobody answered, project
actions that have not moved, commitments you made and have not closed.

Then it tells you which ones are slipping, and it always ends on exactly one
recommended next step: the single highest-leverage loop to close today. A list
of slippage is a mood; one named move is a plan.

**It surfaces, it does not act.** It will not send a nudge, chase anyone on your
behalf, or mark anything done. Every judgement about whether a thread deserves a
follow-up stays yours, because that judgement is relationship work and an
automated nudge is worse than silence. Its only write is its own run log, which
it prunes, and that is what makes "it does not act" precise rather than a
slogan: no task created, no message sent, nothing marked done.

## The five scans

Each run walks five places:

1. **Tasks.** What is overdue, and what is floating. A high-priority task with
   no due date is a named danger here, because nothing will ever make it urgent.
2. **Inbox.** Threads from people who matter that have sat unanswered for about
   a week.
3. **Messaging channels.** The same check on chat, where plenty of real
   conversations actually live.
4. **Projects.** Next actions that have not moved in about three days.
5. **People.** Anyone in your brain's people pages with an open thread, a
   promised next step, or a reply owed.

You can also scope it from chat: `/followup tasks`, `/followup messages`, or
`/followup projects` runs just that scan.

## It watches both directions

The title of this page undersells it. The sweep flags threads going both ways:
messages where they wrote over a day ago and you have not replied (you owe
them), and messages where your last word is more than five days old with no
response (they owe you). Waiting on someone and being waited on look identical
in an inbox; here they are named separately, because only one of them is yours
to fix.

## Will it nag me with the same list every time

No, because it remembers its last run. Before scanning, it reads what it found
last time. Items that stay open across runs escalate rather than repeat flatly,
things you actioned since are not re-surfaced, and whatever is new since last
time is marked as new. The list you read on Thursday is the delta plus the
stubborn, not Tuesday again.

## Install it

**Your assistant** then **Skills**. It writes:

```json
{
  "followup": {
    "enabled": true,
    "deliver": true,
    "schedule": { "kind": "times", "days": ["tue","thu"], "times": ["16:00"] }
  }
}
```

## Why twice a week and not daily

Because a follow-up list that appears every morning gets ignored by Thursday.

This is the single most common mistake people make setting these up: they install
everything daily, get a wall of output, and stop reading any of it. A list you
read twice a week is worth more than a list you skim seven times.

16:00 is chosen so you can actually act on it. Something surfaced at 7am gets
lost in the day; something surfaced at 4pm gets dealt with before you stop.

## What makes it good or useless

It depends almost entirely on whether your assistant knows **who matters**.

An assistant that treats every unanswered email as an open loop will bury you. One
that knows your five most important relationships, which clients are live, and
which threads are commercially load-bearing will tell you three things and be
right about all three.

So if the output is noise, do not change the schedule. Tell your assistant who
your people are and what you are trying to do with them. That is what the
onboarding interview was for, and it is worth revisiting as things change.

## The honest limit

It only sees what it is connected to. Threads that live in a channel your mineral
cannot read are invisible to it, and it will not pretend otherwise. If most of
your real conversations happen somewhere your assistant is not connected, connect
it or accept that this recipe covers half your world.

A connected channel that is down does not take the run with it, either. If a
channel is enabled but unreachable, the sweep skips it and names the skip in
the output, so a quiet section means quiet, not blind.
