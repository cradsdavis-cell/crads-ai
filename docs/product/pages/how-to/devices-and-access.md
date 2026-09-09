---
title: Machines that can open your mineral
summary: The roster, what a key is, removing a machine, and why the door has no back door.
audience: public
access: public
mode: how-to
order: 80
pins: engine/devices/device-sync.mjs, wizard/panel/device-routes.mjs
reviewed: 2026-09-01
---

Your identity on your mineral is an SSH key, one per computer, and your
mineral keeps a roster of the keys allowed to open it. The roster is **the
only door**: a key that is not on it does not work, and removing a key from it
genuinely shuts that machine out. There is no account behind it, no password
reset, and no vendor who can let anyone in.

The list lives on [Your pebble](/docs/your-pebble-page), under the backup
card, and anything that changes it is written to a log you can read and
pushed to your Telegram.

## Where keys come from

**The first key is born with the box.** The wizard that built your mineral put
this computer's key on the server at creation, as its only key. Nobody else
ever held one: not a host, not Crads AI.

**Every later key is vouched for by an earlier one.** A computer that already
opens the mineral lets a new one in, over SSH, straight to your own box:
[add another computer](/docs/add-another-computer) walks both halves. There is
no other way in, which is the entire security model, stated in one sentence.

## Removing one

Remove a machine from the roster and its key stops opening your mineral: the
roster is the only thing the door reads, and the revoke takes effect the next
time that machine tries to connect.

Revoking is also more than shutting the door, and the confirmation says so
before you commit: "It loses access to this mineral, and it is removed from
every sealed secret. Adding it back later will not restore those." Sealed
secrets are locked to the machines you held when they were sealed, so the
strip is irreversible by design; re-enrolling the same laptop does not bring
its copies back. If some sealed secrets could only be opened by the machine
you just revoked, the app names them and asks you to "open the app on an
older computer to refresh them".

One guard exists for your own protection. **Removing the only working key
would lock you out of your own mineral permanently** (there is no back door to
fall back on, by design), so that removal is refused up front: "this is the
last key that can open this mineral, so removing it would lock everyone out;
add another computer first, then remove this one".

The same instinct is built into the machinery one layer down: the code that
writes the door will not write it empty, whoever asks. So even a bug elsewhere
cannot brick your mineral through this file.

Every removal is time-stamped and logged, and your Telegram hears about it.

## If a laptop is stolen

Remove its key from the roster, from any machine you still hold, before you do
anything else. Then treat what that laptop could reach the way you would treat
any stolen credential: the [Secrets](/docs/secrets-page) page lists what your
mineral holds and where each thing is revoked.

If the stolen machine was your **only** machine, there is no roster left to
edit from, and the box is sealed to you as thoroughly as to anyone else. That
is what [the backup](/docs/back-up-and-restore) exists for: your brain is in
your own repository, your snapshot is decryptable with the passphrase you
recorded, and a fresh mineral can be stood up from both.

## What else appears on the roster

A live [support access grant](/docs/grant-support-access) shows on this same
list as its own row, carrying "a window you granted" and its expiry, with its
own Revoke button. Any access anyone else temporarily holds is listed with the
same prominence as your own machines, and comes off the same way. When nothing
is granted, every row on this list is a machine of yours, and that is the
resting state.

You can also just ask. Your mineral keeps a self-description page at the top
of its brain, and your assistant reads it before answering questions about the
mineral itself. The roster is in it, so "which machines can open this mineral"
gets a current answer.

## Renaming

Machines can be renamed so the roster reads as "my laptop" and "the studio
Mac" rather than as key fingerprints. Renaming changes the label only; keys
and access are untouched.

Renaming is not cosmetic: it is what makes Revoke safe to use. The rename
prompt says it itself: "A name you recognise is what makes Revoke safe to use
later." The day a laptop is stolen, you want a roster of machines you can tell
apart, not two rows you have to guess between.
