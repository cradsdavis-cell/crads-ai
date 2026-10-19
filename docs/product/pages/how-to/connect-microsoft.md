---
title: Connect Microsoft 365
summary: Type a short code at Microsoft and your assistant can read, search and send your Outlook email and manage your calendar and contacts. Nothing to set up first.
outcome: let your assistant work with your Outlook mail, calendar and contacts, signed in on your mineral and nowhere else.
audience: public
access: public
mode: how-to
order: 77
pins: engine/lib/ms365.mjs, engine/comms/ms365-login.mjs, engine/comms/mcp-connect.mjs, wizard/panel/member.html
reviewed: 2026-10-19
---

Microsoft 365 connects with **a short code you type at Microsoft**. There is no
app to make and nothing to paste. About two minutes.

Once it is connected, your assistant can read, search and send your Outlook
email and see and manage your calendar and contacts, in your chats and in your
scheduled jobs. It works for a work or school account (Microsoft 365 for
business, or email at your own domain on Outlook) and for a personal one
(outlook.com, hotmail.com, live.com).

## Where your sign-in lives

The part that talks to Microsoft runs **on your mineral**, and so does the
sign-in. When you type the code, Microsoft hands the sign-in straight to your
mineral, which keeps it in an encrypted file of its own. It never passes
through this app, Crads AI or anyone else, and your mail goes from Microsoft
to your mineral and nowhere in between.

## What it can and cannot do

| It can | It cannot |
|---|---|
| Read, search and send email, reply and forward | **Delete** an email, a contact or a calendar |
| Draft replies, file messages into folders, flag and categorise | Make **inbox rules**, so it can never set mail to forward itself |
| See your calendar, find meeting times, create, change or cancel events | **Share** your calendar with anyone |
| Accept or decline invitations | Change mailbox settings such as your automatic replies |
| Read, add and update contacts | Reach OneDrive, SharePoint, Teams or a shared mailbox |

Those limits are on purpose. Your scheduled jobs run while you are away, and
the things in the right-hand column are the ones that are hard to undo or
quietly hand your mail to someone else. Cancelling a meeting is allowed,
because the people invited are told.

## Connect it

1. Open **Connections**. Find **Microsoft 365** in the list and press
   **Connect**.
2. Pick the kind of account: **Work or school**, or **Personal**. If you are
   not sure, it is the one whose address you sign in to Outlook with: your own
   domain is work, outlook.com or hotmail.com is personal.
3. Press **Get a sign-in code**. Your mineral asks Microsoft for a code and the
   card shows it, with a button that opens Microsoft's sign-in page.
4. On that page, type the code, sign in with the account you picked, and
   accept. You can do this on your phone if that is easier. The code lasts 15
   minutes.
5. The card finishes by itself. Your mineral checks that it can reach your
   account from where your scheduled jobs run, and the row in **Your
   connections** shows your address and **working, including in scheduled
   jobs**.

## If Microsoft says an administrator has to approve it

Some organisations only let an administrator approve a new connection. Then
Microsoft shows a message about admin approval, and the card says so.

- **If you run your own Microsoft 365** (many small businesses do: you set it
  up, or you manage the domain), you are the administrator. Press **Get a
  sign-in code** again, sign in with your administrator account, and tick
  **Consent on behalf of your organization** before you accept. That approves
  it once, for everyone in your organisation, and you are connected.
- **If someone else runs it**, ask them to approve it. It is a one-time
  approval in their Microsoft admin centre, and this page is what to send them.

## Your own Microsoft app (optional)

By default the connection signs in with the connector's own public Microsoft
app, which is why there is nothing to set up. An organisation that wants its
own app name on the consent screen can register one in Microsoft Entra and
use it instead:

1. In Microsoft Entra, register a new app. For who can use it, pick accounts
   in your organisation only, or in any organisation.
2. Under **Authentication**, turn on **Allow public client flows**. No secret
   and no redirect address are needed.
3. Under **API permissions**, add the Microsoft Graph delegated permissions
   for mail, calendar and contacts, and grant consent for your organisation.
4. On the Connections card, open **Your own Microsoft app**, paste the app's
   **Application (client) ID**, and, if the app is for your organisation only,
   your directory (tenant) ID or your domain. Then press **Get a sign-in
   code** as above.

## Switching or disconnecting

- **A different account kind or app.** Pick the other one on the card and get
  a new code. The old sign-in is deleted from your mineral first, because it
  belongs to the other door.
- **Disconnect** on the row deletes the connection and the sign-in from your
  mineral. To cut it off from Microsoft's side as well, remove the app under
  **My Apps** (myapps.microsoft.com) for a work account, or under **Apps and
  services** at account.microsoft.com for a personal one.

## When it stops working

The row says **added, waiting for you to sign in once** when there is no
sign-in yet, and **waiting for you to enter the code at Microsoft** while a
code is live. If your assistant reports that Microsoft turned it away, press
**Sign in** on the row and get a new code. Microsoft ends a sign-in that goes
unused for 90 days, and an organisation can end one sooner. If the card says
your mineral needs a newer version, open **Help** and press **Update and
restart** first.
