# This folder is your brain

This is a Crads-AI brain that lives on your own computer. Nothing here runs on
a server. The folder is only awake when you open it in Claude Code, and it
belongs to you the way any folder on your disk does.

## What is in here

- `wiki/` is the brain itself: your priorities, your people, the eight context
  layers the onboarding interview writes. Everything the assistant knows about
  you is a markdown page in here, readable by you at any time.
- `profile.yaml` is who you are and how the assistant should sound. The
  interview fills it in; you can edit it by hand.
- `onboarding-state.json` is where the interview keeps its place, so you can
  stop and pick it up days later.
- `dashboard/` holds the pages the Crads-AI app shows beyond its built-in tabs.
- `.claude/skills/` holds the skills. Each one is a folder with a `SKILL.md`
  that Claude Code discovers as a project skill; `/onboard`, `/daily`,
  `/capture`, `/weekly` and the rest live there.
- `secrets/`, `.claude-auth/` and `.kernel/` are for credentials and machine
  state. They are in `.gitignore` and must stay out of any backup.

## How the interview works

Run `/onboard` in Claude Code with this folder open. It asks one question at a
time, follows the thread, and writes what it learns into `wiki/`. It is
resumable: close the window whenever you like and run `/onboard` again to
carry on from where it stopped.

## What this mode does not do

There are no scheduled jobs in this mode. Nothing runs at 07:00 while you
sleep, nothing watches an inbox, and there is no Telegram line. Those need a
server that stays awake; if you want them later, the Crads-AI app can set one
up on a server in your own hosting account and this folder can move there.
Until then the assistant works exactly as long as you have it open, and not a
minute longer.

## Backing up to GitHub

The Crads-AI app can connect this folder to a private repository in your own
GitHub account (the Backup card, or the finish checklist when the folder was
made). After that, pushing is one command in this folder:

    git push

The app also pushes when it opens, best-effort. Credentials never go in: the
`.gitignore` keeps `secrets/`, `.claude-auth/`, `.kernel/` and every `.env`
out of the repository, and the push refuses if that list is missing.

<!-- crads-ai:engine-notes start (the Crads-AI app keeps this block current; write your own notes above it) -->
## Paths on this computer

The skills in `.claude/skills/` are shared with the server edition of Crads-AI,
so they name server paths. On this computer:

- `/state/` means **this folder**. `/state/profile.yaml` is `./profile.yaml`,
  `/state/box-name` is `./box-name`, `/state/dashboard/` is `./dashboard/`,
  and so on. Never create a `/state` directory at the root of the disk.
- `/app/` does not exist here. When a skill says to run `node /app/engine/...`,
  follow its "On this computer" section if it has one. If it has none, say
  plainly that that part needs a server and carry on with the rest.
- `STATE.md` and `org-inbox/` are server files. Their absence is normal.

## Connections on this computer

Connections live with Claude Code on this computer, not in the Crads-AI app:

- **Gmail, Google Calendar, Google Drive** and the other Claude connectors
  come from the person's own Claude account. They turn them on at
  claude.ai/customize/connectors and sign in there; Claude Code picks them up
  automatically (they show in `/mcp`, marked as from claude.ai).
- **Other services** (Notion, Linear, and anything else with a remote MCP
  server) go in `./.mcp.json` in this folder, added from the app's
  Connections page or with
  `claude mcp add --transport http --scope project <name> <url>`.
  The person then types `/mcp`, picks the service and signs in in their
  browser. Claude Code keeps that sign-in; the app never sees it.
- `.mcp.json` and `.claude/` are in `.gitignore`, so connections are never
  part of a GitHub backup.

Scheduled jobs and Telegram still need a server: nothing here runs while the
folder is closed.
<!-- crads-ai:engine-notes end -->
