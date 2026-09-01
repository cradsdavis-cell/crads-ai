---
title: Get your inbox triaged before you get up
summary: Install the recipe that sorts every unread email into reply, read later, or archive at 07:00.
audience: pebble
access: public
mode: how-to
installs: morning-inbox-triage
order: 10
pins: engine/skills/inbox.md, engine/cron/cadence-lib.mjs
reviewed: 2026-08-25
---

The problem this solves is not that email is hard to read. It is that deciding
what to do with forty messages costs more attention than reading them, and you
pay it at the worst possible moment: first thing, before you have chosen what
the day is for.

So hand the deciding to your assistant, and keep the reading.

## What it does

At 07:00 every day, your assistant reads everything unread and sorts it into
four buckets:

| Bucket | What happens | Why |
|---|---|---|
| Reply or FYI | left **unread**, so it is still visibly yours | an open loop should stay open until you close it |
| Read later | marked read, left where it is | legitimate, no action, not worth your morning |
| Archive | archived | junk, and you did not need to see it |
| Hold | nothing, surfaced for you to call | no rule matched, or the signals conflict, and guessing is not its job |

Two rules it will not break. It never marks something read that it thinks you
owe a reply to, and it asks before it touches labels in bulk. The whole point is
that you can trust the sorted state; a triage you have to double-check is worse
than no triage.

When two buckets both plausibly fit, it takes the safer one: reply or FYI over
read later, read later over archive. The reasoning is asymmetric on purpose. A
wrongly-read email is still visible and recoverable; a wrongly-archived one is
lost email. And a sender your assistant knows is high priority beats a body
that reads like an FYI: if they are one of your people, it is an open loop,
whatever the email looks like.

## How to read the summary

Open loops arrive marked one of two ways. **REPLY** means the last message in
the thread was theirs and it contains an ask: the ball is in your court. **FLAG**
means worth knowing, nothing owed. Answer the replies, skim the flags.

An email becomes an open loop for one of four reasons, and the summary names
which one fired: the sender is someone your assistant knows matters, the
subject or body overlaps one of your active tasks, it touches a decision you
made in the last two weeks, or the body contains a direct ask ("could you",
"let me know", a question hanging at the end of a paragraph).

Archive is narrower than it sounds. It catches mail carrying an unsubscribe
header from a sender your assistant does not know, aggressive marketing
patterns ("limited time", "act now"), and out-of-office auto-replies. That is
the whole list, which is why the archive bucket is the one you can learn to
stop reading.

## Install it

Open **Your assistant**, then **Skills**, and install this recipe.

![The Skills page, where recipes land](shot:member-skills)

That writes one cadence entry on your mineral:

```json
{
  "inbox": {
    "enabled": true,
    "deliver": true,
    "schedule": { "kind": "times", "days": [], "times": ["07:00"] }
  }
}
```

An empty `days` list means every day. You can see it, and change it, on
**Your assistant > Skills**: set the schedule there and **Save schedules**
writes it. (The machinery jobs are not on that page; they report on the Health
card on your Overview.)

## Change the time

07:00 is a guess about you. The useful question is not what time you get up, it
is what time you want to stop being able to usefully worry about email, and
schedule it before that.

To move it, edit the times list. To make it weekdays only, name the days:

```json
"schedule": { "kind": "times", "days": ["mon","tue","wed","thu","fri"], "times": ["06:30"] }
```

Times are in your mineral's timezone, which the interview set. If a schedule is
malformed, the engine refuses it rather than guessing, and the Skills page tells
you which part it refused.

## Before it can run

It needs your mail connected. If you have not done that yet, the Connections
page is where it happens, and it will tell you plainly if a token has expired
rather than failing quietly at 07:00.

![Connections, with the state of each one](shot:member-connections)

## What to expect on day one

The first run is usually the loud one, because it is triaging a backlog rather
than a night. Read its summary before you trust the archive bucket. After that
it settles into a few messages a morning, and the value stops being the sorting
and starts being that you no longer open your inbox to decide things.

If you want a rehearsal first, run it from chat as `/inbox --dry-run`. It
proposes the buckets and writes nothing, which is the right way to spend day
one if trust is the question.

When it does propose writes, it asks once and takes a short answer: `y`
applies everything, `m` marks read but archives nothing, `a` archives but
marks nothing read, `skip` writes nothing at all, and `edit: m3, a1` drops
those items from their batches and applies the rest.

A big backlog does not break it either. Past the cap (100 emails by default)
it processes the first batch, tells you how many are still waiting, and asks
you to run it again.

## If it sorts something wrong

Fix who it knows, not the schedule. The buckets are driven by the
classifications your onboarding interview built: which senders are clients,
which are suppliers, which are noise. When an email lands in the wrong bucket,
the cause is almost always a sender your assistant has not been told about
yet. Tell it, in chat, in a sentence, and the next morning's triage is
different.

And running it twice costs nothing. After a confirmed pass, a re-run produces
no diff: everything it handled is no longer unread, so there is nothing left
to propose.
