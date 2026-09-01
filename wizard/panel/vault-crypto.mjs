// vault-crypto.mjs: the COLD tier's sealing. Runs on the MEMBER's machine, never
// on the box (device-roster + secret-store design, 2026-07-28).
//
// The property this file exists to create: a cold secret is sealed to the member's
// enrolled devices, so the box stores an envelope it has no key for. Crads AI with
// full access to the server can move that envelope around and cannot open it.
//
// Scheme, per secret:
//   value  -> AES-256-GCM under a fresh random 32-byte DEK
//   DEK    -> wrapped once per device: ephemeral X25519 keypair, ECDH to that
//             device's vault public key, HKDF-SHA256, AES-256-GCM over the DEK
// Devices carry a SEPARATE X25519 vault keypair (not a converted ed25519 ssh key):
// Node does X25519 and ECDH natively, so this needs no dependency and no
// hand-rolled curve arithmetic, which is not a thing to hand-roll.
//
// Envelope shape (what the box stores, opaque to it):
//   { v: 1, alg: 'x25519-hkdf-sha256+aes-256-gcm', ciphertext, iv, tag,
//     wraps: [ { fingerprint, epk, wrapped, wiv, wtag } ] }
import {
  generateKeyPairSync, createPublicKey, createPrivateKey, diffieHellman,
  randomBytes, createCipheriv, createDecipheriv, hkdfSync, createHash,
} from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const INFO = Buffer.from('crads-vault-v1');
const b64 = (b) => Buffer.from(b).toString('base64');
const un64 = (s) => Buffer.from(String(s), 'base64');

const pubFrom = (b64key) => createPublicKey({ key: un64(b64key), type: 'spki', format: 'der' });
const privFrom = (b64key) => createPrivateKey({ key: un64(b64key), type: 'pkcs8', format: 'der' });

// A short stable id for a vault public key, so the UI can say WHICH device key a
// wrap belongs to without printing the key itself.
export function vaultFingerprint(publicKeyB64) {
  return 'VK:' + createHash('sha256').update(un64(publicKeyB64)).digest('base64').slice(0, 22);
}

export function mintVaultKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: b64(publicKey.export({ type: 'spki', format: 'der' })),
    privateKey: b64(privateKey.export({ type: 'pkcs8', format: 'der' })),
  };
}

// The on-disk vault keypair for one box identity, minted beside its ssh key
// (device-roster + secret-store design, 2026-07-28). MEMBER identities only:
// operator/support identities must never be sealing targets, or Crads could
// open the cold tier. The private half never leaves this machine; the public
// half is published to the box's device roster (panel /vault/sync ->
// roster-cli set-vaultkey). Reuse-never-clobber, same rule as the ssh key: a
// re-connect must never orphan envelopes already sealed to this device.
// Self-heals a missing .pub from the private half (X25519 publics are
// derivable); an unreadable private key is retired aside, never deleted.
export function ensureVaultKeypair(alias, sshDir = join(homedir(), '.ssh')) {
  mkdirSync(sshDir, { recursive: true });
  const keyPath = join(sshDir, `${alias}.vault.key`);
  const pubPath = join(sshDir, `${alias}.vault.pub`);
  const mintFresh = () => {
    const pair = mintVaultKeypair();
    writeFileSync(keyPath, pair.privateKey + '\n', { mode: 0o600 });
    writeFileSync(pubPath, pair.publicKey + '\n', { mode: 0o644 });
    if (process.platform === 'win32') {
      const un = process.env.USERNAME || process.env.USER || '';
      spawnSync('icacls', [keyPath, '/inheritance:r', '/grant:r', `${un}:R`], { stdio: 'ignore' });
    }
    return { vaultPublicKey: pair.publicKey, vaultKeyPath: keyPath, reused: false };
  };
  if (!existsSync(keyPath)) return mintFresh();
  const privB64 = readFileSync(keyPath, 'utf8').trim();
  if (existsSync(pubPath)) {
    return { vaultPublicKey: readFileSync(pubPath, 'utf8').trim(), vaultKeyPath: keyPath, reused: true };
  }
  try {
    const priv = createPrivateKey({ key: un64(privB64), type: 'pkcs8', format: 'der' });
    const pub = b64(createPublicKey(priv).export({ type: 'spki', format: 'der' }));
    writeFileSync(pubPath, pub + '\n', { mode: 0o644 });
    return { vaultPublicKey: pub, vaultKeyPath: keyPath, reused: true };
  } catch {
    renameSync(keyPath, `${keyPath}.orphan-${Date.now()}`);
    return mintFresh();
  }
}

const gcmEncrypt = (key, plaintext) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { ct, iv, tag: c.getAuthTag() };
};

const gcmDecrypt = (key, ct, iv, tag) => {
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
};

// devices: [{ fingerprint, vaultkey }] where vaultkey is the base64 X25519 public half.
export function seal(value, devices) {
  const targets = (devices || []).filter((d) => d && d.vaultkey);
  if (!targets.length) bail('a cold secret needs at least one device to seal to, or nobody could ever open it');
  const dek = randomBytes(32);
  const { ct, iv, tag } = gcmEncrypt(dek, Buffer.from(String(value), 'utf8'));
  const wraps = targets.map((d) => {
    const eph = generateKeyPairSync('x25519');
    const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: pubFrom(d.vaultkey) });
    const kek = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), INFO, 32));
    const w = gcmEncrypt(kek, dek);
    return {
      fingerprint: d.fingerprint,
      epk: b64(eph.publicKey.export({ type: 'spki', format: 'der' })),
      wrapped: b64(w.ct), wiv: b64(w.iv), wtag: b64(w.tag),
    };
  });
  return {
    v: 1, alg: 'x25519-hkdf-sha256+aes-256-gcm',
    ciphertext: b64(ct), iv: b64(iv), tag: b64(tag), wraps,
  };
}

// Try every wrap: the caller holds one device private key and does not need to be
// told which wrap is theirs. A wrong key fails the GCM tag, which is the check.
export function open(envelope, privateKeyB64) {
  let priv;
  try { priv = privFrom(privateKeyB64); }
  catch { bail('that is not a usable vault key for this computer. Re-connect this computer to the box to mint a fresh one.'); }
  for (const w of envelope?.wraps || []) {
    try {
      const shared = diffieHellman({ privateKey: priv, publicKey: pubFrom(w.epk) });
      const kek = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), INFO, 32));
      const dek = gcmDecrypt(kek, un64(w.wrapped), un64(w.wiv), un64(w.wtag));
      return gcmDecrypt(dek, un64(envelope.ciphertext), un64(envelope.iv), un64(envelope.tag)).toString('utf8');
    } catch { /* not this device's wrap, or tampered: try the next */ }
  }
  bail('this computer cannot open that secret. It was sealed to other devices, so open it on one of those, or re-enter it here.');
}

function bail(msg) { const e = new Error(msg); e.userFacing = true; throw e; }
