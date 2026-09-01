---
title: Get a brief before the day starts
summary: Install the weekday brief that tells you what is on, what matters most, and what is about to slip.
audience: pebble
access: public
mode: how-to
installs: daily-brief
order: 20
pins: engine/skills/daily.md
reviewed: 2026-08-25
---

Most calendars tell you what is on. Almost nothing tells you what matters, and
that is the gap this closes.

## What it does

At 07:15 on weekdays your assistant reads today's tasks and calendar, works out
which events are which kind of thing from what it knows about you, picks the **top
three**, and names what is at risk.

The top three is the whole point. A list of eleven things is a calendar. Three is
a decision, and it is the bit you cannot outsource to a reminder. The filter it
applies is blunt: if you do only these three today, does the day move? And if
only two things pass that filter, it says two. It does not pad the list to
three, because a padded top three is how top threes die.

"At risk" means something with a deadline you are not obviously moving toward. It
is the part people find uncomfortable and useful in that order. Concretely it is
three things: tasks that are overdue but still matter, anything your busy season
makes urgent right now (it knows your seasons from your business profile), and
items it has been tracking that have gone stale.

## What it looks like

Each calendar event is matched against what your assistant knows about you and
tagged with a badge and a recommended action. An enquiry event does not just sit
there as a title; it arrives with the nudge to reply within 24 hours, because
hot leads go cold fast. An event matching nothing it knows is tagged as general
and left alone.

Here is roughly the shape, for an invented surf-school owner. The details are
illustration, not anyone's real morning:

```
## Daily brief, Tuesday 26 August

### Calendar
- 06:30 to 08:30: Beginners group lesson
  Booked client → nothing owed, just show up
- 13:00 to 13:30: Call with the board supplier
  Supplier → confirm the order quantities before the call

### Tasks
Overdue: chase the insurance renewal (3 days)
Due today: send Saturday's lesson roster

### Top 3 for today
1. Reply to the weekend's two enquiries: peak season, they go cold fast
2. Send Saturday's lesson roster
3. Chase the insurance renewal

### Flags
- Insurance renewal is 3 days overdue and lapses Friday
```

## Install it

Open **Your assistant**, then **Skills**, and install this recipe. It writes:

```json
{
  "daily": {
    "enabled": true,
    "deliver": true,
    "schedule": { "kind": "times", "days": ["mon","tue","wed","thu","fri"], "times": ["07:15"] }
  }
}
```

`deliver: true` sends it to your Telegram, so it arrives where you already look
rather than waiting in an app you have to remember to open. Set it to `false` and
it still runs, and you read it in the app.

Either way, the brief is kept in your brain: each run writes it to a page, and
the latest overwrites the last. Miss the delivery and nothing is lost; open the
app and today's brief is sitting there.

## Why 07:15 and weekdays

Fifteen minutes after [the inbox triage recipe](/docs/morning-inbox-triage), if you have that one. The order
matters: triage first so the brief can already account for what landed overnight,
brief second so it is telling you about a sorted world.

Weekends are off deliberately. A tool that briefs you on a Sunday morning is a
tool you will mute, and a muted tool is worse than no tool.

## Make it better

The brief is only as good as what your assistant knows about your priorities. If
it is picking the wrong top three, the fix is almost never the schedule. It is
that your brain does not yet say what matters to you this quarter.

Tell it. In the terminal or the app, say what you are actually trying to get done
and why, and let it write that down. The next brief will be different. That
feedback loop is the product working as intended, not a workaround for a bad
guess.

You can also run it on demand. Ask for the brief from chat whenever you want a
reset, and give it a focus ("brief me, focus on the retreat") to weight the day
toward that one thing.

## Pair it

The brief reads whatever your week's outcomes are. If you install **plan the
week**, Monday morning sets those outcomes and every brief for the rest of the
week measures against them. Separately useful, considerably better together.

And if the week page is missing or stale, the brief says so rather than
pretending. It falls back to your longer-arc priorities and suggests running
plan the week, so the worst case is an honest brief with a nudge attached, not
a confident brief measured against nothing.
