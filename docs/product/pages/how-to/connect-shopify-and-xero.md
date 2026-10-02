---
title: Shopify and Xero, through your Claude account
summary: Why these two connect through your Claude account instead of your mineral, how to set them up there, and what that means for your scheduled jobs.
outcome: use Shopify and Xero with your assistant in your chats, knowing what they can and cannot reach.
audience: public
access: public
mode: how-to
order: 74
pins: wizard/panel/member.html, wizard/panel/mcp-catalogue.mjs
reviewed: 2026-10-02
---

Shopify and Xero both run their own connections for assistants. Today, both
only let **Claude's own connector** in, so your mineral cannot hold either
connection itself. You can still use them with your assistant: you connect
them to your **Claude account**, and they work whenever you chat.

The cost is one plain limit: **your scheduled jobs and Telegram cannot see
them.** Those run on your mineral, and a Claude account connection lives with
Anthropic, not on your mineral. Ask about your store or your accounts in a
chat, not in a morning job.

We list both on the Connections page so you can find them. Their cards say
**Chats only** and the button says **How to**, because pressing it opens these
steps, not a connection.

## Why not on your mineral

- **Shopify:** its sign-in only sends you back to Claude's or ChatGPT's own
  apps. Any other app, ours included, is turned away before you ever see a
  Shopify login.
- **Xero:** its connection for assistants turns down sign-ins from apps other
  than Claude's built-in connector at the moment.

If either opens up, it can move onto your mineral, where scheduled jobs can
use it too, and this page will say so.

## Connect Shopify

1. In the Crads AI app, open **Connections**, find **Shopify** and press
   **How to**, then **Open Claude connectors**. Or go straight to
   claude.ai/customize/connectors.
2. Search for **Shopify** and press **Connect**.
3. Sign in to Shopify and pick your store.
4. Shopify asks what Claude may do. Start with **read-only**: you can widen it
   later, once you have seen how your assistant uses it.

## Connect Xero

1. In the Crads AI app, open **Connections**, find **Xero** and press **How
   to**, then **Open Claude connectors**. Or go straight to
   claude.ai/customize/connectors.
2. Search for **Xero** and press **Connect**.
3. Sign in with your normal Xero login and choose the organisation.

Xero's connector is **read-only**: your assistant can look at invoices,
contacts and reports, and cannot change anything in Xero.

## After it is connected

Ask your assistant about your store or your numbers in a chat and it can
answer straight away. If you want a regular report, ask for it in a chat when
you want it: a scheduled job cannot reach these.

To disconnect either one, remove it in your Claude connector settings. There
is nothing on your mineral to remove.
