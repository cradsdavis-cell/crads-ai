---
name: connect
title: "Connect a service"   # human name shown on the Skills page (2026-08-09 audit R6); the slash id stays as a chip
description: Connect an outside service (Notion, Linear, a calendar, anything with an MCP server) so this mineral can use it, including in scheduled jobs. Triggers on /connect and natural asks like "connect me to Notion", "hook up my calendar", "add the Linear MCP", "can you talk to my email", "set up an integration".
category: box             # Skills-page grouping (briefing|capture|comms|box|org|other), wire vocabulary, not copy
generic: true
---

# Skill: /connect (hook up an outside service)

Purpose: when the person asks you to connect a service, do it through the mineral's
own connection machinery, so the result shows up on their Connections page and
works in their scheduled jobs, not only in this chat.

## The one rule that matters

**Never use `claude mcp add`.** Its default scope is chats-only: the connection
would work while they talk to you, be invisible on their Connections page, and
never load in their scheduled jobs. That silent half-connection is exactly what
this skill exists to prevent. The mineral tool below writes the connection where
everything can see it, records the approval their request already is, and keeps
the Connections page truthful.

## How

All commands run on this mineral. `STATUS` first, always:

```
node /app/engine/comms/mcp-connect.mjs /state status
```

That returns every service with its real state. Use it to answer "what am I
connected to", to avoid re-adding something that exists, and to check the
outcome of everything below.

**A featured service** (notion, linear, sentry, canva, vercel, apify):

```
node /app/engine/comms/mcp-connect.mjs /state add <key>
```

**Anything else with an MCP server**, by URL. Write the definition to a file
first, then feed it on stdin, and delete the file; never put a URL or token in
a command line, and never echo the token back to the person:

```
node -e 'process.stdout.write(Buffer.from(JSON.stringify({name:"<short-name>",url:"<https url>"})).toString("base64"))' > /tmp/def.b64
node /app/engine/comms/mcp-connect.mjs /state add-custom < /tmp/def.b64
rm /tmp/def.b64
```

If the service gave them an API token, include `token_b64` (base64 of the
token) in that JSON: the connection is then working immediately, no sign-in.

**The sign-in**, for OAuth services, happens on the **Connections page in
their Crads-AI app**, not in this chat. The reason is physical: the sign-in
ends with their browser redirecting to a listener on THEIR machine, which the
app provides and this box cannot. So after an `add`, say: open your Crads-AI
app, Connections, and press Sign in on the new row. Then confirm with `status`
before saying it is connected.

**Google (Gmail / Calendar / Drive / Docs)** connects with the member's OWN
Google key, a guided setup on the Connections page walks them through
creating it (about ten minutes, five clicks in Google's console, then drop a
file and sign in). When they ask you to connect Google, send them there:
"open Connections in your Crads-AI app and press Set up on the Google row".
Three truths to state plainly when they ask: the key is theirs and never
leaves their box; the sign-in is one-time and stays put (their app is
published, so Google does not retire it on a schedule); and **they choose
what it reaches**, Google's consent screen lists each service (Gmail,
Calendar, Drive, Docs, Sheets, Tasks, Contacts) with its own tick-box, and
anything they left unticked stays off until they sign in again and grant it.
If a tool fails saying a Google scope is missing, that is a service they
chose not to share, offer the re-sign-in, never work around it.

## Honesty rules

1. **Google runs on the member's own key, signed in once.** If its row says
   "sign-in expired, needs you once more", Google really has dropped the key
   (rare, the box live-checks and tells them by Telegram once); point them at
   Connections → Google → Sign in, two clicks. Never present that state as a
   fault in the product, and never route around the guided setup by other
   means (no hand-built google servers, no `claude mcp add`).
2. **Only claim "connected" after `status` says so.** "working, including in
   scheduled jobs" is the only state that means done; anything else, tell them
   what is left in the words `status` gives you.
3. **Never print a token, a credential value, or the contents of
   `.claude-auth/`.** Confirming that something is set is fine; showing values
   never is.
4. **If they connected something in Claude Code themselves** and it shows as
   "in your chats only", offer the fix:
   `node /app/engine/comms/mcp-connect.mjs /state adopt <name>`, it keeps
   their sign-in and makes the connection available to their jobs.
