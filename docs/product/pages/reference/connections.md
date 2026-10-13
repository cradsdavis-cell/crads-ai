---
title: What you can connect
summary: The 66 services your mineral can connect to, the 2 that only connect through your Claude account, and how each one signs in.
audience: public
access: public
mode: reference
generated: true
order: 20
---

> Generated from the code by docs/product/pipeline/generate.mjs. Do not edit by hand: run the generator.

66 services your mineral can connect to without you finding an endpoint
yourself. 6 of them ship inside the box as featured connectors; the rest
are in the list on the same page, and you connect them from there. 2 more (Shopify and Xero) are listed so you can find them, but they only connect through your Claude account, so they work in your chats and never in scheduled jobs.

The sign-in column says how you authorise it. **One click** means the service supports
dynamic registration, so you sign in and it is done. **Token** means you paste an API
token instead, because that endpoint advertises no one-click flow. **Guided** means the
Connections page walks you through making your own key, step by step, and its link is
the same walkthrough in writing. **Claude account** means the service only lets
Claude's own connector sign in. The last column says where it comes from: **Featured**
connectors ship inside your mineral, **From the list** ones are in the list on the
Connections page, **Guided setup** ones have a step-by-step wizard there, and
**Chats only** ones live in your Claude account.

**Google is not in this table, and that is not an omission of the product.** Google
Workspace (Gmail, Calendar, Drive, Docs, Sheets, Tasks and Contacts) connects as one
row, through its own wizard on the Connections page, with your own key, and
[connecting Google](/docs/connect-google) walks the whole thing. Most services below
connect in one or two clicks; the ones marked **Guided** take a few minutes of setup
on your side first, and the ones marked **Claude account** connect in your Claude
settings, not on your mineral.

Absences are deliberate rather than oversights: every endpoint here was probed live
before it was listed, and a service that advertises a connection flow which does not
actually work is left out until it does. If something you use is missing, ask, and it
gets probed.

## Design

| Service | What you get | Sign-in | In the box |
|---|---|---|---|
| **Canva** | work with your designs | One click | Featured |
| **Figma** | read your design files | One click | From the list |
| **Miro** | boards and diagrams | One click | From the list |

## Dev

| Service | What you get | Sign-in | In the box |
|---|---|---|---|
| **Linear** | see and file issues | One click | Featured |
| **Sentry** | read errors from your apps | One click | Featured |
| **Vercel** | see your deployments | One click | Featured |
| **Atlassian** | Jira issues and Confluence pages | One click | From the list |
| **Semgrep** | scan code for security issues | One click | From the list |
| **Heroku** | apps, dynos and add-ons | One click | From the list |
| **CircleCI** | pipelines and build failures | One click | From the list |
| **Shortcut** | stories and epics | One click | From the list |
| **GitLab** | repos, issues and merge requests | One click | From the list |
| **Honeycomb** | traces and queries | One click | From the list |
| **Buildkite** | pipelines and builds | One click | From the list |
| **Stytch** | auth users and sessions | One click | From the list |
| **Cloudflare Observability** | Workers logs and analytics | One click | From the list |
| **Cloudflare Bindings** | D1, KV, R2 and Workers | One click | From the list |
| **WorkOS** | SSO and directory sync | One click | From the list |
| **PagerDuty** | incidents and on-call | Token | From the list |

## Docs

| Service | What you get | Sign-in | In the box |
|---|---|---|---|
| **Notion** | read and update your pages and databases | One click | Featured |
| **Asana** | tasks and projects | One click | From the list |
| **Todoist** | tasks and projects | One click | From the list |
| **ClickUp** | tasks, docs and goals | One click | From the list |
| **Readwise** | highlights and reading list | One click | From the list |
| **Coda** | docs, tables and formulas | One click | From the list |
| **Box** | files and folders | Token | From the list |

## Comms

| Service | What you get | Sign-in | In the box |
|---|---|---|---|
| **Intercom** | conversations and customers | One click | From the list |
| **Close** | CRM leads and conversations | One click | From the list |
| **Attio** | CRM records and lists | One click | From the list |
| **Resend** | send and inspect email | One click | From the list |
| **Klaviyo** | campaigns and audiences | One click | From the list |
| **Pipedrive** | CRM deals, people and pipelines | One click | From the list |
| **HubSpot** | contacts, deals and companies | Token | From the list |
| **Zoom** | meetings and recordings | Token | From the list |
| **Slack** | search, read and post in your workspace | [Guided](/docs/connect-slack) | Guided setup |
| **Mailchimp** | audiences, contacts, draft campaigns and reports | [Guided](/docs/connect-mailchimp) | Guided setup |

## Data

| Service | What you get | Sign-in | In the box |
|---|---|---|---|
| **Apify** | run scrapers and read results | One click | Featured |
| **Neon** | Postgres branches and queries | One click | From the list |
| **Amplitude** | product analytics and charts | One click | From the list |
| **Prisma** | database schema and queries | One click | From the list |
| **PostHog** | analytics and session replays | One click | From the list |
| **MongoDB** | collections and queries | Token | From the list |

## Meetings

| Service | What you get | Sign-in | In the box |
|---|---|---|---|
| **Otter.ai** | meeting transcripts and summaries | One click | From the list |
| **Fireflies.ai** | meeting recordings, transcripts and notes | One click | From the list |
| **Granola** | your meeting notes and transcripts | One click | From the list |
| **Avoma** | meeting notes, transcripts and insights | One click | From the list |
| **Krisp** | call transcripts and meeting notes | One click | From the list |
| **Fyxer** | meeting notes and drafted email replies | One click | From the list |

## Payments

| Service | What you get | Sign-in | In the box |
|---|---|---|---|
| **PayPal** | orders, payments and disputes | One click | From the list |
| **Square** | payments and point of sale | One click | From the list |
| **Plaid** | bank connections and items | One click | From the list |
| **Polar** | products and subscriptions | One click | From the list |
| **Shopify** | your store, in your chats with Claude | [Claude account](/docs/connect-shopify-and-xero) | Chats only |
| **Xero** | read-only accounts, in your chats with Claude | [Claude account](/docs/connect-shopify-and-xero) | Chats only |

## Web

| Service | What you get | Sign-in | In the box |
|---|---|---|---|
| **Webflow** | sites, collections and content | One click | From the list |
| **Wix** | manage your Wix site | One click | From the list |
| **Netlify** | deploys and site config | One click | From the list |
| **Globalping** | network tests from anywhere | One click | From the list |
| **Zapier** | run your Zaps | One click | From the list |
| **Algolia** | search indices and records | One click | From the list |
| **Sanity** | content and datasets | One click | From the list |
| **Contentful** | entries and content types | One click | From the list |
| **Render** | services and deploys | Token | From the list |
| **WordPress** | your site, and WooCommerce orders and products | [Guided](/docs/connect-wordpress) | Guided setup |

## AI

| Service | What you get | Sign-in | In the box |
|---|---|---|---|
| **Hugging Face** | models, datasets and Spaces | One click | From the list |
| **Context7** | up-to-date library documentation | One click | From the list |
| **Exa** | web search for agents | One click | From the list |
| **ElevenLabs** | text to speech and voices | Token | From the list |
