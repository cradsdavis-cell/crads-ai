---
title: Join a community
summary: Opening a join link, what the page checks for you, what starts arriving, and how leaving or being revoked actually behaves.
audience: public
access: public
mode: how-to
surface: commons
order: 65
pins: engine/community/community-join.mjs, engine/community/community-check.mjs, engine/community/commons-pull.mjs, wizard/panel/member.html, wizard/panel/protocol.mjs
reviewed: 2026-09-02
---

A community shares a **library**: skills, prompts, pages and folders its owner
curates in a git repository they control. Joining means your mineral pulls
that repository, read-only, on its own rhythm. This page is the member's
half; the owner's half is
[sharing with your community](/docs/share-with-your-community).

## What you need

One thing: the **join link** the community's owner sends you directly (a
message, not a public post). It looks like
`crads-ai://join-community/...` and opening it lands you in your own app, on
the Communities page, with the invitation already filled in. Nothing joins
from the click alone; pressing **Join** is yours.

If the link cannot travel (some chat tools break custom links), the owner
sends the same invitation as one line of text starting `cradscommons1:`,
and you paste it into the **Join a community** panel yourself. Same
invitation, two shapes.

If the community's library is a **private GitHub repository**, two more
things apply, and the owner's app normally handles the first: GitHub sends
your account an invitation to read the repository, and your mineral needs its
own GitHub sign-in connected (the same one
[your backup](/docs/back-up-and-restore) uses). A public, open community
needs neither.

## Joining

1. Open the join link (or open **Communities** on your dashboard, open
   **Join a community**, and paste the invitation).
2. If this machine has more than one mineral, the page says which one is
   about to join; switch minerals at the top first if you mean another.
3. Press **Join**. The box validates the invitation strictly and loudly,
   records the community, and runs the first sync straight away, so you see
   the honest outcome in the same breath.

**If the first sync cannot read the library**, the page tells you which
blocker it actually is, not a generic error:

- *"GitHub sent you an invitation email from ⟨owner⟩"* means exactly that:
  the owner's invitation is sitting unaccepted. Accept it on github.com
  (the email lands wherever your GitHub account gets mail), then press
  **Check again** on the community's card.
- *"This mineral has no GitHub sign-in"* means the library is private and
  your box has nothing to read it with. Connect GitHub on **Your mineral**
  (the Backup card), then press **Check again**.
- Anything else is said as itself: a network hiccup keeps retrying on its
  own; a name collision is refused with the fix named, and nothing is ever
  overwritten.

**Check again** runs one sync right now with the same diagnosis, so fixing
the blocker is followed by a button press, not a wait.

## What starts arriving

Each community's card on the Communities page carries its **shared
library**: everything the community offers, by name and description, with
what is new since your last look shown first. Installing a skill, page or
folder is one press there; prompts are read and copied from the
[Library page](/docs/library-page), and the same offers also appear on the
[Skills page](/docs/skills-page) under the community's name.

Nothing installs by itself, ever. Installing is your explicit act, and it
runs through the same lint and sandbox gates as anything else on your
mineral. What a community author writes can only become active on your box
because you chose to install it, which is also the honest limit of the risk:
treat a community like any other software channel, and join the ones you
trust.

## What the community learns about you

Nothing, through the library. The sync is one-way: your box reads their
repository, and nothing of yours is written back up. The owner holds no
credential for your box, and sees nothing of what you installed, ran, or
looked at.
[What your community can see](/docs/what-your-community-can-see) is the full
statement.

## Belonging to several

The normal case, not an edge case. Each community has its own record, its own
inbox and its own card on the Communities page. One community's repository
being down or revoked never affects another.

## Sharing something back

Press **Share back** on the community's card (or ask your assistant): your
skill, page or folder is staged in the library's layout and you get the exact
steps to propose it, including fork and pull-request links when the library
lives on GitHub. Your read access cannot push, so nothing lands there without
the owner's say. Whether to merge it is theirs.

## Leaving, or being revoked

**Leave** removes the community from your box and stops the syncs. If the
owner removes your access instead, the page says once, honestly, that your
access has ended, and then goes quiet rather than repeating errors.

Either way, everything you installed remains yours. The feed stops; nothing
reaches into your mineral to take anything back. That is a standing ruling of
the product, not a courtesy.
