// roster.mjs: the member box's device roster (phase 1 of the device-roster +
// secret-store design, 2026-07-28). One yaml per device under <state>/devices/,
// git-tracked in the member's own brain repo so the history of who could reach
// this box is auditable and survives every update.
//
// Deliberately the same shape as the parent's people/*.yaml (tools/people-sync.mjs):
// a flat per-entity file with a pubkeys: block-list, status "active" | "revoked".
// The derived /state/ssh/member/authorized_keys is written ONLY by device-sync.mjs.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const PUBKEY_RE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9@._ -]{1,64})?$/;

// SHA256:<base64-no-padding> over the decoded key blob: exactly what
// `ssh-keygen -lf` prints, so it can be matched against SSH_AUTH_INFO_0.
export function fingerprintOf(pubkey) {
  const blob = String(pubkey).split(/\s+/)[1] || '';
  return 'SHA256:' + createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '');
}

const devicesDir = (stateDir) => join(stateDir, 'devices');
const fileFor = (stateDir, slug) => join(devicesDir(stateDir), `${slug}.yaml`);
const scalar = (y, k) => (y.match(new RegExp(`^${k}:\\s*"?([^"\\n]*)"?`, 'm')) || [])[1]?.trim() ?? '';

function firstPubkey(yaml) {
  const block = yaml.split(/^pubkeys:\s*$/m)[1] || '';
  for (const line of block.split('\n')) {
    const m = line.match(/^\s+-\s+"?(ssh-ed25519 [^"\n]+?)"?\s*$/);
    if (m) return m[1];
    if (/^\S/.test(line)) break;   // next top-level field ends the list
  }
  return '';
}

function render(d) {
  return [
    `label: ${JSON.stringify(d.label ?? '')}`,
    `status: ${JSON.stringify(d.status ?? 'active')}`,
    `added: ${JSON.stringify(d.added ?? '')}`,
    `revoked: ${JSON.stringify(d.revoked ?? '')}`,
    `last_seen: ${JSON.stringify(d.last_seen ?? '')}`,
    // The X25519 PUBLIC half of this device's vault key, used to seal cold
    // secrets to it. The private half never leaves the device. Empty on devices
    // enrolled before the vault existed: they can open nothing cold until the
    // app mints one for them, which the Secrets tab tells the member.
    `vaultkey: ${JSON.stringify(d.vaultkey ?? '')}`,
    `account: ${JSON.stringify(d.account ?? '')}`,
    'pubkeys:',
    `  - ${JSON.stringify(d.pubkey ?? '')}`,
    '',
  ].join('\n');
}

export function listDevices(stateDir) {
  const dir = devicesDir(stateDir);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.yaml') || f.startsWith('_')) continue;
    const yaml = readFileSync(join(dir, f), 'utf8');
    const pubkey = firstPubkey(yaml);
    out.push({
      slug: f.slice(0, -5),
      label: scalar(yaml, 'label'),
      pubkey,
      fingerprint: pubkey ? fingerprintOf(pubkey) : '',
      added: scalar(yaml, 'added'),
      revoked: scalar(yaml, 'revoked'),
      status: scalar(yaml, 'status') || 'active',
      last_seen: scalar(yaml, 'last_seen'),
      vaultkey: scalar(yaml, 'vaultkey'),
      // WHICH ACCOUNT ENROLLED THIS MACHINE. Empty on every device added before
      // account-bound access, and that is honest rather than a gap to paper
      // over: those keys were installed by a person pasting them, and nothing
      // recorded who. Revoking an account cascades to the machines that name it
      // and deliberately leaves the rest alone, because guessing that an
      // unattributed key belongs to the account being revoked would cut somebody
      // else off. See docs/design-account-bound-access.md.
      account: scalar(yaml, 'account'),
      // Can this row actually open the box RIGHT NOW? A row is not evidence of a
      // computer just because it says active: boxes stamped invite-pending were
      // seeded with a sentinel whose "key" is the literal string
      // "ssh-ed25519 AAAA-no-member-key-staged disabled". cloud-init stopped
      // writing it and the revoke guard stopped counting it, but every box
      // stamped before those fixes still carries one, and the member's Network
      // page listed it as a second "This computer" with its own Revoke button —
      // on the page whose job is revoking a lost laptop. Say which rows are real
      // here, once, so every consumer inherits it.
      usable: (scalar(yaml, 'status') || 'active') === 'active' && PUBKEY_RE.test(String(pubkey ?? '')),
    });
  }
  return out;
}

export function writeDevice(stateDir, d) {
  mkdirSync(devicesDir(stateDir), { recursive: true });
  writeFileSync(fileFor(stateDir, d.slug), render(d));
}

function mutate(stateDir, slug, fn) {
  const found = listDevices(stateDir).find((d) => d.slug === slug);
  if (!found) throw new Error(`no device ${slug}`);
  const next = fn(found);
  writeDevice(stateDir, next);
  return next;
}

// THE DATE DEFAULTS (QA finding 148, 2026-08-17). It used to be a parameter every
// caller had to remember and two of the three production callers did not:
// grants.mjs's revokeWithCascade omitted it, and enrol-sync's staged-web-revoke
// leg bypassed this function altogether with a raw writeDevice. Both produced
// status "revoked" with revoked "", so a row could say it was cut and not say
// when, on the one page that exists to answer who could reach this box and until
// when. roster-cli passed it correctly all along, which is exactly why nobody
// noticed: one of the three was right.
//
// Defaulting rather than throwing on a missing date, because the failure mode of
// a throw here is a revoke that does not happen, and a key left in the door is
// worse than a date nobody typed. An explicit date still wins, for backfills and
// for tests that pin a fixed day.
export const revokeDevice = (stateDir, slug, today = new Date().toISOString().slice(0, 10)) =>
  mutate(stateDir, slug, (d) => ({ ...d, status: 'revoked', revoked: today }));

export const renameDevice = (stateDir, slug, label) =>
  mutate(stateDir, slug, (d) => ({ ...d, label }));

// Publishing the PUBLIC half of a device's vault key. The member's app calls this
// after minting the pair locally; the private half stays on that machine, which
// is what keeps cold secrets out of reach of the box and of Crads AI.
export const setVaultKey = (stateDir, slug, vaultkey) =>
  mutate(stateDir, slug, (d) => ({ ...d, vaultkey }));

export function stampLastSeen(stateDir, fingerprint, nowIso) {
  const hit = listDevices(stateDir).find((d) => d.fingerprint && d.fingerprint === fingerprint);
  if (!hit) return false;
  writeDevice(stateDir, { ...hit, last_seen: nowIso });
  return true;
}

// By-slug variant for the member app, which knows its own roster slug (from
// /devices/self-heal) but not its key's fingerprint. First production writer
// of last_seen (2026-08-04): until it landed, every row read "not recorded yet".
export const stampSeenBySlug = (stateDir, slug, nowIso) =>
  mutate(stateDir, slug, (d) => ({ ...d, last_seen: nowIso }));
