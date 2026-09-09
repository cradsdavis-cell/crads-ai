---
title: Every skill your mineral ships with
summary: The 11 engine skills present on every mineral, with what each one does.
audience: public
access: public
mode: reference
generated: true
order: 10
---

> Generated from the code by docs/product/pipeline/generate.mjs. Do not edit by hand: run the generator.

Every mineral ships with these 11 skills. They are the engine set: the
skill library itself ships empty, so anything beyond this list is something you
added.

Four of them arrive with a schedule already attached: the daily brief in the
morning, the session capture in the evening, the weekly review on Sunday
afternoon, and inbox triage on a repeating interval. Like everything else the
schedules ship switched off; flipping the switch on your Skills page is what
starts one, and the times are yours to change there. The rest run when you ask,
or on any schedule you give them.

## Your mineral

| Skill | What it does |
|---|---|
| **Connect a service** (`/connect`) | Connect an outside service (Notion, Linear, a calendar, anything with an MCP server) so this mineral can use it, including in scheduled jobs. Triggers on /connect and natural asks like "connect me to Notion", "hook up my calendar", "add the Linear MCP", "can you talk to my email", "set up an integration". |
| **Build pages & cards** (`/dashboard`) | Build or change the member's own app pages and dashboard cards, the box-hosted surface their companion app renders. "Build me a page that shows X", "change my dashboard", "add a card for Y". |
| **Explain this system** (`/explain`) | Explain this AI system to the person using it and answer any question they have about how it works. Read-only, it inspects the mineral to give live, accurate answers (what is connected, where the data lives, whether backups are on) but never changes anything. Triggers on /explain and on natural questions like "how does this work", "what is this", "what am I connected to", "where is my data", "how do I back this up", "is this secure". |
| **Onboarding interview** (`/onboard`) | The deep interview that builds a brain from nothing on the 8-layer context spine (North Star, Philosophy, Self, Network, Past, Goals, Tasks, Workflow). Adaptive, one question at a time, resumable, two-pass (capture, synthesise, review). |
| **Write a page** (`/write-page`) | Author a page for your own app, a screen that installs into the sidebar of this mineral. Writes a self-contained, lint-clean page package and installs it here. Run it from the Terminal tab. |

## Briefings

| Skill | What it does |
|---|---|
| **Daily brief** (`/daily`) | Morning prioritisation brief. Pulls today's tasks + calendar, classifies events from the client's profile, picks the top 3, surfaces what's at risk. |
| **Plan your week** (`/plan-week`) | Monday goal-setter. SETS this week's 3 to 5 concrete outcomes (Mon to Fri) and writes them to wiki/this-week.md, the surface the daily brief reads and the close-of-day checks against. The planning yang to /weekly's review yin. Run at the start of the week. |
| **Weekly review** (`/weekly`) | Weekly review. Summarises the week's log, checks project health across active projects, flags stale actions + decisions, sets next week's focus. Run Sunday evening or Monday morning. |

## Capture

| Skill | What it does |
|---|---|
| **Capture the session** (`/capture`) | End-of-session sweep. Scans the conversation AND any configured capture sources (meetings, comms), diffs against the client's brain + tasks + calendar, proposes the updates that should have been written but weren't, confirms, writes. |

## Email and messages

| Skill | What it does |
|---|---|
| **Follow-ups** (`/followup`) | Scan for open loops (overdue tasks, unanswered messages from key contacts, stale project actions, pending commitments) and surface what's slipping before it becomes a problem. Read-only; surfacing, not acting. |
| **Inbox triage** (`/inbox`) | Triage unread inbox into buckets: open-loop (reply/FYI, leave unread) / mark-read (legit, no action) / archive (junk). Read-only on open-loops; bulk-confirm before any label writes. |
