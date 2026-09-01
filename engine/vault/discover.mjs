// discover.mjs: the Secrets ledger. Every credential on this box, one row each.
//
// Why this exists. The vault deliberately sits BESIDE the legacy secret files
// (vault.mjs header says so), because start-comms.sh, backup.mjs, box-up.sh,
// catalog-sync.mjs and panel-server.mjs all read them by literal path. That is a
// sound engineering decision and it produced a bad member experience: the Secrets
// page said "Nothing stored yet" while the box was holding a Telegram bot token, a
// code-server password and a backup passphrase. The member concluded the page was
// broken, or worse, that they had no secrets to worry about.
//
// R7 (panel iteration 2, 2026-08-23) makes this the ONE list: vault entries, the
// legacy secrets/* files, the Claude sign-in, the GitHub login, the member's own
// Google key, every MCP OAuth entry, and any bearer header sitting in .mcp.json.
// Read-only. Each row says what the thing is, who on the box uses it, and where
// the member goes to revoke it (R8: Disconnect on Connections destroys the
// credential on the box; the grant at the provider is theirs to revoke there).
//
// THIS MODULE NEVER RETURNS A SECRET VALUE. Not truncated, not masked, not hashed.
// It reports that a thing exists, where it lives, and whether it looks set. The
// values would otherwise cross the panel transport and land in a browser, which is
// exactly what the vault exists to avoid. The only content-derived fact emitted is
// `set`, a boolean from a length check (and, for the Google row, the email the
// file is named after, which the member typed into the wizard themselves).
//
// Row contract (the page renders these, nothing else):
//   name    machine name, unique within the list
//   label   human name, sentence case
//   what    one line: what it is and who uses it
//   where   path relative to the state dir (or a plain-words location), for the hover
//   set     boolean: holds something non-empty
//   kind    'sign-in' | 'connection' | 'channel' | 'backup' | 'platform' | 'vault'
//   revoke  { via: 'connections' | 'seat' | 'telegram' | 'none', key?: <mcp key> }
//           connections = the Connections page (Disconnect, R8), key = its row
//           seat        = Your pebble / Your rock (sign-in, GitHub custody)
//           telegram    = the Telegram section of Your assistant
//           none        = the box's own plumbing; nothing for the member to revoke
//   updated ISO date of the file's last change, or null
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { connectionLabel } from '../lib/connection-labels.mjs';
import { listSecrets } from './vault.mjs';

// Files under <state>/secrets/ that are not member credentials at all.
const NOT_A_SECRET = new Set(['vault', '.gitignore', '.gitkeep', 'README.md']);

const NONE = { via: 'none' };
const TELEGRAM = { via: 'telegram' };
const SEAT = { via: 'seat' };

// What each known legacy file actually is, in the member's terms, written from
// the code that reads it (the "used by" half names that code's job). An unknown
// file still gets listed (better a vague row than a silent one), just without a
// gloss. Keys are the exact filenames under secrets/.
const KNOWN = {
  'telegram_bot_token': { label: 'Telegram bot token', kind: 'channel', revoke: TELEGRAM,
    what: 'Lets your box talk to you on Telegram. Used by the Telegram bridge and your scheduled jobs.' },
  'telegram_chat_id': { label: 'Telegram chat', kind: 'channel', revoke: TELEGRAM,
    what: 'Which Telegram conversation your box replies in. Used by the Telegram bridge.' },
  'telegram_revoked': { label: 'Telegram, retired tokens', kind: 'channel', revoke: NONE,
    what: 'One-way fingerprints of the Telegram bot tokens you have disconnected, so a retired one cannot be reconnected. Read by the Telegram connect steps and at start-up.' },
  'telegram_revoke_salt': { label: 'Telegram, retired-token salt', kind: 'channel', revoke: NONE,
    what: 'Makes those fingerprints unique to this mineral, so no two boxes can be matched by them. Used whenever a Telegram token is retired or checked.' },
  'code-server-password': { label: 'Browser editor password', kind: 'platform', revoke: NONE,
    what: 'The password for opening your box in a browser. Used by the box at start-up.' },
  'backup_passphrase': { label: 'Backup passphrase', kind: 'backup', revoke: NONE,
    what: 'Encrypts your nightly backup before it leaves the box. Used by the backup job; you need it to restore.' },
  'backup_passphrase.escrowed': { label: 'Backup passphrase, escrow marker', kind: 'backup', revoke: NONE,
    what: 'A note that your backup passphrase has been saved to your own computer. Read by the backup job and the status update.' },
  'catalog_deploy_key': { label: 'Catalogue key', kind: 'platform', revoke: NONE,
    what: 'Lets your box pull shared content it is entitled to. Used by the catalogue sync job.' },
  'provisioning.env.local': { label: 'Set-up credentials', kind: 'platform', revoke: NONE,
    what: 'Set-up credentials from when this box was built. Used when a rock seeds a new organisation.' },
  'box_directory_token': { label: 'Directory token', kind: 'platform', revoke: NONE,
    what: 'Proves to the Crads-AI directory that this box is yours. Used by the device enrolment and status jobs.' },
  'box_reg_host': { label: 'Registered address', kind: 'platform', revoke: NONE,
    what: 'The name this box is registered under in the directory. Used by the enrolment job and the claim step.' },
  'owner_e': { label: 'Owner fingerprint', kind: 'platform', revoke: NONE,
    what: 'A one-way fingerprint of the owner account, so only your own devices can enrol. Used by the device enrolment job.' },
  'heartbeat_deploy_key': { label: 'Status key', kind: 'platform', revoke: NONE,
    what: 'Lets your mineral send its status update to your rock. Used by the status job.' },
  'heartbeat_deploy_key.pub': { label: 'Status key, public half', kind: 'platform', revoke: NONE,
    what: 'The shareable half of the status key. Published to your rock when this box is claimed.' },
  'heartbeat_deploy_key.reanchor': { label: 'Status key, pending move', kind: 'platform', revoke: NONE,
    what: 'A new status key waiting to take over when this box moves to another rock. Used by the re-anchor step.' },
  'org_brain_deploy_key': { label: 'Organisation brain key', kind: 'platform', revoke: NONE,
    what: 'Lets this rock write its organisation brain to its own GitHub repository. Used by the organisation brain sync.' },
  'org_inbox_deploy_key': { label: 'Organisation inbox key', kind: 'platform', revoke: NONE,
    what: 'Lets your mineral read what your rock shares with it. Used by the organisation sync job.' },
  'org_inbox_deploy_key.pub': { label: 'Organisation inbox key, public half', kind: 'platform', revoke: NONE,
    what: 'The shareable half of the organisation inbox key. Published to your rock when this box is claimed.' },
  'org_pull_token': { label: 'Organisation pull token', kind: 'platform', revoke: NONE,
    what: 'A short-lived token a rock uses to fetch its organisation from the directory. Cleared once the claim completes.' },
};

// A CREDENTIAL CAN BE A DIRECTORY (finding 108, 2026-08-13). This read every
// entry with readFileSync, and `.kernel/gh` is a directory: readFileSync throws
// EISDIR, the catch swallowed it into `false`, and so "GitHub access" reported
// NOT SET on EVERY rock, forever, no matter how connected GitHub was. Proven on
// a rock whose Custody card said "Backed up to github.com/…/qa-r2-gmail-brain"
// while Secrets, one page over, said the credential was not set.
//
// The catch stays, because unreadable-by-us is a real state (root-owned files,
// a race with a rotation) and must read as not-set rather than crash the page.
// It simply must not turn "this is a directory" into "this is missing".
const looksSet = (p) => {
  try {
    if (statSync(p).isDirectory()) {
      // set = it holds at least one non-empty file. gh keeps hosts.yml + config.yml
      // here; an empty directory is a real not-set (created, never populated).
      return readdirSync(p, { withFileTypes: true })
        .some((e) => e.isFile() && statSync(join(p, e.name)).size > 0);
    }
    return readFileSync(p, 'utf8').trim().length > 0;
  } catch { return false; }
};
const when = (p) => { try { return new Date(statSync(p).mtimeMs).toISOString().slice(0, 10); } catch { return null; } };
const rdJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// workspace-mcp names the file after the URL-quoted email (mcp-token.mjs
// set-google). Undo that quoting for the label; the email is the member's own
// input, not a secret.
const emailOf = (fname) => { try { return decodeURIComponent(fname.replace(/\.json$/, '')); } catch { return fname.replace(/\.json$/, ''); } };

export function discover(stateDir, env = process.env) {
  const found = [];
  const seen = new Set();
  const push = (row) => { if (!seen.has(row.name)) { seen.add(row.name); found.push(row); } };

  // 1. The vault's own entries. The vault never had a reader in production; the
  //    ledger is now that reader, metadata only (listSecrets carries no values).
  try {
    for (const s of listSecrets(stateDir)) {
      push({
        name: `vault:${s.name}`,
        label: s.label ? sentence(s.label) : sentence(s.name.replace(/-/g, ' ')),
        what: s.tier === 'cold'
          ? 'A secret you sealed to your own computers. This box cannot open it.'
          : `A secret you saved for your box to use while you are away${s.used_by?.length ? ` (used by ${s.used_by.join(', ')})` : ''}.`,
        where: `secrets/vault/${s.name}.json`,
        set: true,
        kind: 'vault',
        revoke: NONE,
        updated: s.updated ? String(s.updated).slice(0, 10) : when(join(stateDir, 'secrets', 'vault', `${s.name}.json`)),
        readable_by_box: s.tier !== 'cold',
      });
    }
  } catch { /* an unreadable vault dir is not a reason to report nothing */ }

  // 2. The legacy files the box's own scripts read by literal path.
  const secDir = join(stateDir, 'secrets');
  if (existsSync(secDir)) {
    for (const e of readdirSync(secDir, { withFileTypes: true })) {
      if (NOT_A_SECRET.has(e.name) || !e.isFile()) continue;
      const p = join(secDir, e.name);
      let k = KNOWN[e.name];
      // One status key per JOINED rock (panel iteration 2 R9): the file is named
      // after the rock, so the label is too.
      const joined = !k && /^heartbeat_deploy_key\.([A-Za-z0-9-]{1,39})$/.exec(e.name);
      if (joined) k = { label: `Status key for ${joined[1]}`, kind: 'platform', revoke: NONE,
        what: `Lets your mineral send its status update to ${joined[1]}, a rock you joined. Used by the status job; removed when that membership ends.` };
      push({
        name: e.name,
        label: k ? k.label : sentence(e.name.replace(/[_-]+/g, ' ')),
        what: k ? k.what : '',
        where: `secrets/${e.name}`,
        set: looksSet(p),
        kind: k ? k.kind : 'platform',
        revoke: k ? k.revoke : NONE,
        updated: when(p),
        // Honest about the tier, since the page next to this one makes a promise
        // about cold secrets that these do not keep.
        readable_by_box: true,
      });
    }
  }

  // 3. Credentials that live outside secrets/ entirely. Named individually rather
  //    than by a directory walk: a walk over /state would sweep up the brain.
  for (const [rel, name, label, what, kind, revoke] of [
    ['.claude-auth/.credentials.json', 'claude-sign-in', 'Claude sign-in',
      'The account your box uses to think. Used by every job and chat; signing in again replaces it.', 'sign-in', SEAT],
    ['.kernel/gh', 'github-access', 'GitHub access',
      'Lets your box push your brain to your own GitHub. Used by the backup job and the custody card.', 'backup', SEAT],
  ]) {
    const p = join(stateDir, rel);
    if (!existsSync(p)) continue;
    push({ name, label, what, where: rel, set: looksSet(p), kind, revoke, updated: when(p), readable_by_box: true });
  }

  // 4. The member's own Google key: one file per signed-in email, written by
  //    mcp-token.mjs set-google, read by workspace-mcp for the google connection.
  const gdir = join(stateDir, '.kernel', 'google-creds');
  if (existsSync(gdir)) {
    try {
      for (const e of readdirSync(gdir, { withFileTypes: true })) {
        if (!e.isFile() || !e.name.endsWith('.json')) continue;
        const email = emailOf(e.name);
        push({
          name: `google-creds:${email}`,
          label: `Google Workspace (${email})`,
          what: 'Your own Google key and sign-in, used by the Google connection and its jobs.',
          where: `.kernel/google-creds/${e.name}`,
          set: looksSet(join(gdir, e.name)),
          kind: 'connection',
          revoke: { via: 'connections', key: 'google' },
          updated: when(join(gdir, e.name)),
          readable_by_box: true,
        });
      }
    } catch { /* unreadable dir reads as nothing there */ }
  }

  // 5. MCP OAuth refresh material, one entry per connection (mcp-token.mjs set).
  //    The google entry there is a clock, not a credential: its key is the file
  //    above, so it is skipped here rather than listed twice.
  const oauthF = join(stateDir, '.kernel', 'mcp-oauth.json');
  const store = rdJSON(oauthF);
  if (store && typeof store === 'object') {
    for (const [k, v] of Object.entries(store)) {
      if (!v || typeof v !== 'object' || v.provider === 'google-byo') continue;
      push({
        name: `oauth:${k}`,
        label: `${connectionLabel(k)} sign-in`,
        what: `The sign-in that keeps your ${connectionLabel(k)} connection renewed. Used by that connection and the jobs that call it.`,
        where: `.kernel/mcp-oauth.json (${k})`,
        set: !!(v.refresh_token || v.client_secret),
        kind: 'connection',
        revoke: { via: 'connections', key: k },
        updated: v.updated_at ? new Date(v.updated_at).toISOString().slice(0, 10) : when(oauthF),
        readable_by_box: true,
      });
    }
  }

  // 6. .mcp.json: bearer headers (presence only) and ${VAR} refs. A header is a
  //    credential sitting in the file itself (mcp-connect add-custom with a token,
  //    or mcp-token set). A ref is one the box expects from the environment, and
  //    those break a connection silently: the server is configured, the variable
  //    is not set, and nothing says so until a skill fails.
  const mcp = rdJSON(join(stateDir, '.mcp.json'));
  if (mcp && typeof mcp === 'object') {
    const servers = mcp.mcpServers && typeof mcp.mcpServers === 'object' ? mcp.mcpServers : {};
    for (const [k, def] of Object.entries(servers)) {
      const headers = def?.headers && typeof def.headers === 'object' ? def.headers : {};
      const auth = Object.keys(headers).find((h) => /^authorization$/i.test(h));
      if (!auth) continue;
      push({
        name: `bearer:${k}`,
        label: `${connectionLabel(k)} access token`,
        what: `The token your ${connectionLabel(k)} connection sends with every request. Used by that connection and the jobs that call it.`,
        where: `.mcp.json (${k})`,
        set: typeof headers[auth] === 'string' && headers[auth].trim().length > 0,
        kind: 'connection',
        revoke: { via: 'connections', key: k },
        updated: when(join(stateDir, '.mcp.json')),
        readable_by_box: true,
      });
    }
    const refs = new Map();
    for (const [k, def] of Object.entries(servers)) {
      for (const m of JSON.stringify(def || {}).matchAll(/\$\{([A-Z0-9_]+)\}/g)) if (!refs.has(m[1])) refs.set(m[1], k);
    }
    for (const [v, k] of refs) {
      push({
        name: v,
        label: `${connectionLabel(k)} credential (${v})`,
        what: `Your ${connectionLabel(k)} connection asks for this by name from the box's environment. Used by that connection and the jobs that call it.`,
        where: 'expected by a connection, from the environment',
        set: !!env[v],
        kind: 'connection',
        revoke: { via: 'connections', key: k },
        updated: null,
        readable_by_box: true,
      });
    }
  }

  return found.sort((a, b) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name));
}
