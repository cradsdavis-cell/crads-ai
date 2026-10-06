---
title: Connect Slack, with your own app
summary: Make a small private Slack app from our template, paste one token, and your assistant can search, read and post in your workspace, in chats and in scheduled jobs.
outcome: let your assistant search, read and post in your Slack workspace, as you, with a token that is yours.
audience: public
access: public
mode: how-to
order: 72
pins: wizard/panel/member.html, engine/comms/mcp-connect.mjs, wizard/panel/mcp-catalogue.mjs
reviewed: 2026-10-06
---

Slack connects with **your own app**: a small private app you make inside your
own workspace, from a template we give you, in about five minutes. You paste
the token it gives you, and your mineral checks it works before it keeps it.

Once it is connected, your assistant can search messages and files, read
channels, threads and direct messages, look people up, read and write
canvases, and post. It does all of that **as you**: it sees what you can see,
and nothing more. It works in your chats and in your scheduled jobs.

## Why your own app

Slack lets an assistant like yours in through an app that lives in your
workspace. We could have published one shared Crads AI app, but then every
member's Slack would pass through something we own. Your own app keeps us out
of the path: the token is made by you, stored on your mineral only, and works
nowhere but your workspace. You can switch it off in Slack whenever you like.

Keep the app **private**. Slack only lets this kind of connection in from
apps that stay inside one workspace (or are published in its Marketplace), so
an app you share with other workspaces stops working.

## Before you start

You need to be signed in to Slack in your browser, in the workspace you want
to connect. If your workspace only lets admins add apps, you will need your
admin to approve it in step 2; Slack sends them the request for you.

In the Crads AI app, open **Your assistant**, then **Connections**. Under
**Add a connection**, find **Slack** and press **Set up**. A card opens with
three steps. It stays open while you go back and forth to Slack.

## Step 1. Make your app

1. Press **Create the app in Slack**. Slack opens with our template already
   filled in.
2. Pick your workspace and press **Next**.
3. Slack shows a summary of what the app can do. Press **Create**.

If Slack opens an empty form instead of the template, choose **From a
manifest**, pick your workspace, choose the **JSON** tab, and paste the
template. The **Copy the template** button on the card puts it on your
clipboard, and here it is in full:

```json
{
  "display_information": {
    "name": "Crads assistant",
    "description": "My assistant, acting as me in this workspace."
  },
  "oauth_config": {
    "scopes": {
      "user": [
        "search:read.public", "search:read.private", "search:read.mpim", "search:read.im",
        "search:read.files", "search:read.users", "files:read",
        "channels:history", "groups:history", "mpim:history", "im:history",
        "channels:read", "groups:read", "im:read", "mpim:read",
        "chat:write", "canvases:read", "canvases:write", "users:read", "users:read.email"
      ]
    }
  },
  "settings": {
    "is_mcp_enabled": true,
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

Three things in it matter:

- **The scopes are user scopes.** The token acts as you, so your assistant can
  reach exactly what your own Slack account can, and no more.
- **`is_mcp_enabled` is on.** That is the switch Slack checks before it lets
  an assistant in. An app made by hand needs it turned on in the app's
  settings, on the page Slack calls **Agents & AI Apps** (some of Slack's own
  pages just say **Agents**).
- **Token rotation is off.** With it on, the token you paste would expire
  twelve hours later. Slack does not let you turn rotation off again once it
  is on, so if you made an app with it on, make a fresh one from the template.

The app has no bot user, and does not need one: everything runs on your own
user token.

If Slack shows a red mark beside `"bot_user"` and **Next** stays greyed out, or
says **"We can't translate a manifest with errors"**, you have an older copy of
the template. Delete the whole `"features"` block (from `"features": {` down to
its closing `},`) and press Next.

## Step 2. Install it and copy the token

1. In your new app's settings, open **OAuth & Permissions**.
2. Press the install button for your workspace, then **Allow**.
3. The same page now shows a **User OAuth Token**, starting `xoxp-`. Copy it.

There is no Bot token on this page, and that is expected. If you made your app
from an older template and do see one (it starts `xoxb-`), leave it: the card
refuses it with a note saying so.

If your workspace needs an admin to approve apps, Slack says so at the install
step and sends them the request. Come back to this step once they have.

## Step 3. Paste the token

Paste the token into the card and press **Connect Slack**. Your mineral saves
it, then asks Slack for the list of things your assistant can do there. When
Slack answers, the card says how many tools it found, and Slack appears in
**Your connections** with the status "working, including in scheduled jobs".

If Slack does not answer properly, the card says why in plain words, and
**nothing is kept**: the token is removed from your mineral straight away, so
you can fix the problem and press Connect again.

| The card says | What happened | What to do |
|---|---|---|
| Slack turned that token down | The token is wrong, revoked, or from an app that is not installed | Copy the User OAuth Token again from **OAuth & Permissions** |
| Slack says your app is not switched on for assistants | The app's MCP switch is off | Turn on Model Context Protocol under **Agents & AI Apps**, or remake the app from the template |
| That is the Bot token | You copied `xoxb-` | Copy the `xoxp-` token above it |
| Your mineral could not reach Slack | A network hiccup | Try again in a minute |

## More than one workspace

Once one workspace is connected, **Your connections** offers **Add another
Slack workspace** under the list. It opens the same card with one extra field
at the top: a short name for the workspace (lowercase letters, numbers and
dashes, such as `reef`). Then make an app in that workspace from the same
template, install it, and paste its token, exactly as above.

Each workspace has its own app, its own token and its own row, named after the
short name: **Slack (reef)**. Your assistant sees them as separate
connections, so tell it which workspace you mean. Disconnecting one row leaves
the others alone.

## What your assistant does with it

It acts as you. It can post as you, so if you would rather see a draft before
anything goes out, tell it so once ("always show me a Slack message before you
send it") and it will remember. Slack limits how fast any one app can search
and post, so a job that wants to send hundreds of messages a minute will be
slowed down by Slack, not by us.

## Disconnecting

Press **Disconnect** on the Slack row in Your connections. That deletes the
token from your mineral. The app itself still exists in your workspace: to
switch it off at Slack's end too, open the app's settings on api.slack.com and
remove it from your workspace, or delete the app.
