---
title: How updates reach you
summary: Your mineral updates when you say so, what an update does and does not touch, and how to tell what you are running.
audience: public
access: public
mode: explanation
order: 50
pins: docs/box-update-channel.md, engine/cron/scheduler.mjs, engine/box/update.mjs
reviewed: 2026-11-03
---

Your mineral updates when you say so. Nothing restarts it overnight unless you
ask for that.

## What happens

When a newer version is published, the app tells you: a banner on the
**Overview** page says an update is ready, and says so more firmly when the
update carries a security fix. Your mineral checks once a day, and the check
only reads; it never restarts anything.

To update, press **Update now** on the banner, or **Update and restart** on the
**Help** page. Your mineral restarts onto the latest published software, which
takes about a minute. Anything your assistant is running at that moment stops,
so pick a moment when you are not in the middle of something. The connection
dropping moments after you press it is the success path, not a failure: the box
has to go down to come back new.

Mechanically, your server downloads new software only when you have asked for
an update. Any other restart (the server rebooting, a crash) comes back on the
same software it was running.

**What an update changes:** the machinery. The engine, the scheduler, the
system pages, the operating system inside the container.

**What it does not touch:** anything of yours. Your brain, your pages, your
skills, your cadence, your connected services, your files, your home folder and
the tools your assistant installed there, and your temp files. All of it is
exactly as you left it.

## If you would rather it updated itself

You can ask your assistant to switch on overnight updates. With that on, your
mineral updates between 04:10 and 06:00 mineral time, and only when there is a
new version and nothing is running: no Claude session, and the machine is not
busy with anything else. If something is running, it tries again ten minutes
later, and leaves it for the next night if the window runs out.

## Knowing what you are running

The app shows the build your mineral is on. Every face of the app carries a
small version chip, and the chip opens into a what's-new fold that lists what
changed, in plain words. This matters more than it sounds: until late August
2026 a mineral could not report which engine it ran, so the answer to "have
you got the fix?" was guesswork for everybody.

When a fix lands that you reported, the version notes in that what's-new fold
say so in plain words. That is the loop closing: you said something was
broken, and the app tells you when it stopped being broken.

## Updates never touch your schedules

Your cadence and the machinery are separate engines. An update changes the
machinery; the schedules you set for your skills live in your own state, and an
update never rewrites them. The separation runs the other
way too: when you edit a schedule, the change takes effect within a minute,
with no restart involved. Nothing about when *your* things run is ever waiting
on a software update, and no software update ever changes when your things
run.

## What an update is not

An update is a restart onto a published image; it is not a door. Nothing about
the update path can read anything on your machine, and nothing else is pushed
to your mineral outside this channel. The one way anybody reaches your mineral
other than through the software it already has is a
[support window you granted](/docs/grant-support-access), and that is set out
in the [privacy policy](/docs/privacy-policy).
