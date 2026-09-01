---
title: Use Claude Code on your mineral
summary: The fuller way in, for people who want a terminal and their whole brain in one session.
audience: public
access: public
mode: how-to
order: 60
pins: wizard/panel/member.html
reviewed: 2026-09-01
---

The app is the everyday way to talk to your assistant, and for most people it is
enough. This page is for the other case: you want a real session, in a real
terminal, with your whole brain in context and the ability to build things.

That is Claude Code, connected to your mineral over SSH. Same assistant, same
brain, much more room. SSH is not a side door here: your keys are the only
identity your mineral has, so this route is the product's own front door with
the panelling off.

## When this is worth it

Honestly, not always. Reach for it when you are:

- **building or editing skills** rather than running them
- **restructuring your brain**, where you want to see and move files
- doing something long and iterative that a chat window makes tedious

For "what is on today" and "sort my inbox", the app is faster and the terminal is
theatre.

## Getting connected

The connect guide lives in the app under **Help**. It is there rather than here
because it hands you the exact host for *your* mineral, and a page that told you
the general shape would just be a worse version of the thing that knows your
address.

What the guide gives you is an SSH host entry. Once that is in place, opening
Claude Code against your mineral is the same as opening it against any machine
you have access to.

The short shape, so you know what you are in for: in Claude Code, open the
**Environment** dropdown, choose "+ Add SSH connection", name it anything you
like, and put your connection name in the SSH Host field exactly as the app
shows it. Port and identity file stay empty; your key is already on this
computer and the app finds it from the connection name. If this computer was
set up through the app in the first place, the connection is usually already
sitting in that dropdown, folder included, so check there before adding
anything.

When Claude Code asks which folder to open, pick the folder named after your
mineral (a mineral that has not named its folder yet calls it "state"). The
first connection takes a minute while the app sets itself up on your mineral;
after that it is quick. And the first thing to say is **"introduce
yourself"**: your assistant already knows who you are and takes it from
there.

One thing the app itself now says in bold, because the opposite reading cost
people hours: **"This is an extra, not a step."** Connecting Claude Code
signs in your laptop and reaches into your mineral over SSH. It does not sign
the mineral itself in, it does not switch on scheduled jobs, and nothing it
does makes the Overview checklist tick. That item belongs to the Terminal
tab: open it and run `claude` once.

## Connections you make in here stay chats-only

A service you connect from inside a Claude Code session works when you chat
and is invisible to your scheduled jobs, which load their connections from a
different place. This is not hidden from you: the
[Connections page](/docs/connections-page) lists such a service honestly,
marked "in your chats only, not in scheduled jobs", and gives it a one-click
**"Use in jobs too"** button that moves it where jobs can load it. The
sign-in survives the move.

## What is different on a mineral

Two things surprise people.

**Your brain is just files.** Markdown, in a git repository, with wikilinks
between pages. There is no database and no API. You can `grep` it, edit it in
place, move pages around, and your assistant will read whatever it finds next
time. The brain graph in the app draws your actual structure rather than a
structure it expected, so you can see the effect of a reorganisation immediately.

**Skills are files too.** A skill is a markdown file with frontmatter describing
when it applies. Writing a new one is writing a file. Editing one is editing a
file. Nothing needs to be registered, compiled or deployed: it is present, so it
works.

That is the whole reason this route exists. Once you can see that the product is
files, the ceiling on what you can make it do stops being our imagination.

## Your mineral describes itself

At the top of the brain sits a page the mineral writes about itself: what it
is, who holds it, which machines can sign in, what is connected, which skills
are installed and where each came from, and its last few custody events. It
is rewritten on every status update, so it can never be older than the last
run, and your assistant reads it before answering questions about what this
mineral is or can do. You can read it too. It is just a file, like everything
else here.

Skills have an address as well: your own live under the brain's
`.claude/skills/<name>/`, one folder per skill, and each one you installed
from a community carries a small receipt naming the community and the version
it came from. The mineral's software version is on the self-description page
too, and in the app under **Help**, in the Mineral software fold.

## The terminal in the app

There is also a Terminal tab in the app, which is the short version of this: good
for asking your assistant something directly or running a skill by name, not
intended for a long build session.

Use it for `/onboard` and for one-off asks. Use Claude Code when you are actually
working.

## Three cautions

**You have real access.** From a session on your mineral you can delete your own
brain. A pebble has a nightly backup and a repository in your own account, and
neither is a reason to be casual the day you decide to reorganise everything (on
a rock, [the backup is something you do](/docs/back-up-and-restore)).

**The machinery is not yours to edit.** The engine, the scheduler and the app are
maintained by us and replaced when the mineral updates, so a change you make
there is a change that disappears on the next restart. Everything under your own brain and your own
skills survives updates, by design: that boundary is what [who edits what](/docs/the-three-layers)
describes.

**Your edits are pushed on the mineral's schedule, not yours.** The brain
goes to your own repository nightly, at 03:50 mineral time, so a long evening
of terminal edits sits only on the mineral until then. Before a big
reorganisation, ask your assistant to push the brain first; then the state
you are about to change is already somewhere safe.
[Back up and restore](/docs/back-up-and-restore) is the full picture.
