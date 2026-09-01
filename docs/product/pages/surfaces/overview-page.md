---
title: Overview
summary: The page your mineral opens on: what your assistant knows, and how it is doing.
audience: public
access: public
mode: reference
surface: dashboard
order: 100
pins: wizard/panel/member.html
reviewed: 2026-09-01
---

*What your assistant knows and how it is doing.*

This is home. Every card here answers one question, and the ones that need you
are hoisted to the front rather than left in place.

## The cards

| Card | Answers |
|---|---|
| **Your assistant** | its name, whose it is, and a way straight into a conversation |
| **Onboarding** | how much of the interview is done, out of eight layers |
| **Brain** | how many pages your assistant has to read from |
| **Skills** | how many are installed, and how many run on a schedule |
| **What your pebble can do** | each capability, whether it is on, and the way in if it is not |
| **Health** | the jobs your mineral runs by itself, and whether they are fine |

## Before the cards load

The page is honest about not knowing yet. While the first read is in flight you
see grey placeholder cards, not stale numbers. If the mineral answers but has
no dashboard to give (usually because it is brand new), the cards give way to
one line: "No data from your mineral yet. It may still be onboarding. This
page checks on its own, or press Refresh."

There is a third in-between state worth recognising. If your mineral could not
rebuild its dashboard just now, the page shows the last version that did build,
with a notice saying so: "this is the last good copy", with the timestamp it
was made and the error your assistant can look into. A frozen dashboard that
admits it is frozen beats one that looks live.

## When your mineral will not answer

If the connection fails, a panel replaces the cards with one of four headlines.
Each means something different, and only some of them are worth waiting on:

- **"Waiting for your mineral"**: the first few attempts. It may still be
  getting set up. The page keeps checking on its own; nothing you need to do.
- **"Still no answer from your mineral"**: several checks in a row have not got
  through. Usually a network hiccup or a mineral mid-restart. Press Try again.
- **"Your assistant is not running"**: the mineral itself is switched on and
  answering, but the assistant inside it has stopped. The panel says the honest
  thing: it will not come back on its own, and it cannot be restarted from this
  app. The technical detail the panel folds away underneath is what to report.
- **"This computer has not been let in yet"**: the mineral is up and answering,
  it just does not know this computer. A machine that already opens the
  mineral is what lets a new one in:
  [add another computer](/docs/add-another-computer) is the two-minute walk.

## The banner and the hero

Until onboarding is finished, a banner sits at the top: "Your assistant is
ready to meet you." with the reassurance "Right here, nothing to install. One
sign-in to Claude and you're talking." Its button opens the Terminal and runs
a scripted introduction for you, so your first conversation starts without you
having to know what to type.

Once onboarding completes, the banner goes and a hero strip takes over from the
Assistant card: your assistant's name, large, and the button becomes
**"Talk to \<name\>"**. One primary action per screen, and it tracks where you
actually are.

## What to look at, and when

**In the first week, watch Onboarding.** Until the interview is finished, every
answer your assistant gives is generic, and no other card on this page can fix
that.

**After that, watch Health.** It reports the jobs that keep your mineral current, including [how updates reach you](/docs/how-updates-reach-you), and summarises [the jobs your mineral runs by itself](/docs/machinery-jobs) in one
line before expanding to the individual jobs. It is the only card that tells you
something is wrong before you notice the symptom.

**"What your pebble can do" is the map of what is still switched off.** Each row
either says it is ready, or links to the thing that turns it on. Working down that
list is a reasonable definition of setting your mineral up properly.

## The health card in full

The headline is one of four phrases, written for a person rather than an
engineer (the raw status token survives in the detail line underneath, so
nothing is hidden, just not shouted):

- **"All good"**: nothing to do.
- **"Not sure yet"**: the mineral has not reported a status yet.
- **"Mostly working"**: something is degraded but retrying. It keeps retrying
  on its own; if it hangs around, mention it to your assistant.
- **"Not working right now"**: a real failure worth a Refresh first, and worth
  reporting if it stays.

Under the headline sits "Checked N ago" (the exact time is on hover), then a
one-line summary of the machinery: "3 jobs, all fine", or "1 of 3 needs a
look". The per-job rows live behind that line in a fold which opens itself only
when something is not ok, so a healthy card is three lines and a sick one shows
you the failing row without a click.

The rows are the protected jobs from
[the jobs your mineral runs by itself](/docs/machinery-jobs), relabelled for
humans: the heartbeat shows as **"Status check-in"**, the update job as
**"Software updates"**, the backup as **"Nightly backup"**. Each carries a
chip: **on**, **failed**, **opted out** (updates switched off deliberately), or
**checking** while the first report is still on its way. The backup row defers
to the Backup card on Your pebble until it has a real run to answer for, rather
than claiming a success it cannot show.

## The capability ladder, concretely

The "What your pebble can do" card has two halves. The left is three rungs, in
order: **"Sign in to Claude on your mineral"**, **"Onboard your brain"**,
**"Make your first backup"**. The right is what those rungs open: run scheduled
tasks, join a community and install what it shares, add another device,
connect email and calendar, and message it on Telegram. (Starting a community
of your own is not on the ladder while the pebble-to-rock upgrade is being
rebuilt for the commons era; [start a community](/docs/become-a-rock) has
where that stands.)

Every capability row is in exactly one of three states. **Open**, with the way
in on the row itself. **Locked**, marked "Not yet", with the reason spelled out
(scheduled tasks, for example: "Jobs run with nobody at the keyboard, so they
need this mineral's own sign-in"). Or **"Checking..."**, when the card simply
has not read the answer yet. That third state is deliberate: ignorance never
locks a row and never promises one, and the card re-checks about every minute
until it knows.

The card's footer carries exactly one action: the way in for the first rung
that is known to be unfinished. Not the first unknown one, because "we have
not checked yet" is not something you can act on.

## The two sign-ins that are not the same sign-in

The single most common Overview confusion. Connecting the Claude Code desktop
app signs in **your laptop**, which reaches into your mineral over SSH. That is
an extra, not a step: it does not sign the mineral itself in, so scheduled jobs
stay off and the ladder's first rung stays unticked however long the app is
connected.

The mineral's own credential is written one way: open the Terminal tab and run
`claude` once. The ladder says so on the rung ("Open the Terminal tab and run
claude once. The desktop app signs in your laptop, not this mineral"), and its
**Open Terminal** button lands you in the Terminal with the command already
typed. Nothing to read, nothing to work out.

## What refreshes, and how often

You should never need to reload this page, because it checks on its own:

- **Connection liveness**: every 20 seconds, always, even after it has been
  green. A liveness dot that stops checking once it likes the answer would be
  worse than none.
- **The dashboard data**: every 60 seconds, but only while the window is
  actually being looked at and the connection is green. Rebuilding the
  dashboard means walking the whole brain on the mineral, and doing that for a
  hidden tab would be a walk for nobody.
- **The machinery rows**: within 2 minutes, on their own slower beat.

The **Refresh** button re-attempts the connection itself, not just the data. A
mineral that is not connected yet needs exactly that, which is why the empty
state points at it.

## What this page is not

It is not a dashboard you build. These cards are fixed and Crads AI maintains
them, in the sense of [who edits what](/docs/the-three-layers). The pages you build for yourself are
separate, and live under **Your pages** in the sidebar.

## Your pages

Those separate pages deserve a word here, because this is where you go looking
for them. **Your pages** is a sidebar section that appears once your mineral
has any: pages you and your assistant build together, by asking for them
("build me a page that shows X") through the **Build pages & cards** skill.

Each page carries its provenance. One your assistant seeded as a starting
point wears an "Example page" chip; one you installed from a community wears
a chip naming that community. Every page has a **Delete** button, and the confirmation
tells you what deleting means before you commit: an example page notes "Your
assistant can make it again if you ask", any other page that "The page file is
removed from your mineral", and both that it cannot be undone from here.

The guarantee that makes member-built pages safe to experiment with: a page
renders in an isolated frame with no network access and no reach into the rest
of the app. The only thing it may ask your mineral for is a read of your brain
pages, read-only. So a badly built page, even one a misbehaving assistant
wrote, can deface itself but cannot touch your data, your settings, or the
outside world. The worst a bad page can do is look wrong, and Delete is right
there.
