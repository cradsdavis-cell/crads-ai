---
title: Join a community
summary: Pasting a join bundle, what starts arriving, and how leaving or being revoked actually behaves.
audience: public
access: public
mode: how-to
surface: commons
order: 65
pins: engine/community/community-join.mjs, engine/community/commons-pull.mjs, wizard/panel/member.html
reviewed: 2026-09-01
---

A community here is a [commons](/docs/rocks-and-pebbles): a git repository its
owner curates, holding the community's skills, packs, prompts, pages and
folders. Joining means your mineral pulls that repository, read-only, on its
own rhythm. This page is the member's half; the owner's half is
[sharing with your community](/docs/share-with-your-community).

## What you need

One thing: the **join bundle**, a single line starting `cradscommons1:`,
handed to you by the community's owner directly (a message, not a public
post). It names their shared repository; nothing else travels in it.

If the commons is a **private GitHub repository**, two more things apply: the
owner must also invite your GitHub account as a read collaborator on the
repository, and your mineral needs its GitHub sign-in connected (the same one
[your backup](/docs/back-up-and-restore) uses) to read it. A public commons
needs neither.

## Joining

1. Open **Network**, then **Communities** on your dashboard.
2. Open the **Join a community** fold, paste the bundle, and press **Join**.
3. The box validates the bundle strictly and loudly, records the community,
   and runs the first pull straight away, so you see the honest outcome in
   the same breath: synced, or a named reason it could not.

**If the first pull says it cannot read the repository**, that is usually the
collaborator invite: accept the owner's invitation on github.com (it arrives
by email), and your mineral keeps trying on its own rhythm until it gets in.
The page says exactly this rather than pretending.

**If joining is refused because the name is taken**, this box already carries
something under that community name. The refusal names the case and the fix;
it never overwrites anything.

## What starts arriving

Your mineral pulls each commons on its existing sync cadence into its own
inbox. New and updated items appear as **offers**: skills on the
[Skills page](/docs/skills-page) under the community's name, pages, prompts
and folders in the [Library](/docs/library-page).

Nothing installs by itself, ever. Installing is your explicit act, and it
runs through the same lint and sandbox gates as anything else on your
mineral. What a community author writes can only become active on your box
because you chose to install it, which is also the honest limit of the risk:
treat a commons like any other software channel, and join the ones you trust.

## What the community learns about you

Nothing, through the commons. The pull is one-way: your box reads their
repository, and nothing of yours is written back up. The owner holds no
credential for your box and sees nothing of what you installed or ran.
[What your community can see](/docs/what-your-community-can-see) is the full
statement.

## Belonging to several

The normal case, not an edge case. Each community has its own record, its own
inbox and its own row on the Communities page. One community's repository
being down or revoked never affects another.

## Sharing something back

Ask your assistant to prepare a share (the `community-share` verb does the
same): your skill, page or folder is staged in the commons layout and you get
the exact steps to propose it, including fork and pull-request links when the
commons lives on GitHub. Your read access cannot push to the commons, so
nothing lands there without the owner's say. Whether to merge it is theirs.

## Leaving, or being revoked

**Leave** removes the community from your box and stops the pulls. If the
owner removes your access instead, the page says once, honestly, that your
access to that commons has ended, and then goes quiet rather than repeating
errors.

Either way, everything you installed remains yours. The feed stops; nothing
reaches into your mineral to take anything back. That is a standing ruling of
the product, not a courtesy.
