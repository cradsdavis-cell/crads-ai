---
title: When something looks wrong
summary: The short list of symptoms, what each usually means, and where to look before you worry.
outcome: match a symptom to its usual cause and know where to look before you worry.
audience: public
access: public
mode: how-to
order: 90
pins: docs/traps.md
reviewed: 2026-09-01
---

Most problems on a mineral present as one of the symptoms below, and most have
a one-line cause. This page is the list, ordered by how often each actually
happens rather than by how alarming it feels.

## The morning brief did not arrive

**Look at [Connections](/docs/connections-page) first.** A scheduled job that
needed a dead connection fails rather than pretending, so a missing brief usually
means an expired sign-in, and the row will say so.

If Connections is green, check the schedule itself on
[Skills](/docs/skills-page): a malformed schedule is refused rather than guessed
at, and the page says so.

Third check, if both of those look right: the fold at the bottom of
Connections for services connected to your **Claude account**. Those work in
your chats and can never run in a scheduled job, so a brief that depends on
one keeps failing until the service is connected on the mineral itself, from
the Connections page.

## My assistant answers like it knows nothing about me

It probably does not. Check the Onboarding card on
[Overview](/docs/overview-page): until [the interview](/docs/the-interview) is
finished, every answer is generic. That is the cause almost every time this is
reported.

## I connected the Claude Code app but the checklist still says not signed in

That is the expected result, not a failure. Connecting the app signs in
**your laptop** and reaches into your mineral over SSH; it does not sign the
**mineral** in, so it does not switch on scheduled jobs and nothing it does
makes the Overview checklist tick. The app now says it in bold: "This is an
extra, not a step." The checklist item belongs to the Terminal tab: open it
and run `claude` once.

## My assistant uses a service when I chat, but the scheduled job cannot see it

The service is connected in a place only chats load. A connection made inside
a Claude Code session works when you talk and is invisible to scheduled jobs,
and [Connections](/docs/connections-page) says so rather than hiding it: the
row is marked "in your chats only, not in scheduled jobs" and carries a
one-click **"Use in jobs too"** button, which is the fix. The one kind with
no button is a service connected to your **Claude account** in the app's own
fold: those can never run in jobs, because there is nothing on the mineral to
move; connect the service on the mineral instead.

## The app says "software unknown" for my mineral

The mineral is running a build too old to report which build it is. The fix is an
update: open **Help**, and under **Mineral software** run **Update and restart
this mineral**. When it comes back it will be current and say so;
[how updates reach you](/docs/how-updates-reach-you) is the mechanics.

## Sign in answers a raw error like "bad server url"

The mineral's software is behind the app. The Connections page fills in the
addresses it signs in against from what the mineral reports, and a mineral
running older software does not report them, so the sign-in starts with a
blank address and fails with a raw error instead of a kind sentence. The fix
is the same update as above: open **Help** and run the software update under
**Mineral software**. Once the mineral is current, Sign in behaves.

## My new computer cannot connect

Adding a computer needs a machine that already opens the mineral to vouch for
it: [add another computer](/docs/add-another-computer) walks both halves, and
its last section covers the refusals (a name that does not match the bundle,
a mineral that did not answer the probe). If the mineral is mid-restart, the
bundle stays good; try again in a minute.

## Google shows a scary "unverified app" screen

That screen is correct and expected: the app is **yours**, you created it minutes
ago, and nobody was asked to verify it. Click **Advanced**, then *Go to* your
app's name. The whole story is in [connect Google](/docs/connect-google).

## I got a Telegram message saying my Google sign-in stopped working

Rare, and real: Google dropped the key your mineral holds, so "your scheduled
jobs cannot reach Gmail or Calendar until you sign in again". The mineral
checks the key itself and sends that message exactly once, not on repeat. The
fix is the two clicks the message names: **Connections**, then **Google**,
then **Sign in**. If the sign-in itself misbehaves,
[connect Google](/docs/connect-google) has the whole story.

## There is a machine on my roster I do not recognise

Remove it, then work out what it was. A mineral made through the setup wizard
is born with only your own key, so every row should be a machine of yours, a
machine you added, or a live support grant you made. See
[machines that can open your mineral](/docs/devices-and-access).

## A machine appeared on my roster that I was already using

If the notice reads "This computer was already connected but had never been
listed here, so it has been added to the roster", that is the roster healing
itself, not an intruder: a machine connected before the roster existed gets
listed the first time you open the page on it, and the new row is yours to
rename or revoke like any other. A machine you genuinely do not recognise is
the entry above, and gets the opposite treatment.

## Secrets lists things I never added

Rows described as the mineral's own plumbing are exactly that: the keys and
tokens the mineral needs to be a mineral (status keys, internal tokens, and so on). They are listed because a
[Secrets page](/docs/secrets-page) that hid some of the secrets would be a
different kind of page. There is nothing on them for you to revoke; each row
that IS yours says where it comes off.

## My bot never replies on Telegram

Look at the Telegram card on Connections. A chip reading "one step left"
means the pairing never finished: the bot exists, but it was never bound to
your chat, so it has nobody to answer. The pairing code expires after ten
minutes, so reopen the card for a fresh one and message that code to your
bot. The button you want is **Finish setup**, not disconnect;
[connect Telegram](/docs/connect-telegram) walks the two steps.

## Everything disconnected for a minute

That is the expected face of a software update. The restart takes about a
minute and everyone connected drops briefly: this panel, open terminals and
Claude Code sessions all reconnect on their own afterwards, and nothing of
yours is touched.

## The mineral is unreachable

Sometimes it is genuinely the machine, and sometimes it is between you and it.
Give it a minute, then open **Help** and run **Update and restart this mineral**
(under **Mineral software**), which restarts the mineral's software without
touching anything of yours. If it stays unreachable, the machine itself is
worth a look in your own hosting console, Hetzner's or DigitalOcean's (it is
your server; their console can reboot it), and a person helping you can go deeper
[with your permission](/docs/grant-support-access).

## Something else

Report it, and say what you saw rather than what you concluded: "the brief had
no calendar section" finds the cause faster than "the assistant is broken".
When a fix lands, the app's version notes say so in plain words.
