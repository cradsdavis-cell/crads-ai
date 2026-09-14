---
title: Who edits what
summary: Three layers on every mineral: the machinery the project maintains, the infrastructure you own, and the pages you build.
audience: public
access: public
mode: explanation
order: 40
pins: docs/three-layer-model.md
reviewed: 2026-09-01
---

Every part of your mineral belongs to exactly one of three layers, and each layer
has one editor. Knowing which is which answers most "can I change this" questions
before you have to ask.

![The three layers as bands: your pages on top, your infrastructure, the machinery underneath, each with its one editor.](diagram:three-layers)

## Layer 1: the machinery. The project maintains it.

The container image, the engine, the desktop app, the skill runner, the scheduler
and its run history, the system pages, and a handful of protected jobs.

You do not edit these, and you also do not have to maintain them. They arrive
by a nightly restart onto the latest published software
([how updates reach you](/docs/how-updates-reach-you)).

The trade is honest: you give up the ability to change the engine, and in
return the engine is somebody else's problem. And because the software is free
and headed to an open-source release, "somebody else" is not forever a single
company: the layer is maintained *for* you, never held *over* you.

One consequence is worth spelling out, because it looks like a missing feature
until you see why it is there. The machinery jobs (the nightly update restart,
the status check) are visible on your mineral, shown read-only, and **not
deletable from any surface**. A mineral cannot be reached from outside except
through the software it already runs, so a mineral that deleted its own update
channel would go permanently dark: no fix could ever arrive again. The one
deliberate opt-out is turning the nightly update off, and even that is not a
delete: it is a flag your assistant sets when you ask, on purpose, because it
is a considered lifecycle decision rather than a setting to fidget with
([how updates reach you](/docs/how-updates-reach-you) covers what it costs).

## Layer 2: the infrastructure. You own it.

Which skills exist on your mineral, what runs on a schedule and when, which
outside services are connected and with whose tokens, and the machine itself.

Since September 2026 "you own it" is literal all the way down. The server is
in your own hosting account, Hetzner or DigitalOcean, billed to you by them. The only keys that open
it are yours, from first boot: the wizard put this computer's key on the
machine when it was created, and every later machine was
[vouched for by an earlier one](/docs/add-another-computer). There is no
account above you, no host who pays your bill, and no field anywhere in which
somebody else's name could appear as this machine's owner. Whoever pays
the host for the box holds the box, and that is you.

Installing a skill, moving a schedule from daily to twice a week, connecting a
service, disconnecting one: all yours, no permission needed.

### Your sign-ins are yours, and what that honestly costs

The tokens behind your connections (your Google sign-in, your Telegram bot,
the rest) live in your own mineral's state. They survive every update, and
nobody else can read or repair them.

The honest consequence: an expired sign-in can never be silently fixed behind
your back, because nobody holds the access to fix it. The box has to tell you,
which is exactly what the live states on the
[Connections page](/docs/connections-page) are for. When a sign-in dies, the
row says so and asks for you once, because you are the only person who can
supply it.

## Layer 3: your pages. You build them.

The dashboard pages your app renders. Ask your assistant for a page that shows the
thing you check every morning, and it builds it.

Two things follow from these being *your* files. Updates may add new template
pages, but an update will never overwrite a page you have edited. When you
*want* an improved template, that is a pull, not a push: ask your assistant,
and it walks the differences with you and reapplies what you choose. Upstream
changes land on your pages only by your own hand.

And a page you build is sandboxed when it renders, which is why you can be
careless with them. "Sandboxed" is doing real work in that sentence, so here
is what it actually means: the page renders in an isolated frame where its
scripts run, but inside an empty room, with no network access and none of the
app's privileges. The one thing it can reach is a read-only bridge to your
brain pages: it can list them and read them, and that is the whole list. A
page can never grant access, write anything, or restart anything. The worst a
badly built page can do is look wrong, which is precisely the ceiling that
makes carelessness safe.

## The part people get wrong

**Your brain is not a schema.** The eight layers a fresh mineral starts with (north
star, philosophy, self, network, past, goals, tasks, workflow) are a *starting
template*, not a structure the software depends on. Rearrange them, rename them,
throw half of them away, invent your own: nothing breaks.

That is a deliberate constraint on the machinery rather than a permission for
you. No update, system page or engine feature is allowed to assume your brain
looks a particular way, which is why the brain graph draws whatever is
actually there rather than what a template expected.

## System pages and your pages are different in kind

Some pages in the app are not files at all. The brain graph, the setup state, the
skills list, the scheduled jobs, the connections: those are **live views**, built
from your mineral's state every time you open them. They are always present, never
editable, and never stale, because there is nothing cached to go stale.

That is why an expired token shows up as an expired token on the connections page
rather than being discovered six weeks later when you notice the morning brief
stopped arriving.

## When somebody does need to touch your mineral

Fixing something on a particular box sometimes needs a person on the machine
itself, and that access is granted, never standing. You grant a window; the
mineral's own door enforces the expiry, even if the software on the box is the
thing that is broken; revoking takes effect immediately; and the grant's whole
lifecycle is readable on your own mineral.
[Let someone look at your mineral](/docs/grant-support-access) is the full
shape.
