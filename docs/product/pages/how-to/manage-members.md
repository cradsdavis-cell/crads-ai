---
title: Manage your members
summary: The roster of grants, minting and revoking access, helping people get set up, and how anyone leaves without losing anything.
audience: public
access: public
mode: how-to
persona: host
surface: pebbles
order: 30
pins: engine/community/commons-admin.mjs, engine/community/commons-pull.mjs
reviewed: 2026-09-01
---

Membership in a community is read access to your
[commons](/docs/rocks-and-pebbles), so managing members is managing grants:
who can pull your shared repository, recorded on a roster you keep. (New to
the words rock and pebble? [Rocks and pebbles](/docs/rocks-and-pebbles)
defines them once, plainly.)

The roster lives on the **Commons** card of your rock's Catalogue page, and
[share with your community](/docs/share-with-your-community) covers the
publishing half. This page is about the people.

## What a member is now

Someone who runs **their own mineral**, built with the same
[wizard](/docs/first-hour) everyone uses, on their own Hetzner account, with
their own Claude subscription, and who pulls your commons. You pay for
nothing of theirs, you hold no credential for anything of theirs, and their
machine works identically whether your community exists or not.

That changes what "managing" means. There is no build button, no invitation
that creates a machine, and no roster state your software can read off their
box. What you manage is access to your content, and what you provide beyond
it is help.

(The app's **Members** page still exists on a rock: it shows the rock-local
registry of members from the hosted era, with each mineral's own check-ins
and device receipts, and points at the commons flow for adding anyone new.
For a community started under the commons model it is simply quiet; the
grants roster below is the living list.)

## Adding a member

1. **Record a grant** on the roster: a label you know them by, optionally
   their email or GitHub username.
2. The panel prints their **join bundle** (`cradscommons1:...`). Hand it to
   them directly, in a private message, never a public post.
3. For a private GitHub commons, **also invite their GitHub account as a
   read collaborator** on the repository. The panel reminds you every time,
   because the bundle alone grants nothing: the git host's access control is
   the actual door.

On their side, they paste the bundle on their Communities page and your
library starts arriving as offers: [join a community](/docs/join-a-community)
is the page to send them.

## Getting a new member to a working mineral

Most communities onboard people who have never run a server, so the real work
of adding a member is the hour around the wizard, not the grant. What works:

- **Before anything, the prerequisites.** Their own Claude account, a Hetzner
  account with a payment method, and a free GitHub account (for their backup
  and for a private commons). Hetzner sometimes takes a day to verify a new
  account, so this is homework before a session, not a step in one.
- **Walk the wizard together**, in a room or on a call:
  [your first hour](/docs/first-hour) is the script. The costs screen does
  the money conversation for you, up front, which is exactly where it should
  happen.
- **The two stalls to expect**: the Hetzner token step (five console clicks,
  [its own page](/docs/get-a-hetzner-api-token)), and the Claude sign-in on
  the mineral itself, which the desktop app does not do for them.
  [Run a cohort session](/docs/run-a-cohort-session) has the room craft.

If you charge for guided setup or onboarding, that is a service you price and
agree with them yourselves. The software is free either way.

## Knowing how members are doing

The commons tells you nothing about them, by design: no status, no install
receipts, no activity. The pull is one-way and their box writes nothing back
up.

So the answer is the human one, and it is better than the dashboard it
replaces: ask. [Hosting a community well](/docs/host-a-community-well) has
the two questions that actually diagnose ("what did you ask it last week?"),
and the two-week call that catches the silent member. A host who relied on a
liveness dashboard was mostly learning who to ask; you can just ask.

## Revoking a member

Two halves, in this order:

1. **Mark the grant revoked** on your roster, so your records say what you
   decided and when.
2. **Remove their read access on the git host** (on GitHub: remove the
   collaborator). This is the half that actually ends the feed.

On their side, their Communities page says once that their access has ended,
and then goes quiet. **What they installed stays theirs.** Nothing you do can
reach into their mineral, and that sentence is worth saying to people before
they join: it is the reason joining is safe.

## When a member leaves

They press Leave, the pulls stop, and everything they installed stays. Tidy
your side when you notice: mark the grant, remove the collaborator. Nothing
else exists to clean up, because nothing of theirs was ever on your side.

## Contributions from members

A member who wants to share something back stages it in the commons layout
from their own box and proposes it as a fork and pull request (on GitHub) or
a branch you can see. You review and merge in the git host's ordinary flow.
Their read access cannot push, so nothing lands in the commons without you.
