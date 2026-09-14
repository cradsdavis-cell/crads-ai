---
title: What it will not do
summary: The limits that are built in, the rules I hold mine to, and how to tell a broken connection from a thin brain.
audience: public
access: public
mode: explanation
order: 280
pins: engine/skills/inbox.md, engine/skills/capture.md, engine/skills/explain.md
reviewed: 2026-09-10
---

Most of these docs tell you what your assistant can do. This page is the other
half, and I would rather you read it in week one than find it out in week six.
Some of what follows is built into the software. Some of it is rules I hold my
own assistant to, and you will have to give yours the same rules yourself. I
will keep the two apart, because confusing them is how people get burned.

## It will be confidently wrong sometimes

The brain underneath is a language model. When it does not know something it
does not go quiet; it fills the gap with the most plausible thing, in the same
even tone it uses when it is right. The word for this is hallucinate, and it
is not lying. It is a guess wearing the clothes of a fact.

So: a number, a name, a date, a quoted line, a "studies show". Anything that
would embarrass you if it were wrong. Check it before you act on it, and ask
the assistant where it came from. If the source is a page in your brain, read
the page. If it cannot name one, treat the claim as a guess. The `/verify`
recipe on [starter recipes](/docs/starter-recipes) turns this into a habit
rather than a resolution.

The good news is that the fix is mostly not about the assistant. A thin answer
is usually a thin brain. If it keeps guessing at what matters to you this
quarter, that is because nothing in the brain says so, and [grow the
brain](/docs/grow-the-brain) is the page for that.

## What is built in

These are the software's own limits. You do not have to ask for them, and you
cannot talk it out of them in conversation.

- **It drafts. It does not send.** Email, messages, anything outbound: it
  writes the draft and stops. You send.
- **`/inbox` asks once before it touches a label.** It sorts unread mail into
  buckets and shows you the lot; nothing is marked read or archived until you
  give one bulk confirmation.
- **`/capture` shows what it will write before writing it.** The
  end-of-session sweep proposes each change to the brain and waits.
- **`/explain` and `/followup` change nothing.** Both read the mineral and
  report. Ask `/explain` what is connected, where your data lives, whether
  backups are on, and it answers from what is actually there.
- **Schedules ship switched off.** Nothing runs unattended until you flip a
  switch on the Skills page and save, and nothing can be scheduled at all
  until the mineral has its own Claude sign-in.
- **It reaches what you connected and nothing else.** A skill can only read a
  service you have added on the Connections page ([what you can
  connect](/docs/connections) is the catalogue). It does not browse the web
  on its own. Research means your brain, your connected services, what you
  paste, and a search service like Exa if you connect one.

That is the list. Notice what is not on it.

## Four house rules I paste into the brain

Nothing in the engine stops the assistant from editing a page without asking,
or from deleting a file, or from telling you it read something it only
skimmed. Those are behaviours I want from mine, so I wrote them into layer 8
of my brain (the workflow layer, `wiki/_layers/8-workflow.md`), which the
assistant reads at the start of every session. They are rules, not
guarantees. A rule in the brain is followed the way a good new hire follows a
rule: nearly always, and better the more plainly you wrote it.

Here are the four, in a form you can paste into the Terminal:

```
Add these four rules to layer 8 of my brain under a heading
"House rules", and show me the page before you save it.

1. Propose before writing. For anything that matters (a
   client page, a draft going out, a change to a page you
   already have), show me the wording or the before-and-after
   and wait for my yes. Do not write first and tell me after.
2. Check before acting. Before asking someone for
   information, check whether I already have it. Before
   recommending who to contact, check whether a plan in the
   brain already names someone. Before drafting to a person,
   read their page for recent contact.
3. Never delete. Move it aside with today's date and a
   reason, and ask. This goes for pages, files, and anything
   in a connected service.
4. Never claim to have read what you have not. Refer to a
   document, an article or a message as read only if it is
   actually in front of you. Present a line as a quote only
   if it is word for word.
```

Why these four. The first saves you the most: it turns every edit into a
before-and-after you glance at, and a glance is enough. The second is about
premises. An assistant that asks a supplier for a phone number you already
have makes you look disorganised, and the check costs five seconds. The third
is because a moved file comes back and a deleted one does not. The fourth is
the honesty rule: an assistant that says "your 2023 pricing note sits close to
this" when it never opened the note has just made a claim in your voice that
you cannot stand behind.

## Earn before you act

![Read, draft, act](diagram:trust-ladder)

There is a ladder and I climb it slowly. Read first: connect a service, let
the assistant see it, ask it questions about what it sees. Then draft: let it
write the reply, the report, the page, while you stay the one who sends or
saves. Only then act: a schedule that writes labels, a skill that updates a
page without a look from you.

Each rung up buys you time and costs you predictability. A phrase I picked up
from Nate Herk and have not been able to improve on: autonomy equals risk
equals cost ([where these ideas come from](/docs/where-these-ideas-come-from)
has the rest of what I owe him). So I scope to the lowest rung that solves the
problem. A daily report that always runs the same five steps does not need
anything deciding its path; it needs five steps. And I scope the tools, not
just the words. Telling it "never send email" in a prompt is a wish. Not
connecting the thing that can send is a wall. The engine already builds the
wall for sending; for everything else, you decide what to connect and when.

The rule of thumb I use: a skill earns a schedule after it has run well by
hand three times, and a connection earns a wider grant after I have read its
output for a fortnight and not once winced.

## When it looks wrong

Most "it is broken" moments are one of four things, and they have four
different fixes.

| What you see | What it usually is | Where to go |
|---|---|---|
| It cannot see mail, calendar or a service you connected | An expired sign-in or a real fault on that one connection | [Fix a broken connection](/docs/fix-a-broken-connection) |
| A brief did not arrive, a skill shows "failed", the Overview has a red card | The mineral itself, a schedule, or the sign-in that schedules need | [When something looks wrong](/docs/when-something-looks-wrong) |
| A draft does not sound like you | Layer 8 is thin on voice, or you accepted a draft you did not quite like | [Teach it your voice](/docs/teach-it-your-voice) |
| It keeps guessing at your priorities, your clients, your prices | The brain does not say. It was said once in a conversation and never written down | [Grow the brain](/docs/grow-the-brain) |

One more that is not a fault at all: it forgot yesterday's conversation.
Sessions do not resume. Whatever mattered had to be captured into the brain,
and `/capture` at the end of a session is how. [How your assistant
thinks](/docs/how-your-assistant-thinks) explains the two kinds of memory,
and once you have seen them the forgetting stops being mysterious.
