---
title: What your community can see
summary: Nothing, by construction: what the commons carries, what it cannot, and the one access anyone can ever be granted.
audience: public
access: public
mode: explanation
surface: sharing
order: 30
pins: engine/community/commons-pull.mjs, engine/heartbeat.mjs
reviewed: 2026-09-01
---

*What leaves your mineral, and who receives it.*

If your mineral belongs to a community, the honest answer to "what do they see
of me" is now short enough to be the opening line: **nothing**. This page
exists because "we respect your privacy" is not an answer and a mechanism is,
so here is the mechanism.

## How a community connects to you

A community shares a [commons](/docs/rocks-and-pebbles): a git repository its
owner curates, which your mineral pulls **read-only**, on its own rhythm. The
pull is one-way by construction:

- Your box reads their repository. Nothing of yours is written back up: no
  status, no activity, no install receipts, no liveness signal, nothing.
- The owner holds no credential for your box, and your box holds nothing of
  theirs beyond read access to the commons.
- Pulling never executes anything. What arrives sits in an inbox directory as
  data until you choose to install an item, and installing runs through your
  own lint and sandbox gates.

So the community's owner learns you pulled nothing, installed nothing, ran
nothing. They cannot tell your morning brief fired, and they cannot tell it
did not. If they want to know how you are getting on, they ask you, which is
the design: support is a conversation, not a dashboard.

## What your mineral writes about itself, for you

Your mineral does keep a status file about itself: whether it is signed in,
which software it runs, when its jobs last ran. That file is written **for
you**: it feeds the Health card on your [Overview](/docs/overview-page) and
the self-description page at the top of your brain, and it stays on your box.
Under the commons model there is no feed that carries it to anyone.

(One historical note, for boxes that predate September 2026: the old hosted
model had an optional status heartbeat a member's box pushed to its community,
governed by sharing switches on this page. A box still carrying that older
wiring keeps honouring those switches until it is migrated; a community joined
through a commons bundle never has the wiring at all.)

## The one access anyone can ever be granted

The **support access** card at the bottom of the Sharing page is the one kind
of reach that goes past everything above, and it exists only when you create
it. Its opening line is the contract: nothing opens until you grant it, it
expires on its own, you can revoke it at any moment, and every grant is logged
on your own mineral.

The resting state is the one you should expect to see: no support access
granted, your mineral closed to everyone but your own machines. While a grant
is active, the card says so with its deadline, the window is enforced by the
mineral's own door even if nothing else ever runs, and the grant is drawn on
the [Map's](/docs/map-page) device roster with its own Revoke button, because
anything that can reach your mineral belongs on that list.
[Let someone look at your mineral](/docs/grant-support-access) is the full
walkthrough.

## What this replaces, and why it is better

Earlier versions of this product had a carefully bounded status record a
community host could read, with switches, floors and a field-by-field table on
this page. It was honest, and it still required you to trust that the table
was the whole list.

The commons model deletes the question. There is no field to enumerate because
there is no record; a community's software has no path to your box at all. The
trade is real and worth naming: your community's host can no longer notice
from a dashboard that you have been stuck for a week. Tell them. They are
hosting you because they want to know.
