---
title: Running your rock
summary: The host's operations page: the backup that is yours to do, the update that is yours to press, the interview that gates everything, and the weekly look.
audience: public
access: public
mode: how-to
persona: host
order: 35
pins: engine/cron/scheduler.mjs, wizard/panel/member.html
reviewed: 2026-09-01
---

A rock does not look after itself the way a pebble does, and that is by
design: your own pebble updates and backs itself up nightly, while the
machine your community's library lives on changes only when you change it.
This page is the whole of what "looking after it" means: four habits, none of
them daily.

If you have not made a rock yet, start at
[start a community](/docs/become-a-rock). For grants, bundles and revocation,
see [manage your members](/docs/manage-members).

## Why your rock is different

A pebble and a rock run different sets of
[machinery jobs](/docs/machinery-jobs): a rock skips the self-maintenance
jobs a pebble gets. The two missing ones that matter are the nightly backup
and the nightly software update, and the first two habits below exist because
of them.

## 1. Back it up, deliberately

Your rock's brain (the community context, your library, your published
pages) does not push itself nightly. **Its backup is something you do**, on
the **Custody & backup** card:

- If no repository is connected yet, press **Connect GitHub**. You approve a
  one-time code on github.com, and the box creates a private repository your
  organisation owns.
- Once connected, the button reads **Back it up now**. It checks the
  repository is really yours, copies the brain to it, and tells you if it
  could not.

The card is honest about the in-between states: nothing connected ("if this
mineral died today, the rock's brain would go with it"), connected but never
pushed (a remote address is not a backup, and the card refuses to count it as
one), and backed up, with the repository name and the last push date read
from the repository itself, the far end, so it reports the copy that actually
exists. A "last push" date that keeps getting older is the tell. Make the
habit event-shaped: push before you change what the rock publishes, before an
update, before you onboard a cohort.

## 2. Update it, deliberately

A rock stays on the software it has until you restart it. The control is
under **Help**, in **Mineral software**: tick the acknowledgement and press
**Update and restart this mineral**. About a minute; everyone connected
reconnects on their own. Update when you are told a fix is out; nothing else
will do it. [How updates reach you](/docs/how-updates-reach-you) is the full
mechanics.

Your members' pebbles are unaffected either way: each of them updates itself
nightly from the public software, whatever state your rock is in.

## 3. Keep its brain ahead of its members

Your rock's own [interview](/docs/the-interview) is not optional context.
Everything you publish to the community inherits its coherence from those
answers, so do it before you curate anything, and revisit it when the
community's shape changes. The publishing habit that follows from it is on
[curate skills for your community](/docs/curate-for-your-community): publish
what the community actually asks for, starting from empty.

## 4. Look at three things a week

- **Who has actually onboarded.** Not who joined: who finished their own
  interview. The commons gives you no dashboard for this, so it is a question
  you ask, and [hosting a community well](/docs/host-a-community-well) gives
  you the exact wording.
- **What waits on you.** The [Decisions](/docs/decisions-page) page for
  anything the rock stages for your answer, share-back pull requests on the
  commons repository, and anything members have raised with you directly.
- **After any update you announce, whether people got it.** A member's pebble
  picks up published software on its nightly restart; a member who reports
  yesterday's bug today has probably not restarted yet.

## A fifth habit, smaller

A pebble refreshes its own connected services on a schedule; a rock does not,
because that refresher is a pebble job. After a long gap away from the app,
glance at the rock's Connections and sign anything back in that lapsed. It
takes a minute and it is the one piece of quiet rot the machinery will not
catch for you.

## The identity card

**Your rock**, the page, opens with the identity card. The **display name is
renamed here**: press **Rename**, type it, save. The handle never changes;
that was the deal at promotion. The card also shows the rock's **own software
build**, which is the answer to "am I behind?" when a fix is announced.

## What you never have to do

You do not maintain the software (updates arrive when you press the button),
you do not host anyone (members run their own machines), and you cannot read
member brains, so there is nothing to be careful *about* there. The
[hosting agreement](/docs/hosting-a-rock) sets out the whole split of
responsibilities.
