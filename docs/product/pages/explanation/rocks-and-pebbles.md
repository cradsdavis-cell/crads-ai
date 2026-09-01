---
title: Rocks and pebbles
summary: Why the thing you get is a private box of your own, and what a community is now that nothing sits in the middle.
audience: public
access: public
mode: explanation
order: 10
reviewed: 2026-09-01
pins: docs/commons-model.md, engine/community/commons-pull.mjs
---

I built this the wrong way round twice, so it is worth saying what the shape is
now and why it ended up here. If you are still deciding whether the category is
for you at all, start with [what an AI EA actually is](/docs/what-an-ai-ea-is).
If you are ready to make one, [your first hour](/docs/first-hour) is the
walkthrough.

## A pebble is yours

A **pebble** is your own private workspace: one box, one brain, one assistant,
and nobody else in it. Not a seat in somebody's software. A machine in your own
hosting account, holding your files, that you alone hold the key to.

That distinction does most of the work. When your assistant knows your
business, it knows it because your brain is a folder of readable, linked pages
sitting on your own server. You can open them. You can rewrite them. You can
take them and go. There is no version of this where the useful thing lives
with us and you rent access to it.

Which is also why the assistant is only as good as its interview. An assistant
with a thin brain is a chatbot with your logo on it. The hour you spend being
interviewed is not onboarding friction, it is the product.

## You make it yourself, and you pay nobody but your providers

Since September 2026 there is nothing central in this product at all. Nobody
provisions a machine for you, nobody bills you, and nobody holds an account
for you. The desktop app's **Set up my own** wizard builds your mineral on
your own Hetzner account, with your own API token, and the only key on the
server from its first boot is yours.

The costs, plainly, because they are the first screen of the wizard too:

- a Hetzner cloud server, roughly $10 to 25 a month depending on the size you
  pick, billed to you by Hetzner
- your own Claude subscription, billed to you by Anthropic
- nothing to Crads-AI, ever

Your identity here is your SSH key, not an email or a password. There is no
sign-in because there is nothing to sign in to: the app on your computer talks
straight to your box, and a second computer gets in because a computer you
already trust [lets it in](/docs/add-another-computer).

## A rock is a community hub, with no reach into anything

A **rock** is a community's own mineral: a coaching practice, a cohort, a
company, an association. It has a brain of its own, built by the same
interview asked about the community instead of a person, and it exists to
share what the community knows.

What a rock explicitly is **not**, any more, is a machine that can create,
own, or reach into anyone else's machine. Members make their own pebbles with
the same wizard everyone uses. The rock has no provisioning powers, holds no
credential for any member's box, and there is no path, however privileged, by
which it could read a member's pages. That is not a policy you are asked to
trust; there is simply no machinery that could do it.

## How a community actually connects: the commons

What ties a rock to its members is a **commons**: a plain git repository the
rock's owner controls, holding the community's curated skills, packs, prompts,
pages and folders. The whole model in five sentences:

- The owner publishes the community's library into the commons from their own
  rock ([sharing with your community](/docs/share-with-your-community)).
- Membership is read access to that repository, granted and revoked with the
  git host's own tools. A private GitHub repository with invited collaborators
  is the usual shape; a public repository makes an open community.
- The owner hands each member a **join bundle**, one line starting
  `cradscommons1:`, out of band. The member pastes it on their own
  [Communities page](/docs/join-a-community), and their mineral pulls the
  commons read-only on its own rhythm.
- Everything that arrives is an **offer**. Nothing installs itself, ever;
  installing is the member's explicit act, through the same lint and sandbox
  gates as anything else.
- Leaving, or being revoked, stops the feed. What a member installed stays
  theirs. That is a standing ruling, not an accident.

The isolation runs both ways by construction. The rock holds nothing of the
member's; the member holds nothing of the rock's beyond read access to the
commons. Pulling a commons never executes its content, and a hostile commons
gets no lever beyond files sitting in an inbox directory until you choose to
install one.

## Why a box each, and not one system with accounts

The honest answer is that we tried the other versions first. A hosted platform
is cheaper to run, easier to update, and much easier to sell. It is also a
system where the interesting material, everyone's brain, sits within someone
else's reach, and where "can you see my notes" has a complicated answer.

So: a box each, on your own account, with your own key. It costs you a hosting
bill and a little setup, and it means the sentence "nobody reads your notes"
is a description of the architecture rather than a promise about anyone's
conduct. [What your community can see](/docs/what-your-community-can-see) and
[what happens if Crads AI goes away](/docs/continuity) both get much shorter
answers under this shape, which is the point of it.

## What the words mean, once

- **Mineral** is the word for either kind, when it does not matter which. Your
  pebble is a mineral; a rock is a mineral.
- **Pebble**: one person's private box.
- **Rock**: a community's own mineral, the hub that curates its commons.
- **Commons**: the git repository a community shares; membership is read
  access to it.
- **Join bundle**: the one-line `cradscommons1:` string a community owner
  hands you to join their commons.
- **Member**: someone whose mineral has joined a community's commons.
- **Brain**: the linked pages your assistant reads and writes. Yours.
- **Skill**: something your assistant knows how to do, on request or on a
  schedule.
- **Cadence**: what runs without you asking.

That is the whole vocabulary. Everything else in these docs is one of those
things doing something.

If you run a community and want this for your members, the mechanics are in
[start a community](/docs/become-a-rock), and what you are taking on is in the
[hosting agreement](/docs/hosting-a-rock).
