---
title: Let someone look at your mineral
summary: Granting support access: what it opens, when it closes, and how to end it early.
audience: public
access: public
mode: how-to
order: 95
pins: engine/support/support-access.mjs
reviewed: 2026-09-01
---

Sometimes something is broken in a way that needs a person on the machine
itself: paid support, guided setup, a hand you trust. Nobody can do that on
their own: support access exists only when you grant it, and this page is what
granting it actually means. The wording below says "Crads AI" because that is
whose support key the grant admits; the mechanics are identical whoever is
helping you.

## What a grant is

A recorded, expiring permission. When you grant support access:

- **It expires on a clock the door itself enforces.** You choose the duration
  when you grant it, anywhere from 1 hour to 72. The line that opens the door
  carries the mineral door's own expiry stamp, so access ends on time even if
  the software on your mineral never runs another line. Nothing has to wake
  up to close it.
- **It is recorded on your own mineral**, not in our systems: the grant and
  every event around it (granted, revoked, when, for how long) are appended
  to a file on your mineral you can open and read yourself. The event list in
  the app is a view of that file, not a copy we hold.
- **Your Telegram hears about it.** The grant, and any change to it, is pushed
  to you like every other custody event.

There is no standing alternative to this. A mineral made through the setup
wizard is born with your key and nobody else's, so before your first grant
the honest description of your mineral is: closed to everyone but
[your own machines](/docs/devices-and-access).

## Where to grant it

The control lives on the Sharing page, in the **Support access** card. When
nothing is granted the card says exactly that: "No support access granted.
Your mineral is closed to Crads AI." One button grants the default:
**"Grant support access for 24 hours"**, and the confirmation is a single
line, "OK: support access granted for 24h (until ...). Revoke any time."

While a grant is live the card flips to its active state and shows the
expiry: Crads AI can reach this mineral until that moment and no later. The
most recent events display underneath, straight from the record.

A live grant also appears on your [device roster](/docs/devices-and-access),
as its own row with its own Revoke button. It is a key that can open your
mineral, and that list claims to be all of them, so it is there.

## What it opens, honestly

A grant is server access, and the [privacy policy](/docs/privacy-policy) says
what that means rather than softening it: during a live grant, files on the
mineral are readable, including secrets stored in the tier a scheduled job can
use. Credentials in the **sealed** tier stay sealed: there is deliberately no
code on your mineral that can open those, for us or for anyone.

A support session also lands where a member session lands: inside the
mineral. It never touches the bare host machine the mineral runs on.

Two habits make this a small thing to grant: keep anything genuinely damaging
in the sealed tier ([Secrets](/docs/secrets-page) explains the split), and
grant the shortest duration that fits the problem.

## Ending it early

Revoke it at any time, from the same place you granted it, or from the grant's
row on your device roster. Revocation does not ask us; it removes the access,
logs that it did, and answers "OK: support access revoked."

One detail worth knowing because it was once a class of bug: a single piece
of software derives the door from both records, your devices and the grant.
So enrolling or revoking a machine can never silently drop a live grant, and
granting or revoking support can never disturb your machines.

## What we do inside a grant

Fix the thing you asked about, and tell you what we did. The log on your
mineral records the grant's whole lifecycle: who enabled it, when, until
when, and when it was revoked. It does not capture a transcript of each
command run inside the session; that is a real limit and we would rather
name it than imply otherwise. So "what did you actually touch" is answered
by the lifecycle record plus our written account of the work, and we keep
that account specific.
