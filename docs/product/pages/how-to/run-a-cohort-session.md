---
title: Run a cohort onboarding session
summary: How to get five people from nothing to a working assistant in one room, and what goes wrong if you improvise it.
audience: public
access: public
mode: how-to
order: 10
pins: engine/onboarding/interview-spec.yaml, wizard/panel/door.html, wizard/panel/member.html
reviewed: 2026-09-01
---

Hosting craft rather than machinery. The buttons are documented elsewhere; this is
how to use them in a room full of people without losing half of them.

## The shape that works

Each person leaves the room with a mineral of their own, built by their own
hands, on their own accounts. The sequence per person:

1. Run the **Set up my own** wizard: costs, token, build
   ([your first hour](/docs/first-hour) is the script).
2. Sign Claude in on their mineral, in its Terminal.
3. Set their first scheduled task.
4. Connect Telegram.
5. Have them open your community's join link; it fills their
   Communities page in for them ([join a community](/docs/join-a-community)).

Until step 2 their mineral is deliberately asleep, which is a feature in the
room: nobody's assistant does anything surprising while you are still talking.
The Skills page shows a banner and locks every switch until the mineral's own
Claude sign-in lands. Nothing about that is broken. A host who knows it
recognises the locked state from across the room; a host who does not spends
ten minutes debugging a feature.

## Before anybody arrives

**Send the prerequisites at least a week early, as homework.** Three accounts,
each theirs: a Claude subscription, a Hetzner account **with a payment method
added and any identity check completed** (Hetzner can take a day to verify a
new account, and a verification stall in the room is twenty minutes gone), and
a free GitHub account. Say plainly what the running costs are; the wizard's
first screen will repeat it, which is the right kind of redundancy.

**Print the run-sheet.** Not a slide. You will be walking between people and a
laptop screen is useless for that.

**Do the whole thing yourself first, on a fresh mineral, the day before.** Not
to test the software: to have felt the places where a person hesitates, so you
recognise them from across a room.

## The order that matters

**Onboard your own rock before the room.** Everything you publish inherits its
coherence from your rock's own [interview](/docs/the-interview), so it is a
prerequisite, not good practice.

Do **not** run members' interviews in the room.

It is the best part of the product and it takes an hour, and an hour of five
people separately talking to their assistants is a room with no energy in it.
Get everyone set up, show one interview on a screen for two minutes so they
know what it looks like, and send them home to do their own.

When you set that expectation, say what the interview actually is, in one
breath: their story, their values, their north star, their goals, their past,
their people, the business, how they work, their tools, their voice, and their
constraints. Adaptive follow-ups, not a form: it keeps probing an area until it
is actually covered.

And kill the hour objection before anyone raises it: the interview is
resumable. Progress persists, it can be spread across as many sittings as they
like, and it can be done by voice over Telegram. Nobody has to find a free
hour. They have to start.

## Where people get stuck

**The Hetzner token.** Five console clicks and the one genuinely unfamiliar
step. Narrate it once for the whole room from
[get a Hetzner API token](/docs/get-a-hetzner-api-token) rather than letting
five people find five different console screens.

**The Google connection.** It is ten minutes of console work and the only
genuinely laborious thing in the product. Two options and you should pick one
before the room, not during it: either everyone does it together while you
narrate, or you skip it entirely and send a follow-up. Do not let three people
do it while two watch.

**The unverified-app screen.** Someone will stop dead at Google saying the app
is not verified. Have the sentence ready: the app is theirs, they made it four
minutes ago, nobody was asked to verify it. Say it before they see it.

**The desktop app that looks like a sign-in.** Someone will connect the Claude
Code desktop app and conclude they are done. They are not: connecting the app
signs in their laptop, which then reaches into the mineral over SSH. It does
not sign the mineral in, so scheduled jobs stay locked and the checklist does
not tick. The fix is one `claude`, run once in the mineral's own Terminal tab.
Have that sentence ready too.

**One person with a broken laptop.** There is always one. Decide in advance
whether you carry on and give them a call later, because deciding it in the
moment costs the room ten minutes. The call has a standard shape: a scheduled
30-minute concierge session where you do the setup steps together, exactly as
they would have happened in the room. Not a link and good luck.

## After the room

**Ask for friction, not feedback.** "What confused you" gets answers. "Any
feedback?" gets "it was great". The confusions are the valuable output of the
session and they are perishable: collect them that day.

Pass them on to the project, and fix your own run-sheet the same day. A
confusion two people hit is a sentence missing from your intro; a confusion
everyone hit belongs upstream, reported where the software is maintained.

## What not to promise

Do not promise dates. Give a gate: "after the next release", not "Thursday".
You do not control the release and a missed date you invented costs you more
credibility than the delay itself.

Do not promise capabilities you have not personally seen work. If you are not
sure, say you will check.

The room is one hour of [hosting a community well](/docs/host-a-community-well);
that page is about the months after it.
