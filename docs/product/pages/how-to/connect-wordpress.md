---
title: Connect WordPress and WooCommerce
summary: Switch on MCP on your site, make a user for your assistant, give it an application password, and connect. About ten minutes, with a check at the end.
outcome: let your assistant work with your WordPress site and your WooCommerce products and orders, signed in as its own user.
audience: public
access: public
mode: how-to
order: 73
pins: wizard/panel/member.html, engine/comms/mcp-connect.mjs, wizard/panel/mcp-catalogue.mjs
reviewed: 2026-10-02
---

Your assistant connects to your WordPress site **as a user you make for it**,
signed in with an **application password**. That is a second password
WordPress lets you create for one purpose and revoke on its own, without
touching anyone's real password. Your mineral checks the connection works
before it keeps it.

With WooCommerce, your assistant can look up, add, update and remove products,
look up orders, change an order's status, and add notes to orders. When it
connects, the card says how many of these your site offers (seven, today). It works in your
chats and in your scheduled jobs.

## What your site needs

- **https.** WordPress only offers application passwords on a secure site.
- **Permalinks set to anything but Plain** (Settings, then Permalinks).
- **For the shop tools: WooCommerce 10.9 or newer.** WooCommerce's MCP
  feature is still a preview, so it is off until you switch it on (step 1).
- **Without WooCommerce:** the MCP Adapter plugin, from WordPress's own
  GitHub (step 1). A site without a shop can only offer your assistant what
  its plugins choose to share, which out of the box may be very little.

In the Crads AI app, open **Your assistant**, then **Connections**. Under
**Add a connection**, find **WordPress** and press **Set up**. Type your
site's address at the top of the card first: every button on the card then
opens the right page on your site.

## Step 1. Switch on MCP on your site

**With WooCommerce:**

1. Press **Open WooCommerce features** on the card (that is WooCommerce, then
   Settings, then Advanced, then Features, in your site's admin).
2. Find **WooCommerce MCP**. WooCommerce lists it with its experimental
   features.
3. Tick it and press **Save changes**.

**Without WooCommerce:**

1. Press **Download MCP Adapter** to download the plugin's zip file. It comes
   from WordPress's own GitHub; it is not in the plugin directory yet.
2. Press **Upload a plugin**, choose the zip, press **Install Now**, then
   **Activate**.

## Step 2. Make a user for your assistant

Press **Add a user** on the card. Give the new user a name you will recognise,
like `assistant`, and an email address you own.

Pick its **role** with care, because the role is what your assistant can do:

- **Shop manager** if you run WooCommerce. It can manage products and orders,
  including refunds and customer details. It cannot change your site's
  settings, themes or plugins, or other users.
- **Editor** for a site without a shop.

Do not give it Administrator. Your assistant does not need it, and a separate,
smaller user is the whole point.

## Step 3. Make an application password

1. Press **Open your users** on the card and click the user you just made.
2. Scroll down to **Application Passwords**.
3. Under **New Application Password Name**, type `Crads`.
4. Press **Add Application Password**.
5. WordPress shows the new password **once**, in groups of four letters.
   Copy all of it, spaces included.

**If there is no Application Passwords section:** something has switched the
feature off. The usual cause is a security plugin. Wordfence does it by
default: in Wordfence, open **All Options**, then **Brute Force Protection**,
and turn off **Disable WordPress application passwords**. A site that is not
on https never shows the section at all.

## Step 4. Connect

Type the new user's **username** and paste the **application password**, then
press **Connect WordPress**. Your mineral saves them, then asks your site for
the list of things your assistant can do. When the site answers, the card says
how many tools it found, and WordPress appears in **Your connections** with
the status "working, including in scheduled jobs".

If the site does not answer properly, the card says why, and **nothing is
kept**: the password is removed from your mineral straight away, so you can
fix the problem and press Connect again.

| The card says | What happened | What to do |
|---|---|---|
| Your site turned down that username and password | Wrong username, or the user's normal password instead of the application password, or your host is dropping the sign-in (below) | Check both, then see below |
| Your site has no MCP connection at that address yet | Step 1 is not done | Tick WooCommerce MCP and save, or activate MCP Adapter |
| Your mineral could not reach your site | The address is wrong, or the site is not public | Check the address starts `https://` and opens in a browser |

### If the username and password are right and it still says no

Some hosts quietly drop the part of the request that carries the password, so
WordPress never sees it. On Apache hosts the fix is one line in your site's
`.htaccess` file, straight after `RewriteEngine On`:

```
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
```

WordPress writes this line itself in a standard setup, so you will usually
only need it on a site with an old or customised `.htaccess`. If you are not
comfortable editing that file, your host's support can add it for you; ask
them to "pass the Authorization header through to PHP".

## Disconnecting

Press **Disconnect** on the WordPress row in Your connections. That deletes
the password from your mineral. To switch it off at your site's end too, open
the user in WordPress, find **Application Passwords**, and revoke `Crads`, or
delete the user.
