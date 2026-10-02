---
title: Connect Mailchimp, with your own key
summary: Make an API key in Mailchimp, paste it, and your assistant can read your audiences and reports, add and tag contacts, and draft campaigns. It never sends one.
outcome: let your assistant work with your Mailchimp audiences and campaigns, with a key that is yours and a send button that stays yours.
audience: public
access: public
mode: how-to
order: 75
pins: engine/comms/mailchimp-mcp.mjs, engine/comms/mcp-connect.mjs, wizard/panel/member.html
reviewed: 2026-10-02
---

Mailchimp connects with **an API key you make in your own account**. You paste
it on the Connections page, and your mineral checks it with one real read of
your account before it keeps it. About three minutes.

Once it is connected, your assistant can work with your audiences, contacts,
draft campaigns and reports, in your chats and in your scheduled jobs. A
Monday job that tells you how last week's newsletter did is the kind of thing
this is for.

## Why your own key, and why on your mineral

Mailchimp does not publish an official connection for assistants that covers
audiences and campaigns. The services that offer one host it themselves,
which means your audience passes through their machines.

So this one runs **on your mineral**. Your key is stored there, the small
program that talks to Mailchimp runs there, and your contact list never passes
through Crads AI or anyone else on its way to your assistant.

## What it can and cannot do

| It can | It cannot |
|---|---|
| List your audiences, tags and saved segments | **Send or schedule a campaign** |
| Find contacts and read a contact's details | Delete a contact, an audience or a campaign |
| Add a contact, or update one's name and fields | Change an existing contact's subscription status |
| Add and remove tags | |
| Draft a campaign: audience, subject and content | |
| Change a campaign's content while it is still a draft | |
| Send you a test of a draft | |
| Read a sent campaign's report: opens, clicks, unsubscribes | |

**It never sends a campaign.** A newsletter to your whole list cannot be taken
back, so your assistant drafts it and sends you a test, and you press Send in
Mailchimp.

**New contacts are added as "pending".** Mailchimp emails them to confirm, and
they receive nothing until they do. If you tell your assistant someone has
agreed to hear from you (they signed up at a market stall, say), it can add
them as subscribed instead. That is your call to make: the law in most
countries, and Mailchimp's own rules, need you to have that consent.

## Before you start

You need to be able to sign in to Mailchimp. In the Crads AI app, open **Your
assistant**, then **Connections**. Under **Add a connection**, find
**Mailchimp** and press **Set up**.

## Step 1. Make an API key

1. Press **Open Mailchimp API keys** on the card. Mailchimp may ask you to sign
   in first; it then opens the right page. (To find it yourself: your profile
   icon, **Profile**, then **Extras**, then **API keys**.)
2. Click **Create A Key**.
3. Name it `Crads`, so you know what it is later.
4. Click **Generate Key**, then **Copy Key to Clipboard**, then **Done**.

Mailchimp shows the whole key **only this once**. It looks like 32 letters and
numbers, a dash, and a short code such as `us21`. That ending tells your
mineral which of Mailchimp's servers holds your account, so copy all of it.

**A key can do whatever the Mailchimp user who made it can.** Mailchimp does not
offer smaller, limited keys. If that matters to you, have someone with a
smaller role in your Mailchimp account make the key instead.

## Step 2. Paste the key

Paste it into the card and press **Connect Mailchimp**. Your mineral saves it,
starts the Mailchimp program, and asks Mailchimp who the account belongs to.
When Mailchimp answers, the card says "Connected to" your account's name, and
Mailchimp appears in **Your connections** with the status "working, including
in scheduled jobs".

If Mailchimp turns the key down, the card says so and **nothing is kept**: the
key is removed from your mineral straight away, so you can make a new one and
try again.

| The card says | What happened | What to do |
|---|---|---|
| That does not look like a Mailchimp API key | Part of the key is missing, often the `-us21` ending | Copy it again; if Mailchimp no longer shows it, make a new one |
| Mailchimp turned that key down | The key is wrong, revoked, or expired | Make a new key and paste that |
| Your mineral could not reach Mailchimp | A network hiccup | Try again in a minute |

## Keys expire after a year

Mailchimp keys made since 22 June 2026 stop working a year after they are
made. The Mailchimp row in Your connections shows roughly when to expect that,
counted from the day you pasted the key. When it happens, your assistant tells
you Mailchimp has turned the key down: make a new key, disconnect Mailchimp,
and set it up again with the new one. Keys made before 22 June 2026 do not
expire.

## Some things depend on your Mailchimp plan

Mailchimp decides which features each plan includes, and your assistant can
only do what your plan allows. If something is not in your plan, your
assistant says Mailchimp refused it and why. Test emails are limited by
Mailchimp too: on the Free plan, 24 in a day.

## Disconnecting

Press **Disconnect** on the Mailchimp row in Your connections. That deletes the
key from your mineral. To switch it off at Mailchimp's end too, open **API
keys** in your Mailchimp profile and click **Revoke** next to the key named
`Crads`. A revoked key cannot be switched back on.
