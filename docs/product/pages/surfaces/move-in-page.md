---
title: Move in
summary: The tab a server you already had shows while it moves in, a plan of steps you approve one at a time, each of which can be undone.
audience: public
access: public
mode: reference
surface: movein
order: 110
pins: wizard/panel/member.html, wizard/panel/move-in-host.mjs, engine/move-in
reviewed: 2026-10-18
---

*What your server already does, moving into Crads-AI one step at a time.*

You only see this tab on a server you already had before Crads-AI, while it
is moving in. On any other mineral the **Move in** button is not in the
sidebar at all, and once the move-in is finished it goes away.

While a server is moving in, Crads-AI runs nothing of its own: no schedules,
no Telegram replies, no commits. Your server keeps doing what it did. The
page lists a plan, made from what the server already runs, and nothing on it
happens until you approve it.

## The plan

The line at the top counts the steps (done, approved, waiting for your yes,
skipped) and says who answers your Telegram bot. **Make the plan again**
rebuilds the plan after something on the server changed; every step you have
already decided keeps its state.

The steps come in three groups.

### On your mineral

Changes inside your mineral only. Each job your server runs on a schedule
comes in **switched off**, with the same times: a job that asks Claude to do
something goes on the Skills page, and a plain program goes in the Scripts
list. Nothing runs twice, because nothing in Crads-AI is switched on yet.
Your Telegram bot's details are carried over too, so Telegram shows as
connected, while your own program on the server keeps answering it.

### On your server

One step per job, to switch it over. **Run it once** runs the Crads-AI copy,
so you can check it does what the server's copy does. **Switch over** then
turns the Crads-AI copy on and switches the server's crontab line off by
putting `# crads-move-in <date>:` in front of it. The line is never deleted.
The step that lets Crads-AI answer your Telegram bot lists anything your own
program does that Crads-AI's Telegram does not do yet.

### Things to know

Notes, where nothing changes: your skills, your CLAUDE.md, your connections,
your hooks, your branch and your backups folder stay as they are. **Got it**
marks one as read.

Every step says why it is there, and what it assumed when it had to guess.
Each one has **Approve** and **Skip** while it waits, **Apply** or **Switch
over** once approved, and **Undo** once it is done. Undo puts back exactly
what was there before.

## Still on the server

Programs that run all the time (a bridge, a dashboard, a tunnel, your other
containers) and anything whose program only exists on the server stay there.
They are listed here, and after the move-in the Health card on Overview lists
them under **Still on the server**, so one that stops is not forgotten.

## Finishing, or moving out

When every step is done or skipped, **Finish moving in** appears. From then
on your schedules, Telegram and backups run normally.

**Move out** reverses every step that is done, newest first, and then takes
the Crads-AI setup off your server. It asks first, on the page. Your brain
folder is left as it was, apart from the plan files (`cockpit/move-in.json`
and `move-in.md`).
