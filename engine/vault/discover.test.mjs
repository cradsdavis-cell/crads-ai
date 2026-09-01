// discover.test.mjs
//
// The load-bearing test here is the canary one. discover() runs over files that ARE
// secrets and its output crosses the panel transport into a browser, so a refactor
// that starts including content (a preview, a mask, a "first 4 characters" nicety)
// would quietly turn a listing feature into a leak. Every value below is a canary,
// and the test asserts none of them appear anywhere in the serialised output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { discover } from './discover.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const CANARIES = {
  tg: 'TG-CANARY-8f3a2b1c',
  pw: 'PW-CANARY-77d1e9aa',
  unknown: 'UNKNOWN-CANARY-x1',
  gh: 'GH-CANARY-4b2',
  auth: 'AUTH-CANARY-9z',
  vaulted: 'VAULT-CANARY-should-not-appear',
};

function box() {
  const d = tmpDir('discover-');
  mkdirSync(join(d, 'secrets', 'vault'), { recursive: true });
  mkdirSync(join(d, '.claude-auth'), { recursive: true });
  mkdirSync(join(d, '.kernel'), { recursive: true });
  writeFileSync(join(d, 'secrets', 'telegram_bot_token'), CANARIES.tg);
  writeFileSync(join(d, 'secrets', 'code-server-password'), CANARIES.pw);
  writeFileSync(join(d, 'secrets', 'backup_passphrase'), '   \n');       // present but empty
  writeFileSync(join(d, 'secrets', 'some-other-thing'), CANARIES.unknown);
  writeFileSync(join(d, 'secrets', 'vault', 'gmail-token.json'), JSON.stringify({ tier: 'hot', label: 'Gmail token', value: CANARIES.vaulted, used_by: ['morning'] }));
  writeFileSync(join(d, '.kernel', 'gh'), CANARIES.gh);
  writeFileSync(join(d, '.claude-auth', '.credentials.json'), CANARIES.auth);
  writeFileSync(join(d, '.mcp.json'), JSON.stringify({
    mcpServers: {
      todoist: { env: { TODOIST_API_TOKEN: '${TODOIST_API_TOKEN}' } },
      google: { env: { GOOGLE_OAUTH_CLIENT_SECRET: '${GOOGLE_OAUTH_CLIENT_SECRET}' } },
    },
  }));
  return d;
}

test('discover NEVER emits a secret value, from any source', () => {
  const d = box();
  try {
    const out = JSON.stringify(discover(d, { TODOIST_API_TOKEN: 'set' }));
    for (const [which, value] of Object.entries(CANARIES)) {
      assert.equal(out.includes(value), false, `${which} canary leaked into discover() output`);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('finds the legacy files the box reads by literal path', () => {
  const d = box();
  try {
    const names = discover(d, {}).map((f) => f.name);
    for (const n of ['telegram_bot_token', 'code-server-password', 'backup_passphrase', 'some-other-thing']) {
      assert.ok(names.includes(n), `missing ${n}`);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('an unknown filename is still listed, just without a gloss', () => {
  const d = box();
  try {
    const row = discover(d, {}).find((f) => f.name === 'some-other-thing');
    assert.ok(row, 'an unrecognised credential must not be silently dropped');
    assert.equal(row.what, '');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the vault dir is not walked as legacy files: a vault entry appears once, as a vault row', () => {
  const d = box();
  try {
    const rows = discover(d, {}).filter((f) => /gmail-token|^vault$/.test(f.name));
    assert.equal(rows.length, 1, 'one row per vault entry, never a second one from the folder walk');
    assert.equal(rows[0].name, 'vault:gmail-token');
    assert.equal(rows[0].kind, 'vault');
    assert.equal(rows[0].revoke.via, 'none');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('set is honest: an empty file reads as not set', () => {
  const d = box();
  try {
    const rows = discover(d, {});
    assert.equal(rows.find((f) => f.name === 'backup_passphrase').set, false);
    assert.equal(rows.find((f) => f.name === 'telegram_bot_token').set, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('an MCP credential ref reports whether the environment actually supplies it', () => {
  const d = box();
  try {
    const rows = discover(d, { TODOIST_API_TOKEN: 'yes' });
    assert.equal(rows.find((f) => f.name === 'TODOIST_API_TOKEN').set, true);
    // The silent-breakage case: a server is configured, the variable is not set,
    // and nothing anywhere says so until a skill fails at 3am.
    assert.equal(rows.find((f) => f.name === 'GOOGLE_OAUTH_CLIENT_SECRET').set, false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a box with nothing to find returns an empty list rather than throwing', () => {
  const d = tmpDir('discover-bare-');
  try { assert.deepEqual(discover(d, {}), []); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('a malformed .mcp.json does not sink the whole scan', () => {
  const d = box();
  try {
    writeFileSync(join(d, '.mcp.json'), '{ not json');
    const names = discover(d, {}).map((f) => f.name);
    assert.ok(names.includes('telegram_bot_token'), 'file scan must survive a bad .mcp.json');
    assert.equal(names.includes('TODOIST_API_TOKEN'), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// --- finding 108: a credential can be a DIRECTORY ---------------------------
//
// looksSet read every entry with readFileSync. In production `.kernel/gh` is a
// DIRECTORY (gh keeps hosts.yml + config.yml in it), readFileSync throws EISDIR,
// and the catch swallowed that into `false`. So "GitHub access" reported NOT SET
// on every rock forever, however connected GitHub was: proven on a rock whose
// Custody card read "Backed up to github.com/…/qa-r2-gmail-brain" while Secrets,
// one page over, said the credential was not set.
//
// NOTE ON THE FIXTURE ABOVE: box() writes `.kernel/gh` as a FILE, which is not
// what the product creates. That is why this survived — the shape under test
// disagreed with the shape in production. These use the real shape.
function boxWithGhDir({ populated = true } = {}) {
  const d = tmpDir('discover-ghdir-');
  mkdirSync(join(d, 'secrets'), { recursive: true });
  mkdirSync(join(d, '.kernel', 'gh'), { recursive: true });
  if (populated) {
    writeFileSync(join(d, '.kernel', 'gh', 'hosts.yml'), 'github.com:\n  oauth_token: GH-DIR-CANARY\n');
    writeFileSync(join(d, '.kernel', 'gh', 'config.yml'), 'version: 1\n');
  }
  return d;
}
const ghRow = (d) => discover(d, {}).find((f) => f.name === 'github-access');

test('108: a populated gh config DIRECTORY reads as set', () => {
  const row = ghRow(boxWithGhDir());
  assert.ok(row, 'the GitHub access row must still be discovered');
  assert.equal(row.set, true, 'a directory holding a non-empty hosts.yml is connected');
});

test('108: an EMPTY gh directory is still honestly not-set', () => {
  const row = ghRow(boxWithGhDir({ populated: false }));
  assert.ok(row, 'the row is still discovered');
  assert.equal(row.set, false, 'created but never populated is a real not-set');
});

test('108: reading a directory still never leaks its contents', () => {
  const d = boxWithGhDir();
  assert.doesNotMatch(JSON.stringify(discover(d, {})), /GH-DIR-CANARY/,
    'discover must never emit a secret value, directory-shaped or not');
});

// --- R7 (2026-08-23): the ledger lists EVERY credential store on the box -----
//
// The sources discover() used to miss: the member's own Google key file, the
// MCP OAuth refresh entries, and a bearer header sitting inside .mcp.json. Each
// gets its own fixture; each fixture carries a canary; none may leak.
const R7 = {
  grefresh: 'GREFRESH-CANARY-1a',
  gsecret: 'GSECRET-CANARY-2b',
  nrefresh: 'NREFRESH-CANARY-3c',
  bearer: 'BEARER-CANARY-4d',
  hb: 'HBKEY-CANARY-5e',
};
function ledgerBox() {
  const d = tmpDir('discover-r7-');
  mkdirSync(join(d, 'secrets'), { recursive: true });
  mkdirSync(join(d, '.kernel', 'google-creds'), { recursive: true });
  writeFileSync(join(d, '.kernel', 'google-creds', 'jane%2Bwork@gmail.com.json'), JSON.stringify({
    token: '', refresh_token: R7.grefresh, client_id: 'x.apps.googleusercontent.com', client_secret: R7.gsecret,
  }));
  writeFileSync(join(d, '.kernel', 'mcp-oauth.json'), JSON.stringify({
    google: { provider: 'google-byo', email: 'jane+work@gmail.com', keyed_at: 1, creds_file: join(d, '.kernel', 'google-creds', 'jane%2Bwork@gmail.com.json') },
    notion: { url: 'https://mcp.notion.com/mcp', refresh_token: R7.nrefresh, client_id: 'c', updated_at: Date.UTC(2026, 7, 20) },
    'youtube-transcript': { url: 'https://yt.example/mcp', refresh_token: null, client_secret: null },
  }));
  writeFileSync(join(d, '.mcp.json'), JSON.stringify({
    mcpServers: {
      stripe: { type: 'http', url: 'https://mcp.stripe.com', headers: { Authorization: `Bearer ${R7.bearer}` } },
      notion: { type: 'http', url: 'https://mcp.notion.com/mcp' },
      todoist: { env: { TODOIST_API_TOKEN: '${TODOIST_API_TOKEN}' } },
    },
  }));
  for (const n of ['heartbeat_deploy_key', 'heartbeat_deploy_key.pub', 'org_inbox_deploy_key', 'box_directory_token',
    'box_reg_host', 'owner_e', 'org_brain_deploy_key', 'org_pull_token', 'backup_passphrase.escrowed', 'heartbeat_deploy_key.reanchor', 'org_inbox_deploy_key.pub']) {
    writeFileSync(join(d, 'secrets', n), R7.hb);
  }
  return d;
}
const withLedger = (fn) => { const d = ledgerBox(); try { return fn(d, discover(d, {})); } finally { rmSync(d, { recursive: true, force: true }); } };

test('R7: no value from any of the new sources leaks, either', () => withLedger((d, rows) => {
  const out = JSON.stringify(rows);
  for (const [which, value] of Object.entries(R7)) assert.equal(out.includes(value), false, `${which} canary leaked`);
}));

test('R7: every row carries the full contract', () => withLedger((d, rows) => {
  assert.ok(rows.length > 10);
  const kinds = new Set(['sign-in', 'connection', 'channel', 'backup', 'platform', 'vault']);
  const vias = new Set(['connections', 'seat', 'telegram', 'none']);
  for (const r of rows) {
    for (const f of ['name', 'label', 'what', 'where', 'set', 'kind', 'revoke']) assert.ok(f in r, `${r.name} lacks ${f}`);
    assert.ok(kinds.has(r.kind), `${r.name}: kind ${r.kind}`);
    assert.ok(vias.has(r.revoke.via), `${r.name}: revoke.via ${r.revoke.via}`);
    assert.equal(typeof r.set, 'boolean');
    assert.equal(r.label, r.label.charAt(0).toUpperCase() + r.label.slice(1), `${r.name}: label not sentence case`);
    assert.doesNotMatch(r.label + r.what, /—/, `${r.name}: em dash`);
    if (r.revoke.via === 'connections') assert.ok(r.revoke.key, `${r.name}: connections revoke needs a key`);
  }
  assert.equal(new Set(rows.map((r) => r.name)).size, rows.length, 'names are unique');
}));

test('R7: the Google key file is one row per email, revoked on Connections under google', () => withLedger((d, rows) => {
  const g = rows.find((r) => r.name === 'google-creds:jane+work@gmail.com');
  assert.ok(g, 'the google-creds file must be listed');
  assert.equal(g.label, 'Google Workspace (jane+work@gmail.com)');
  assert.equal(g.what, 'Your own Google key and sign-in, used by the Google connection and its jobs.');
  assert.equal(g.kind, 'connection');
  assert.deepEqual(g.revoke, { via: 'connections', key: 'google' });
  assert.equal(g.set, true);
  assert.equal(g.where, '.kernel/google-creds/jane%2Bwork@gmail.com.json');
  // the oauth store's google entry is a clock pointing at that file, not a second credential
  assert.equal(rows.some((r) => r.name === 'oauth:google'), false, 'google must not be listed twice');
}));

test('R7: each MCP OAuth entry is a row, labelled by connectionLabel, set only when it holds refresh material', () => withLedger((d, rows) => {
  const n = rows.find((r) => r.name === 'oauth:notion');
  assert.ok(n);
  assert.equal(n.label, 'Notion sign-in');
  assert.deepEqual(n.revoke, { via: 'connections', key: 'notion' });
  assert.equal(n.set, true);
  assert.equal(n.updated, '2026-08-20');
  const y = rows.find((r) => r.name === 'oauth:youtube-transcript');
  assert.ok(y, 'an unknown key is still listed');
  assert.equal(y.label, 'Youtube Transcript sign-in', 'never the raw key');
  assert.equal(y.set, false, 'an entry with no refresh token or secret is honestly not set');
}));

test('R7: a bearer header in .mcp.json is a row, presence only', () => withLedger((d, rows) => {
  const b = rows.find((r) => r.name === 'bearer:stripe');
  assert.ok(b);
  assert.equal(b.set, true);
  assert.equal(b.kind, 'connection');
  assert.deepEqual(b.revoke, { via: 'connections', key: 'stripe' });
  assert.equal(rows.some((r) => r.name === 'bearer:notion'), false, 'a server with no header has no bearer row');
  const ref = rows.find((r) => r.name === 'TODOIST_API_TOKEN');
  assert.deepEqual(ref.revoke, { via: 'connections', key: 'todoist' }, 'an env ref points at the connection that asks for it');
}));

test('R7: every legacy name has a gloss and a kind; telegram rows revoke on Telegram', () => withLedger((d, rows) => {
  for (const n of ['heartbeat_deploy_key', 'heartbeat_deploy_key.pub', 'heartbeat_deploy_key.reanchor', 'org_inbox_deploy_key',
    'org_inbox_deploy_key.pub', 'box_directory_token', 'box_reg_host', 'owner_e', 'org_brain_deploy_key', 'org_pull_token', 'backup_passphrase.escrowed']) {
    const r = rows.find((x) => x.name === n);
    assert.ok(r, `missing ${n}`);
    assert.notEqual(r.what, '', `${n} has no gloss`);
    assert.equal(r.revoke.via, 'none');
    assert.equal(r.where, `secrets/${n}`);
  }
  assert.equal(rows.find((x) => x.name === 'heartbeat_deploy_key').what, 'Lets your mineral send its status update to your rock. Used by the status job.');
  assert.equal(rows.find((x) => x.name === 'backup_passphrase.escrowed').kind, 'backup');
}));

test('R7: channel and sign-in rows point at where revoke lives', () => {
  const d = box();
  try {
    const rows = discover(d, {});
    assert.deepEqual(rows.find((r) => r.name === 'telegram_bot_token').revoke, { via: 'telegram' });
    assert.equal(rows.find((r) => r.name === 'telegram_bot_token').kind, 'channel');
    assert.deepEqual(rows.find((r) => r.name === 'claude-sign-in').revoke, { via: 'seat' });
    assert.equal(rows.find((r) => r.name === 'claude-sign-in').kind, 'sign-in');
    assert.equal(rows.find((r) => r.name === 'github-access').kind, 'backup');
    const cold = join(d, 'secrets', 'vault', 'cold-one.json');
    writeFileSync(cold, JSON.stringify({ tier: 'cold', envelope: { wraps: [{ fingerprint: 'f' }], ct: 'SEALED-CANARY' } }));
    const c = discover(d, {}).find((r) => r.name === 'vault:cold-one');
    assert.equal(c.readable_by_box, false);
    assert.doesNotMatch(JSON.stringify(discover(d, {})), /SEALED-CANARY/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// The revoke-hardening branch put two new files under secrets/ (2026-08-26).
// Anything unknown still gets a row, so they were never invisible, they were
// unlabelled: two bare filenames in a member-facing list of their own
// credentials, with no way to tell what they are or whether it is safe to
// delete them.
test('the retired-token files read as Telegram housekeeping, not as unlabelled mystery rows', () => {
  const d = box();
  try {
    writeFileSync(join(d, 'secrets', 'telegram_revoked'), 'a'.repeat(64));
    writeFileSync(join(d, 'secrets', 'telegram_revoke_salt'), 'b'.repeat(64));
    const rows = discover(d, {});
    for (const n of ['telegram_revoked', 'telegram_revoke_salt']) {
      const r = rows.find((x) => x.name === n);
      assert.ok(r, `${n} is listed`);
      assert.match(r.label, /^Telegram, /, `${n} names itself in the member's terms`);
      assert.notEqual(r.label, n, `${n} must not fall back to the bare filename`);
      assert.ok(r.what && r.what.length > 20, `${n} says what it is for`);
      assert.equal(r.kind, 'channel', 'they belong with the Telegram credentials');
      // Neither is a credential anyone can revoke: they are the record OF a revoke.
      assert.deepEqual(r.revoke, { via: 'none' });
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('R7: a malformed oauth store or an unreadable creds dir does not sink the scan', () => {
  const d = ledgerBox();
  try {
    writeFileSync(join(d, '.kernel', 'mcp-oauth.json'), '{ nope');
    const rows = discover(d, {});
    assert.ok(rows.find((r) => r.name === 'bearer:stripe'));
    assert.ok(rows.find((r) => r.name.startsWith('google-creds:')));
    assert.equal(rows.some((r) => r.name.startsWith('oauth:')), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Panel iteration 2 R9: one status key per JOINED rock, named after the rock.
test('a heartbeat_deploy_key.<rock> file is labelled as that rock\'s status key, not a raw filename', () => {
  const d = tmpDir('vault-r9-');
  try {
    mkdirSync(join(d, 'secrets'), { recursive: true });
    writeFileSync(join(d, 'secrets', 'heartbeat_deploy_key.rock-one'), '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n');
    const row = discover(d, {}).find((r) => r.name === 'heartbeat_deploy_key.rock-one');
    assert.ok(row);
    assert.equal(row.label, 'Status key for rock-one');
    assert.match(row.what, /a rock you joined/);
    assert.equal(row.kind, 'platform');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
