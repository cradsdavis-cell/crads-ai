# Host-update channel (D55)

Signed host-script bundles for already-provisioned boxes. Full design + runbook:
`docs/box-update-channel.md`. Short version:

- Cloud-init runs once, so host-side files (`enter-aios`, sshd config, the
  systemd unit) freeze at provision time; the SSH channel force-lands inside the
  container and can never fix them. This channel closes that gap for every box
  provisioned AFTER it shipped.
- A bundle is `current.tar.gz` (payload: `VERSION` integer + `apply.sh`) plus a
  detached `ssh-keygen -Y sign` signature, committed under `dist/` and baked
  into both images at `/app/host-updates/` (Dockerfile.rock / .member).
- On each box a root systemd timer (`ai-os-host-update.timer`, baked by both
  cloud-init templates) runs `aios-host-update`: `docker cp` the pair out of the
  container, `ssh-keygen -Y verify` against the root-owned
  `/etc/ai-os/host-update-signers`, refuse anything unsigned or version-stale,
  then run `apply.sh` as root. The container stages bytes; only a valid
  signature makes root act.
- The channel ships DISARMED: the baked signers file is comment-only.

## Arming it (one-time, operator)

```sh
ssh-keygen -t ed25519 -N '' -C updates@ai-os -f ~/secrets/aios-host-update-key
```

Keep the private key OUT of git. Put the public half into BOTH cloud-init
templates' `/etc/ai-os/host-update-signers` entry as one line:

```
updates@ai-os namespaces="aios-host-update" ssh-ed25519 AAAA…
```

## Shipping a fix

```sh
mkdir payload
printf '2\n' > payload/VERSION          # strictly greater than the last shipped
cat > payload/apply.sh <<'EOF'
#!/bin/bash
set -euo pipefail
# idempotent host-side changes only; runs as root, cwd = unpacked bundle
EOF
./make-bundle.sh payload ~/secrets/aios-host-update-key
git add dist/ && git commit
```

The next image publish carries the bundle; each box applies it within ~30 min
of its next restart onto that image (panel "Update & restart", or any reboot).

`aios-host-update.sh` here is the CANONICAL applier; both cloud-init templates
embed it verbatim and `host-update.test.mjs` fails if they drift.
