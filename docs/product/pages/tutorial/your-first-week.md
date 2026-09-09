---
title: Your first week
summary: Seven days from a finished setup to an assistant you would miss: what to switch on, what to correct, and what to ask.
audience: public
access: public
mode: tutorial
order: 30
pins: engine/cron/cadence-lib.mjs, wizard/panel/member.html
reviewed: 2026-09-01
---

[Your first hour](/docs/first-hour) ends with an assistant that is awake and a
brain that knows your world. This page is about the week after: the small
sequence that turns it from something you set up into something you would
miss.

None of this is compulsory and none of it is technical. Each day below is ten
minutes, and the order matters less than the habit of coming back.

## Day one. Turn on the first schedule

Open **Your assistant**, then **Skills**. Each row is one thing your assistant
can do; the switch beside it decides whether it runs on a schedule, and
**Save schedules** writes your choices to the mineral.

One caveat first, because it is the likeliest dead end of the whole week: the
switches stay locked until your mineral has its own Claude sign-in. That is
deliberate, not broken. Scheduled jobs run with nobody at the keyboard, so
they need the mineral's own sign-in, and connecting the Claude Code desktop
app does not count: that signs in your laptop, not the mineral. If the page
shows a sign-in banner, the fix is one `claude` run in the Terminal tab, and
then everything unlocks.

Start with **Inbox triage** if your email is connected, or the **Daily brief**
if it is not yet: it starts from what your brain knows and gets sharper with
every connection you add. One is plenty. The point of day one is not coverage,
it is waking up tomorrow to find something already done.

Worth knowing what you are switching on. Inbox triage sorts unread mail into
four buckets: open loops (threads where a reply is owed, left unread and
untouched), mark-as-read (legitimate, no action needed), archive (junk), and
hold (ambiguous, left for you to decide). Nothing is written without one bulk
confirm from you, and the bias is deliberate: when in doubt it marks read
rather than archives, because a false archive is a lost email and a false
mark-read is visible and recoverable. Re-running it after a confirmed pass
produces no duplicates; handled mail is simply no longer unread.

Two more small habits that pay off before you leave the page. First, run a
skill once before you schedule it: every skill's drawer has a **Run now**
button, it works in the background on your mineral, and the result lands in
your brain. Second, press **Read the skill** on any card: it shows the actual
instructions the skill runs on, with a chip saying where it came from. Reading
one is the fastest way to calibrate how much to trust the whole system.

And so you can tell later whether a schedule actually fired: each skill row
carries a run-health chip, including an explicit warning when a scheduled
skill has not fired since it should have. The machinery fold on your Overview
summarises the always-on jobs the same way, and opens itself only when
something is sick; a healthy card stays folded.

## Day two. Read the first brief, then correct it

Tomorrow's brief will be wrong in places. That is expected, and what you do
about it is the single most important habit in this whole page.

Open the **Terminal** and say so, in plain words:

```
The brief keeps leading with routine invoices. What matters most
to me this quarter is the retreat bookings. Remember that.
```

Your assistant writes that into your brain, and the next brief reads it. An
assistant you correct gets sharper every week; one you only consume from
plateaus. Nothing about correcting it requires care or phrasing: talk to it
the way you would brief a person.

The brief itself is also written to a page in your brain, for the record, so
if you miss a morning nothing is gone: the latest one is sitting there when
you look.

## Day three. Connect the thing you live in

For most people that is Google:
[connect it with your own key](/docs/connect-google). It is the longest setup
on any of these pages (about ten minutes, five console visits) and the page
walks every click. What you get back is an assistant whose morning brief has
actually read your inbox and calendar rather than guessing at them.

If your working life lives somewhere else, open
[**Connections**](/docs/connections-page) and look down
[the catalogue](/docs/connections): most services connect with one sign-in.

## Day four. Put it in your pocket

[Connect Telegram](/docs/connect-telegram). Two minutes, its own step-by-step
page. From then on the brief lands on your phone, and anything needing your
yes reaches you wherever you are, instead of waiting in an app you have to
remember to open.

## Day five. Ask it something real

Not a test question. A real one, in the Terminal, about your actual week:

```
Who am I waiting on replies from?
What did I say I would do this week that I have not started?
```

This is the day the interview pays for itself. If an answer is thin, that is
information too: it usually means a corner of your brain is thin, and saying
so ("you are missing most of my supplier contacts") is how it fills.

That first question has a name, by the way: it is the **Follow-ups** skill,
and it sweeps in both directions, what you owe and what is owed to you.
Overdue tasks, unanswered email from the people who matter, chat messages
(inbound and unreplied for over a day, or sent by you and cold for five),
stale project actions, people left in limbo, and one recommended next step.
Like everything on the Skills page it can also run on a schedule, so the
sweep happens without you asking.

## Day six. Look at your brain

Open **Your assistant**, then [**Brain**](/docs/brain-page). The graph is
every page your assistant knows, drawn live from the files on your mineral.
Click anything to read it: it is yours, in plain language, and nothing about
it is hidden from you.

Look for the thin spots. A rich Network page and an empty Goals page produces
an assistant that is good at people and useless about priorities. The fix is
day two's habit: say what is missing, in the Terminal, and let it write.

## Day seven. Close the week, and let it plan the next

Back on the **Skills** page, switch on the **Weekly review**. It reads your
week against what you said mattered and names what stalled, honestly.

Honestly is the operative word. The review says what moved and what did not,
assesses the health of each active project, proposes three key moves for next
week (actions, not project names), and always names exactly one thing to let
go of. Exactly one, because a list of things to drop is a way of dropping
none. And a project that has sat dead for two weeks gets asked the question
out loud: is this still alive?

Its Monday counterpart is **Plan your week**, and the pair close a loop. It
sets 3 goals (5 at the most), each an outcome rather than an activity,
verifiable as done or not done by Friday: "send the proposal", not "work on
proposals". Each goal ladders to one of your named priorities, the set is
sized against your real calendar rather than an imaginary empty week, at most
one is a stretch goal (marked as such, so a normal week still counts as a
win), and carry-overs are named rather than silently re-added: a goal slipping
two weeks running is a signal, not an admin detail. The goals are written
where the daily brief reads them every morning, which is what makes the whole
week one connected thing instead of five separate days.

## Two side quests, for whenever the mood takes you

Neither of these belongs to a day; both are worth knowing exist.

**Ask for a page.** Say "build me a page that shows X" in the Terminal and the
dashboard skill writes it: a page of your own that your app renders, in a
sandbox that cannot reach anything else. Your app is a shell over pages you
can ask for, which is a strange thing to discover by accident in week three.

**Close a session with `/capture`.** At the end of a real working
conversation, type it and the assistant proposes what that conversation should
have written but did not: brain pages, decisions, tasks, calendar changes. It
shows the diff for each surface and writes only what you confirm; it never
silent-writes. Ten seconds of typing turns an hour of talking into things that
persist.

## Where you are after a week

A sorted inbox before you wake. A brief that knows what matters. Your phone as
the front door. A brain you have read and corrected twice. That is the whole
product working as intended, and everything past this point (writing your
own skills, [adding a second computer](/docs/add-another-computer), building
your own pages) is optional depth, not homework.

One last honest habit: [back up your mineral](/docs/back-up-and-restore) has
the one step in the whole system only you can do. Do it this week, not the
week you need it.
