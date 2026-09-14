---
title: Find what you do not know
summary: Five ways to make your assistant surface what is missing, from your brain, from a plan, and from a decision you are about to make.
outcome: get your assistant to ask you the questions, stress-test a decision before you commit, and show you where the brain is thin.
audience: public
access: public
mode: how-to
order: 285
---

Everything else in this section is about asking your assistant for things.
This page is about the reverse: getting it to ask you, and to tell you what
it cannot see. A brain is built from what you thought to write down, which
means its gaps are exactly the things you did not think of. You cannot find
those by browsing. You find them by asking questions shaped to surface
absence.

Five ways, from the gentlest to the most bruising.

![Known and unknown](diagram:known-unknowns)

## Grill me

The fastest way to get what is in your head onto a page is to be interviewed
about it. Not a form. A conversation where the assistant asks one question at
a time, suggests what it thinks the answer is, and writes down what you say
before asking the next one.

Paste this into the [Terminal](/docs/terminal-page) with your topic filled
in:

```
Grill me about [the topic: a plan, a decision, a new offer,
how the front desk should run].

Rules. Ask one question at a time. With each question, give
me your best guess at the answer from what the brain already
says, so I can confirm or correct instead of starting from
blank. Settle the upstream decision before the ones that
depend on it. If I cannot answer something, write it down as
a flag with who could answer it, and move on.

After every answer, before the next question, write what I
said to a page in the brain called [topic]-notes, with a
running summary at the top and an "Open flags" list at the
bottom. Never hold answers only in the conversation. When we
are done, read the page back for contradictions and give me
the next step.
```

The writing-to-a-page rule is the one that matters. Sessions do not resume,
so an hour of good answers held only in the chat is an hour you lose when you
close the tab. Written after every answer, the page is the record and the
conversation is just the way it got there.

If you find yourself running this more than twice, it is a skill. Ask the
assistant to save the prompt as `.claude/skills/grill-me/SKILL.md` ([write
your own skill](/docs/write-your-own-skill) shows the shape) and from then on
it is `/grill-me`.

> Tip: picture a physio clinic running this on "how should a new patient's first visit go". Forty questions in a morning, and at the end a page the assistant reads before every welcome-pack draft. The questions the owner could not answer became the agenda for the next staff meeting.

## The council

Before a decision you would find expensive to reverse, put it in front of a
panel whose job is to kill it. The adversarial council is Nate Herk's idea
([where these ideas come from](/docs/where-these-ideas-come-from)), and its
structure is what makes it work: opposed stances, taken one at a time, and
then a separate judging pass that none of the stances get to influence.

Write the decision as one falsifiable sentence first ("we drop the
small-garden package and only take design-and-build from October"). Then:

```
I am about to decide: [the decision, one sentence].
What I would be giving up by choosing it: [the other path].
The facts that bear on it: [three to five lines, from the
brain or from me].

Take five stances in turn. Give each its own heading and two
or three sharp points. Do not soften one to agree with
another.

1. The contrarian. Assume this fails. What kills it? What am
   I not seeing because I want it to be true?
2. First principles. Ignore my momentum and everything I have
   already invested. From the facts alone, what does this
   situation call for?
3. The road not taken. Make the strongest honest case for the
   path I am giving up.
4. The outside view. What usually happens to moves like this?
   Use only what you can actually reach: the brain, connected
   services, and a search service if one is connected. Say
   plainly what you could not check.
5. The other side. Speak as the person this decision lands
   on: the client, the supplier, me in six months. Would they
   say yes?

Write all five to a page in the brain called
[decision]-council. Stop there. Do not judge yet.
```

Then close the session, open a fresh one, and paste:

```
Read the page [decision]-council and act as the judge. You
did not write those stances and you are not to average them.
Where do they agree? Where do they contradict, and which side
has the stronger evidence? Which claims were checked and
which stayed assumption?

Give a verdict: green-light, reshape, or kill, with your
confidence, and the two or three sentences that carry it.
Then name the cheapest test: the single lowest-cost thing I
could do in the next two days that would most reduce the
uncertainty. Then the one piece of evidence that would flip
your verdict. Append all of it to the page.
```

The fresh session is not a nicety. A judge that starts with nothing but the
page cannot be swayed by the tone of the conversation that produced it, and
the assistant that wrote the stances will grade them too kindly if you let
it. The verdict has three values on purpose. Reshape is the common one. Kill
is the valuable one, and if it never says kill, it is being agreeable rather
than useful.

## The negative-space audit

The council checks a decision. This checks the brain itself. Once a month, or
before anything big:

```
Read the brain and answer three questions, briefly and
concretely, with page names.

1. What is not in my brain that you would need in order to
   do my job well for a week? Name the missing pages, not
   the topics.
2. Which pages are thin: a heading and two lines where there
   should be a page? List them, worst first.
3. What have I never asked you that someone running a
   [garden-design studio] usually needs?
```

The third question is the one that finds things. The first two find gaps you
would eventually trip over; the third finds gaps you did not know had the
shape of a gap. A two-person accountancy might get back "you have no page on
how you decide which clients to let go", and that is a real answer to a
question they never asked.

An empty page is not a failure, either. The app says so when it has nothing
to show, and says why rather than pretending:

![Nothing here yet](shot:member-empty)

## Audit your skills

The same move works on the skills library. Every few weeks:

```
Looking at how I actually work and the skills I have, what
skills should I add, edit, or remove? Be specific. Point to
tasks I keep doing by hand that could be a skill, and skills
I made but never use.
```

It reads every skill file on the mineral and knows the rest from what you have
told it and captured. Expect it to suggest cutting something. A library you
actually use is short, and [starter recipes](/docs/starter-recipes) is meant
as a shelf to pick from, not a set to complete.

## Ask it about itself

The last one costs nothing. `/explain` is a built-in skill that reads the
mineral and answers questions about it without changing anything: what is
connected, where the data lives, whether the backup ran, who can sign in.
When you are not sure what the system knows or can reach, ask it, and the
answer comes from what is actually there rather than from a manual. "What can
you not see right now?" is a fair question, and it will answer it.

For the limits that are the same on every mineral, [what it will not
do](/docs/what-it-will-not-do) is the written version. For a word on this
page you did not recognise, [the glossary](/docs/glossary) has it.
