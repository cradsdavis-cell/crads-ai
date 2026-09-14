---
title: The CRIT method
summary: Four steps that turn a vague ask into a brief your assistant can act on, and why the third step is the one people skip.
outcome: brief your assistant in four steps so the first draft lands close, and know when a one-line ask is enough.
audience: public
access: public
mode: how-to
order: 220
pins: engine/skills/onboard.md
reviewed: 2026-09-10
---

Most disappointing answers come from a one-line ask that a person would also
have struggled with. "Write to the supplier" is not a brief; it is a hope.
CRIT is a way of briefing that takes about a minute longer than the hope and
gets you a first draft you can send after two edits. It is Geoff Woods's
framing, from his book The AI-Driven Leader, and the full credit is in
[where these ideas come from](/docs/where-these-ideas-come-from).

The four letters are context, role, interview, task. The order matters less
than the habit of covering all four.

![Context, role, interview, task, in a loop back to context](diagram:crit-four-steps)

## Context: what it needs

Start with what a good assistant would need to know before doing the job.
Who is involved, what has happened, what is at stake, what has already been
tried. On a mineral a lot of this is already in the brain, which is the point
of the interview, so the context step is often one line pointing at a page
rather than a paragraph retyping it:

```
Read the page on Northside Sports Supplies before you start.
```

If the brain does not have the page, that is worth noticing. Say what it
needs to know now, and afterwards ask it to write the page, so the next
brief starts from there. [Grow the brain](/docs/grow-the-brain) is that
habit.

## Role: who it should be

Tell it what seat to sit in. The same facts produce different drafts from an
operations manager and from a friend who happens to know the trade. A role
is one sentence: "You are the practice manager writing on the owner's
behalf." "You are a plain-spoken accountant explaining this to a client who
finds numbers stressful." The role sets the register before a word of the
task is read.

## Interview: let it ask you

This is the step people skip, and it is the one that does the most work.
Instead of guessing what you have left out, ask the assistant to ask you.

```
Before you draft anything, interview me. Ask one question at a time
about whatever you would need to know to do this well. Wait for
each answer. Stop when you have enough, and tell me you have.
```

Three or four questions later, the brief has the detail you would never have
thought to type: that the supplier was late last quarter too, that the
practice has a second supplier it could switch to, that the owner would
rather keep the relationship than win the argument. The assistant knew to ask
because the questions came from the gaps in its own picture, not yours.

The interview-me prompt is Nate Herk's, credited in
[where these ideas come from](/docs/where-these-ideas-come-from). The
onboarding interview your mineral runs when you type `/onboard` is the same
step at the scale of a whole brain: one question at a time, resumable,
following the thread you opened rather than a checklist.
[The interview](/docs/the-interview) describes what it asks about.

## Task: what you want back

Only now the ask itself, made concrete. What form (an email, a list, a
page in the brain), how long, what it must include, what it must leave out,
and what "done" looks like. "Draft the email, under 150 words, name the date
we need, offer the smaller order as a fallback, and do not mention the second
supplier." The assistant drafts; sending is yours, always.

## A worked example

A physio clinic's supplier of treatment-table consumables has missed a
delivery for the second month running. The practice manager opens the
[Terminal](/docs/terminal-page) and types, in one go:

![The Terminal, where a brief like this is typed](shot:member-terminal)

```
Context: read the page on Northside Sports Supplies. They missed
the August order and now the September one; we are down to a week
of stock. We have used them for six years and the owner likes them.

Role: you are our practice manager, writing for the owner.

Interview: before drafting, ask me one question at a time about
anything you need. Stop when you have enough.

Task: then draft an email under 150 words asking for a firm
delivery date by Friday, mentioning we may need to split the order
elsewhere if it slips again. Warm, not threatening.
```

The assistant asks three questions: whether there is a named contact, whether
the owner would accept a partial delivery, and whether price has been raised
in the past year. Then it drafts. The manager edits one sentence, copies it
into her mail and sends it. Then she says "capture what you learned about
Northside", and the supplier's page gains three lines the next brief can
use.

> Tip: label the four parts when you first start, exactly as above. After a
> few weeks you will stop needing the labels and simply write the brief in
> that order; the shape will have become how you ask.

## When to skip it

Not every ask is a brief. Use CRIT when the answer will go somewhere (a
client, a supplier, a decision) or when the job has more than one reasonable
way to do it. Skip it when:

- the brain already holds the context and the register: "reply to Jo about
  Thursday, keep it short" is a complete ask once Jo has a page
- you are asking a question, not commissioning work: "who am I waiting on?"
- it is a built-in skill with its own brief already inside it: `/daily`,
  `/followup`, `/weekly` need no preamble

The richer the brain, the shorter your briefs get, because the context step
is increasingly "read the page". That is why the interview is worth the hour,
and why the habits in [prompting habits](/docs/prompting-habits) lean towards
saying less as the months go on.

## Turn a good brief into a skill

If you find yourself typing the same CRIT brief every week, it is no longer a
brief: it is a recipe. Ask the assistant to save it as a skill of your own,
and from then on it is a single command in the Terminal, schedulable like any
built-in. [Write your own skill](/docs/write-your-own-skill) is the
how-to, and [starter recipes](/docs/starter-recipes) has a dozen to begin
with.
