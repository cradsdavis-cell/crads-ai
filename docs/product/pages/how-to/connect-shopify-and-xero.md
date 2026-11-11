---
title: Shopify, Xero and Figma, through your Claude account
summary: Why these three connect through your Claude account instead of your mineral, how to set them up there, and what that means for your scheduled jobs.
outcome: use Shopify, Xero and Figma with your assistant in your chats, knowing what they can and cannot reach.
audience: public
access: public
mode: how-to
order: 74
pins: wizard/panel/member.html, wizard/panel/mcp-catalogue.mjs
reviewed: 2026-11-11
---

Shopify, Xero and Figma each run their own connection for assistants. Today,
each only lets **Claude's own connector** (or a short list of approved apps)
in, so your mineral cannot hold any of these connections itself. You can still use them with your assistant: you connect
them to your **Claude account**, and they work whenever you chat.

The cost is one plain limit: **your scheduled jobs and Telegram cannot see
them.** Those run on your mineral, and a Claude account connection lives with
Anthropic, not on your mineral. Ask about your store or your accounts in a
chat, not in a morning job.

We list all three on the Connections page so you can find them. Their cards say
**Chats only** and the button says **How to**, because pressing it opens these
steps, not a connection.

## Why not on your mineral

- **Shopify:** its sign-in only sends you back to the AI apps Shopify has
  approved (Claude, ChatGPT, Gemini and a few others). Any other app, ours
  included, is turned away before you ever see a Shopify login.
- **Xero:** its connection for assistants turns down sign-ins from apps other
  than Claude's built-in connector at the moment.
- **Figma:** its connection for assistants only lets in the AI apps on
  Figma's own approved list, and ours is not on it. It does not accept a
  personal access token either, so there is no key you could paste instead.

If any of them opens up, it can move onto your mineral, where scheduled jobs can
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

## Connect Figma

1. In the Crads AI app, open **Connections**, find **Figma** and press **How
   to**, then **Open Claude connectors**. Or go straight to
   claude.ai/customize/connectors.
2. Search for **Figma** and press **Connect**.
3. Sign in with your normal Figma login.

Then paste a link to a Figma file or frame into a chat and ask about it: what
is on it, what a component is called, how it would be built.

## After it is connected

Ask your assistant about your store, your numbers or your designs in a chat and it can
answer straight away. If you want a regular report, ask for it in a chat when
you want it: a scheduled job cannot reach these.

To disconnect any of them, remove it in your Claude connector settings. For
Shopify, also uninstall the integration in your Shopify admin, which is what
actually withdraws its access. There is nothing on your mineral to remove.
