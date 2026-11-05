---
title: Connect Odoo, with your own key
summary: Make an API key in your Odoo, paste it with the address of your Odoo, and your assistant can look things up, keep contacts and leads current, and draft invoices. It never deletes, posts or sends.
outcome: let your assistant work with your Odoo contacts, CRM, sales and invoices, with a key that is yours and the confirm button still yours.
audience: public
access: public
mode: how-to
order: 78
pins: engine/comms/odoo-mcp.mjs, engine/comms/mcp-connect.mjs, wizard/panel/member.html
reviewed: 2026-11-05
---

Odoo connects with **an API key you make in your own Odoo**. You paste it on
the Connections page with your Odoo's address, and your mineral checks it with
one real read (who the key belongs to) before it keeps it. About five minutes.

Once it is connected, your assistant can work with your contacts, leads,
quotations, products and invoices, in your chats and in your scheduled jobs.
A Monday job that lists who still owes you money, oldest first, is the kind of
thing this is for.

## Why your own key, and why on your mineral

Every Odoo is its own: your company's Odoo lives at its own address, on Odoo
Online, Odoo.sh or your own server. So there is no single Odoo connection to
sign in to, the way there is for Notion or Linear. The ready-made ones either
need extra software installed inside your Odoo, or pass your records through
somebody else's machines.

So this one runs **on your mineral**. Your key is stored there, the small
program that talks to your Odoo runs there, and your records never pass
through Crads AI on the way to your assistant. What your assistant reads
goes to Claude, as everything else it works on does.

## What you need

- **Odoo 14 or newer.**
- **On Odoo Online, the Custom plan.** Odoo only opens its API to outside
  programs on Custom. On One App Free and Standard, Odoo turns every request
  away, and the card will say so. Odoo.sh and your own server have no such
  limit.
- **For Odoo 18 and older**, the email you sign in to Odoo with, and the
  database name if your Odoo server hosts more than one. Odoo 19 and Odoo
  Online need neither.

## What it can and cannot do

| It can | It cannot |
|---|---|
| Look up any record you can see in Odoo, and count them | **Delete anything**, or remove lines from an order or invoice |
| Add and update contacts, leads, quotations and products | **Confirm or post** an invoice, bill, quotation or order |
| Draft a customer invoice, credit note or vendor bill | Edit an invoice or bill once it is no longer a draft |
| List posted invoices or bills still owed, or only the overdue ones | **Register a payment** or reconcile anything |
| Leave an internal note on a record | **Email anyone**: notes are internal, never sent to customers |
| Tell you which Odoo it is talking to, and as whom | Archive a record, or move it through its workflow |
| | Change users, access rights, settings, journals, taxes or the chart of accounts |

**Invoices stay drafts.** Your assistant can put a draft together, line by
line, and tell you the total. You review it in Odoo and press **Confirm**
there. The same goes for quotations: it can write one, and you confirm it.

**The key acts as you.** It can see and do whatever the Odoo user who made it
can, within the limits above, and Odoo checks every request against that
user's access rights. To give your assistant less, an Odoo administrator can
make it a user of its own with fewer rights and make the key there. On Odoo
Online that is usually another paid user.

## Before you start

In the Crads AI app, open **Your assistant**, then **Connections**. Under
**Add a connection**, find **Odoo** and press **Set up**.

## Step 1. Make an API key

1. In Odoo, click your picture at the top right, then **My Preferences** (some
   versions say **Preferences**).
2. Open the **Account Security** tab and click **New API Key**. Odoo asks for
   your password first.
3. Name it `Crads`, so you know what it is later.
4. If Odoo asks how long the key should last (Odoo 19 and later do), pick the
   longest it offers: **three months**. Older versions do not ask.
5. Click **Generate Key** and copy it.

Odoo shows the key **only this once**. It is 40 letters and numbers.

No **API Keys** section on that tab? Switch on developer mode (**Settings**,
then **Activate the developer mode** at the bottom of the page) and look again.

## Step 2. Paste it

1. Type your Odoo's address, like `https://yourcompany.odoo.com`. It must start
   `https://`: your key never crosses the internet unprotected.
2. Paste the key.
3. On Odoo 18 or older, add your sign-in email, and the database name if you
   were told one.
4. Press **Connect Odoo**.

Your mineral saves it, starts the Odoo program, and asks your Odoo who the key
belongs to. When it answers, the card says "Connected as" your name and
company, with your Odoo version, and Odoo appears in **Your connections** with
the status "working, including in scheduled jobs".

If anything is wrong, the card says what and **nothing is kept**: the key is
removed from your mineral straight away, so you can fix it and try again.

| The card says | What happened | What to do |
|---|---|---|
| That does not look like an Odoo API key | Part of the key is missing | Copy it again; if Odoo no longer shows it, make a new one |
| Odoo turned that key down | The key is wrong, deleted, or has expired | Make a new key and paste that |
| Your mineral could not reach your Odoo | The address is wrong, or your Odoo is offline | Check the address in your browser, then try again |
| Odoo said: your Odoo is older than 19 and needs the email | An older Odoo signs in differently | Add your sign-in email (and database) and press Connect again |
| Odoo said: something about access or your plan | Odoo refused the request | On Odoo Online, check you are on the Custom plan; otherwise ask your Odoo administrator |

## When keys run out

**On Odoo 19 and later**, including Odoo Online, a key lasts three months at
most. The Odoo row in Your connections shows roughly when to expect that,
counted from the day you pasted the key. When it happens, your assistant tells
you Odoo has turned the key down: make a new key, disconnect Odoo, and set it
up again with the new one.

**On Odoo 14 to 18**, keys do not expire. The row shows no date, and the key
works until someone deletes it in Odoo.

## Disconnecting

Press **Disconnect** on the Odoo row in Your connections. That deletes the key
from your mineral. To switch it off at Odoo's end too, open **My Preferences**,
then **Account Security**, and delete the key named `Crads`.
