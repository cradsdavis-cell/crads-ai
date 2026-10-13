---
title: Back up your mineral, and get it back
search-title: Back up and restore your AI assistant
summary: What is already backed up, the one thing you have to do yourself, and why the passphrase matters more than the backup.
outcome: know what is already backed up, do the one step only you can, and get everything back.
audience: public
access: public
mode: how-to
order: 50
pins: engine/backup.mjs, engine/restore.mjs, engine/policy.json, docs/mineral-restore-runbook.md, wizard/panel/door.html, wizard/panel/own-brain.mjs
reviewed: 2026-10-13
---

Two different things get backed up, by two different mechanisms, and the second
one has a step only you can do.

## Your brain backs itself up

Your brain is a folder of ordinary files, kept under git (the same
change-tracking system programmers use, working quietly underneath; you never
have to touch it). Connect GitHub and it pushes to a **private repository in
your own account**, on its own, from then on.

That is the important half. It means the pages your assistant has written about
your world exist somewhere that is not this machine and is not ours, in a format
you can read in any text editor, on infrastructure we cannot reach.

**If you do nothing else on this page, connect GitHub.** The create wizard
offers this exact step on its finish checklist, the moment your mineral first
comes alive, so you may well have done it on day one; the chip there says so
honestly either way. Later, and for any mineral made before the checklist
existed, the same flow lives on the **Backup** card, near the top of
**Your mineral**:

![Your mineral, with the Backup card under the mineral's name](shot:member-seat)

Here is the whole of it:

1. If you do not have a GitHub account, make one at github.com first. The free
   kind is fine; it is a place to keep private copies of files.
2. In the app, open **Your mineral**. The **Backup** card says where you stand.
   If nothing is connected yet it reads "Your brain lives on this mineral and
   nowhere else", which is the app being honest with you.
3. Press **Connect my GitHub**. A code appears; approve it on the github.com
   page that opens. Nothing to install, nothing to type beyond the sign-in.
4. Wait for the card to say **Done. Your brain now lives at github.com/...**,
   private and yours. From then on it stays current on its own, every night.

If the flow stops partway, it is safe to press again. The card names the leg
that failed and keeps the steps that did work, and says so in its own words:
"Nothing was lost: every step is safe to run again, so pressing Connect my
GitHub picks up where this stopped."

Once connected, the card is one line of truth: the repository's name, the date
your brain was last sent, and whose account it sits in: "private, in your own
GitHub account, every night".

The card also offers **Download a copy now** at any time. That downloads your
mineral's whole working state to the computer you are sitting at, minus
credentials and history: keys, secrets and sign-ins are excluded from the
archive, and the encrypted settings snapshot from the section below rides
along inside it. Connected or not, that button is always yours.

## Everything else backs up encrypted

Some things cannot live in a git repository: your Claude sign-in, your service
tokens, your bot token, your scheduled jobs, your connection settings. Those are
deliberately excluded from your brain repo, because a repository that carried your
credentials would be a repository you could not safely share or clone.

So once a night your mineral tars them up, **encrypts them on your machine** with
a passphrase generated on your machine, and pushes the encrypted blob to the same
repository. Of that snapshot, the repository only ever sees ciphertext; your brain pages ride the same repository as readable files you own. We never hold the passphrase.

In your terms, the encrypted snapshot holds: your Claude sign-in, your Telegram
link, your other stored secrets, your GitHub sign-in, your schedule, your
connection settings, and your profile. In other words, everything that makes a
fresh machine yours again.

It runs nightly at 03:40 mineral time, deliberately just before the 03:50 brain
push and the software restart a little after 04:10: the snapshot is written, ten minutes later
it leaves the box with the brain push, and only then does the machine restart.

And every night's snapshot is proven before it counts: the fresh blob is
decrypted and unpacked in a drill, every file that went in is checked to come
back out, and only then does it replace last night's copy. A failed run can
never destroy the previous good snapshot, because the previous one is not
touched until the new one has passed.

**Without GitHub connected, the snapshot dies with the machine.** The nightly
blob is still written, but it stays local-only, on the very machine it exists
to survive. Connecting GitHub is what puts both halves offsite at once: the
readable brain and the encrypted snapshot travel in the same repository.

## The step only you can do

Here is the catch, and it is a real one rather than a formality.

The passphrase is generated on your mineral on the first backup run, and printed
once, on that run. **Its only other copy is inside the backup it encrypts.**

Which means: if your machine dies and the passphrase lived only on that machine,
you have an encrypted blob that nobody, including us, can open. That is not a
backup. It is a souvenir.

So take the passphrase off the box, once, into wherever you keep things like
that: a password manager, or a piece of paper somewhere safe. The passphrase
lives in your mineral's own secrets, which your assistant can read for you, so
the way to do it is to ask, in the Terminal, in plain words:

```
Show me my backup passphrase so I can store it somewhere safe,
then record that I have.
```

Your mineral tracks whether this has happened. The record is a file the
[Secrets](/docs/secrets-page) page lists as **Backup passphrase, escrow
marker**, and until it exists the nightly record refuses to call the snapshot
recoverable. That is not nagging, it is the honest state.

The distinction it is holding onto is worth stating: **offsite is not the same
as recoverable.** The nightly record tracks both, separately. Offsite means the
encrypted copy left the box. Recoverable means somebody can actually decrypt
it, which needs the passphrase recorded off the box too. Until you do the step
above, the record carries its own warning, verbatim: "the backup passphrase has
not been recorded off this box, so this snapshot cannot be decrypted once the
VM is gone".

## Getting it back

If your mineral's server dies, you build a new mineral and pour the old one
back into it. There is no button for this in the app: it is a short procedure
with one command, and it takes three things from you: your GitHub account,
your backup passphrase, and the name of your old brain repository (you can see
it on github.com; it ends in `-brain`).

Before you start, an honest note: this has been tested end to end on test
copies, not yet on a real second server. If anything below does not match what
you see, stop and ask for help rather than improvising. Nothing in these steps
changes your old repository: it is only ever read.

1. **Make a new mineral with a new name.** In the app, under your minerals,
   choose **Set up my own** and build it exactly as you did the first time.
   Give it a name your old mineral never had. (A reused name points the app back
   at the dead server, and points your new mineral at the very backup you are
   about to restore from.) You can rename the assistant afterwards.
2. **Connect GitHub on the new mineral,** with the same GitHub account that
   holds your old brain. This makes a fresh repository for the new mineral, and
   lets the new mineral read the old one.
3. **Hold off on signing in to Claude.** The restore brings your old sign-in
   back, and would overwrite a new one.
4. **Open a plain terminal on your computer** (Terminal on a Mac, PowerShell on
   Windows) and type `ssh ` followed by your new mineral's name and `-box`, for
   example:
   ```
   ssh ana2-box
   ```
   You are now inside your new mineral.
5. **Check first.** This reads your old repository, opens the encrypted
   snapshot with your passphrase, and changes nothing:
   ```
   node /app/engine/restore.mjs /state --from your-github-name/old-name-brain --dry-run
   ```
   It asks for your passphrase. Nothing shows as you paste it; press Enter. If
   it says the passphrase does not open the snapshot, check you copied all of
   it. If it says the command is not found, your new mineral is on older
   software: in the app, **Help ▸ Update and restart**, then try again.
6. **Restore.** The same line without `--dry-run`:
   ```
   node /app/engine/restore.mjs /state --from your-github-name/old-name-brain
   ```
   Your pages, profile and settings come back, and your sign-ins come back
   from the snapshot. Your new mineral keeps its own name and its own list of
   computers that can open it, so you cannot lock yourself out. The restored
   brain is sent to your new repository straight away.
   If you disconnected Telegram after your last backup, add
   `--without-telegram` to the end of that line.
7. **Restart it.** In the app, **Help ▸ Update and restart**, so everything
   starts on the restored settings.
8. **Redo what does not travel.** Expect to sign in to Claude again: open the
   Terminal and it will ask if it needs to. On **Connections**, reconnect
   anything that does not show as connected. Only the computer you built the
   new mineral from can open it, so
   [let your other computers in](/docs/add-another-computer) again.
9. **Check it worked.** Your pages are on the Brain page; Claude answers in
   the Terminal; a message to your Telegram bot gets a reply. The next morning
   the Backup card shows a fresh nightly copy, under the same passphrase you
   already keep.

Once you are happy, delete the dead server in your hosting console. Keep the
old repository: it is your history.

**No passphrase?** Then the snapshot cannot be opened, by you or anyone. Your
brain still comes back: add `--no-snapshot` to the restore line, and redo
every sign-in and connection by hand. This is why the step above, the one only
you can do, matters more than the backup itself.

## What is not backed up

Anything you never told your assistant, and anything you deleted before the last
run. Backups are nightly, not continuous.

If you are about to do something drastic to your brain, the safe move is to let a
night pass first, or push your brain manually before you start.

