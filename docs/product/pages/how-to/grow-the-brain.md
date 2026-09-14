---
title: Grow the brain
summary: The everyday habits that turn a seeded brain into one that knows your business: correct it, tell it things, capture, and bring documents in.
outcome: make your assistant sharper every week by writing the right things into its brain, and recognise a thin page when you meet one.
audience: public
access: public
mode: how-to
order: 240
pins: engine/skills/capture.md, engine/lib/brain-root.mjs
reviewed: 2026-09-10
---

The interview seeds the brain. What makes it good is the month after, and
the month after is not a project. It is four small habits, none of them
technical, each of them ten seconds at the moment the information exists.
[How your assistant thinks](/docs/how-your-assistant-thinks) explains why
this is the whole game; this page is the practice.

![The conversation is short-term; the brain is permanent](diagram:two-memories)

One rule sits under all four habits. If your assistant forgot something, it
was never written down. Conversations end; pages do not. A new session in the
Terminal starts from the pages and nothing else, so anything worth having
next week has to be in one.

## Habit one: correct it, in plain words

The first brief will be wrong in places. That is expected, and what you do
about it matters more than anything else on this page. Open the
[Terminal](/docs/terminal-page) and say so, the way you would to a person:

![The Terminal, where corrections are typed](shot:member-terminal)

```
The brief keeps leading with routine invoices. What matters most to
me this quarter is the two new-build gardens. Remember that.
```

Your assistant writes that into the goals layer of your brain and the next
brief reads it. Nothing about correcting it requires care or phrasing; it
does need to be said out loud, in the Terminal, rather than sighed at. An
assistant you correct gets sharper every week. One you only consume from
plateaus in a fortnight.

Corrections about *how* it works go the same way. "Never suggest chasing a
client on a Monday" or "always show me what you are about to write before
you write it" belong in the workflow layer, and saying them once is enough.

## Habit two: read a thin answer as a thin page

Ask it something real and the answer will sometimes be thin: "who am I
waiting on?" returns two names when you know there are seven. That is
information. It almost always means a corner of the brain is thin, not that
the assistant is weak. Say what is missing:

```
You are missing most of my supplier contacts. Here are the ones
that matter, with what each of them owes me right now.
```

The [Brain](/docs/brain-page) page makes this visible. The graph draws
every page live from the files on your mineral, and the thin spots are the
sparse corners: a dense network page and a one-line goals page produces an
assistant that is good at people and useless about priorities.

![The Brain page, where thin corners show as sparse corners](shot:member-brain)

## Habit three: capture, and you cannot over-capture

Decisions made mid-conversation are the easiest thing to lose. The garden
studio's day rate goes up. A physio clinic stops taking a kind of referral.
The accountancy agrees a new sign-off wording with a client. Each of these
was said in a session, and a session does not survive being closed.

Two ways to move them across. Mid-conversation, say "capture that" and it
writes the decision to the page where it belongs, showing you what it wrote.
At the end of any real working session, type `/capture` and it sweeps the
whole conversation, proposes the pages, decisions and tasks that should have
been written, shows a diff for each, and writes only what you confirm.

Early on, capture almost everything that is not throwaway. The pages are
cheap and the assistant gets sharper with every fact. The only real mistake
is the opposite one: a good session, a closed window, and all of it gone.

> Tip: end a session with `/capture` even when you think nothing happened.
> It will usually find a person you named, a date you agreed, or a decision
> you did not notice you made.

## Habit four: bring documents in

There is no import button, and you do not need one. To bring a document
into the brain, paste it into the Terminal and ask for a page:

```
Here is our standard terms letter. Write it into the brain as a page,
and note that we send it with every new engagement.
```

For a longer file, or many of them, the other route is the brain's own
folder on the mineral. Open it in
[Claude Code on your mineral](/docs/claude-code-on-your-mineral), drop the
file in, and ask for a proper page from the raw file. Either way the source
comes to the brain, which is the same destination as a capture from the
other direction.

Two limits, stated plainly. A very long paste fills the session's short-term
memory, which is exactly why long things belong in a page rather than being
pasted in every time. And nothing on the mineral reads the web unless you
have connected a search service; [what you can connect](/docs/connections)
lists them.

## Where the brain lives, and who edits it

Every page is a markdown file on your mineral, mirrored to the private
GitHub repository you set up in [back up and restore](/docs/back-up-and-restore).
Eight layers by default (north star, philosophy, self, network, past, goals,
tasks, workflow), a page per person, and whatever else grows. You can open
any page from the Brain page and read it, and you can edit it yourself in
[Claude Code on your mineral](/docs/claude-code-on-your-mineral) for a
longer sitting. Nothing about the structure is fixed: rename layers, add a
`clients/` folder, delete half of it. [Who edits what](/docs/the-three-layers)
explains which files are yours and which the machinery maintains.

## Do not over-build it

A folder of linked pages, read by an assistant that knows how to find its
way around them, is enough for almost every small business, and it stays
enough for a long time. There are fancier shapes: search indexes, knowledge
graphs, always-on agents watching your inbox to file things by themselves.
Each one adds cost and moving parts, and each one is only worth it when a
question you actually ask cannot be answered by the plain version.

So the discipline is restraint. Climb when a real question demands it, not
because a bigger system exists. The maturity ladder this comes from is Nate
Herk's, credited in [where these ideas come from](/docs/where-these-ideas-come-from);
the short version is that a well-corrected brain of two hundred pages beats
a clever system nobody corrects.

## Two ways to find the gaps

When you are not sure what is thin, ask. `/explain` reads your mineral and
tells you what is there. And the questions in
[find what you do not know](/docs/find-what-you-do-not-know) ask the
assistant to name what is missing from its own picture of you, which is the
fastest audit there is. The voice you write in is its own corner of the
brain, with its own page: [teach it your voice](/docs/teach-it-your-voice).
