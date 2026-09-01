---
title: Add another computer
summary: A machine you already trust lets the new one in, over SSH, with no account and no service in the middle.
audience: public
access: public
mode: how-to
order: 75
pins: wizard/panel/device-routes.mjs, wizard/panel/door.html
reviewed: 2026-09-01
---

Your identity on your mineral is an SSH key, one per computer. So a new laptop
does not sign in to anything: a computer that already opens the mineral
vouches for it, directly to your own box. There is no account, no email, and
no Crads-AI service anywhere in the chain.

You need both machines in front of you (or a way to copy two short strings
between them). The whole thing takes about two minutes.

## On the new computer

1. Open the Crads AI app. On the door, choose **I already have one**.
2. Type the mineral's name, exactly as it was set up ("the name it was set up
   with" is the prompt, and a wrong guess is refused later rather than
   installed under a mismatched name).
3. Press **Show this computer's key**. A single line appears, starting
   `ssh-ed25519`. Copy it.

## On the computer that already opens the mineral

1. Open the app. Find the mineral in the list and choose **Add a device**.
2. Paste the new computer's key and confirm.
3. The app appends the key to the box's own door over SSH, and answers with a
   **connection bundle**: one line starting `crads1:`. Copy that back to the
   new computer.

The paste is strict on purpose: exactly one key line is accepted, and
anything else (a second line, a stray character) is refused rather than
smuggled in. Appending the same key twice changes nothing.

## Back on the new computer

Paste the bundle and confirm. The app repairs its connection details from the
bundle, pins the box's host key before first contact when the bundle carries
one, then proves the whole chain with a real connection and says honestly
whether the mineral answered. When it does, this computer is in: same
mineral, same brain, same assistant.

## What just happened, in one paragraph

The old machine appended the new machine's public key to
`authorized_keys` on your box, which is the one list the door reads
([machines that can open your mineral](/docs/devices-and-access) is that
list's page). The bundle carried the box's address and host key back so the
new machine knows both where to connect and that it is talking to the right
server. At no point did anything leave the three machines you own.

## If it does not connect

- **"That name does not match"**: the mineral's name on the new computer must
  be the name the bundle was minted for. Re-run the offer with the right
  name.
- **The probe says the mineral did not answer**: the box may be restarting or
  the address unreachable from this network. The bundle is still good; try
  again in a minute.
- **No second computer any more** (lost, wiped, stolen): a machine can also be
  let in over plain SSH by anyone who still holds a working key, and if no
  working key exists anywhere, the box is sealed by design; that is what
  [the backup](/docs/back-up-and-restore) exists for. If a machine was
  stolen, remove its key from the roster first.
