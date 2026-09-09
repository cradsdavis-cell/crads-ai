---
title: Privacy policy
summary: What is stored, where it runs, what leaves your mineral, and why almost none of this page is about us any more.
audience: public
access: public
mode: legal
version: 0.12
effective: 2026-09-09
order: 10
---

## Who this is

Crads AI is operated by Samuel Davis, trading as Crads AI, **ABN 26 929 349
775**, in Coogee, New South Wales, Australia. Contact: cradsdavis@gmail.com.

This is version 0.10, effective 1 September 2026. The version and date at the
top of this page change whenever the text does, and prior versions stay on
the record.

*Changed in 0.10: the self-host redesign, which rewrote most of this page by
deleting its subject matter. Minerals are now created by their owners, on
their own hosting accounts, with their own keys; Crads AI operates no
accounts, no registration directory for them, no billing, and no tunnels, and
provisions nothing. The sections of versions 0.1 to 0.9 covering the
registration directory and its email hashes, the community status heartbeat
and its sharing switches, the setup key a community-built mineral was born
with, EU-only hosting, and the sub-processor table describing our vendors are
gone because the machinery they disclosed is gone. What survives is the
support-access disclosure and everything about the machine itself, which was
always yours. Changed in 0.11: the community model (a shared repository your
mineral pulled read-only) was removed from the software on 2026-09-09, so the
one sentence about it is gone; nothing else changed.*

## The short version

Your mineral is a machine in your own hosting account, in a location you
chose, opened only by your own keys, running your assistant on your own
Claude account. Your brain lives on it as ordinary files. **Nobody at Crads
AI reads your notes**, and under this design the sentence is structural
rather than behavioural: nothing of yours routes through us, and we hold no
account, record or credential about your mineral. It is your data, on your
machine, end to end.

The rest of this page is that sentence, in detail.

## What we hold about you

For a person who downloads the software and runs a mineral: **nothing**.
There is no account to create, no registration, no telemetry, and no
analytics in the app or on the docs site. The few things the app remembers
(which mineral you opened last, which side-menu groups you folded) live in
your own computer's storage and are never sent anywhere.

If you correspond with us (email, a support engagement, a paid service), we
hold that correspondence and the ordinary business records of it: that is
the whole list, and it exists because you wrote to us.

## Where your mineral runs

On a server you created in your own hosting account, at Hetzner or
DigitalOcean, in whichever of that company's locations you picked in the setup
wizard. Your contract for that machine is with them, not with us, and we
cannot see, reach or bill it.

If you are in Australia and picked a European location, your data is stored
overseas. We say that plainly because Australian privacy law expects
disclosure of overseas storage, and because you should know it regardless:
it is your choice, made in the wizard, changeable by rebuilding elsewhere.

## What lives on your mineral, and stays there

- **Your brain.** The pages your assistant writes and reads: who you are,
  your goals, your people, your business, your voice.
- **Your credentials.** Your Claude sign-in, your connected service tokens,
  your Telegram bot token if you use one.
- **Your run history.** What your assistant did and when.

None of this is copied to us. There is no central store of brains, because
there is no central store: one person, one machine.

## What leaves your mineral

Only what you set up, and each goes to an account of your own:

1. **A backup, to a repository you own.** A pebble pushes its brain nightly
   to a private GitHub repository in your own account, as readable files,
   and an encrypted snapshot of its settings and credentials to the same
   repository as ciphertext, AES-256, with a passphrase generated on your
   box. We never hold the passphrase and the repository is not ours. One
   property of git worth stating: the repository keeps history, so earlier
   snapshots persist in history you own until you prune it.
2. **Things you asked it to send.** Skill output you tick "Send me the
   result" on is delivered to your own Telegram bot, transiting Telegram's
   servers under your agreement with Telegram. Anything your assistant does
   through a service you connected (a draft in your Gmail, an event in your
   calendar) happens at that service, on your account, because you set it up
   and asked for it.

## Services you connect

- **[Google](/docs/connect-google)** (Gmail, Calendar, Drive). You create
  your own Google OAuth client and it stays on your mineral. Your Google key
  **never touches** Crads AI infrastructure, and we could not read your mail
  if we wanted to.
- **Everything else** in the connections catalogue signs in on your mineral,
  with the token stored on your mineral.
- **Anthropic.** Your assistant runs on **your** Claude account, under your
  agreement with Anthropic. What you send your assistant, you are sending
  through their service on your own account.

Because each of these is your account at that provider, connected by you,
they are your providers rather than our sub-processors: we are not in any of
those relationships.

## When anyone can reach your mineral

Two ways, both bounded, and only one involves a person.

**Software updates.** A pebble restarts nightly onto the latest published
software. That updates the machinery, not your files, and you can switch it
off. An update is a restart onto a published image; it is not a door, and
nothing about it can read your machine.

**Support access, only if you grant it.** If something is broken and you want
help on the machine itself, you grant access explicitly. The grant **expires
on a clock** enforced by the mineral's own door, and its lifecycle (that it
was enabled, when, until when, and any revoke) is recorded on your own
mineral where you can read it. What is not captured is a per-command
transcript of the session itself; that is a real limit and we would rather
name it than imply a log that does not exist. Nobody can add themselves to
your mineral without you granting it, and there is no standing key: a mineral
made by the wizard is born holding only your own.

## What a support session can see

Worth being exact about, because "someone can look at your mineral" and
"someone can read your saved passwords" are different sentences and you
should know which one you are agreeing to.

Your mineral stores secrets in two tiers:

- **Available to the box** (the default for anything a scheduled job needs at
  3am). Stored as a value on your disk. Encrypting it there would be theatre,
  because the box would have to keep the key on the same disk to use it at
  3am. **Anyone with access to the server can read these, and that includes a
  support session you have granted.**
- **Sealed to your devices.** Stored as an envelope only your own enrolled
  machines can open. There is deliberately no code on your mineral that can
  decrypt these, so a support session cannot read them, and neither can a
  scheduled job.

The [Secrets page](/docs/secrets-page) in the app lists every entry grouped
by what it is for. The rule that decides the tier is the one above: anything
a scheduled job needs while you are asleep is available to the box.

The same is true of your brain during a support session. A granted session is
server access, and server access can read files. The honest statement is that
the protection during an active grant is the grant record and the clock, not
an inability: the mineral records that the window was open and when it
closed, not each thing done inside it. If a credential would be damaging in
someone else's hands and nothing scheduled needs it, seal it; if you change
your mind about a grant, revoke it, and it ends immediately.

## Taking your data, and deletion

Your brain is a folder of readable files in a git repository on a machine you
hold, mirrored to a repository in your own account. There is no export step,
because there is nothing to export from: it is already yours, in a portable
format, everywhere it exists.

Deleting your mineral is deleting your server, in your own hosting console,
which destroys the machine and its disk under your contract with your host.
Nothing needs our involvement and we hold no record of the machine to delete
at our end. Copies you hold, including your backup repository, remain yours.

## Breaches

Given what is stored where, a breach of Crads AI could not expose your
mineral's content, because we do not hold any. If something we do hold about
you (correspondence, service records) is exposed, we will tell you what
happened, what was exposed, and what to do, without waiting to have a
complete picture first.

## Complaints

Write to cradsdavis@gmail.com. If you are in Australia and unsatisfied, you
can complain to the Office of the Australian Information Commissioner.
