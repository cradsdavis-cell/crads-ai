---
title: Share with your community
summary: The owner's half of the commons: set it up, publish your library into it, grant and revoke members, mint join bundles.
audience: public
access: public
mode: how-to
persona: host
surface: publish
order: 25
pins: engine/community/commons-admin.mjs, engine/community/commons-publish.mjs, wizard/panel/member.html
reviewed: 2026-09-01
---

A community shares a **commons**: a git repository you own, holding your
curated skills, packs, prompts, pages and folders. Members' minerals pull it
read-only and everything arrives as offers on their side. This page is your
half; the member's half is [join a community](/docs/join-a-community), and
the reasoning behind the model is in
[rocks and pebbles](/docs/rocks-and-pebbles).

Everything below lives on your rock panel's **Catalogue** page, on the
**Commons** card.

## 1. Create the repository

Any git host works; nothing in the software assumes GitHub. The documented
default is a **private GitHub repository** with invited collaborators, which
gives you a private community with the host's own access control doing all
the work. A public repository makes an open community anyone can pull.

## 2. Set up the commons

On the Commons card: the repository URL, an optional branch, and the
community name your members will see. For an ssh URL you can add a write
deploy key; for a GitHub https URL your rock's own GitHub sign-in does the
pushing.

## 3. Author as before, then publish

Nothing new to learn on the authoring side. Skills, packs, prompts, pages and
folders are written with the existing authoring verbs and Claude Code skills
into your library zones, and curation is the catalogue: what is in the zones
is what publishes.

**Publish** lays the whole catalogue out in the repository in the shape every
member pickup surface already reads, with a manifest members' catalogues
merge. Pages pass the same lint gate as everywhere else; a failing page is
skipped and named, never shipped silently. What you should publish, and why
an empty catalogue beats a full one at the start, is
[its own page](/docs/curate-for-your-community).

## 4. Grant a member

Record a grant on the roster: a label you know them by, optionally their
email or GitHub username. The panel prints their **join bundle**, one line
starting `cradscommons1:`. Hand it to them out of band, in a direct message,
never a public post.

For a private GitHub commons there is a second half, and the panel reminds
you every time: **also invite their GitHub account as a read collaborator on
the repository.** The bundle tells their mineral where to pull from; the
collaborator invite is what actually grants the read. Until they accept it,
their box says so plainly and keeps trying on its own.

## 5. Revoke a member

Mark the grant revoked in the roster, then remove their read access on the
git host. Removing the host access is what actually ends the feed; the
roster is your record. What they already installed stays theirs. That is a
standing ruling, not an accident, and it is worth saying to a member before
they join rather than after they leave.

## Reviewing share-backs

A member who wants to contribute proposes content as a fork and pull request
(on GitHub), or a branch pushed where you can see it. You merge or decline in
the git host's ordinary review flow. There is no custom review machinery to
run, and a member's read access cannot push anything into the commons on its
own.

## What the commons never carries

Member data, in either direction. The repository holds your curated content
and its manifest; your roster of grants lives in your own rock's brain, and
nothing a member does on their box is written back up. You get no status
feed, no install receipts and no activity signal through the commons, which
is the honest price of a model where you also hold no way into anyone's
machine. If you want to know how members are getting on,
[ask them](/docs/host-a-community-well); the software no longer answers on
their behalf.
