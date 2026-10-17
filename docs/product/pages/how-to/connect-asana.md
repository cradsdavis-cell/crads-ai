---
title: Connect Asana, with your own app
summary: Make a small Asana app in your own account, paste its two details, sign in once, and your assistant stays connected to your tasks and projects, in chats and in scheduled jobs.
outcome: let your assistant read and update your Asana tasks and projects, signed in through an app that is yours.
audience: public
access: public
mode: how-to
order: 76
pins: wizard/panel/mcp-oauth-routes.mjs, engine/comms/mcp-oauth-lib.mjs, engine/comms/mcp-refresh.mjs, wizard/panel/member.html
reviewed: 2026-10-17
---

Asana connects through **an app you make in your own Asana account**. You
paste its Client ID and Client secret on the Connections page, sign in once,
and your mineral keeps the connection alive by itself after that. About five
minutes, once.

Once it is connected, your assistant can find, read, create and update your
tasks, projects and comments, in your chats and in your scheduled jobs.

## Why your own app

Asana's connection for assistants only lets an app sign in if someone has
registered it in Asana first. Registering one shared app for everyone would
put Crads AI in the middle of every member's Asana. So each mineral uses an
app that its owner made: it belongs to you, it works only for the workspace
you choose, and you can delete it in Asana at any time.

## If your Asana was connected the old way

If you connected Asana before 17 October 2026, that connection used a server that Asana is switching off, and it
dropped out of any chat left open for more than an hour. Your Asana row on the
Connections page now says so and has a **Move to the new Asana** button. It
opens the steps below; when you finish, the new connection replaces the old
one and your assistant keeps the same Asana tools.

## Step 1: make the app

1. On the Connections page, find **Asana** and press **Set up** (or **Move to
   the new Asana** on your existing row).
2. Press **Open Asana's developer console**, and sign in to Asana if it asks.
3. Click **New app**. Name it **Crads assistant**, choose **Asana MCP** as the
   app type, tick **I agree to the Asana API Terms**, and click **Create**.

## Step 2: the sign-in address and your workspace

1. In your new app, click **OAuth** in the left menu, then **Add redirect
   URL**. Paste the address the Connections page shows (it starts
   `http://localhost:`), click **Add**, then **Save changes**.
2. Click **Manage distribution**. Leave **Specific workspaces** chosen, click
   **Add workspace**, pick your workspace and click **Add**. Without a
   workspace, Asana refuses the sign-in.

## Step 3: paste the details and sign in

1. Click **Basic information** in the app's menu. It shows the **Client ID**
   and the **Client secret**, each with a **Copy** button.
2. Paste each into its box on the Connections page and press **Sign in to
   Asana**.
3. Asana asks whether **Crads assistant wants access to Asana MCP**. Click
   **Allow**. The browser tab says **Connected**, and the Connections page
   updates by itself.

The sign-in finishes on your own computer: the address you pasted in step 2
points at the Crads AI app, which is why it starts `http://localhost`.

## What stays where

- The Client ID, the Client secret and the sign-in itself are stored on your
  mineral only.
- Asana's sign-in lasts an hour at a time. Your mineral renews it every half
  hour, and a chat that is already open picks up the renewed sign-in by
  itself.
- To disconnect, press **Disconnect** on the Asana row. To cut it off from the
  Asana side as well, delete the app in Asana's developer console.

## If something goes wrong

- **"Another program is using port …"**: something else on your computer has
  the sign-in port. Close it, or restart the computer, and press Sign in again.
- **Asana says the redirect URL does not match**: the address in step 2 must be
  pasted exactly as the Connections page shows it.
- **Asana shows an error about your workspace**: add your workspace under
  **Manage distribution** (step 2) and try again.
- Anything else: see [fix a broken connection](/docs/fix-a-broken-connection).
