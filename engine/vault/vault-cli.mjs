#!/usr/bin/env node
// vault-cli.mjs: the box-side command surface for the secret store. The panel's
// member verbs shell out to exactly this.
//
// SECRET VALUES ARRIVE ON STDIN, NEVER IN ARGV. A value in argv would show up in
// the process list, in shell history, and in any command log the transport keeps,
// which is the same class of mistake as pasting it into a chat window.
//
//   node vault-cli.mjs <stateDir> list                       -> {secrets:[...]}  (no values)
//   node vault-cli.mjs <stateDir> discover                   -> {found:[...]}    (credentials the vault does NOT manage; metadata only, never values)
//   node vault-cli.mjs <stateDir> envelopes                  -> {secrets:[...]}  (cold envelopes, for the app to open)
//   node vault-cli.mjs <stateDir> put-hot  <name> [label]    <- value on stdin
//   node vault-cli.mjs <stateDir> put-cold <name> [label]    <- sealed envelope JSON on stdin
//   node vault-cli.mjs <stateDir> get-hot  <name>            -> the value (hot only)
//   node vault-cli.mjs <stateDir> remove   <name>
import { readFileSync } from 'node:fs';
import { listSecrets, getHot, putHot, putCold, removeSecret } from './vault.mjs';
import { discover } from './discover.mjs';

const die = (msg) => { console.error(msg); process.exit(1); };
const stdin = () => { try { return readFileSync(0, 'utf8'); } catch { return ''; } };

const stateDir = process.argv[2] || '/state';
const cmd = process.argv[3] || 'list';
const [name, label] = process.argv.slice(4);

try {
  if (cmd === 'list') {
    console.log(JSON.stringify({ secrets: listSecrets(stateDir) }, null, 2));
  } else if (cmd === 'discover') {
    console.log(JSON.stringify({ found: discover(stateDir) }, null, 2));
  } else if (cmd === 'envelopes') {
    console.log(JSON.stringify({ secrets: listSecrets(stateDir, { withEnvelopes: true }) }, null, 2));
  } else if (cmd === 'put-hot') {
    const value = stdin().replace(/\n$/, '');
    if (!value.trim()) die('ERROR: that secret is empty, so nothing was saved.');
    putHot(stateDir, name, value, { label: label || '' });
    console.log(`OK: saved "${name}". Your box can use this while you are away, which means Crads AI could read it with server access.`);
  } else if (cmd === 'put-cold') {
    const raw = stdin().trim();
    if (!raw) die('ERROR: that secret is empty, so nothing was saved.');
    let envelope;
    try { envelope = JSON.parse(raw); } catch { die('ERROR: that sealed secret is malformed, so nothing was saved.'); }
    putCold(stateDir, name, envelope, { label: label || '' });
    console.log(`OK: saved "${name}", sealed to your own computers. This box cannot open it, and neither can Crads AI.`);
  } else if (cmd === 'get-hot') {
    console.log(getHot(stateDir, name));
  } else if (cmd === 'remove') {
    console.log(removeSecret(stateDir, name)
      ? `OK: deleted "${name}".`
      : `OK: nothing called "${name}" was stored, so nothing changed.`);
  } else {
    die(`ERROR: unknown command "${cmd}".`);
  }
} catch (e) {
  die((e && e.userFacing) ? `ERROR: ${e.message}` : `ERROR: ${e?.message || 'that did not work'}`);
}
