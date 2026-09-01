---
title: Get a Hetzner API token
summary: The five-minute walk from no account to the token the setup wizard asks for, and what that token actually is.
audience: public
access: public
mode: how-to
order: 5
pins: wizard/panel/door.html, wizard/provision/engine.mjs
reviewed: 2026-09-01
---

Crads-AI is self-hosted: your assistant runs on a server in your own hosting
account, at Hetzner, a German hosting company. The setup wizard builds that
server for you, and to do it on your account it needs an API token from you.
This page gets you from nothing to that token.

The token is the key to your hosting project. It stays on your computer, the
app sends it only to Hetzner's own API, and you can revoke it at any time.
Treat it like a password all the same.

## 1. Make a Hetzner account

Go to **console.hetzner.com** and sign up with your email. Confirm the email,
then add a payment method: the server is billed to you by Hetzner directly,
roughly four to thirty euros a month depending on the size you pick in
the wizard, and nothing is charged until a server actually exists.

Hetzner sometimes asks new accounts to verify identity before they can create
servers. That check is theirs, not ours; if it appears, complete it and come
back. It can take from minutes to a day.

## 2. Create a project

On the Cloud console's start screen choose **New project** and give it any
name; "my-brain" is fine. If your account already shows a default project,
that one works too. A project is just Hetzner's box for grouping servers, and
your mineral will live inside whichever project the token belongs to.

## 3. Generate the token

Open the project. In the left sidebar choose **Security**, then the
**API tokens** tab, then **Generate API token**.

Name it something you will recognise later ("crads-ai" is fine), and set the
permissions to **Read & Write**. This matters: a read-only token can look at
your project but cannot build anything in it, and the wizard will refuse it.

## 4. Copy it straight away

Hetzner shows a token exactly once, at the moment it is generated. Copy it
before closing the dialog and paste it into the wizard. If you lose it, do not
hunt for it; generate a fresh one and delete the old from the same screen.

## What the wizard does with it

The app checks the token against Hetzner with a read-only call before offering
to build, shows you the real locations and machine sizes your account offers,
and then creates one server with your own SSH key as its only key. The token
is held in the app's memory for that run and is never written to disk or sent
anywhere except api.hetzner.cloud. If you ever want to withdraw it, revoke the
token in the Hetzner console; the server it built keeps running regardless,
because the server is yours, not the token's.
