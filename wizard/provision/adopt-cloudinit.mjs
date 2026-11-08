// adopt-cloudinit.mjs: the SHARED-SERVER variant of host setup (spec
// docs/superpowers/specs/2026-10-17-adopt-existing-server.md § 2, "Host setup,
// the shared-server variant"). Used when the person answers "Yes, my assistant
// is already on it" on the "A server you already have" card.
//
// WHAT IT IS. The dedicated renderer (selfhost-cloudinit.mjs) turns the pebble
// template into a cloud-config that takes a machine over: a firewall that lets
// in SSH and nothing else, PasswordAuthentication off for every login, the
// timezone, swap, an `aios` service account and an empty /state. On a server
// that already runs the person's assistant every one of those breaks
// something, so this file renders a different, smaller thing:
//
//   | Piece          | Shared server (this file)                                     |
//   | Users          | `member` only, the SSH front door. No `aios`                   |
//   | sshd           | the `Match User member` block only, nothing outside it         |
//   | Firewall       | untouched                                                      |
//   | Docker         | used as found (docker-ce); installed only when absent          |
//   | Timezone       | untouched; the host zone goes into /etc/ai-os/env as TZ        |
//   | Swap           | only when asked                                                |
//   | /state         | none on the host: the brain folder is mounted at /state        |
//   | ai-os.service  | --user <owner uid>:<owner gid> -v <brain>:/state, AIOS_ADOPTED |
//
// WHY NOT CLOUD-INIT. The spec's first draft replayed this through
// `cloud-init single` like the dedicated path. On a machine that booted
// through cloud-init (every cloud server, including the first test case),
// `cloud-init single --file` merges our file into the instance's own
// cloud-config, so write_files and runcmd would also re-apply the provider's
// first-boot files and commands, on a server whose files the person has been
// changing ever since. That is acceptable on a machine "used for this alone"
// and not on one that runs their assistant. So the shared variant renders a
// plain bash script that writes exactly its own files and runs exactly its own
// commands, and records each change as it makes it (see RECORDING below). It
// needs no cloud-init at all.
//
// RECORDING. Every host change lands as one {what, reverse} entry in
// <brain>/.kernel/move-in/host-setup.json BEFORE the change is made, rewritten
// after each step, so a run that dies half way still leaves a file that undoes
// exactly what it did. `reverse` is DATA ({ op, path | unit | user }), never a
// shell command: the brain folder is writable from inside the container, so a
// command stored there would let the container choose what root runs at Move
// out. adopt-host.mjs teardownSharedHost() accepts only the ops and paths this
// file can write (ADOPT_HOST_FILES and friends) and skips anything else.
//
// Changes inside the brain folder (ownership.json, the device roster seed, the
// host inventory) are recorded too, with reverse { op: 'keep' }: teardown
// never touches the person's folder apart from deleting host-setup.json last.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_DIR = join(HERE, '..', '..', 'provisioning', 'host');

// Same normalisation as selfhost-cloudinit.mjs (a Windows checkout turns these
// into CRLF and the shebang then names "/bin/bash\r").
const toLf = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b)).replace(/\r\n/g, '\n');

// A folder path we are willing to put inside a shell script, a systemd unit
// and an sshd helper without quoting games: no spaces, no quotes, no `$`.
export const SAFE_PATH_RE = /^\/[A-Za-z0-9._@+/-]*$/;
const PUBKEY_RE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9@._-]{1,64})?$/;
const TZ_RE = /^[A-Za-z0-9_+/-]{1,64}$/;

/** Every host file the shared-server setup can write. Teardown removes only these. */
export const ADOPT_HOST_FILES = Object.freeze([
  '/etc/ai-os/env',
  '/etc/ai-os/host-update-signers',
  '/usr/local/bin/aios-state-keys',
  '/usr/local/bin/aios-host-update',
  '/usr/local/bin/enter-aios',
  '/etc/ssh/sshd_config.d/60-aios-member.conf',
  '/etc/systemd/system/ai-os-host-update.service',
  '/etc/systemd/system/ai-os-host-update.timer',
  '/etc/systemd/system/ai-os.service',
  '/usr/local/bin/aios-passwd',
  '/etc/ai-os/passwd',
  '/etc/ai-os/group',
]);
export const ADOPT_HOST_DIRS = Object.freeze(['/etc/ai-os']);
export const ADOPT_HOST_UNITS = Object.freeze(['ai-os-host-update.timer', 'ai-os.service']);
export const ADOPT_HOST_USER = 'member';
export const ADOPT_SWAPFILE = '/swapfile';

// Single-quote a string for bash.
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const entry = (what, reverse) => JSON.stringify({ what, reverse });

/**
 * Merge the adopt flags into an existing ownership.json text, keeping every
 * other key exactly as it was. Throws in words when the file is not a JSON
 * object: clobbering it would lose the person's record.
 */
export function mergeOwnership(existingText) {
  let rec = {};
  if (existingText != null && String(existingText).trim() !== '') {
    try { rec = JSON.parse(String(existingText)); } catch { rec = null; }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      throw new Error('ownership.json in your folder is not a JSON object, so the app will not rewrite it. Fix it or move it aside, then check again');
    }
  }
  return JSON.stringify({ ...rec, adopted: true, moving_in: true }, null, 2) + '\n';
}

function hostFiles({ boxName, image, brainRoot, uid, gid, tz, files }) {
  const src = (name, override) => toLf(override ?? readFileSync(join(HOST_DIR, name)));
  const env = [
    '# Crads-AI, adopted brain (shared server). No code-server: reach it with the app.',
    'BROWSER_IDE=off',
    'AIOS_OWNER_EMAIL=',
    `AIOS_BOX_HOST=${boxName}`,
    'AIOS_ANCHOR_ORG=',
    `AIOS_OWNER=${boxName}`,
    `AIOS_BOX_NAME=${boxName}`,
    `TZ=${tz}`,
    '',
  ].join('\n');
  // The pebble's door script, pointed at the brain folder instead of a host
  // /state. The seen.log line is handed back to the brain's owner, because a
  // root-owned file in their folder is one their own tools cannot rotate.
  const stateKeys = [
    '#!/bin/sh',
    '# Door for $1; log that key $2 knocked. Why: engine/devices/enrol-sync.mjs.',
    `D=${brainRoot}`,
    'SEEN="$D/devices/seen.log"',
    'if [ -n "$2" ] && [ -d "$D/devices" ]; then',
    '  [ "$(wc -c < "$SEEN" 2>/dev/null || echo 0)" -gt 65536 ] && : > "$SEEN"',
    `  printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" >> "$SEEN" 2>/dev/null || true`,
    '  chown --reference="$D/devices" "$SEEN" 2>/dev/null || true',
    'fi',
    'exec cat "$D/ssh/$1/authorized_keys" 2>/dev/null',
    '',
  ].join('\n');
  // ONLY the Match block. The dedicated drop-in starts with a global
  // `PasswordAuthentication no`, which on a shared server would change how
  // every other login on the machine signs in. Nothing here applies to
  // anyone but `member`, who has no password and no host key file at all:
  // the roster in the brain folder is its only door.
  const sshd = [
    'Match User member',
    '  PasswordAuthentication no',
    '  AuthorizedKeysFile none',
    '  ForceCommand /usr/local/bin/enter-aios',
    '  AuthorizedKeysCommand /usr/local/bin/aios-state-keys %u %f',
    '  AuthorizedKeysCommandUser root',
    // enter-aios records helper sessions and needs to see which key logged in
    // (spec 2026-11-08-helper-access-design.md section 5).
    '  ExposeAuthInfo yes',
    '',
  ].join('\n');
  const signers = [
    '# allowed_signers for aios-host-update (ssh-keygen -Y verify).',
    '# No signer line = no-op. See provisioning/host-updates/README.md.',
    '',
  ].join('\n');
  const huService = [
    '[Unit]', 'Description=AI OS host-update applier (signed bundles from the box image)', '',
    '[Service]', 'Type=oneshot', 'ExecStart=/usr/local/bin/aios-host-update', '',
  ].join('\n');
  const huTimer = [
    '[Unit]', 'Description=AI OS host-update timer (D55)', '',
    '[Timer]', 'OnBootSec=5min', 'OnUnitActiveSec=30min', 'RandomizedDelaySec=5min', '',
    '[Install]', 'WantedBy=timers.target', '',
  ].join('\n');
  // Runs as root (systemd's default) so no login of the person's has to join
  // the docker group; the CONTAINER runs as the brain's owner, so files the
  // assistant writes in the folder belong to the same person as everything
  // else in it.
  // THE OWNER NEEDS A NAME INSIDE THE CONTAINER (shadow test on Oracle,
  // 2026-10-19). The container runs as the brain's owner, and an image only
  // names the uids it was built with (1000 is `node`). Sam is uid 1002: inside,
  // `whoami` failed (the panel read "Not connected") and HOME was `/`, so npx
  // could not write its cache and every npx-launched connection died. The
  // rehearsal never saw it, because its login happened to be uid 1000.
  // Before every start, this copies the image's own passwd and group, adds the
  // owner if the image does not name them, and the container gets both files
  // read-only plus a HOME inside the brain's never-committed .kernel/.
  const passwd = [
    '#!/bin/sh',
    '# Give the brain owner a name and a home inside the Crads-AI container.',
    '# Args: image uid gid brain. Why: wizard/provision/adopt-cloudinit.mjs.',
    'set -eu',
    'IMG="$1"; U="$2"; G="$3"; B="$4"; O="${AIOS_ETC:-/etc/ai-os}"; H=/state/.kernel/home',
    'docker run --rm --entrypoint cat "$IMG" /etc/passwd > "$O/passwd.tmp"',
    'docker run --rm --entrypoint cat "$IMG" /etc/group > "$O/group.tmp"',
    'if ! awk -F: -v u="$U" \'$3==u{f=1} END{exit !f}\' "$O/passwd.tmp"; then',
    '  N=$(getent passwd "$U" | cut -d: -f1 | tr -cd "a-z0-9_-"); [ -n "$N" ] || N=owner',
    '  awk -F: -v n="$N" \'$1==n{f=1} END{exit !f}\' "$O/passwd.tmp" && N="crads-$N"',
    '  echo "$N:x:$U:$G:Crads-AI owner:$H:/bin/bash" >> "$O/passwd.tmp"',
    'fi',
    'if ! awk -F: -v g="$G" \'$3==g{f=1} END{exit !f}\' "$O/group.tmp"; then',
    '  N=$(getent group "$G" | cut -d: -f1 | tr -cd "a-z0-9_-"); [ -n "$N" ] || N=owner',
    '  awk -F: -v n="$N" \'$1==n{f=1} END{exit !f}\' "$O/group.tmp" && N="crads-$N"',
    '  echo "$N:x:$G:" >> "$O/group.tmp"',
    'fi',
    'chmod 0644 "$O/passwd.tmp" "$O/group.tmp"',
    'mv -f "$O/passwd.tmp" "$O/passwd"; mv -f "$O/group.tmp" "$O/group"',
    '[ -d "$B/.kernel/home" ] || install -d -o "$U" -g "$G" -m 0700 "$B/.kernel/home"',
    '',
  ].join('\n');
  const service = [
    '[Unit]',
    `Description=Crads-AI assistant (adopted brain at ${brainRoot})`,
    'Requires=docker.service',
    'After=docker.service network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    'Restart=always',
    'RestartSec=5',
    'KillMode=none',
    'TimeoutStartSec=600',
    // Pull new software only when the member pressed Update (trap 82): the box
    // leaves .kernel/update-requested in the brain folder; any other restart
    // comes back on the same software. `docker run` fetches a missing image.
    `ExecStartPre=-/bin/sh -c 'F=${brainRoot}/.kernel/update-requested;[ -e $$F ]&&/usr/bin/docker pull ${image}&&rm $$F'`,
    'ExecStartPre=-/usr/bin/docker rm -f ai-os',
    `ExecStartPre=/usr/local/bin/aios-passwd ${image} ${uid} ${gid} ${brainRoot}`,
    `ExecStart=/usr/bin/docker run --rm --name ai-os --user ${uid}:${gid} --env-file /etc/ai-os/env -e AIOS_ADOPTED=1 -e HOME=/state/.kernel/home -v /etc/ai-os/passwd:/etc/passwd:ro -v /etc/ai-os/group:/etc/group:ro -v ${brainRoot}:/state -p 127.0.0.1:7781:7781 -p 127.0.0.1:7780:7780 ${image} up`,
    'ExecStop=/usr/bin/docker stop ai-os',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
  return [
    { path: '/etc/ai-os/env', mode: '0640', content: env },
    { path: '/etc/ai-os/host-update-signers', mode: '0644', content: signers },
    { path: '/usr/local/bin/aios-state-keys', mode: '0755', content: stateKeys },
    { path: '/usr/local/bin/aios-host-update', mode: '0755', content: src('aios-host-update', files?.hostUpdate) },
    { path: '/usr/local/bin/enter-aios', mode: '0755', content: src('enter-aios', files?.enterAios) },
    { path: '/etc/ssh/sshd_config.d/60-aios-member.conf', mode: '0644', content: sshd },
    { path: '/etc/systemd/system/ai-os-host-update.service', mode: '0644', content: huService },
    { path: '/etc/systemd/system/ai-os-host-update.timer', mode: '0644', content: huTimer },
    { path: '/usr/local/bin/aios-passwd', mode: '0755', content: passwd },
    { path: '/etc/systemd/system/ai-os.service', mode: '0644', content: service },
  ];
}

/**
 * Render the shared-server setup.
 * @param {object} o
 * @param {string} o.boxName       the mineral's name
 * @param {string} o.ownerPubKey   this computer's ssh-ed25519 key for the mineral
 * @param {string} o.image         ghcr.io image (the :v2 pebble)
 * @param {string} o.brainRoot     absolute, resolved path of the brain folder on the server
 * @param {number} o.uid, o.gid    the folder's owner
 * @param {string} [o.tz]          the host's own zone, for the container
 * @param {boolean} [o.swap]       add a 2 GB swap file (only when the person asked)
 * @param {object} [o.inventory]   the host inventory to write for /move-in
 * @param {string|null} [o.ownershipText] ownership.json as the check read it (null: absent)
 * @param {string[]} [o.priorEntries] host-setup.json entries from an earlier run, kept
 * @param {object} [o.files]       in-memory host scripts for the packaged exe
 * @param {string} [o.hostRoot]    TESTS ONLY: a prefix for every host path, so the
 *                                 script can run in a scratch tree with stubbed tools
 * @returns {{ files: {path,mode,content}[], script: string }}
 */
export function renderAdoptSetup(o) {
  const { boxName, ownerPubKey, image, brainRoot, uid, gid, tz = 'UTC', swap = false,
    inventory = null, ownershipText = null, priorEntries = [], files, hostRoot = '' } = o || {};
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(String(boxName))) throw new Error(`box name '${boxName}' must be lowercase DNS-safe`);
  if (!PUBKEY_RE.test(String(ownerPubKey || '').trim())) throw new Error('ownerPubKey must be a single ssh-ed25519 public key line');
  if (!String(image || '').startsWith('ghcr.io/') || /\s/.test(image)) throw new Error('image must be a ghcr.io reference');
  if (!SAFE_PATH_RE.test(String(brainRoot)) || brainRoot === '/') throw new Error('the brain folder must be an absolute path of plain characters');
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid <= 0 || gid < 0) throw new Error('the brain folder needs a non-root owner');
  if (!TZ_RE.test(String(tz))) throw new Error('the timezone does not look like a zone name');
  if (hostRoot && !SAFE_PATH_RE.test(hostRoot)) throw new Error('hostRoot must be a plain absolute path');
  const key = String(ownerPubKey).trim();
  const fl = hostFiles({ boxName, image, brainRoot, uid, gid, tz, files });
  const merged = mergeOwnership(ownershipText);

  const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
  const lines = [];
  const L = (...x) => lines.push(...x);

  L('set -eu',
    `ROOT=${shq(hostRoot)}`,
    `B=${shq(brainRoot)}`,
    `OU=${uid}; OG=${gid}`,
    'M="$B/.kernel/move-in"; HS="$M/host-setup.json"',
    'step(){ echo "crads-step: $1"; }',
    'fail(){ echo "crads-failed: $1"; exit 44; }',
    // The record. One JSON object per entry, rewritten after every change.
    'ENTRIES=()',
    ...priorEntries.map((e) => `ENTRIES+=(${shq(e)})`),
    'flush(){',
    '  [ -d "$M" ] || return 0',
    '  { printf "["; i=0; for e in "${ENTRIES[@]}"; do [ $i -gt 0 ] && printf ","; printf "\\n  %s" "$e"; i=$((i+1)); done; printf "\\n]\\n"; } > "$HS.tmp"',
    '  chown "$OU:$OG" "$HS.tmp" 2>/dev/null || true; chmod 0600 "$HS.tmp"; mv -f "$HS.tmp" "$HS"',
    '}',
    'rec(){ for e in "${ENTRIES[@]}"; do [ "$e" = "$1" ] && return 0; done; ENTRIES+=("$1"); flush; }',
    'mkd(){ [ -d "$1" ] || install -d -o "$OU" -g "$OG" -m 0700 "$1"; }',
    // stdin -> a file in the brain folder, owned by the folder's owner, swapped in whole
    'put_brain(){ cat > "$1.crads-tmp"; chown "$OU:$OG" "$1.crads-tmp"; chmod "$2" "$1.crads-tmp"; mv -f "$1.crads-tmp" "$1"; }',
    '');

  L('step folder',
    '[ -d "$B" ] || fail "the folder $B is not there any more"',
    'mkd "$B/.kernel"; mkd "$M"',
    'flush',
    '');

  if (inventory) {
    L('step inventory',
      `rec ${shq(entry('wrote the host inventory for /move-in (.kernel/move-in/host-inventory.json)', { op: 'keep', why: 'inside your folder' }))}`,
      `base64 -d <<'CRADS_B64' | put_brain "$M/host-inventory.json" 0600`, b64(JSON.stringify(inventory, null, 2) + '\n'), 'CRADS_B64',
      '');
  }

  // Docker: used as found. docker.io and Docker's own docker-ce cannot share
  // apt, so the check refused that already; this re-asks in case it changed.
  L('step docker',
    'if command -v docker >/dev/null 2>&1; then',
    '  if dpkg -s docker.io 2>/dev/null | grep -q "^Status: install ok installed"; then fail "docker came from Ubuntu\'s docker.io package"; fi',
    'else',
    `  rec ${shq(entry('installed Docker (docker-ce) from Docker’s own package source', { op: 'keep', why: 'Docker stays installed' }))}`,
    '  install -m 0755 -d "$ROOT/etc/apt/keyrings"',
    '  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$ROOT/etc/apt/keyrings/docker.asc"',
    '  chmod a+r "$ROOT/etc/apt/keyrings/docker.asc"',
    '  CODENAME=$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")',
    '  printf "Types: deb\\nURIs: https://download.docker.com/linux/ubuntu\\nSuites: %s\\nComponents: stable\\nArchitectures: %s\\nSigned-By: /etc/apt/keyrings/docker.asc\\n" "$CODENAME" "$(dpkg --print-architecture)" > "$ROOT/etc/apt/sources.list.d/docker.sources"',
    '  apt-get update',
    '  DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
    '  systemctl enable --now docker',
    'fi',
    '');

  // The member login: the app's SSH front door, and nothing else. Created
  // here (not by a users module) so the record knows it was ours.
  L('step member',
    `if ! getent passwd ${ADOPT_HOST_USER} >/dev/null 2>&1; then`,
    `  rec ${shq(entry('added the login "member", the app’s way in', { op: 'remove-user', user: ADOPT_HOST_USER }))}`,
    `  useradd --create-home --shell /bin/bash --groups docker ${ADOPT_HOST_USER}`,
    'else',
    `  usermod -aG docker ${ADOPT_HOST_USER}`,
    'fi',
    '');

  L('step files',
    `[ -d "$ROOT/etc/ai-os" ] || rec ${shq(entry('made the folder /etc/ai-os', { op: 'remove-dir', path: '/etc/ai-os' }))}`);
  for (const f of fl) {
    L(`rec ${shq(entry(`wrote ${f.path}`, { op: 'remove-file', path: f.path }))}`,
      `mkdir -p "$(dirname "$ROOT${f.path}")"`,
      `base64 -d > "$ROOT${f.path}.crads-tmp" <<'CRADS_B64'`, b64(f.content), 'CRADS_B64',
      `chmod ${f.mode} "$ROOT${f.path}.crads-tmp"; mv -f "$ROOT${f.path}.crads-tmp" "$ROOT${f.path}"`);
  }
  // Written by aios-passwd at every start; recorded now so Move out removes them.
  L(`rec ${shq(entry('the owner\u2019s name inside the container (/etc/ai-os/passwd)', { op: 'remove-file', path: '/etc/ai-os/passwd' }))}`,
    `rec ${shq(entry('the owner\u2019s group inside the container (/etc/ai-os/group)', { op: 'remove-file', path: '/etc/ai-os/group' }))}`);
  // A broken drop-in would stop sshd accepting anyone, the person included.
  L('if ! sshd -t 2>/dev/null; then rm -f "$ROOT/etc/ssh/sshd_config.d/60-aios-member.conf"; fail "the SSH server rejected the member login settings, so they were taken out again"; fi',
    'systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true',
    '');

  if (swap) {
    L('step swap',
      'if [ -z "$(swapon --show --noheadings 2>/dev/null)" ] && [ ! -e "$ROOT/swapfile" ]; then',
      `  rec ${shq(entry('added a 2 GB swap file at /swapfile', { op: 'remove-swap', path: ADOPT_SWAPFILE }))}`,
      '  { fallocate -l 2G "$ROOT/swapfile" || dd if=/dev/zero of="$ROOT/swapfile" bs=1M count=2048; } && chmod 600 "$ROOT/swapfile" && mkswap "$ROOT/swapfile" >/dev/null && swapon "$ROOT/swapfile" \\',
      '    && { grep -q "^/swapfile " "$ROOT/etc/fstab" 2>/dev/null || echo "/swapfile none swap sw 0 0" >> "$ROOT/etc/fstab"; } || rm -f "$ROOT/swapfile"',
      'fi',
      '');
  }

  // The device roster lives in the brain (devices/ and ssh/member/, both in
  // the never-commit list). Seeded only when absent: device-sync owns them
  // from the first boot on.
  L('step roster',
    'mkd "$B/devices"; mkd "$B/ssh"; mkd "$B/ssh/member"',
    'if [ ! -s "$B/devices/this-computer.yaml" ]; then',
    `  rec ${shq(entry('added this computer to the device roster in your folder (devices/this-computer.yaml)', { op: 'keep', why: 'inside your folder' }))}`,
    `  printf 'label: "This computer"\\nstatus: "active"\\nadded: "%s"\\nrevoked: ""\\nlast_seen: ""\\nvaultkey: ""\\npubkeys:\\n  - %s\\n' "$(date -u +%Y-%m-%d)" ${shq(key)} | put_brain "$B/devices/this-computer.yaml" 0644`,
    'fi',
    'if [ ! -s "$B/ssh/member/authorized_keys" ]; then',
    `  printf '%s\\n' ${shq(key)} | put_brain "$B/ssh/member/authorized_keys" 0644`,
    'fi',
    '');

  // ownership.json: the two flags, merged, before the service ever starts
  // (box-up reads `adopted` on its first run, the engine reads `moving_in`).
  // Refuses when the file changed since the check rather than merging into a
  // version nobody looked at.
  const was = ownershipText == null ? '' : b64(ownershipText);
  L('step ownership',
    `WAS=${shq(was)}`,
    'NOW=""; [ -f "$B/ownership.json" ] && NOW=$(base64 -w0 "$B/ownership.json")',
    '[ "$NOW" = "$WAS" ] || fail "ownership.json in your folder changed since the check; check the server again"',
    `rec ${shq(entry('marked your folder as adopted and moving in (ownership.json: adopted, moving_in)', { op: 'keep', why: 'inside your folder; /move-in clears moving_in' }))}`,
    `base64 -d <<'CRADS_B64' | put_brain "$B/ownership.json" 0644`, b64(merged), 'CRADS_B64',
    '');

  L('step service',
    'systemctl daemon-reload',
    `rec ${shq(entry('started the host-update timer (ai-os-host-update.timer)', { op: 'stop-unit', unit: 'ai-os-host-update.timer' }))}`,
    'systemctl enable --now ai-os-host-update.timer',
    `rec ${shq(entry('started your assistant’s container (ai-os.service)', { op: 'stop-unit', unit: 'ai-os.service' }))}`,
    'systemctl enable --now ai-os.service',
    'echo crads-setup-ok',
    '');

  return { files: fl, script: lines.join('\n') };
}
