---
title: Self-hosted Claude: what runs where
search-title: Can you self-host Claude? What runs on your server, and what does not
summary: You cannot run Claude itself on a machine you own. You can own everything around it. What runs on your mineral, what goes to Anthropic, and the honest alternative.
audience: public
access: public
mode: explanation
order: 12
pins: docs/self-host-design.md
reviewed: 2026-10-11
---

You cannot run Claude itself on your own server. Nobody can, outside Anthropic
and the large cloud platforms that offer it. What you can own is everything
around it: the machine, the memory, the keys, the schedule and the
connections. That is what Crads-AI is, and this page draws the line exactly so
you can decide whether the split suits you.

## Claude itself only runs at Anthropic

Anthropic does not release Claude's weights. There is no download, no
container, no version you can put on a server of your own. So a product that
says it "self-hosts Claude" is doing one of two things: running the software
around Claude on your machine and calling Anthropic for the thinking, or
running a different, open model under Claude's name. Crads-AI is the first
kind.

[How your assistant thinks](/docs/how-your-assistant-thinks) has the picture
behind this: a mind you rent, a memory you own, senses you add. Self-hosting
moves the memory and the senses onto your machine. The mind stays rented.

## What runs on your mineral

Your [mineral](/docs/what-a-mineral-is) is a server in your own Hetzner or
DigitalOcean account, opened only by your own SSH key. On it:

- **Your brain**: every page your assistant knows about you, as markdown
  files in git, readable in any text editor.
- **Claude Code**, the program your assistant works in. It runs on your
  mineral, reads your files there, and calls Anthropic when it needs Claude to
  think.
- **Your credentials**: your Claude sign-in, and the token for every service
  you connect.
- **Your schedule**: the morning brief, the inbox sweep, every job that runs
  while you sleep.
- **Your run history**: what it did, and when.

Each night the brain is backed up to a private GitHub repository in your own
account. None of it is copied to Crads-AI, because there is nowhere of ours
for it to go.

## What goes to Anthropic, every time

The thinking happens at Anthropic, so whatever the thinking needs goes there:

- what you type to your assistant
- the pages and files it reads to answer you
- whatever comes back from the tools it uses along the way, such as an email
  it fetched to summarise

That traffic runs on your own Claude account, under your own agreement with
Anthropic. Crads-AI is not in the path and never sees it. What Anthropic keeps,
and whether it can be used to improve their models, is set by their terms and
by the privacy settings in your Claude account. Check those yourself.

## Two connections live with Anthropic, not on your mineral

Shopify and Xero only let Claude's own connector in, so you connect them to
your Claude account instead. They work in your chats and not in your
scheduled jobs; [Shopify and Xero](/docs/connect-shopify-and-xero) has the
detail. Every other connection signs in on your mineral and keeps its token
there.

## On this computer moves the machine, not the mind

The app's **On this computer** mode makes your mineral a folder on your own
laptop instead of a rented server. Your brain and credentials live there.
Every answer still comes from Claude, at Anthropic, on your account. What you
give up is everything that needs a machine that stays on: no scheduled jobs,
no Telegram, no connections.

## If nothing may leave your building, use a local model

Some people need every word to stay on hardware they own: a clinic under
strict rules, a firm whose clients forbid it. For them self-hosted Claude does
not exist, and the honest answer is an open model they run themselves, with a
tool like Ollama and a chat window on top. They trade some quality for
complete locality, and for that requirement it is the right trade.

I built Crads-AI on Claude anyway. For an assistant that drafts in your voice
and reads a week of your inbox, the quality of the thinking is most of what you
notice. The part that compounds over months is the memory, and that part is
entirely yours.

If that split suits you, [your first hour](/docs/first-hour) goes from download
to an assistant that is awake.
