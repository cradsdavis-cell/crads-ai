#!/usr/bin/env node
// roster-cli.mjs: the box-side command surface for the device roster. The panel's
// member verbs shell out to exactly this, so validation lives in ONE place and a
// member editing yaml by hand gets the same rules.
//
//   node roster-cli.mjs <stateDir> list
//   node roster-cli.mjs <stateDir> add <slug> <label> <pubkey> [--account <email>]
//   node roster-cli.mjs <stateDir> revoke <slug>
//   node roster-cli.mjs <stateDir> rename <slug> <label>
//   node roster-cli.mjs <stateDir> set-vaultkey <slug> <x25519-pub-b64>
//   node roster-cli.mjs <stateDir> stamp <fingerprint>
//   node roster-cli.mjs <stateDir> adopt
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listDevices, writeDevice, revokeDevice, renameDevice, stampLastSeen, stampSeenBySlug, setVaultKey, fingerprintOf, PUBKEY_RE } from './roster.mjs';
import { syncKeys, supportLine } from './device-sync.mjs';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
const die = (msg) => { console.error(msg); process.exit(1); };
const today = () => new Date().toISOString().slice(0, 10);

const stateDir = process.argv[2] || '/state';
const cmd = process.argv[3] || 'list';
let a = process.argv.slice(4);

// WHOSE MACHINE THIS IS, as a FLAG and not a positional (QA finding 146,
// 2026-08-17). The roster has carried an `account` column since account-bound
// access landed and `add` had no way to write one, so every device installed
// through this CLI arrived unattributed: the panel's devices-add verb and the
// invite lane's handover (cockpit/jobs/enrol-arrivals.mjs) are both callers, and
// enrol-sync's own writeDevice was the only writer of the field in the product.
// The consumer is revokeWithCascade (engine/box/grants.mjs), which cuts exactly
// the rows that NAME the account being removed, so with every row blank the cut
// list was always empty and /app/access's promise in bold ("Removing an account
// cuts them off entirely, and every machine they enrolled with it") was never
// once true.
//
// A FLAG because `add` takes the pubkey as the REST of the line: a public key is
// itself two or three space-separated words, so `rest.join(' ')` has to be
// greedy and a trailing positional would be eaten by it. Pulled out before the
// positional split for that reason, and only there.
//
// Refused rather than dropped when it is not an address: silently storing junk
// here would make the cascade compare against noise, which fails in the
// direction that leaves a machine open.
const flag = (name) => {
  const out = [];
  const rest = [];
  for (let i = 0; i < a.length; i += 1) {
    const v = String(a[i]);
    // A flag with nothing after it is PRESENT-AND-EMPTY, never absent: `''` fails
    // the validator below and is refused, where `undefined` would have meant "the
    // caller did not claim to know" and passed silently.
    if (v === `--${name}`) { out.push(a[i + 1] === undefined ? '' : a[i + 1]); i += 1; continue; }
    if (v.startsWith(`--${name}=`)) { out.push(v.slice(name.length + 3)); continue; }
    rest.push(a[i]);
  }
  a = rest;
  return out.length ? out[out.length - 1] : undefined;
};
// Normalised the way grants.mjs normEmail compares it, so a row written here and
// a revoke asked for there can never miss each other on case alone.
const accountArg = (raw) => {
  if (raw === undefined) return '';
  const v = String(raw).trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/.test(v)) {
    die('ERROR: --account takes the email address that enrolled this computer, like "sam@example.com".');
  }
  return v;
};

if (cmd === 'list') {
  let support = null;
  if (supportLine(stateDir)) {
    try {
      const g = JSON.parse(readFileSync(join(stateDir, 'support', 'access.json'), 'utf8')).grant;
      support = { active: true, expires_at: g.expires_at };
    } catch { support = { active: true, expires_at: '' }; }
  }
  console.log(JSON.stringify({ devices: listDevices(stateDir), support }, null, 2));
} else if (cmd === 'add') {
  const account = accountArg(flag('account'));   // strips the flag from `a` first
  const [slug, label, ...rest] = a;
  const pubkey = rest.join(' ').trim();
  if (!SLUG_RE.test(String(slug ?? ''))) die('ERROR: the short id must be lowercase letters, numbers and dashes (2 to 32 characters).');
  if (!String(label ?? '').trim()) die('ERROR: give this computer a name you will recognise later, like "work laptop".');
  if (!PUBKEY_RE.test(pubkey)) die('ERROR: that key does not look right. It should be ONE line starting with "ssh-ed25519".');
  const existing = listDevices(stateDir);
  if (existing.some((d) => d.slug === slug)) die(`ERROR: a device with the short id "${slug}" already exists. Pick another, or revoke that one first.`);
  const fp = fingerprintOf(pubkey);
  const clash = existing.find((d) => d.fingerprint === fp && d.status === 'active');
  if (clash) die(`ERROR: that key is already enrolled as "${clash.label}" (${clash.slug}).`);
  writeDevice(stateDir, { slug, label: String(label).trim(), pubkey, added: today(), status: 'active', revoked: '', last_seen: '', account });
  const r = syncKeys(stateDir);
  console.log(`OK: "${label}" can now open this box. ${r.devices} device(s) enrolled.`);
} else if (cmd === 'revoke') {
  const [slug] = a;
  const all = listDevices(stateDir);
  const target = all.find((d) => d.slug === slug);
  if (!target) die(`ERROR: no device "${slug}".`);
  // Defence in depth (live-cert 2026-08-03): count only devices that carry a
  // REAL key. A box stamped invite-pending used to be seeded with a sentinel
  // row ("ssh-ed25519 AAAA-no-member-key-staged disabled"); it read as active,
  // so this guard counted two devices and let the member revoke their only
  // working one. The cloud-init seed no longer writes that row, and this no
  // longer trusts a row just because it says active.
  const usable = all.filter((d) => d.status === 'active' && PUBKEY_RE.test(String(d.pubkey ?? '')));
  if (target.status === 'active' && usable.length <= 1 && usable.some((d) => d.slug === target.slug)) {
    die('ERROR: this is the last device that can open your box, so revoking it would lock you out. Add another computer first, then revoke this one.');
  }
  revokeDevice(stateDir, slug, today());
  syncKeys(stateDir);
  console.log(`OK: "${target.label}" can no longer open this box. It stops working on its next connection attempt.`);
} else if (cmd === 'rename') {
  const [slug, ...rest] = a;
  const label = rest.join(' ').trim();
  if (!SLUG_RE.test(String(slug ?? ''))) die('ERROR: unknown device.');
  if (!label) die('ERROR: give this computer a name you will recognise later.');
  renameDevice(stateDir, slug, label);
  console.log(`OK: renamed to "${label}".`);
} else if (cmd === 'set-vaultkey') {
  // The member's app mints the X25519 pair locally and publishes only the public
  // half here, so cold secrets can be sealed to this device. Base64 SPKI DER.
  const [slug, vaultkey] = a;
  if (!SLUG_RE.test(String(slug ?? ''))) die('ERROR: unknown device.');
  if (!/^[A-Za-z0-9+/]{40,120}={0,2}$/.test(String(vaultkey ?? ''))) die('ERROR: that does not look like a vault key.');
  setVaultKey(stateDir, slug, vaultkey);
  console.log(`OK: this computer can now open sealed secrets.`);
} else if (cmd === 'stamp') {
  stampLastSeen(stateDir, String(a[0] ?? ''), new Date().toISOString());
} else if (cmd === 'seen') {
  const [slug] = a;
  if (!listDevices(stateDir).some((d) => d.slug === slug)) die('ERROR: unknown device.');
  stampSeenBySlug(stateDir, slug, new Date().toISOString());
  console.log('OK: seen.');
} else if (cmd === 'adopt') {
  // Migration for boxes stamped before the roster existed: any key already in
  // the derived authorized_keys that is not a support grant becomes a roster row,
  // so the table is populated and the lockout guard has something to protect.
  // Idempotent: keys already enrolled are skipped. Support lines carry an
  // expiry-time option, so PUBKEY_RE (anchored at ssh-ed25519) skips them.
  let existingLines = [];
  try { existingLines = readFileSync(join(stateDir, 'ssh', 'member', 'authorized_keys'), 'utf8').split('\n'); } catch { /* nothing to adopt */ }
  const known = new Set(listDevices(stateDir).map((d) => d.fingerprint));
  let n = 0;
  for (const line of existingLines) {
    const key = line.trim();
    if (!PUBKEY_RE.test(key)) continue;
    if (known.has(fingerprintOf(key))) continue;
    // "Adopted key", not "This computer" (2026-08-12): adopt runs ON THE BOX
    // over keys that were already in authorized_keys, so it genuinely cannot
    // know which machine holds any of them. Naming them after the box's own
    // idea of "this computer" claimed knowledge it does not have, and put a
    // second row called "This computer" next to the app's.
    const slug = n === 0 ? 'adopted-key' : `adopted-key-${n + 1}`;
    writeDevice(stateDir, {
      slug,
      label: n === 0 ? 'Adopted key' : `Adopted key (${n + 1})`,
      pubkey: key, added: today(), status: 'active', revoked: '', last_seen: '',
    });
    known.add(fingerprintOf(key));
    n++;
  }
  syncKeys(stateDir);
  console.log(n ? `OK: adopted ${n} existing key(s) into the roster.` : 'OK: nothing to adopt; the roster is already current.');
} else {
  die(`ERROR: unknown command "${cmd}".`);
}
