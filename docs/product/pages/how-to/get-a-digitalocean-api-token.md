---
title: Get a DigitalOcean API token
summary: The five-minute walk from no account to the token the setup wizard asks for when you pick DigitalOcean, and what that token actually is.
outcome: make a DigitalOcean account and hand the wizard a token that can build in Sydney.
audience: public
access: public
mode: how-to
order: 6
pins: wizard/panel/door.html, wizard/provision/digitalocean.mjs, wizard/provision/providers.mjs
reviewed: 2026-09-09
---

Crads-AI is self-hosted: your assistant runs on a server in your own hosting
account. The setup wizard offers two hosting companies, Hetzner and
DigitalOcean, and builds the server on whichever you pick. This page is the
DigitalOcean one; [get a Hetzner API token](/docs/get-a-hetzner-api-token) is
the other.

Why DigitalOcean, when Hetzner is cheaper at every size? Location.
DigitalOcean has a Sydney datacentre, along with Singapore, London, Frankfurt,
Amsterdam, New York, San Francisco, Toronto and Bangalore. If you are in
Australia and want your data to stay in Australia, this is the way to have
that. The wizard defaults to Sydney when you pick DigitalOcean.

To build on your account the wizard needs an API token from you. The token is
the key to your DigitalOcean account. It stays on your computer, the app sends
it only to DigitalOcean's own API, and you can revoke it at any time. Treat it
like a password all the same.

## 1. Make a DigitalOcean account

Go to **cloud.digitalocean.com** and sign up with your email. Confirm the
email, then add a payment method: the server is billed to you by DigitalOcean
directly, in US dollars, roughly twenty-four to ninety-six dollars a month
depending on the size you pick in the wizard, and nothing is charged until a
server actually exists.

DigitalOcean sometimes asks new accounts to verify identity before they can
create servers. That check is theirs, not ours; if it appears, complete it and
come back.

## 2. Open the API page

In the control panel's left sidebar, near the bottom, choose **API**. The
**Tokens** tab is the one you want. (DigitalOcean calls a server a "droplet";
the wizard says "server" throughout, and they are the same thing.)

## 3. Generate the token

Press **Generate New Token**. Name it something you will recognise later
("crads-ai" is fine), and pick an expiry you are comfortable with: the wizard
needs the token only while it builds, so a short expiry costs you nothing, and
a token that has expired simply means generating another before the next
build.

Give it **Full Access**. This matters: a read-only token can look at your
account but cannot build anything in it, and the wizard will refuse it. If you
would rather scope it by hand, the wizard needs to read your account, regions
and sizes, create and read SSH keys, and create, read and delete droplets.

## 4. Copy it straight away

DigitalOcean shows a token exactly once, at the moment it is generated. Copy
it before closing the dialog and paste it into the wizard. If you lose it, do
not hunt for it; generate a fresh one and delete the old from the same screen.

## What the wizard does with it

The app checks the token against DigitalOcean with a read-only call before
offering to build, shows you the real locations and machine sizes your account
offers with DigitalOcean's own list prices, and then creates one server with
your own SSH key as its only key. The token is held in the app's memory for
that run and is never written to disk or sent anywhere except
api.digitalocean.com. If you ever want to withdraw it, revoke the token in the
DigitalOcean control panel; the server it built keeps running regardless,
because the server is yours, not the token's.

One difference from Hetzner worth knowing: DigitalOcean does not stop you
creating two servers with the same name. The wizard tags each server it makes
so that, if your connection drops at the wrong moment, it finds the server it
already made rather than making a second one.
