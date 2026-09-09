---
title: How updates reach you
summary: Your mineral restarts nightly onto new software, what that does and does not touch, and how to tell what you are running.
audience: public
access: public
mode: explanation
order: 50
pins: docs/box-update-channel.md, engine/cron/scheduler.mjs
reviewed: 2026-09-01
---

Software arrives on your mineral by itself. Worth understanding, because it is the
one thing that changes your machine without you asking.

## What happens

Once a night your mineral restarts onto the latest published software. The
restart takes about a minute.

When, exactly: at 04:10 mineral time, plus an offset of up to half an hour
that is stable per box, so yours restarts at the same minute every night but
everyone's minerals do not all hit the software registry in the same minute.
The ordering around it is deliberate: the encrypted snapshot runs at 03:40
and the brain push at 03:50, so the night's backup has left the box before
the restart touches anything.

Mechanically, an update *is* a restart. On every start the box re-pulls its
published image from the public registry, so what arrives is exactly what the
project has published, and there is no second path by which different
software could arrive.

**What that changes:** the machinery. The engine, the app, the scheduler, the
system pages.

**What it does not touch:** your brain, your pages, your skills, your cadence,
your connected services, your files. All of it is exactly as you left it.

If you were told an update is out and you do not want to wait for tonight,
there is a button: **Update and restart**, on the Claude Code tab. Same
restart, same minute, same nothing-of-yours-moves. Its one oddity is that the
connection dropping moments after the restart is scheduled is the success
path, not a failure: the box has to go down to come back new. Give it a
minute; everything reconnects on its own.

## Knowing what you are running

The app shows the build your mineral is on. Every face of the app carries a
small version chip, and the chip opens into a what's-new fold that lists what
changed, in plain words. This matters more than it sounds: until late August
2026 a mineral could not report which engine it ran, so the answer to "have
you got the fix?" was guesswork for everybody.

When a fix lands that you reported, the version notes in that what's-new fold
say so in plain words. That is the loop closing: you said something was
broken, and the app tells you when it stopped being broken.

## Turning it off

You can, though not from a settings screen: there is deliberately no switch
for this in the app. The opt-out is a flag on your mineral, and your assistant
sets it when you ask. That is on purpose. Whether your machine receives
software is a considered decision about its lifecycle, not a toggle to fidget
with, so setting it takes a sentence to your assistant rather than a click in
passing.

The honest consequence: you keep the software you have, including its bugs, and
you stop receiving fixes for the connectors that break when Google or Microsoft
change something on their end. That is a reasonable trade for a week while you
finish something, and a bad one as a permanent state.

## Updates never touch your schedules

Your cadence and the machinery are separate engines. The nightly restart is
the machinery's own job; the schedules you set for your skills live in your
own state, and an update never rewrites them. The separation runs the other
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
