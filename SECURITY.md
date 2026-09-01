# Security policy

## Reporting a vulnerability

Please report security issues **privately** by email to
**cradsdavis@gmail.com** with "SECURITY" in the subject line. Do not open a
public issue for anything that could put a running box at risk.

You can expect an acknowledgement within a few days. Please include enough
detail to reproduce, and, if you can, which surface it touches (the box engine,
the desktop app / wizard, the images, or the commons pull path).

## Scope notes

Every Crads-AI box is self-hosted and owner-operated: there is no central
service, so most classic SaaS attack surface simply does not exist here. The
surfaces that do matter:

- **SSH and the member door** (`/state/ssh/`, device roster, `enter-aios`).
- **The wizard's provisioning path** (the Hetzner token is held in memory on
  the user's machine and must never be written to disk or sent anywhere but
  `api.hetzner.cloud`).
- **The commons pull path** (a hostile commons must never execute content on a
  member box; install-is-consent, transport allow-list, size caps).
- **The images** (what bakes in; `scripts/clean-gate.sh`).

Reports about any of those are especially valued.
