---
title: Connect any other email, over IMAP
summary: Type your mail server's settings and an app password, and your assistant can search and read your email and write drafts for you to send. It never sends, deletes or moves anything.
outcome: let your assistant work with a mailbox that is not Gmail or Microsoft 365, with your own password and the Send button still yours.
audience: public
access: public
mode: how-to
order: 79
pins: engine/comms/imap-mcp.mjs, engine/comms/mcp-connect.mjs, wizard/panel/member.html
reviewed: 2026-11-05
---

This is for **a mailbox that is not Gmail or Microsoft 365**: the email that
came with your web hosting, or Fastmail, iCloud, Zoho, Yahoo and the like.
Gmail and Microsoft 365 have their own connections, which do more, so use
those for them: [connect Google](/docs/connect-google) and
[connect Microsoft 365](/docs/connect-microsoft).

You type your mail server's settings and a password on the Connections page,
and your mineral signs in once to check them before it keeps them. About five
minutes.

Once it is connected, your assistant can search your email, read a message,
and write a reply or a new email into your **Drafts** folder, in your chats and
in your scheduled jobs. A morning job that lists who wrote overnight and drafts
the replies, ready for you to check and send, is the kind of thing this is for.

## Why it runs on your mineral

Every mail provider runs its own mail server, so there is no single email
connection to sign in to. The ready-made ones pass your mailbox through
somebody else's machines.

So this one runs **on your mineral**. Your password is stored there, the small
program that talks to your mail server runs there, and your email never passes
through Crads AI on the way to your assistant. What your assistant reads goes
to Claude, as everything else it works on does. The connection to
your mail server is always encrypted, and your mail server's certificate is
checked first.

## What it can and cannot do

| It can | It cannot |
|---|---|
| List your folders | **Send anything**: there is no sending in it at all |
| Search a folder by sender, recipient, subject, words or date, or only unread | **Delete**, move, archive or flag an email |
| Read an email in full, and list its attachments by name | Mark an email as read: reading it changes nothing |
| Write a reply, threaded under the email it answers, into Drafts | Open or save attachments |
| Write a new email into Drafts | Change your mailbox, folders or settings |

**Drafts stay drafts.** Your assistant writes the email into your Drafts
folder. You open it in your usual mail app, on your phone or computer, check
it, change anything you like, and press **Send** there.

## What you need

- Your mail server's **incoming (IMAP) settings**: the server name, like
  `mail.yourhost.com` or `imap.fastmail.com`, and the port, almost always
  `993` with SSL/TLS. Your provider's help pages list them; search for "IMAP
  settings". Your mail app's account settings show them too, under incoming
  mail.
- Your **username**, usually your full email address.
- A **password**. If your provider has **app passwords** (iCloud, Yahoo,
  Fastmail, Zoho and most providers with two-step sign-in do), make one named
  `Crads` and use that. You can revoke it at any time without changing your
  real password. A web host's mailbox (cPanel and similar) usually just uses
  the mailbox's own password.

## Before you start

In the Crads AI app, open **Your assistant**, then **Connections**. Under
**Add a connection**, find **Email (IMAP)** and press **Set up**.

## Step 1. Find your settings

Look up your provider's IMAP settings, and make an app password if they offer
them. Tick **Done** when you have them.

## Step 2. Type them in

1. Your email address, and the password (or app password).
2. The mail server, the port and the security. `993` with **SSL/TLS** is right
   for almost everyone; choose **STARTTLS** only if your provider says so, and
   the port changes to `143` with it.
3. Only if they differ: the username, when it is not your email address, and
   the drafts folder, when your mail server does not mark one.
4. Press **Connect email**.

Your mineral saves it, starts the email program, and signs in once. When it
works, the card says "Connected as" your address, and **Email (IMAP)** appears
in **Your connections** with the status "working, including in scheduled
jobs".

If anything is wrong, the card says what and **nothing is kept**: the password
is removed from your mineral straight away, so you can fix it and try again.

| The card says | What happened | What to do |
|---|---|---|
| Your mail server turned the sign-in down | The username or password is wrong, or the provider wants an app password | Check both; if your provider has app passwords, make one and use that |
| Could not reach your mail server | The server name or port is wrong, or the server is down | Check them against your provider's IMAP settings |
| Your mail server's security certificate didn't check out | The server name is not the one on its certificate | Use the server name your provider gives, often their own (like `mail.yourhost.com`) rather than your domain |
| Your mail server does not allow signing in with a password | IMAP is switched off for the mailbox | Ask your provider to turn IMAP access on |

## Disconnecting

Press **Disconnect** on the Email (IMAP) row in Your connections. That deletes
the password from your mineral. If you used an app password, revoke it at your
provider too.
