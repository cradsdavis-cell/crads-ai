#!/usr/bin/env node
// community-check.mjs: the "Check again" button behind a community that
// cannot be read (commons usability overhaul, 2026-09-02; ruling 3).
//
//   node community-check.mjs <state-dir> <org>
//
// One pull, now, for one community, followed by the same diagnosis
// community-join runs: a member who has just accepted the owner's GitHub
// invitation (or just connected their GitHub sign-in) should not have to wait
// for the cadence to notice. The outcome is one honest sentence:
//   - syncing again (access recovered, or it always worked)
//   - the invitation is still sitting unaccepted (named, with who sent it)
//   - no GitHub sign-in on this mineral (and where to connect one)
//   - plain no-access, or a transient network answer, said as themselves
// The record's access_hint is updated so the Communities page renders the
// same words this printed.
import { ORG_RE, readCommunity, writeCommunity } from './commons-lib.mjs';
import { accessAdvice, diagnoseAccess } from './commons-github.mjs';
import { pullOne } from './commons-pull.mjs';

const [state, org] = process.argv.slice(2).map((s) => String(s || ''));
const die = (msg) => { console.log(`ERROR: ${msg}`); process.exit(1); };
if (!state || !org) die('usage: community-check <state-dir> <org>');
if (!ORG_RE.test(org)) die('org must be the community name shown on the Communities page');

const rec = readCommunity(state, org);
if (!rec) die(`this box is not a member of a community named ${org}.`);
const display = rec.org_display || org;

const wasEnded = rec.status === 'access-ended';
const r = pullOne(state, rec);

if (r.status === 'ok') {
  console.log(wasEnded
    ? `OK: ${display} is readable again and syncing. Its shared library appears in your catalogue.`
    : `OK: ${display} is syncing. Its shared library appears in your catalogue.`);
} else if (r.status === 'access-ended') {
  const d = await diagnoseAccess(state, rec);
  const cur = readCommunity(state, org) || rec;
  writeCommunity(state, { ...cur, access_hint: d.hint || undefined, invite_from: d.from || undefined });
  const advice = accessAdvice(d);
  if (advice) console.log(`Not yet: ${advice.charAt(0).toUpperCase()}${advice.slice(1)}`);
  else console.log(`Not yet: this mineral still cannot read ${display}'s shared library. If the owner just shared it with you, their GitHub invitation may not have been sent or accepted; ask them. If you were a member before, your access may have ended.`);
} else if (r.status === 'oversized') {
  console.log(`Not yet: ${r.line || `${display} is larger than this mineral accepts.`}`);
} else {
  console.log(`Not yet: the check did not complete (${(r.line || 'network or host trouble').slice(0, 160)}). Nothing is wrong with your membership; try again in a moment.`);
}
