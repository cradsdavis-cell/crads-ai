---
title: Teach it your voice
summary: The three-step loop that makes drafts sound like you, the self-check you can ask for, and the one page in the brain where your voice lives.
outcome: get drafts that read as yours within a few weeks, by editing to taste, telling it what changed, and asking it to check its own tells.
audience: public
access: public
mode: how-to
order: 250
pins: engine/skills/onboard.md
reviewed: 2026-09-10
---

Your assistant will not sound like you on day one. It has read the samples
you gave in the interview, which is a start, and it still writes like a
careful stranger. The fix is not a setting. It is a short loop you run a
handful of times, and the loop works because of one fact: the edits you make
are the lesson.

## The loop

1. Ask it to draft something real. A reply, a proposal paragraph, a note to
   a client, in the [Terminal](/docs/terminal-page).
2. Edit the draft yourself until it sounds right, then send it from your own
   mail. The assistant drafts; sending is always yours.
3. Tell it what you did:

```
I edited and sent this version. Learn my tone from the changes.

[paste the version you sent]
```

That third step is where the learning happens. It compares what it wrote with
what you sent, works out what the differences have in common, and writes
that into the brain, in the workflow layer, where your voice lives. Do this
five or six times over a fortnight and the drafts start arriving needing one
edit instead of six.

> Careful: the fastest way to ruin the voice is to accept a draft you do not
> quite like. If you send it unedited, you have just told it the draft was
> right. Always edit to taste first; the corrections teach it more than any
> description of your style could.

## Edit its draft, or hand it yours

The loop above starts from its draft. The other direction works at least as
well, and often better: when you have a rough version of your own, hand it
over and ask for a line edit rather than a rewrite.

```
Here is my rough draft. Tighten it and fix anything unclear, but
keep my phrasing and my rhythm. Do not rewrite it in your own voice.
```

A draft that starts from your words keeps your rhythm, because the assistant
is only fixing what is broken. A draft generated from a description of your
style has to guess at the rhythm, and it guesses like a language model. If
you have even three sentences of your own, start from them.

## Describe the voice in tensions, and give the why

When you do describe your voice, adjectives on their own do not help much:
"warm" and "professional" describe half the people in your industry. What
steers the assistant is the tension between two things you are: direct but
not cold, warm but not gushing, casual but never sloppy. Two or three of
those, plus the reason, and it has something to work with.

The reason matters as much as the rule. "Never use em dashes" is a wall it
will find a gap in; "I never use em dashes, it is not how I write, use a
comma or split the sentence" is a piece of context it can generalise from.
That is habit two of [prompting habits](/docs/prompting-habits), and it
applies to voice more than to anything else.

## The self-check you can ask for

Assistants have tells: patterns that read as machine-written to anyone who
knows you. You can ask yours to scan its own draft for them before it shows
you, and to say what it found. Paste this once, or put it in the brain as
described below.

```
Before you show me any draft I will send, check it against this list
and tell me what you found and what you changed:

1. Words I would never use. If you are not sure, ask me for my list.
2. Sentences that all run the same length. Vary them: a short one,
   then a long one.
3. Em dashes. Zero. Use a comma, a colon, or two sentences.
4. Paragraphs that end on a neat little moral. End on a concrete
   detail instead.
5. "Not X, but Y" constructions. One is plenty; two is a tell.
6. Lists of three matching adjectives. Break the pattern.
7. Compliments to the reader that I did not ask for. Cut them.

Report it as "voice check: 6 of 7 clean, flagged: number 4" and show
me the draft underneath.
```

The list is deliberately generic. The first item is the one that becomes
yours: after a few rounds, ask it to keep a page of the words and phrases you
have struck out, and to check against that page every time. A garden
designer's list is not a physio's, and neither is an accountant's.

## Where your voice lives

Everything the loop learns is written to one file in your brain:
`wiki/_layers/8-workflow.md`, the workflow layer. It holds how you write and
speak, the samples from the interview, the tensions you named, the words you
struck out, and the standing checks you asked for. The assistant reads it at
the start of every session, before you have typed a word, which is why a
lesson taught on Tuesday is still in force in a fresh session on Friday.

You can read that page yourself on the [Brain](/docs/brain-page) page, and
you can edit it directly. If the assistant has written something about your
voice that is wrong, fixing the page fixes every future draft. If you want a
longer sitting with it, [Claude Code on your mineral](/docs/claude-code-on-your-mineral)
opens the same files in a full editor.

> Tip: put the self-check in the workflow page rather than pasting it each
> time. "Add the voice check to my workflow page and run it on every draft I
> will send" is the whole instruction, and from then on it is the
> assistant's habit rather than yours.

## Different readers, different registers

One voice is not one register. The note to a long-standing client and the
first email to a new supplier are both you, and they are not the same. Say
so, once, and it will keep them apart:

```
Add to my workflow page: with clients I have worked with for over a
year, skip the pleasantries and go straight to the point. With anyone
new, one line of warmth first, then the ask. Never more than one.
```

That distinction is the sort of thing the interview asks about in the
workflow layer, and the sort of thing it cannot know until you have sent a
few of each. Which is the loop again: draft, edit, tell it, and let the page
grow. [Grow the brain](/docs/grow-the-brain) is the same habit applied to
everything else it knows about you, and [a day with your assistant](/docs/a-day-with-your-assistant)
shows where the voice loop sits in an ordinary morning.
