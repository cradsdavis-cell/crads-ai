#!/usr/bin/env node
// engine.mjs — the ed25519 key machinery (what survives of the provisioning
// engine).
//
// SELF-HOST COLLAPSE (2026-09-01): the org-provisioning flow that filled this
// file — runWizard, provisionRock, deprovision, the Hetzner/Cloudflare/GitHub
// clients, cloud-init render, the D42 org-policy composer — was DELETED with
// the org setup wizard (wizard/ui/). Creating a box is the door's own
// self-host flow now (wizard/provision/engine.mjs, BYO Hetzner token, no
// Cloudflare, no central anything). The bash pair (wizard/aios-setup.sh) and
// wizard/engine-parity.md document the retired flow's history.
//
// What remains is the piece the surviving install machinery still leans on:
// minting an OpenSSH ed25519 keypair in-process (node:crypto only, private key
// never touches disk here) and recovering a public line from one of our own
// private keys. Consumer: member-connect.mjs (installAccess/self-heal, which
// provision-routes and device-routes run), plus its tests.

import { generateKeyPairSync, randomBytes } from 'node:crypto';

// ------------------------------------------------- ed25519 OpenSSH key encoding
// Pure node:crypto replacement for `ssh-keygen -t ed25519 -N '' -C <comment>`.
// Public: "ssh-ed25519 <b64(blob)> <comment>\n". Private: the openssh-key-v1
// container (cipher none, kdf none, 1 key, checkint pair, seed||pub, comment,
// 1,2,3... padding to the 8-byte blocksize), base64 wrapped at 70 columns.
function sshStr(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const l = Buffer.alloc(4); l.writeUInt32BE(b.length, 0);
  return Buffer.concat([l, b]);
}
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }

// Recover the OpenSSH public line from one of our own private keys. The public key is
// embedded in the openssh-key-v1 blob, so this is a pure structural parse (Node's
// createPrivateKey cannot read OpenSSH private keys). Used to self-heal a device key whose
// .pub went missing after an interrupted setup, instead of telling a member to move files.
// Returns null if the blob is not one of ours / not parseable (the caller mints fresh then).
export function derivePublicKey(privatePem, comment) {
  try {
    const m = String(privatePem).match(/-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/);
    if (!m) return null;
    const blob = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
    const magic = 'openssh-key-v1\0';
    if (blob.subarray(0, magic.length).toString('utf8') !== magic) return null;
    let o = magic.length;
    const rd = () => { const n = blob.readUInt32BE(o); o += 4; const s = blob.subarray(o, o + n); o += n; return s; };
    rd(); rd(); rd();                       // ciphername, kdfname, kdfoptions
    if (blob.readUInt32BE(o) < 1) return null; o += 4;   // number of keys
    const pubBlob = rd();                    // sshStr(pubBlob): ssh-ed25519 type + 32-byte pub
    const tlen = pubBlob.readUInt32BE(0);
    if (pubBlob.subarray(4, 4 + tlen).toString('utf8') !== 'ssh-ed25519') return null;
    return `ssh-ed25519 ${pubBlob.toString('base64')} ${comment}\n`;
  } catch { return null; }
}

export function generateDeployKeypair(comment) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);    // raw A
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32); // raw k
  const pubBlob = Buffer.concat([sshStr('ssh-ed25519'), sshStr(pub)]);
  const check = randomBytes(4);
  let priv = Buffer.concat([
    check, check,
    sshStr('ssh-ed25519'), sshStr(pub),
    sshStr(Buffer.concat([seed, pub])),
    sshStr(comment),
  ]);
  const padLen = (8 - (priv.length % 8)) % 8;
  const pad = Buffer.alloc(padLen);
  for (let i = 0; i < padLen; i++) pad[i] = i + 1;
  priv = Buffer.concat([priv, pad]);
  const blob = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'utf8'),
    sshStr('none'), sshStr('none'), sshStr(''),
    u32(1), sshStr(pubBlob), sshStr(priv),
  ]);
  const wrapped = blob.toString('base64').match(/.{1,70}/g).join('\n');
  return {
    publicKey: `ssh-ed25519 ${pubBlob.toString('base64')} ${comment}\n`,
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`,
  };
}
