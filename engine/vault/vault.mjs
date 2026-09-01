// vault.mjs (engine/vault/, NOT engine/secrets/: the repo gitignores **/secrets/)
// R7 (2026-08-23): the Secrets page is now a read-only ledger (discover.mjs) and no
// longer offers Add or Delete; the secrets-put / secrets-remove verbs stay for now.
// The box-side secret store (device-roster + secret-store design,
// 2026-07-28). One file per secret under <state>/secrets/vault/<name>.json.
//
// Two tiers, and the split is not a preference, it is a fact about the box:
//   HOT   a scheduled job needs this at 3am while the member is asleep, so the
//         box must be able to read it on its own. Stored as a value. Anyone with
//         server access can read it, and the app says so on the entry.
//   COLD  nothing scheduled touches it, so it is sealed on the member's machine
//         to their enrolled devices' vault keys. This module NEVER decrypts a
//         cold entry: there is deliberately no code path here that could, which
//         is the whole point. It stores and moves an opaque envelope.
//
// Deliberately NOT encrypted-at-rest for hot: the box would hold the key on the
// same disk, so it would be ceremony rather than security, and backup.mjs
// already encrypts the whole secrets/ tree with a per-box passphrase before it
// rides the brain repo to the member's own GitHub. The honest hot claim is the
// label plus the editor, and overstating it would be worse than not doing it.
//
// The vault sits BESIDE the legacy secret files (telegram_bot_token,
// backup_passphrase, code-server-password, catalog_deploy_key,
// provisioning.env.local) which are read directly by start-comms.sh, backup.mjs,
// box-up.sh, catalog-sync.mjs and panel-server.mjs. Nothing here touches them.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const VALID_NAME = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

const vaultDir = (stateDir) => join(stateDir, 'secrets', 'vault');
const fileFor = (stateDir, name) => join(vaultDir(stateDir), `${name}.json`);
const today = () => new Date().toISOString();

function checkName(name) {
  if (!VALID_NAME.test(String(name ?? ''))) {
    const e = new Error('a secret name must be lowercase letters, numbers and dashes (2 to 64 characters), for example "gmail-token"');
    e.userFacing = true;
    throw e;
  }
  return name;
}

function readEntry(stateDir, name) {
  try { return JSON.parse(readFileSync(fileFor(stateDir, name), 'utf8')); } catch { return null; }
}

function writeEntry(stateDir, name, entry) {
  mkdirSync(vaultDir(stateDir), { recursive: true });
  writeFileSync(fileFor(stateDir, name), JSON.stringify(entry, null, 2) + '\n', { mode: 0o600 });
}

// The listing NEVER carries hot values. Callers that genuinely need one ask for
// it by name through getHot, which is a separate, narrower call on purpose.
export function listSecrets(stateDir, { withEnvelopes = false } = {}) {
  const dir = vaultDir(stateDir);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    const e = readEntry(stateDir, f.slice(0, -5));
    if (!e || !e.tier) continue;                       // corrupt or half-written: skip, never throw
    out.push({
      name: f.slice(0, -5),
      tier: e.tier,
      label: e.label || '',
      used_by: e.used_by || [],
      created: e.created || '',
      updated: e.updated || '',
      ...(e.tier === 'cold'
        ? { sealed_to: (e.envelope?.wraps || []).map((w) => w.fingerprint),
            ...(withEnvelopes ? { envelope: e.envelope } : {}) }
        : {}),
    });
  }
  return out;
}

export function putHot(stateDir, name, value, { label = '', usedBy = [], created = '' } = {}) {
  checkName(name);
  const prev = readEntry(stateDir, name);
  writeEntry(stateDir, name, {
    tier: 'hot',
    label: label || prev?.label || '',
    used_by: usedBy.length ? usedBy : (prev?.used_by || []),
    created: created || prev?.created || today(),
    updated: today(),
    value: String(value),
  });
}

// envelope is produced by wizard/panel/vault-crypto.mjs ON THE MEMBER'S MACHINE.
// This function stores it verbatim and has no way to interpret it.
export function putCold(stateDir, name, envelope, { label = '', usedBy = [], created = '' } = {}) {
  checkName(name);
  if (!envelope || !envelope.ciphertext || !Array.isArray(envelope.wraps) || !envelope.wraps.length) {
    const e = new Error('that sealed secret is malformed, so nothing was saved');
    e.userFacing = true;
    throw e;
  }
  const prev = readEntry(stateDir, name);
  writeEntry(stateDir, name, {
    tier: 'cold',
    label: label || prev?.label || '',
    used_by: usedBy.length ? usedBy : (prev?.used_by || []),
    created: created || prev?.created || today(),
    updated: today(),
    envelope,
  });
}

export function getHot(stateDir, name) {
  checkName(name);
  const e = readEntry(stateDir, name);
  if (!e) { const err = new Error(`no secret called "${name}"`); err.userFacing = true; throw err; }
  if (e.tier === 'cold') {
    const err = new Error(`"${name}" is a cold secret: it is sealed to your own computers, so this box cannot read it. Open it in the app on one of your devices.`);
    err.userFacing = true;
    throw err;
  }
  return e.value;
}

export function removeSecret(stateDir, name) {
  checkName(name);
  const p = fileFor(stateDir, name);
  if (!existsSync(p)) return false;
  rmSync(p);
  return true;
}
