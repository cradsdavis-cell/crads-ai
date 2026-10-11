---
title: Crads for teams
search-title: Crads for teams: a company brain plus an assistant for everyone
summary: One company brain your whole team contributes to, an assistant on its own server for each person, and a company agent that holds the brain together. What goes where, who can change what, and what the owner owns.
audience: public
access: public
mode: explanation
order: 5
pins: engine/team/team-hub.mjs
reviewed: 2026-10-11
---

A single assistant knows one person's work. A team needs two things at once:
everyone's assistant should know what the company knows, and each person still
needs a corner of their own. Crads for teams is built around that split.

## What a team is

Everything below lives in **your** accounts. Crads AI holds none of it.

- **A company brain.** A private repository in your GitHub. It holds who you
  are, how you sound, your policies and prices, shared client and process pages,
  shared skills, and what each person's assistant has published.
- **A company agent.** An assistant on its own server, and the only thing that
  can write the company brain. Every hour it merges what people published, with
  sources, and keeps a daily digest and a page for the week so far.
- **An assistant for each person.** Each on its own server, with its own brain,
  reading the company brain first.

Every server sits in your hosting account, made with your own API token. You,
the owner, can open every one of them from your computer.

## What flows up, and what never does

Every night each person's assistant publishes **facts** from their work to the
company brain: clients, projects, decisions. Every fact carries a line naming
the person and the page it came from, so an answer can always say where it got
something and who to check with.

Two things never leave a person's server: their `personal/` folder, and any
page marked private. That holds three separate ways: those pages are never
copied into what gets published, the publishing job is blocked from reading
them, and every publish is a commit you can inspect.

Be straight with your team about one thing: **the company owns the servers**.
`personal/` is private from the company brain and from colleagues. It is not
secret from whoever administers the servers. It is for work in progress, not
for private life.

## Who can write what

| | Company brain | Their own repository |
|---|---|---|
| A person's assistant | read only | write |
| The company agent | write | read |

A person's assistant can only publish into its own repository, and the company
agent copies in only that person's own folder. So no assistant can rewrite a
policy, a shared skill or a colleague's pages, even by mistake.

## How the rules change

Policies, prices, processes, client pages and shared skills change only one
way: someone **proposes** it, and the owner approves it.

- A person asks their assistant to propose a change. In Slack, anyone can ask
  the company agent the same way.
- The company agent puts it in **Waiting for you** on its Team page, with the
  exact lines that change and any warnings: a shared skill reaches every
  assistant on the team, so a skill that downloads things, mentions keys or
  tries to override instructions is flagged.
- You approve or turn it down. Nothing changes for anyone until you approve,
  and every decision is kept, with your note.

## When people disagree

Two people often know different things about the same client. The company
brain does not pick a winner: it shows both, side by side, each with its
source, and the digest lists every place it happens. An assistant asked about
that client says that colleagues disagree and who to check with.

## The company agent in Slack

Connect Slack and anyone on the team can @mention the company agent, or message
it directly, and get an answer from the company brain with its sources. It
reads the company brain and nothing else, it ignores ordinary channel chatter,
and it never answers in a channel shared with another company. Asked to change
something, it drafts a proposal for you instead.

This is a different thing from [connecting Slack to one person's
assistant](/docs/connect-slack), which lets that assistant read and post as
them. Both can be on at once.

## A shared inbox

If the team shares a mailbox, the company agent can read it every hour and add
one line per new message to the company brain: who wrote, what they want, which
client, and who knows them best. It is built so that reading outside email is
all that part can do: it sees that one mailbox and nothing else, it cannot send
or change mail, and what it writes is checked line by line before it reaches the
brain. Anything personal or confidential is counted for the owner, not
summarised.

## When someone leaves

You choose who is leaving and type their name. Then, in order: their
`personal/` folder is copied to your computer for you to hand back to them,
their access to the company brain is removed, their repository is archived
(kept, read-only), the company agent stops merging from them, and their server
is deleted. What they already published stays with the company.

## What it costs

The software is free and open source. You pay the providers directly: one
server per person plus one for the company agent, billed by your hosting
company; Claude for each person (company seats or their own plans, your
choice), billed by Anthropic; and Slack and GitHub as you already use them.
Nothing is paid to Crads AI unless you want help setting it up.

[Set up a team](/docs/set-up-a-team) walks through it.
