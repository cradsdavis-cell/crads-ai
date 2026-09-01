// selfhost-cloudinit.mjs — render the pebble cloud-init for a SELF-HOSTED box.
//
// Derives from provisioning/managed/cloud-init.template.yaml (the proven boot
// contract: systemd unit pulls the public image and runs it) with the hosted
// era transformed out:
//   - NO cloudflared: the tunnel block is stripped wholesale. Access is SSH
//     only (the desktop app's interface), so the firewall opens 22/tcp instead
//     of relying on an outbound tunnel.
//   - NO operator key, NO anchor org, NO arrival callbacks: the only key on
//     the box is the owner's, and nothing on the box reports to any Crads
//     service at boot.
//
// LIVE-CERT REQUIRED: this renderer has unit tests but the rendered YAML has
// not yet booted real metal. The first wizard end-to-end run on a throwaway
// server is the cert; until then treat the output as a draft of the contract.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, '..', '..', 'provisioning', 'managed', 'cloud-init.template.yaml');
const HOST_DIR = join(HERE, '..', '..', 'provisioning', 'host');

// The host scripts ride gz+b64 exactly as provision-pebble.sh ships them.
// sshd's ForceCommand for the member user IS enter-aios, so a box without
// these boots but locks every SSH out (live-cert finding #3, 2026-09-01: the
// first cert box did exactly that).
const HOST_SCRIPTS = [
  ['/usr/local/bin/aios-host-update', 'aios-host-update'],
  ['/usr/local/bin/enter-aios', 'enter-aios'],
];

// gz+b64 is opaque to every YAML parser between here and /usr/local/bin, so
// whatever bytes go in come out. The Windows exe bakes these as SEA assets from
// a windows-latest checkout, where git's core.autocrlf=true rewrites them to
// CRLF, and the shebang lands on the box as `#!/bin/bash\r`. The kernel then
// looks for an interpreter named "/bin/bash\r" and bash reports "cannot
// execute: required file not found" from inside the sshd ForceCommand: the box
// boots perfectly and locks every SSH out. Found live on test-mineral-4,
// 2026-09-01, on the first box built from the Windows exe; both live certs ran
// from Linux and never saw it. This renderer is the contract boundary, so it
// normalises rather than trusting whatever checked the sources out. The
// .gitattributes pin is the other half; either alone would have been enough,
// which is why both are here.
const toLf = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b)).replace(/\r\n/g, '\n');

function hostScriptBlocks(files) {
  const sources = { 'aios-host-update': files?.hostUpdate, 'enter-aios': files?.enterAios };
  return HOST_SCRIPTS.map(([target, src]) => {
    const body = toLf(sources[src] ?? readFileSync(join(HOST_DIR, src)));
    const gz = gzipSync(Buffer.from(body, 'utf8'), { level: 9 }).toString('base64');
    return `  - path: ${target}\n    permissions: '0755'\n    encoding: gz+b64\n    content: ${gz}`;
  }).join('\n');
}

const PUBKEY_RE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [^\n]{1,128})?$/;

/**
 * @param {object} o
 * @param {string} o.boxName      short DNS-safe name for the mineral
 * @param {string} o.ownerPubKey  the owner's ssh-ed25519 public key line
 * @param {string} o.image        e.g. ghcr.io/cradsdavis-cell/crads-pebble:v2 (public)
 * @param {string} [o.ownerEmail] local identity only; goes nowhere
 * @param {object} [o.files]      in-memory sources for the packaged exe, where
 *                                import.meta.url is the exe itself and none of
 *                                these paths exist on disk (found live on the
 *                                first Windows run, 2026-09-01):
 *                                { template, hostUpdate, enterAios } strings.
 */
export function renderSelfHostCloudInit({ boxName, ownerPubKey, image, ownerEmail = '', files }) {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(boxName)) throw new Error(`box name '${boxName}' must be lowercase DNS-safe`);
  if (!PUBKEY_RE.test(ownerPubKey.trim())) throw new Error('ownerPubKey must be a single ssh-ed25519 public key line');
  if (!image.startsWith('ghcr.io/')) throw new Error('image must be a ghcr.io reference');

  let t = toLf(files?.template ?? readFileSync(TEMPLATE, 'utf8'));

  // The hosted template's substitution slots, filled for the self-host shape.
  t = t
    .replaceAll('__BOX_NAME__', boxName)
    .replaceAll('__BOX_HOST__', boxName) // no DNS of ours; the box's own idea of its name
    .replaceAll('__OWNER__', boxName)
    .replaceAll('__OWNER_EMAIL__', ownerEmail)
    .replaceAll('__ANCHOR_ORG__', '') // hubs are joined later via commons repos, never at birth
    .replaceAll('__MEMBER_PUBKEY__', ownerPubKey.trim())
    .replaceAll('__IMAGE__', image)
    .replaceAll('__SSH_FIREWALL_RULE__', 'ufw allow 22/tcp')
    .replaceAll('__PEBBLE_PASSWORD__', randomPassword());

  // Strip the cloudflared install: everything from its banner comment to the
  // service-install line goes, and the tunnel token slot with it.
  const lines = t.split('\n');
  const start = lines.findIndex((l) => l.includes('--- cloudflared'));
  if (start !== -1) {
    let end = lines.findIndex((l, i) => i >= start && l.includes('cloudflared service install'));
    if (end === -1) end = start;
    lines.splice(start, end - start + 1);
    t = lines.join('\n');
  }
  if (t.includes('__TUNNEL_TOKEN__')) throw new Error('tunnel token slot survived the strip; template drifted, update this renderer');
  if (t.includes('cloudflared service install')) throw new Error('cloudflared install survived the strip; template drifted');

  // Host scripts are NOT operator machinery: enter-aios is the member's SSH
  // front door (sshd ForceCommand). Inject them at the marker, exactly as the
  // hosted-era provision script did. Seed hooks ARE operator machinery; those
  // markers render away, along with comment lines that merely mention a slot
  // (the template's own header narrates __TOKENS__ without being one).
  t = t.replace(/^.*#__HOST_SCRIPTS__.*$/m, hostScriptBlocks(files));
  t = t
    .replace(/^.*#__(SEED_WRITE_FILES|SEED_RUNCMD)__.*$\n?/gm, '')
    .replace(/^\s*#.*__[A-Z_]+__.*$\n?/gm, '')
    .replace(/^\s*#.*cloudflared.*$\n?/gim, ''); // narration of the tunnel era

  const unfilled = t.match(/__[A-Z_]+__/g);
  if (unfilled) throw new Error(`unfilled template slots: ${[...new Set(unfilled)].join(', ')}`);
  return t;
}

function randomPassword() {
  // Local code-server password; the surface is not exposed (no tunnel, firewall
  // deny-inbound except SSH) but the slot must hold something non-guessable.
  return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
}
