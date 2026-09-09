---
title: Questions, answered straight
summary: The questions people actually ask before and after getting a mineral, each answered in a few sentences with the deep page beside it.
audience: public
access: public
mode: explanation
order: 5
pins: wizard/panel/door.html, wizard/panel/member.html
reviewed: 2026-09-01
---

Short answers, in the order people ask them. Every answer links the page that
carries the detail, and nothing here says anything the deeper pages do not.

## What actually is this?

A private AI assistant that lives on a machine of your own (we call the
machine a **mineral**), knows your world because it interviewed you, and works
for you on a schedule: inbox sorted before you wake, a brief that knows what
matters, follow-ups chased. [What an AI EA actually is](/docs/what-an-ai-ea-is)
makes the full argument; [what a mineral is](/docs/what-a-mineral-is) explains
the two words you will keep meeting.

## What does it cost?

The software is free, and it stays free. What costs money is the machine it
runs on and the AI inside it, and you pay both providers directly:

- a **Hetzner cloud server**, roughly €4 to €30 a month depending on the size
  you pick in the setup wizard, billed to you by Hetzner
- your own **Claude subscription**, billed to you by Anthropic
- **nothing to Crads-AI, ever**

Those facts are also the first screen of the wizard, before anything is
created, so the bill is never a surprise. If someone sets your mineral up for
you or supports you afterwards, that is a service you agree with them, priced
by them; it is never a software fee.

## Can you read my stuff?

No, and under this design the answer is unusually short. Your mineral runs on
your own hosting account, its only key is yours, and nothing about it routes
through Crads AI: no account, no directory, no billing, no tunnel. There is
nothing of yours for us to hold. The one way anyone else gets in is a
[support window you deliberately grant](/docs/grant-support-access), which
expires on its own clock. The [privacy policy](/docs/privacy-policy) is the
binding version.

## Do I need to be technical?

Mostly no. If you can make an account at a hosting company and paste a token,
the wizard does the rest, and
[get a Hetzner API token](/docs/get-a-hetzner-api-token) walks the one
genuinely unfamiliar step. Answering the interview needs no technical skill at
all. The deliberately technical route exists too, for those who want it:
[Claude Code on your mineral](/docs/claude-code-on-your-mineral).

## Do I need a Claude account?

Yes. Your assistant runs on Claude, on **your** Claude account, on your
machine. That is deliberate: it keeps everyone else out of your
conversations. You sign it in once during
[your first hour](/docs/first-hour), and scheduled jobs run on that sign-in.

## Why doesn't installing the Claude Code app count as signing in?

Because it signs in the wrong machine. The desktop app signs in your laptop,
which then reaches into your mineral over SSH; scheduled runs happen with
nobody at the keyboard, so they need the mineral's **own** sign-in. That is
one `claude` run in the Terminal tab, once.
[Claude Code on your mineral](/docs/claude-code-on-your-mineral) explains why
the two are different.

## Where is my data kept?

On the server you created, in the location you picked in the wizard, in your
own Hetzner account, plus a backup in a private GitHub repository in your own
account. The wizard offers whatever locations Hetzner sells, so where your
data lives is your choice, and if you are in Australia and pick a European
location, your data is stored overseas: the
[privacy policy](/docs/privacy-policy) says so plainly, because Australian
privacy law expects it and you should know regardless.

## Which servers is my data actually on?

Two different machines get called "the server" and it is worth separating
them.

**Your mineral** is the machine you rented in your own name. Your notes, your
brain, your skills and your schedule live there and nowhere else, plus the
backup in your own repository.

**Anthropic's Claude servers** are what your assistant sends a question to and
gets an answer back from, on your own Claude account. They do the thinking.
They are not where your world is kept: what goes over is the part of the
question your assistant needs answered, not your filing cabinet.

## What happens if Crads AI disappears?

Less than you would think, which is the honest advantage of this shape.
Nothing of yours runs through us at runtime: your machine keeps running, your
backups keep landing in your own repository. What stops is new software and
us. The
software is headed to an open-source release precisely so that even that gap
can be picked up by someone else.
[What happens if Crads AI goes away](/docs/continuity) answers this at
length, starting by conceding it is the right question.

## Can I leave? What do I keep?

Everything, because you already hold everything. Your brain is readable files
on a machine in your own account, and your backup is in your own GitHub
repository. Stopping is deleting a server you own, in your own hosting
console, whenever you choose. There is nobody to notify and nothing to claw
back.

## What is the interview, and do I have to do it in one go?

The interview is the hour that turns a blank machine into an assistant that
knows your world, and no, it resumes exactly where you stopped, days later if
need be. Three twenty-minute sittings beat one exhausted hour.
[The interview](/docs/the-interview) explains the eight layers and what
happens to your answers.

## Can I rename my assistant?

Yes. One name everywhere: your assistant's name is your mineral's name, and
**Rename** (beside the name on your pebble's page) changes that one thing.
Your connections and your keys stay exactly as they are.

## The brief got something wrong. Is that it?

No, that is day two. Tell your assistant, in plain words, in the Terminal:
what it got wrong and what matters instead. It writes that down and the next
brief reads it. An assistant you correct gets sharper every week;
[your first week](/docs/your-first-week) builds the habit.

## Something looks broken. Where do I start?

[When something looks wrong](/docs/when-something-looks-wrong) lists the
symptoms people actually hit, each with its cause and the page that fixes it.
If a scheduled job went quiet, the answer is usually on
[Connections](/docs/connections-page): jobs fail rather than pretend when a
connection dies.

## What happens when I disconnect a service?

The credential is destroyed on your mineral, immediately. The permission you
originally granted lives at the service's end and is yours to revoke there,
in that account's own settings. The [Secrets](/docs/secrets-page) page shows
what exists on your mineral without ever showing values, so you can check the
result rather than trust it.
[Fix a broken connection](/docs/fix-a-broken-connection) covers the states a
connection can be in.

## How do I use it from a second computer?

A computer that already opens your mineral lets the new one in, directly,
over SSH: no account, no service in the middle.
[Add another computer](/docs/add-another-computer) walks both halves; it
takes about two minutes with both machines in front of you.

## How is this different from just using ChatGPT?

Ask a chat window "what should I focus on today" and you get advice-shaped
filler, because it cannot know you. Your assistant answers from your actual
goals, your actual inbox, your actual people, and it acts on a schedule
instead of waiting to be asked. The longer answer, including what this is
*not*, is [what an AI EA actually is](/docs/what-an-ai-ea-is).

## Who owns what I write? Do you train on it?

You own your content, and it never reaches us, so there is nothing we could
train on. Your assistant's answers to you run on your own Claude account,
under your agreement with Anthropic. The [terms](/docs/terms) say all of
this in the binding form.

## Do I keep using the chat window and the browser extension?

No. Once your assistant is running, this replaces them. You do not need the
browser extension and you can remove it, and you do not need to start work in
a chat window any more.

The reason is not that they are bad, it is that they start from nothing every
time. Your assistant already knows your goals, your people and your inbox, so
work that used to mean pasting context in now just means asking. Your two
interfaces from here are the Crads AI app and the Terminal inside it.

Dictation software is the exception worth keeping: it types into any window,
including this one, so if you already talk rather than type, carry on.

## I have more than one Claude account. Does it matter which one I use?

Use one, and use the same one every time. Your assistant signs in to Claude
once and every scheduled job afterwards runs on that sign-in, so a second
account is the most common reason a setup that looked finished stops
behaving. If you have already signed in with the wrong one, remove the
connection and set it up again rather than adding a second: see
[fix a broken connection](/docs/fix-a-broken-connection).

## How do I know what a skill actually does?

Open it. Every skill on the Skills page carries a description of what it does
and when it runs, and the ones your assistant came with are listed there
alongside any you build. You can also turn a
skill from something you ask for into something that simply happens on a
schedule, and delete any you do not want. The
[Skills page](/docs/skills-page) walks through it.

## Which model should I use, and why did I run out?

Your assistant runs on your own Claude account, so the models you can pick and
the amount you can use are set by your Claude plan, not by us. Stronger models
think harder and use your allowance faster.

Usage runs in windows rather than as one monthly pot, so the useful habit is to
check where you are rather than guess: type `/usage` in the Terminal and it
tells you. If you are running out sooner than you expect, that is usually a
strong model doing routine work, and moving the routine jobs down a level fixes
it without you noticing a difference.

## Are "pebble" and "mineral" standard industry words?

No, they are ours. Nobody else uses them and you will not find them elsewhere,
so if they read as jargon on first contact, that is fair. A **mineral** is the
machine your assistant lives on. A **pebble** is one person's mineral, which
is every mineral there is. [What a mineral is](/docs/what-a-mineral-is) is the
longer version.
