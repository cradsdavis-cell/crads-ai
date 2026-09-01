#!/usr/bin/env node
// commons-admin.mjs: the rock owner's side of the commons-repo model
// (self-host pivot, 2026-09-01; docs/self-host-design.md section 3).
//
//   node commons-admin.mjs <state-dir> <brain-root> init      (JSON on stdin)
//   node commons-admin.mjs <state-dir> <brain-root> status
//   node commons-admin.mjs <state-dir> <brain-root> grant     (JSON on stdin)
//   node commons-admin.mjs <state-dir> <brain-root> revoke <grant-id>
//   node commons-admin.mjs <state-dir> <brain-root> roster
//   node commons-admin.mjs <state-dir> <brain-root> bundle
//
// init records where this rock's commons lives: <state>/commons.conf carries
// URL, BRANCH, ORG and ORG_DISPLAY (validated fields, regex-readable, never
// sourced as shell), and an optional deploy key lands 0600 at
// <state>/secrets/commons_deploy_key. Everything arrives as JSON on stdin,
// base64 through the verb layer, so nothing typed can reach the shell.
//
// grant/revoke keep the ROSTER: a rock-local ledger of who was handed a join
// bundle, living in the rock's own brain (registry/commons-roster.json, so it
// rides the org's own backup), NEVER in the commons repo. The commons holds
// no member data by construction. A grant mints the member's join bundle; for
// a private GitHub commons the owner must also invite the member's GitHub
// account as a read collaborator, and the copy says so every time. Revoking
// marks the ledger row and tells the owner to remove the host access; the
// member keeps what they installed (standing ruling).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BRANCH_RE, ORG_RE, allowFileFromEnv, mintBundle, readCommonsConf, validGitUrl } from './commons-lib.mjs';

const [state, brain, cmd, arg] = process.argv.slice(2).map((s) => String(s || ''));
const die = (msg) => { console.log(`ERROR: ${msg}`); process.exit(1); };
if (!state || !brain || !cmd) die('usage: commons-admin <state-dir> <brain-root> <init|status|grant|revoke|roster|bundle> [id]');

const CONF = path.join(state, 'commons.conf');
const KEY = path.join(state, 'secrets', 'commons_deploy_key');
const ROSTER = path.join(brain, 'registry', 'commons-roster.json');
const PUBSTATE = path.join(state, 'commons-publish.json');

// eslint-disable-next-line no-control-regex
const clean = (s, max) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);
const readConf = () => readCommonsConf(state);

function readRoster() {
  try {
    const j = JSON.parse(readFileSync(ROSTER, 'utf8'));
    if (j && Array.isArray(j.grants)) return j;
  } catch { /* absent: starts empty */ }
  return { grants: [] };
}
function writeRoster(r) {
  mkdirSync(path.dirname(ROSTER), { recursive: true });
  const tmp = `${ROSTER}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(r, null, 2) + '\n');
  renameSync(tmp, ROSTER);
}
const readStdinJson = () => {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
  try { const j = JSON.parse(raw); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
};
const isGithub = (url) => {
  const v = validGitUrl(url, { allowFile: allowFileFromEnv() });
  return v.ok && (v.host === 'github.com' || (v.host || '').endsWith('.github.com'));
};
const inviteReminder = (url) => (isGithub(url)
  ? 'For a private GitHub commons, also invite their GitHub account as a READ collaborator on the repo (Settings, Collaborators); the bundle alone does not grant repository access.'
  : 'If the commons repository is private, also grant their account read access on your git host; the bundle alone does not grant repository access.');

if (cmd === 'init') {
  const j = readStdinJson();
  if (!j) die('init needs a JSON body on stdin');
  const url = clean(j.url, 300);
  if (!validGitUrl(url, { allowFile: allowFileFromEnv() }).ok) die('url must be an https, ssh or git repository URL (for example https://github.com/your-org/your-commons)');
  const org = clean(j.org, 40).toLowerCase();
  if (!ORG_RE.test(org)) die('community name must be 2-38 lowercase letters, digits or hyphens (this is the name members see)');
  const branch = clean(j.branch, 100);
  if (branch && !BRANCH_RE.test(branch)) die('branch must be a plain branch name');
  const display = clean(j.org_display, 64) || org;
  const key = typeof j.key === 'string' ? j.key.replace(/\r/g, '') : '';
  if (key) {
    if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----\n[\s\S]+-----END [A-Z ]*PRIVATE KEY-----\n?$/.test(key)) {
      die('that does not look like a private deploy key (expected a BEGIN/END PRIVATE KEY block). Leave it empty to use this rock\'s own GitHub sign-in instead.');
    }
    mkdirSync(path.dirname(KEY), { recursive: true });
    writeFileSync(`${KEY}.tmp`, key.endsWith('\n') ? key : key + '\n', { mode: 0o600 });
    renameSync(`${KEY}.tmp`, KEY);
  }
  const conf = `URL=${url}\n` + (branch ? `BRANCH=${branch}\n` : '') + `ORG=${org}\nORG_DISPLAY=${display}\n`;
  mkdirSync(state, { recursive: true });
  writeFileSync(`${CONF}.tmp`, conf);
  renameSync(`${CONF}.tmp`, CONF);
  console.log(`OK: this rock's commons is ${url}${branch ? ` (branch ${branch})` : ''}, shared as "${display}" (${org}).${key ? ' Deploy key saved.' : ''}`);
  console.log('Publish puts your catalogue there; grants hand members their join bundle.');
  process.exit(0);
}

if (cmd === 'status') {
  const conf = readConf();
  const roster = readRoster();
  let pub = null;
  try { pub = JSON.parse(readFileSync(PUBSTATE, 'utf8')); } catch { /* never published */ }
  process.stdout.write('COMMONS_STATE ' + JSON.stringify({
    configured: !!conf,
    ...(conf || {}),
    key_present: existsSync(KEY),
    roster: {
      active: roster.grants.filter((g) => g && g.status === 'active').length,
      revoked: roster.grants.filter((g) => g && g.status === 'revoked').length,
    },
    last_publish: pub,
  }) + '\n');
  process.exit(0);
}

if (cmd === 'roster') {
  process.stdout.write('ROSTER_STATE ' + JSON.stringify(readRoster()) + '\n');
  process.exit(0);
}

if (cmd === 'bundle') {
  const conf = readConf();
  if (!conf) die('no commons is configured yet. Run commons init first.');
  console.log(mintBundle({ org: conf.org, org_display: conf.org_display, url: conf.url, ...(conf.branch ? { branch: conf.branch } : {}) }));
  console.log(inviteReminder(conf.url));
  process.exit(0);
}

if (cmd === 'grant') {
  const conf = readConf();
  if (!conf) die('no commons is configured yet. Run commons init first.');
  const j = readStdinJson();
  if (!j) die('grant needs a JSON body on stdin');
  const label = clean(j.label, 80);
  if (!label) die('a grant needs a label: the name you know this member by');
  const email = clean(j.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) die('that email does not look like an email address (it is optional; leave it out if unsure)');
  const github = clean(j.github, 40);
  if (github && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(github)) die('that GitHub handle does not look like a GitHub username (it is optional; leave it out if unsure)');
  const roster = readRoster();
  const id = 'g-' + Math.random().toString(36).slice(2, 10);
  roster.grants.push({
    id, label, ...(email ? { email } : {}), ...(github ? { github } : {}),
    issued: new Date().toISOString(), status: 'active',
  });
  writeRoster(roster);
  const bundle = mintBundle({ org: conf.org, org_display: conf.org_display, url: conf.url, ...(conf.branch ? { branch: conf.branch } : {}) });
  console.log(`OK: grant ${id} recorded for ${label}. Hand them this bundle out of band (a message, not a public post):`);
  console.log(bundle);
  console.log(inviteReminder(conf.url));
  process.exit(0);
}

if (cmd === 'revoke') {
  const id = clean(arg, 20);
  if (!/^g-[a-z0-9]{4,12}$/.test(id)) die('revoke needs the grant id from the roster (it looks like g-xxxxxxxx)');
  const roster = readRoster();
  const g = roster.grants.find((x) => x && x.id === id);
  if (!g) die(`no grant ${id} in the roster.`);
  if (g.status === 'revoked') { console.log(`OK: grant ${id} (${g.label}) was already revoked.`); process.exit(0); }
  g.status = 'revoked';
  g.revoked = new Date().toISOString();
  writeRoster(roster);
  const conf = readConf();
  console.log(`OK: grant ${id} (${g.label}) is marked revoked in the roster.`);
  console.log('Now remove their read access on your git host'
    + (conf && isGithub(conf.url) ? ' (GitHub: repo Settings, Collaborators, remove their account)' : '')
    + '. The bundle stops working once the host access is gone. What they already installed stays theirs; that is by design.');
  process.exit(0);
}

die(`unknown command ${cmd}. Use init, status, grant, revoke, roster or bundle.`);
