---
title: What happens if Crads AI goes away
summary: The honest answer to "what if you pick up another job", and why the self-hosted shape makes it survivable.
audience: public
access: public
mode: explanation
order: 20
pins: docs/self-host-design.md, engine/backup.mjs
reviewed: 2026-09-01
---

The first serious objection I got to this whole thing was not about the software.
It was: *what happens if you pick up another job, or decide this isn't something
you want to do any more.*

It is the right question, it was asked by someone whose members would have been
the ones affected, and the answer cannot be "don't worry". So here it is
properly. It is also the question that shaped the September 2026 redesign, and
the answer got materially better because of it.

## What I am

One person. Samuel Davis, trading as Crads AI, in Sydney. Not a company with a
board and a runway, and I am not going to dress it up as one. That is the actual
risk you are weighing, and no architecture makes a sole operator into an
institution.

What architecture can do is make the risk *survivable* rather than *fatal*,
which is a different and achievable thing. Most software fails badly when its
vendor disappears, because the vendor holds the thing you actually needed.
This is now built so that I hold nothing.

## Why this survives me

**Your machine is yours, all the way down.** Your mineral runs on a server in
your own Hetzner account, billed to you, opened only by your own keys. You did
not take the box from me; you built it, so there is no sense in which you need
to take the box back if I vanish. It keeps running, keeps its schedule, keeps
answering you.

**Your brain is files, not a database row.** Your pages are markdown in a git
repository, on that machine, mirrored to a repository in your own GitHub
account every night. If Crads AI stopped existing tonight, you would still
have every page, readable in any text editor, on infrastructure I have no
access to. There is no export step, because there is no store of mine to
export from. The **Download a copy now** button on the Backup card exists
anyway, and works with nothing of mine involved.

**Nothing routes through me at runtime.** There is no Crads AI account, no
directory, no billing, no tunnel, no service in the path between you and your
assistant. Your assistant is your Claude account talking to your files on
your machine. Your community, if you have one, is a git repository between
you and its owner. If every piece of my infrastructure went dark tonight,
nothing you use tomorrow would notice.

**The software is headed into the open.** Crads-AI is free, and the code is
being prepared for a public open-source release. Once it lands, the last
remaining dependency on me (new software, fixes for the connectors that rot
when Google or Microsoft change something) becomes something anyone can pick
up: you, someone you hire, or whoever in the community cares enough.

## What you would actually lose

I would rather be specific than reassuring.

- **Updates and fixes stop**, until and unless someone else picks the code up.
  Your mineral keeps running the software it has. What rots over months is
  the world moving: a provider changes an API and nobody ships the fix.
- **Support ends.** Anything on your box that breaks in a way you cannot fix
  yourself stays broken unless you or someone you hire picks it up. It is
  ordinary Linux, node and markdown, so that is a real option rather than a
  theoretical one.
- **Me.** The judgement, the docs staying current, the person to ask. That is
  the one part with no mitigation, and pretending otherwise would be
  marketing.

The narrower version members used to ask (*what if my community's host moves
on?*) now barely needs a section: your community was a repository you pulled
from. If it goes quiet, your mineral carries on unchanged, and everything you
installed stays. [Rocks and pebbles](/docs/rocks-and-pebbles) has the shape.

## What I will do if I stop

Committing to this in writing is the only part of this page that is a promise
rather than a description:

1. **Notice, not silence.** If I wind this down deliberately, everyone running
   a mineral I know about gets told, with a stated date, not left to notice
   the updates stopped.
2. **The code goes public first**, if it somehow is not already, so that
   anyone can keep their machine maintained.
3. **The docs stay up** long enough to outlive the transition, and this page
   is updated to say plainly what has changed.

## What I cannot promise

I cannot promise the project continues. I cannot promise that if I am hit by a
bus tomorrow, the orderly version above happens rather than the abrupt one: it
is one person and there is no second operator today. That is why the design
sections matter more than the promise section. The design is the guarantee; my
intentions are only the improvement on it.

One thing IS yours to do, today, and it is the difference between "survivable"
and "survived": [back up your mineral](/docs/back-up-and-restore) has the one
step only you can do. Do it this week, not the week you need it.

If you are a community leader deciding whether to put your name on this for
your members, the trade in one sentence: **the operator is a single point of
failure, and nothing your members depend on runs through him.**
