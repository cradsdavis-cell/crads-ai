---
title: Use a server you already have
summary: Run your assistant on a server you made yourself, at AWS, Google Cloud, Azure or any host, or on a machine you own at home or in the office.
outcome: have the setup wizard build your assistant on an Ubuntu server you made, with no cloud password or key ever given to the app.
audience: public
access: public
mode: how-to
order: 8
pins: wizard/panel/door.html, wizard/provision/own-server.mjs, wizard/provision/providers.mjs, wizard/panel/provision-routes.mjs
reviewed: 2026-10-15
---

The wizard can make a server for you at Hetzner or DigitalOcean. If you would
rather use a company it cannot make servers at, such as AWS, Google Cloud or
Azure, or a machine you own, pick **A server you already have**. You make the
server, the wizard sets it up, and from then on it is the same assistant as
any other.

Two good reasons to choose this. Some organisations already have an account
with one of the big clouds, and their contract terms. And a machine you own
keeps your assistant's memory on hardware you physically hold; only the
conversation itself goes to Anthropic, as it does everywhere
([self-hosted Claude](/docs/self-hosted-claude) explains that line).

## What the server needs

- **Ubuntu 24.04** (22.04 also works), on an ordinary Intel/AMD or Arm machine.
- **4 GB of memory or more**, and at least 15 GB of free disk.
- **Used for this alone.** Setup turns on a firewall that lets SSH in and
  nothing else, so do not use a machine that already serves something.
- **A login with passwordless sudo**, which cloud servers have from the start.
- **SSH on port 22** that this computer can reach.

The wizard checks all of this before it changes anything, and says plainly
what is missing.

## 1. Get this mineral's key

In the app, choose **Set up my own**, pick **A server you already have**, name
your mineral, and press **Show my key**. That is the public half of a key made
for this mineral; the private half never leaves your computer. Copy it.

## 2. Make the server

Whichever company you use, the choices are the same: Ubuntu 24.04, about 4 GB
of memory, SSH allowed, and the key from step 1.

- **AWS Lightsail** (the simplest AWS option): create an instance, choose
  Linux, OS only, Ubuntu 24.04, and a plan with 4 GB of memory. Under the SSH
  key pair, upload the key from step 1. SSH is allowed by default. The login
  name is **ubuntu**. Attach a static IP so the address never changes.
- **Google Cloud**: create a Compute Engine instance with 4 GB of memory (an
  e2-medium) and an Ubuntu 24.04 LTS boot disk of about 30 GB. Under Security,
  add the key from step 1 as an SSH key. Google takes the login name from the
  last word of the key, so change that word to a short name such as crads; that
  is your login name. The default network already allows SSH.
- **Azure**: create a virtual machine from Ubuntu Server 24.04 LTS with 4 GB of
  memory (a B2s, for example). Choose SSH public key, paste the key from step
  1, and allow SSH (port 22) as an inbound port. The login name is the user name
  you typed, **azureuser** unless you changed it.
- **A machine you own**: install Ubuntu Server 24.04 on it, then on that machine
  add the key from step 1 to your login's `~/.ssh/authorized_keys` file, and
  give the login passwordless sudo (run `sudo visudo` and add a line
  `yourname ALL=(ALL) NOPASSWD:ALL`). If `cloud-init` is not installed, install
  it with `sudo apt install cloud-init`. Set the machine never to sleep.

## 3. Check it and build

Back in the app, type the server's address and the login name, and press
**Check the server**. The app connects with the key, reads what the server is
(and says what it found), and changes nothing. Then press **Build it**. Setup
takes a few minutes: it installs Docker and your assistant, turns on the
firewall and adds a swap file. The rest of the wizard, GitHub and the Claude
sign-in, is the same as for any server.

## A machine at home: reaching it from elsewhere

Your assistant connects outwards, so chatting from your phone, Telegram and the
schedule all work wherever you are, with nothing to set up on your router. The
desktop app connecting to the machine is the one thing that needs a way in. On
the same network, use the machine's local address. Away from home, install
**Tailscale** (free) on the machine and on your computer, and use the machine's
Tailscale name as the address. Do not open a port on your router for this.

Keeping it running is your side of the deal: power cuts, internet drops and
disk failures all stop your assistant until the machine is back. The nightly
backup to your own GitHub covers the worst case
([back up and restore](/docs/back-up-and-restore)).

## Moving an assistant you already have

To move a mineral from Hetzner or DigitalOcean onto a server you made, move it
to this computer first, then move it to a server and pick **A server you
already have**. The brain, connections, secrets and schedule travel with it,
over your own connections; nothing passes through us.

## Removing it

The app never deletes or resets your server: it is yours, and the app has no
way in except the key you gave it. **Remove** only forgets the server on this
computer. To take your assistant off the server, rebuild or delete the server
in your cloud's console, or reinstall your own machine.
