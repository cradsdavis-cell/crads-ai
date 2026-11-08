---
title: Let someone work on your mineral
summary: Helper access: approving a request, what it opens, when it closes, what is recorded, and how to end it early.
outcome: let a named person work on your mineral for a fixed time, see what they did, and end it early.
audience: public
access: public
mode: how-to
order: 95
pins: engine/support/support-access.mjs, engine/support/grants.mjs, provisioning/host/enter-aios
reviewed: 2026-11-08
---

Sometimes something needs a person on the mineral itself: a fix from Crads
AI, or a build by someone you have hired. Nobody can do that on their own.
Access exists only when you grant it, to a person you can name, for a time
you can see, and this page is what granting it actually means.

## Two ways in

- **A fix from Crads AI.** On the Help page, the **Helper access** card has
  one button: **"Grant Crads AI support access for 24 hours"**.
- **Someone you have hired.** They send you a request: a link that opens the
  app, or a code you paste into **Paste a request from a helper** on the same
  card. Before anything opens, your mineral checks the request and shows you
  who is asking (name, organisation, contact and their key), what it is for,
  how long it lasts, and exactly what they will be able to see. You choose
  **Let them in** or **Decline**.

A request is signed by Crads AI, so it can't be forged or changed. It is
made for one mineral, so a request meant for someone else's won't open
yours. It works once, and it expires if nobody answers it within a week.

## What a grant is

A recorded, expiring permission for one named person.

- **It ends on a clock the door itself enforces:** up to 72 hours for a fix,
  up to 30 days for a project. Access ends on time even if the software on
  your mineral never runs another line.
- **It is recorded on your own mineral**, not in our systems: who, what for,
  from when, until when, the consent text you saw, and when it ended.
- **Your Telegram hears about it** when it opens and when it ends, and once a
  week while it stays open.
- **It appears on your [device roster](/docs/devices-and-access)** as its own
  row with its own Revoke, because it is a key that can open your mineral and
  that list claims to be all of them.

## What a helper can see, honestly

During a grant, a helper can reach everything on the mineral: your files,
your assistant's memory and notes, your chat history, and the secrets in the
tier a scheduled job can use. Credentials in the **sealed** tier stay sealed:
there is deliberately no code on your mineral that can open those, for them
or for anyone. A helper lands inside the mineral, never on the bare server
underneath it.

Two habits make this a small thing to grant: keep anything genuinely damaging
in the sealed tier ([Secrets](/docs/secrets-page) explains the split), and
grant the shortest time that fits the job.

## What is recorded

On a server set up since 8 November 2026, every session a helper opens is
recorded on the server itself, outside the part of the server their access
reaches: the commands they ran and what came back, the files they moved, and
their shell. **Session record** on their row shows it.

On an older server only the grant is recorded, not what was done inside it.
The request screen tells you which kind of server yours is before you decide.
A new server from the setup wizard records sessions.

A record shows the work. It cannot stop someone set on misusing full access,
so only let in people you trust. A job or file a helper leaves behind that
runs later is not part of their session; it shows in your mineral's own job
list and history.

## Someone who is not Crads AI

If you let in someone who does not work for Crads AI, they are not acting for
us. What they build, what they charge and how they treat what they see is
between you and them, under your agreement with them. We provide the door,
the request, the consent screen and the record.

## Ending it early

**End now** on their row, or Revoke on your device roster, ends it at once.
It does not ask anyone; it removes the access, logs that it did, and tells you.
