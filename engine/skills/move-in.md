---
name: move-in
title: "Move in"   # human name shown on the Skills page; the slash id stays as a chip
description: Move what your server already does into Crads-AI, one step at a time and only with your yes. Makes a plan from what is already scheduled and running on the server, explains it in plain words, and applies only the steps you approve; every step can be undone. Triggers on /move-in and on asks like "move my jobs in", "what will moving in change", "carry my cron jobs over", "switch my Telegram bot over".
category: box             # Skills-page grouping (briefing|capture|comms|box|org|other): wire vocabulary, not copy
generic: true
---

# Skill: /move-in (bring an existing server into Crads-AI)

Purpose: the person already had a server and a brain before Crads-AI. The app set the server up beside what was running and mounted their brain at `/state`, in move-in mode: nothing is scheduled, committed or answered by Crads-AI yet. Your job is to help them decide, step by step, what moves into Crads-AI and what stays on the server, and to apply only what they say yes to.

## First: is there anything to move in?

Read `/state/ownership.json`. If `moving_in` is not `true`, say the move-in is finished (or was never started), show the "Still on the server" list from `/state/move-in.md` if there is one, and stop. If `/state/.kernel/move-in/host-inventory.json` does not exist, this is not an adopted server: say so plainly and stop. Never make a plan by looking around the server yourself.

## The rules that matter

1. **You never touch the server directly.** You are inside the container. You cannot and must not edit the crontab, stop services or change anything outside `/state`. Steps on the server are done by the app, from its Move in page, over its own connection. If the person asks you to switch a server job off, tell them which step it is and that the app's Move in page does it.
2. **The planner decides the plan, not you.** Make or refresh it with:
   `node /app/engine/move-in/plan.mjs /state`
   It reads the inventory the app collected and writes `/state/cockpit/move-in.json` and `/state/move-in.md`. Run it again whenever the person says something on the server changed; it keeps every step they have already decided.
3. **Nothing happens without a yes.** Apply a step only after the person has said yes to that step, or to a batch you listed by name in the same message. "Sounds good" to a whole plan is not a yes to every step: list what you are about to do and ask once.
4. **Every change goes through the apply tool**, never by hand, so it can be undone:
   - approve: `node /app/engine/move-in/apply.mjs /state approve <id> [<id> ...]`
   - apply a step on the mineral: `node /app/engine/move-in/apply.mjs /state apply <id>`
   - undo one: `node /app/engine/move-in/apply.mjs /state undo <id>`
   - skip one: `node /app/engine/move-in/apply.mjs /state skip <id>` (and `unskip <id>`)
   A step whose `side` is `host` cannot be applied from here; approve it, then send the person to the Move in page to do it.
5. **Never print secrets.** The plan already hides anything that looks like a token or password. Do not read `secrets/`, `.env` files or the inventory's raw lines aloud.

## How to explain the plan

Read `/state/move-in.md` (or `cockpit/move-in.json` for the detail) and explain it in plain words, a few steps at a time, in this order:

1. **What moves in, switched off.** Each scheduled job becomes a Crads-AI entry with the same times, switched off: a job that asks Claude with words the plan could copy goes on the Skills page; plain programs go in the Scripts list. A job whose prompt is put together when it runs (by the shell, or by the person's own job runner) is never rewritten as a skill: it goes in the Scripts list running the same command inside the mineral, and the runner calls `claude` itself there. If the step says the brain also has a same-named skill, ask whether that skill does the same job; if it does, they can schedule the skill instead and skip the step. Nothing runs twice, because nothing in Crads-AI is switched on yet.
2. **Switching a job over.** For each job, the switch-over step turns the Crads-AI copy on and puts `# crads-move-in <date>:` in front of the server's crontab line, which stops it without deleting it. Before switching over, the person runs the Crads-AI copy once (Run now on the Move in page) and checks it did what the server's copy does. One job at a time; the backup job last, and only after a Crads-AI backup has been restored as a test.
3. **Telegram.** The bot's details are carried over so the app shows Telegram connected, but the person's own program keeps answering it. While moving in, Crads-AI sends nothing to Telegram and reads nothing. After Finish it can send (the results of jobs set to "Send me the result") while their own program still answers. Letting Crads-AI answer the bot is a separate step that only opens after Finish, because while moving in Crads-AI's reader is held back and nobody would be answering; it does not count toward finishing. Read its `why` aloud, because it lists what their program does that Crads-AI's Telegram does not do yet.
4. **Still on the server.** Always-on programs (bridges, dashboards, tunnels, containers) and anything whose program only exists on the server stay there. Say so, and say they show on the Health card so they are not forgotten.
5. **Things to know.** Their skills, CLAUDE.md, connections, hooks, branch and backups folder stay as they are; read out anything the notes flag (a connection that cannot run inside the mineral, uncommitted changes). If the plan says to connect GitHub first, their git remote is one only the server can use (an SSH alias or a folder on the server): Crads-AI's nightly push cannot reach it, so their own backup job stays on the server and its switch-over waits until GitHub is connected through the app and the plan is made again.

Every step's `why` says what the planner assumed. When it says it guessed (a job read as a plain script because its runner could not be read, a schedule it could not carry over exactly), say so and ask the person whether that is right before they approve it. If they correct you, change nothing yourself: refresh the plan, or tell them to ask for the job to be added the way they want.

## A step that stopped part way through

A step on the server is done in two halves, and if the app closed or lost its connection between them, the plan shows the step as part-way through (`in_flight` in `cockpit/move-in.json`). Never fix that by hand and never edit the plan file. Tell the person to open the Move in page and press **Check the server**: the app reads the crontab line or the service with the step's own read-only check, says what it found, and offers the two ways out that are safe from there (finish the step, or put it back as it was). If the server shows neither state, someone changed it by hand; say so and ask them to look at it on the server before checking again.

## Finishing

When every step is done or skipped (the Telegram switch-over does not count), the person finishes from the Move in page (or you run `node /app/engine/move-in/apply.mjs /state finish` after they say so). The jobs they switched on run on their schedules from the next minute, and Crads-AI's own Telegram and nightly backup come up within a couple of minutes. If they change their mind about the whole thing, "Move out" on the Move in page first holds everything Crads-AI runs (nothing more is committed), then reverses every done step, newest first, and then takes the Crads-AI setup off the server. Their brain folder keeps the plan files and ownership.json. Anything Crads-AI already committed stays in their git history: Move out lists those commits and never rewrites history.
