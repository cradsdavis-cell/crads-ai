# Crads-AI

**Website and docs:** <https://crads-ai.com> · **Download the app:** <https://crads-ai.com/download>

Free, open-source, fully self-hosted AI assistant infrastructure. Your server,
your SSH key, your accounts. Nothing central: no directory service, no billing,
no accounts with us, no server of ours in the loop.

A **mineral** is a small cloud server (or any Docker host) running the Crads-AI
box engine: a persistent, file-based "brain" (plain Markdown + git), a scheduler,
skills, and Claude Code as the assistant that works inside it. The desktop app
connects to it over SSH and gives it a panel, a terminal, and a guided setup
wizard.

- **Ownership by construction.** Whoever pays the hosting bill owns the box,
  holds the only SSH key, and answers for the data on it. Provisioning runs
  locally in the desktop app; your Hetzner API token never leaves your machine.
- **Your data, your backup.** The box pushes its brain to a private GitHub repo
  on *your* account.
- **Communities without a control plane.** A "rock" is a community hub with no
  metal: it curates a **commons** (a plain git repository of skills, packs,
  prompts and pages). Membership is read access to that repository; nothing a
  community publishes can execute on your box unless you install it. See
  `docs/commons-model.md`.
- **Free software.** Licensed AGPL-3.0 (see `LICENSE`). Revenue, where any
  exists, comes from services (guided setup, support, community onboarding),
  never from the software.

## Quickstart

1. Download the desktop app (Windows / macOS) from the releases page, or build
   it from source (below).
2. Open it and choose **Set up my own**. The wizard states the real costs up
   front (your Hetzner server, your Claude subscription, $0 to Crads-AI), walks
   you through creating a Hetzner API token, generates your SSH key, creates the
   server, and connects.
3. Full documentation: <https://crads-ai.com/docs> (source in `docs/product/`).

You need: a Hetzner Cloud account (~AUD $12–16/mo for a cx33-class server), a
Claude subscription, and a free GitHub account for the brain backup.

## Repository layout

| Path | What it is |
|---|---|
| `engine/` | The box engine: scheduler, skills, brain, devices, community machinery |
| `wizard/` | The desktop app: door, one panel (the org/member edition split died 2026-09-01), self-host provisioning wizard (`wizard/provision/`) |
| `rock-machinery/` | Rock (community hub) machinery notes |
| `brain-control/` | Vendored rock brain control plane (see `brain-control/SOURCE.txt`; refreshed by `scripts/vendor-brain-control.sh`) |
| `Dockerfile.*`, `docker-bake.hcl` | The three images: base, pebble (member), rock |
| `provisioning/` | Cloud-init templates, host scripts, and box provisioning |
| `docs/product/` | The documentation site source + its build pipeline |
| `docs/self-host-design.md` | The design record of the self-host pivot |
| `docs/commons-model.md` | How communities share content, in full |
| `scripts/` | Build + hygiene scripts (`clean-gate.sh` is the personal-content wall) |

## Build from source

Everything runs on Node 22+ with zero runtime dependencies.

```sh
# the test suite (what CI runs)
node --test $(git ls-files '*.test.mjs')

# the images (multi-arch bake; publishes to ghcr.io/<owner> in CI)
docker buildx bake

# the docs site
node docs/product/pipeline/generate.mjs
```

The desktop app is packaged as a Node single-executable application by
`.github/workflows/wizard-app.yml` (Windows exe + macOS app bundle). To run it
un-packaged: `node wizard/app.mjs`.

### What a fork must configure

- **Images**: `docker-publish.yml` publishes to `ghcr.io/<your account>` using
  the standard `GITHUB_TOKEN`; no extra secrets. `promote.yml` moves the `:v2`
  tag your boxes pull, same token. If your GitHub account name contains
  uppercase letters, set the `REG` variable to the lowercase form.
- **Desktop app releases**: `wizard-app.yml` publishes a rolling prerelease in
  this repo with `GITHUB_TOKEN`. Mirroring to a separate public app repo is
  optional: set the `CRADS_AI_APP_REPO` repository variable (owner/name) and the
  `CRADS_AI_APP_TOKEN` secret (a token that can write that repo's releases). The
  in-app updater polls the repo named by `RELEASE_BASE` in
  `wizard/panel/updater.mjs`; point it at your own releases if you fork.

## Contributing

See `CONTRIBUTING.md`. Security reports: see `SECURITY.md`.
