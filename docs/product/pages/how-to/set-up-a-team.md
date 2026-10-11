---
title: Set up a team
summary: The owner's walkthrough: build the company brain and everyone's assistants in one run, hand each person their assistant, connect Slack, approve changes, add people, and handle someone leaving.
outcome: run a team of assistants that share one company brain.
audience: public
access: public
mode: how-to
order: 6
pins: wizard/panel/team-routes.mjs
reviewed: 2026-10-11
---

You run this once, as the owner, from the Crads app on your own computer. If
you have not read it yet, [Crads for teams](/docs/crads-for-teams) explains
what you are building and who can change what.

## Before you start

- **A hosting API token** with read and write access, for the account the
  servers should live in: [Hetzner](/docs/get-a-hetzner-api-token) or
  [DigitalOcean](/docs/get-a-digitalocean-api-token). It stays on your
  computer and is never stored.
- **A GitHub account.** The company brain and one repository per person are
  made in it, all private.
- **A decision about Claude.** Each person signs in on their own assistant,
  with a company Claude seat or their own plan. The company agent needs one too.

## Build the team

1. Open the app. On the first screen choose **Set up a team** (under
   **New here?** if this computer already has an assistant).
2. Give the team a short name, like `acme`, and list the people, one per line.
   Want an assistant for yourself too? Add your own name.
3. Pick the hosting company, paste the token, and choose **Check the token**,
   then **Build the team**.
4. Sign in to GitHub when the app shows a code.

The app then makes the company brain and each person's repository, builds the
servers one at a time (the company agent first), gives each server its keys,
and joins it to the team. Each server takes a few minutes on first boot.

## Hand each person their assistant

The last screen lists, for each person:

1. Their assistant's name, for example `acme-jess`.
2. They install Crads, choose **I already have one** and type that name. The
   app shows them a key.
3. On your computer, find their assistant in the list, choose **Add a device**
   under it and paste their key. Their computer is in, and yours stays in as
   the admin.
4. They sign in to Claude from the **Terminal** tab.

Then fill in `company/about.md`, `voice.md`, `policies.md` and `prices.md` in
the company brain on GitHub. Every assistant reads them first.

## Connect Slack

Open the company agent in the app (its name ends in `-agent`), sign it in to
Claude from its **Terminal** tab, then open its **Team** page:

1. Choose **Copy the manifest**, then at `api.slack.com/apps` choose **Create
   New App**, **From a manifest**, your workspace, and paste it.
2. Under **Basic Information**, in **App-Level Tokens**, generate a token with
   the `connections:write` scope. It starts `xapp-`.
3. Under **Install App**, install it and copy the **Bot User OAuth Token**. It
   starts `xoxb-`.
4. Paste both on the Team page and choose **Connect Slack**.

Invite the agent to a channel and @mention it to try it. This is separate from
[connecting Slack to one person's assistant](/docs/connect-slack); each
person can still do that for their own.

## Triage a shared inbox

If the team shares a mailbox (hello@, info@), the company agent can read it:

1. Open the company agent in the app and connect the shared mailbox on its
   **Connections** page (see [connecting Google](/docs/connect-google)).
2. On its **Team** page, under **The shared inbox**, pick that connection and
   choose **Start triaging it**.

Every hour from 07:00 to 19:00 it adds one line per new message to the company
brain: who wrote, what they want, which client, and who on the team knows them.
It can only read that one mailbox: it never sends, drafts, files or changes
anything, links and addresses are stripped from what it writes, and anything
personal or confidential is counted for you rather than summarised. Anyone can
then ask "what's in the shared inbox?".

## Approve changes

Proposed changes to policies, prices, processes, client pages and shared skills
appear on the company agent's **Team** page, under **Waiting for you**, within
the hour. Read the lines that change and any warnings, add a note if you like,
and choose **Approve** or **Turn down**. Every assistant on the team has an
approved change within the hour.

## Add people

Choose **Set up a team** again: your team is listed. Choose **Add people**, list
the new names, paste the hosting token, and **Add them**. Nobody else's server
is rebuilt. Hand the new people their assistants as above.

## Someone is leaving

Choose **Someone's leaving** for your team, pick the person, type their name
to confirm, paste the hosting token, and choose **Remove them from the team**.
Their `personal/` folder is saved on your computer (in `Crads-AI/team-exports`)
for you to hand back; nobody else has a copy. If their server is already gone,
tick **Their server is already gone** to skip that step.

## Support for the whole team

Under your team, **Support access for the whole team** opens Crads AI support
for 24 hours on the company agent only, or on every server. Every server
includes your staff's assistants, so tell your team first. **Close it on every
server** ends it early. Each grant is logged on each server, the same as
[granting support access](/docs/grant-support-access) on one.
