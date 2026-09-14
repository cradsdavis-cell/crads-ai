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
