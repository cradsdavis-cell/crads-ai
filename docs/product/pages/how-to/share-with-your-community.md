---
title: Share with your community
summary: "Start a community with one field, publish your library into it, share join links, and see who has accepted, live."
audience: public
access: public
mode: how-to
persona: host
surface: publish
order: 25
pins: engine/community/commons-create.mjs, engine/community/commons-admin.mjs, engine/community/commons-github.mjs, engine/community/commons-publish.mjs, wizard/panel/member.html
reviewed: 2026-09-02
---

A community shares a **commons**: a git repository you own, holding your
curated skills, packs, prompts, pages and folders. Members' minerals pull it
read-only and everything arrives as offers on their side. This page is your
half; the member's half is [join a community](/docs/join-a-community), and
the reasoning behind the model is in
[rocks and pebbles](/docs/rocks-and-pebbles).

Everything below lives on your hub's **Catalogue** page, on the **Commons**
card.

## 1. Start the community

Type the community's name in human words ("Harbour Guild") and press
**Start the community**. Your hub does the rest itself, with its own GitHub
sign-in: it creates a **private repository** named after the community on
YOUR GitHub account, puts a README naming the community in it, and wires the
card up. If the hub has no GitHub sign-in yet, the card offers the same
one-press connect flow the Backup card uses, then finishes the create on its
own.

Tick **open community** if anyone with the link should be able to pull the
library; that makes the repository public instead.

**Advanced: bring your own repository.** Any git host works; nothing in the
software assumes GitHub. The fold under the start button takes a repository
URL, an optional branch, the community name, and (for ssh URLs) a write
deploy key, exactly as before. For a GitHub URL your hub's own GitHub sign-in
does the pushing.

## 2. Author as before, then publish

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

## 3. Share with a member

On the Access section: a label you know them by, and (for a private GitHub
commons) their GitHub username. Press **Share with them** and three things
happen at once:

- they are **recorded on your roster** (your own ledger, kept in your hub's
  brain, never in the commons);
- when you gave their username, your hub **sends the GitHub invitation
  itself** (read access, nothing more) and tells you it did, or tells you
  exactly why GitHub refused;
- their **join link** is printed with a copy button. Send it in a direct
  message, never a public post: opening it lands them on their app's
  Communities page with the invitation filled in. A raw one-line invitation
  is printed too, the fallback for anywhere the link cannot travel.

Their side of this is [join a community](/docs/join-a-community); until they
accept GitHub's emailed invitation, their app says so in those words and
gives them a Check again button.

## 4. See who is actually in

For a GitHub commons the roster is **live**: each row with a username says
what GitHub says right now (*invite pending*, *accepted*, or *not on the
repo*), and anyone with read access to the repository whom your roster does
not name is listed as well, so the two lists cannot silently disagree. When
GitHub cannot be reached, the roster still answers from your ledger and says
that is what it is doing.

## 5. Revoke a member

Press **Revoke** on their row. When the grant carries their GitHub username,
the same press also removes their read access on GitHub (a still-pending
invitation is cancelled too); otherwise removing the host access stays your
step, and the copy says so. What they already installed stays theirs. That is
a standing ruling, not an accident, and it is worth saying to a member before
they join rather than after they leave.

## Reviewing share-backs

A member who wants to contribute proposes content as a fork and pull request
(on GitHub), or a branch pushed where you can see it. You merge or decline in
the git host's ordinary review flow. There is no custom review machinery to
run, and a member's read access cannot push anything into the commons on its
own.

## What the commons never carries

Member data, in either direction. The repository holds your curated content
and its manifest; your roster lives in your own hub's brain, and nothing a
member does on their box is written back up. You get no status feed, no
install receipts and no activity signal through the commons, which is the
honest price of a model where you also hold no way into anyone's machine. If
you want to know how members are getting on,
[ask them](/docs/host-a-community-well); the software no longer answers on
their behalf.
