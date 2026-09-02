#!/usr/bin/env node
// commons-create.mjs: "Start a community" as one field (commons usability
// overhaul, 2026-09-02; ruling 1).
//
//   node commons-create.mjs <state-dir> <brain-root>    (JSON on stdin)
//
// stdin: { name: "Harbour Guild", open: false }
//
// The owner types the community's name in human words; everything else is
// derived and done here, ON THE BOX, with the box's own stored GitHub token
// (gh sign-in or the Backup card's brain token — readGhToken checks both,
// exactly the own-brain custody model):
//   1. derive the lowercase id ("Harbour Guild" -> harbour-guild)
//   2. create the PRIVATE repo <id>-commons under the OWNER'S GitHub
//      (open: true makes it public: an open community anyone can pull)
//   3. seed a README naming the community
//   4. write commons.conf so publish and grants work immediately
//
// Everything arrives as JSON on stdin (base64 through the verb layer), so
// nothing typed can reach the shell. Idempotent where it can be: an existing
// <id>-commons repo this account can push to is adopted, own-brain style. A
// commons that is ALREADY configured refuses rather than repointing anything:
// repointing is the Advanced form's job (commons-admin init), on purpose.
import { readFileSync } from 'node:fs';
import {
  deriveOrgId, readCommonsConf, readGhToken, writeCommonsConfFile,
} from './commons-lib.mjs';
import { createRepo, ensureReadme, ghClient, whoami } from './commons-github.mjs';

const [state, brain] = process.argv.slice(2).map((s) => String(s || ''));
const die = (msg) => { console.log(`ERROR: ${msg}`); process.exit(1); };
if (!state || !brain) die('usage: commons-create <state-dir> <brain-root>  (JSON on stdin)');

// eslint-disable-next-line no-control-regex
const cleanStr = (s, max) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);

let j = null;
try { j = JSON.parse(readFileSync(0, 'utf8')); } catch { j = null; }
if (!j || typeof j !== 'object' || Array.isArray(j)) die('commons-create needs a JSON body on stdin');

const display = cleanStr(j.name, 64);
if (!display) die('name the community first: a couple of human words, e.g. "Harbour Guild"');
const org = deriveOrgId(display);
if (!org) die(`"${display}" does not reduce to a usable community id (letters and numbers needed). Try a simpler name.`);
const open = j.open === true;

const existing = readCommonsConf(state);
if (existing) die(`a commons is already set up (${existing.url}, shared as "${existing.org_display}"). To point at a different repository, use "Bring your own repository" below.`);

const token = readGhToken(state);
if (!token) die('this hub has no GitHub sign-in yet, so it cannot create the repository for you. Connect GitHub first (the Backup card on Your mineral, or run connect-github in the Terminal tab), then press Start again.');

const gh = ghClient({ token });
const repoName = `${org}-commons`;

const me = await whoami(gh);
if (!me.ok) die(`GitHub did not accept this hub's sign-in (${me.detail}). Reconnect GitHub, then press Start again.`);

const made = await createRepo(gh, {
  name: repoName,
  isPrivate: !open,
  description: `The ${display} shared library (Crads-AI commons)`,
});
if (!made.ok) die(made.reason);
const fullName = made.fullName || `${me.login}/${repoName}`;
const [owner, repo] = fullName.split('/');

const readme = await ensureReadme(gh, {
  owner, repo,
  text: `# ${display}\n\nThe shared library of the ${display} community, published from its Crads-AI hub.\nMembers' minerals pull this repository read-only; installing anything from it stays each member's own act.\n`,
});

writeCommonsConfFile(state, { url: `https://github.com/${fullName}.git`, org, org_display: display });

if (made.created) {
  console.log(`OK: created ${fullName} on your GitHub (${open ? 'open: anyone with the link can pull it' : 'private: only people you share with can read it'}) and set it up as the ${display} shared library (${org}).`);
} else {
  console.log(`OK: ${fullName} already existed on your GitHub, so it is now set up as the ${display} shared library (${org}).${open && made.isPrivate ? ' Note: the repository is private; make it public on GitHub if you want an open community.' : ''}`);
}
if (readme.ok && readme.written) console.log('A README naming the community is in the repository.');
if (!readme.ok) console.log(`(The README could not be written: ${readme.detail}. The repository still works; add one whenever you like.)`);
console.log('Publish puts your catalogue there. Sharing with a member records them here, sends their GitHub invitation when you give their username, and prints their join link.');
