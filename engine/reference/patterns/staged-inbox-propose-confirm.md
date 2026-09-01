---
title: Staged-inbox propose-confirm (automated sweeps land in a review queue, not on the brain)
maturity: needs-engine-release
---

## What it is

Automated sweeps (an inbox watcher, an overnight reconcile job) never write directly to the brain or send anything on their own. Instead they drop proposals into one staging area, and a human reviews and approves before anything actually applies. The automation gets to run unattended; the risk of an unwatched job writing something wrong stays contained to a queue a human clears deliberately.

## Why it matters

Unattended jobs are useful exactly because nobody is watching them run in real time, which is also the risk. Without a staging area, an automated job has two bad options: stay so conservative it can't do anything useful, or write/send with no review, which is fine until one classification is wrong and something incorrect reaches a customer or a business record. Staging gets the leverage of automation without betting a client's own customer relationships on every classification being right.

## How to adopt it on this box

- The engine doesn't have a generic "staged job output" surface yet (no `state/inbox/`-style directory, no evening-review implementation). This is a `needs-engine-release` item, not something to build ad hoc per client.
- Until it ships: keep every automated job inside `comms.outbound_policy: propose-confirm` (the existing default) and route proposals into the next live chat/Telegram turn rather than a fire-and-forget background write. Don't invent a bespoke per-client staging file as a workaround, that fragments the pattern across clients instead of waiting for the shared version.
- Once a generic staging surface exists, route every cron/job proposal there and fold the day's proposals into one digest (see `evening-digest.md`) rather than pinging on each one individually.

## Signals you need it

- The client asks "wait, did that just happen automatically?" about something the box did on its own.
- A cron job either does nothing useful because it's been made too conservative, or the client has stopped trusting it because one bad write landed without review.
- More than one or two separate automated pings land on the client in a single day.
