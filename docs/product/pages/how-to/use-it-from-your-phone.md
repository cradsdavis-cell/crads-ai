---
title: Use it from your phone
summary: Your whole assistant in the Claude app on your phone, with your brain, your skills and your connections, while your laptop stays shut.
outcome: talk to your assistant from the Claude app on your phone, and know how to switch that off.
audience: public
access: public
mode: how-to
order: 65
pins: engine/comms/remote-control.mjs, engine/start-comms.sh, engine/cron/scheduler.mjs, wizard/panel/member.html, wizard/panel/panel-server.mjs
reviewed: 2026-10-14
---

Your assistant lives on a server, so it is awake when your laptop is not. The
**Claude app** on your phone can talk to it directly: the same assistant you
use at your desk, with your brain, your skills and your connected services,
and the work still happens on your mineral.

It is **on already**. There is nothing to install on your mineral and nothing
to connect.

## Open it on your phone

1. Install the **Claude** app (iPhone or Android) if you do not have it.
2. Sign in with **the same Claude account your mineral is signed in to**.
3. Open the **Code** tab.
4. Pick your assistant. It is listed by its name, with a small computer icon
   and a green dot when it is ready.
5. Ask it something, the way you would at your desk.

**You should see:** an answer that knows you, because it is reading your
brain. Ask "what's on my plate this week?" as a first test.

It works in a browser too: open **claude.ai/code**, signed in to the same
account, and pick your assistant from the list.

## What it can do from there

Everything it can do at your desk. It reads and updates your brain, runs your
skills, and uses the services you connected (your email and calendar, Canva,
and the rest), with the same limits you set: if Gmail is drafts-only, it is
drafts-only from your phone too. When it needs your permission for something,
the question comes to your phone and waits for your answer.

You can send it a photo, and the phone's own dictation works for typing by
voice.

## Telegram still has a job

If you set up [Telegram](/docs/connect-telegram), keep it. It is how your
**morning brief** and other scheduled results reach your phone without you
asking. The Claude app is where you talk to your assistant; Telegram is where
it brings you things.

## What to know before you rely on it

- **Your Claude sign-in now opens your mineral.** Anyone signed in to your
  Claude account can reach your assistant this way, with the same reach as
  you. Keep the email or Google account you sign in to Claude with secure.
  Claude's **Require trusted devices** setting (in beta) asks each new phone or
  browser to confirm with a passkey, your fingerprint or your face.
- **Anthropic keeps the conversation.** While a phone or browser session is
  connected, Anthropic stores that conversation under your Claude account, as
  it does your other Claude chats. The [privacy policy](/docs/privacy-policy)
  has the detail.
- **It needs your mineral to be signed in to Claude.** If that sign-in lapses,
  your phone cannot reach it until you sign in again (open the **Terminal** tab
  and run `claude`). The app's Connections page says so when it happens.
- **It comes back on its own.** After an update, a restart or a dropped
  network, your mineral restarts it within about two minutes.

## Switch it off (or back on)

In the Crads AI app, open **Your assistant**, then **Connections**. The first
row is **Claude app on your phone**. Press **Details**, then **Switch off**.
Your assistant can no longer be reached from the Claude app, and any phone
session that was open ends. **Switch on** brings it back straight away.

The row's chip is the short truth: **on**, **starting**, **restarting**,
**off**, **sign in to Claude** (your mineral's sign-in has lapsed), or **needs
a look** (it could not start; the details say why).

## If your assistant is not in the list

- Check the phone is signed in to **the same Claude account** as your mineral.
  A different account sees a different list.
- Check the chip on the Connections row. **Restarting** clears itself within
  two minutes; **sign in to Claude** needs the sign-in above.
- On a Team or Enterprise Claude plan, an owner of that plan has to allow it
  first (in Claude's admin settings, under Claude Code).
