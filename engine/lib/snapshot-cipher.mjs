// snapshot-cipher.mjs: the ONE place the backup snapshot's cipher is spelled.
//
// engine/backup.mjs encrypts the nightly snapshot with openssl and engine/restore.mjs
// decrypts it on a new mineral. If the two ever disagreed on a single flag (the
// iteration count, pbkdf2, the cipher) every snapshot in every member's repository
// would be unopenable by the tool written to open it, and nothing would say so until
// the day somebody needed it. So both import these arguments instead of each typing
// them out. restore.test.mjs runs the real backup.mjs and the real restore.mjs
// against each other, which is the check that this sharing is not just tidy.
//
// The passphrase always travels in the environment (`-pass env:...`), never on the
// command line, where any process listing on the box could read it.

export const PASS_ENV = 'AIOS_BACKUP_PASSPHRASE';
export const CIPHER_ARGS = ['-aes-256-cbc', '-pbkdf2', '-iter', '200000'];

/** openssl argv to encrypt `inPath` to `outPath` (fresh random salt each time). */
export const encryptArgs = (inPath, outPath) =>
  ['enc', ...CIPHER_ARGS, '-salt', '-in', inPath, '-out', outPath, '-pass', `env:${PASS_ENV}`];

/** openssl argv to decrypt `inPath` to `outPath`. */
export const decryptArgs = (inPath, outPath) =>
  ['enc', '-d', ...CIPHER_ARGS, '-in', inPath, '-out', outPath, '-pass', `env:${PASS_ENV}`];
