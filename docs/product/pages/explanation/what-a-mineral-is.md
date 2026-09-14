---
title: What a mineral is
summary: The two words these docs use for the thing you get, and why it is a private box of your own rather than a seat in someone's software.
audience: public
access: public
mode: explanation
order: 10
reviewed: 2026-09-09
pins: wizard/panel/door.html
---

Two words come up on every page of these docs, so here they are once. If you
are still deciding whether the category is for you at all, start with
[what an AI EA actually is](/docs/what-an-ai-ea-is). If you are ready to make
one, [your first hour](/docs/first-hour) is the walkthrough.

## A mineral is the machine

A **mineral** is the server your assistant lives on: one box, one brain, one
assistant, and nobody else in it. Not a seat in somebody's software. A machine
in your own hosting account, holding your files, that you alone hold the key
to. The desktop app on your computer is the window onto it; the mineral is
the thing.

It does not have to be a rented server. The app's **On this computer** mode
makes the mineral a folder on your own machine: free, nothing to rent, the
same brain. What that mode cannot do is anything that needs a machine that
stays on: no scheduled jobs, no Telegram, no connections. It is only awake
when you are. The rest of this page describes the server kind.

That distinction does most of the work. When your assistant knows your
business, it knows it because your brain is a folder of readable, linked pages
sitting on your own server. You can open them. You can rewrite them. You can
take them and go. There is no version of this where the useful thing lives
with us and you rent access to it.

Which is also why the assistant is only as good as its interview. An assistant
with a thin brain is a chatbot with your logo on it. The hour you spend being
interviewed is not onboarding friction, it is the product.

## A pebble is your mineral

A **pebble** is what we call one person's mineral: your private workspace.
The app's sidebar calls the page about the machine itself "Your pebble", and
the moment the first read lands it takes the name you gave your assistant.
Every mineral made since September 2026 is a pebble. You will meet the word
"rock" in old conversations and old commit messages; it named a community's
hub in an earlier shape of the product, and there is no such thing any more.

## You make it yourself, and you pay nobody but your providers

Since September 2026 there is nothing central in this product at all. Nobody
provisions a machine for you, nobody bills you, and nobody holds an account
for you. The desktop app's **Set up my own** wizard builds your mineral on
your own hosting account, with your own API token, and the only key on the
server from its first boot is yours.

The costs, plainly, because they are the first screen of the wizard too:

- a cloud server, roughly €4 to €30 a month depending on the size you pick,
  billed to you by your hosting provider (or nothing, in On this computer
  mode)
- your own Claude subscription, billed to you by Anthropic
- nothing to Crads-AI, ever

Your identity here is your SSH key, not an email or a password. There is no
sign-in because there is nothing to sign in to: the app on your computer talks
straight to your box, and a second computer gets in because a computer you
already trust [lets it in](/docs/add-another-computer).

![Who can see what: your brain and credentials stay on the mineral; your providers run the pieces you pay them for; Crads AI reaches it only when you let us in.](diagram:who-sees-what)

## Why a box each, and not one system with accounts

The honest answer is that we tried the other versions first. A hosted platform
is cheaper to run, easier to update, and much easier to sell. It is also a
system where the interesting material, everyone's brain, sits within someone
else's reach, and where "can you see my notes" has a complicated answer.

So: a box each, on your own account, with your own key. It costs you a hosting
bill and a little setup, and it means the sentence "nobody reads your notes"
is a description of the architecture rather than a promise about anyone's
conduct. [What happens if Crads AI goes away](/docs/continuity) gets a much
shorter answer under this shape, which is the point of it.

## What the words mean, once

- **Mineral**: the machine your assistant lives on. A server in your own
  hosting account.
- **Pebble**: one person's mineral. Yours.
- **Brain**: the linked pages your assistant reads and writes. Yours.
- **Skill**: something your assistant knows how to do, on request or on a
  schedule.
- **Cadence**: what runs without you asking.

That is the whole vocabulary. Everything else in these docs is one of those
things doing something.
