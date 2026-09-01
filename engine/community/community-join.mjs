#!/usr/bin/env node
// community-join.mjs: paste a `cradscommons1:` bundle, become a member of a
// commons (self-host pivot, 2026-09-01; docs/self-host-design.md section 3).
//
//   node community-join.mjs <state-dir>       (the bundle string on stdin)
//
// The bundle rides STDIN, never argv: nothing pasted can become shell, and a
// hostile bundle is refused loudly by parseBundle before anything is written.
// Joining records the community under <state>/communities.d/<org>.json and
// runs the first pull inline, so the honest outcome (synced, private repo the
// box cannot read yet, host down) is reported in the same breath. For a
// private GitHub commons the owner must ALSO have invited this member's
// GitHub account as a read collaborator; until that invite is accepted the
// first pull says so rather than pretending.
//
// Multiple communities per box are the normal case: each gets its own record,
// its own inbox at org-inbox.d/<org>/, and its own row in community-list.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ORG_RE, inboxConfFor, inboxDirFor, parseBundle, readCommunity, writeCommunity } from './commons-lib.mjs';
import { pullOne } from './commons-pull.mjs';

const state = String(process.argv[2] || '');
const die = (msg) => { console.log(`ERROR: ${msg}`); process.exit(1); };
if (!state) die('usage: community-join <state-dir>  (bundle on stdin)');

let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
const parsed = parseBundle(raw);
if (!parsed.ok) die(parsed.error);
const c = parsed.community;
if (!ORG_RE.test(c.org)) die('the bundle is damaged (its community name is not usable).');

// Refuse a name collision rather than quietly overwriting anything:
//   - already joined this community: say so, point at leave-then-rejoin
//   - an org-inbox.d entry with the same name that is NOT ours (a real joined
//     rock tie from the pre-pivot machinery): never adopt or clobber it.
const existing = readCommunity(state, c.org);
if (existing) {
  if (existing.url === c.url) die(`you are already a member of ${c.org_display} (${c.org}). Nothing changed.`);
  die(`a community named ${c.org} is already recorded on this box with a different repository. Leave it first if you mean to replace it.`);
}
const conf = inboxConfFor(state, c.org);
if (existsSync(conf) && !/^COMMONS=1$/m.test((() => { try { return readFileSync(conf, 'utf8'); } catch { return ''; } })())) {
  die(`this box already has a rock inbox named ${c.org} from an earlier tie. That name is taken; ask the community owner for a bundle with a different community name.`);
}
if (!existsSync(conf) && existsSync(inboxDirFor(state, c.org))) {
  die(`this box already has inbox content named ${c.org} that it does not manage. That name is taken; ask the community owner for a bundle with a different community name.`);
}

const rec = {
  org: c.org,
  org_display: c.org_display,
  url: c.url,
  ...(c.branch ? { branch: c.branch } : {}),
  joined: new Date().toISOString(),
  status: 'joined',
};
writeCommunity(state, rec);

const r = pullOne(state, rec);
if (r.status === 'ok') {
  console.log(`OK: joined ${c.org_display}. Its commons is on this box now; new and updated items appear in your catalogue for you to install when you choose.`);
} else if (r.status === 'access-ended') {
  console.log(`OK: joined ${c.org_display}, but this box cannot read its commons yet. For a private repository the owner must invite your GitHub account as a read collaborator (and this box needs its GitHub sign-in connected). The box keeps trying on its normal rhythm.`);
} else if (r.status === 'oversized') {
  console.log(`OK: joined ${c.org_display}, but ${r.line}`);
} else {
  console.log(`OK: joined ${c.org_display}, but the first sync did not complete (${(r.line || 'network or host trouble').slice(0, 160)}). The box keeps trying on its normal rhythm.`);
}
