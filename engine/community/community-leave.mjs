#!/usr/bin/env node
// community-leave.mjs: leave a commons this box joined (self-host pivot,
// 2026-09-01; docs/self-host-design.md section 3).
//
//   node community-leave.mjs <state-dir> <org>
//
// Leaving removes the community record, the conf shim and the pulled inbox
// checkout, which is what stops the cadence pull. It touches NOTHING the
// member installed: skills in .claude/skills/, pages in dashboard/pages/,
// folders in library/ all stay, per the standing ruling that a member keeps
// what they installed. The conf shim is only removed when it is ours
// (COMMONS=1): a real joined-rock inbox with the same name is never touched.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { ORG_RE, inboxConfFor, inboxDirFor, readCommunity, removeCommunity } from './commons-lib.mjs';

const [state, org] = process.argv.slice(2).map((s) => String(s || ''));
const die = (msg) => { console.log(`ERROR: ${msg}`); process.exit(1); };
if (!state || !org) die('usage: community-leave <state-dir> <org>');
if (!ORG_RE.test(org)) die('org must be the community name shown on the Communities page');

const rec = readCommunity(state, org);
if (!rec) die(`this box is not a member of a community named ${org}.`);

const conf = inboxConfFor(state, org);
let confIsOurs = false;
try { confIsOurs = /^COMMONS=1$/m.test(readFileSync(conf, 'utf8')); } catch { /* absent */ }
if (confIsOurs) rmSync(conf, { force: true });
if (confIsOurs || !existsSync(conf)) rmSync(inboxDirFor(state, org), { recursive: true, force: true });
removeCommunity(state, org);

console.log(`OK: left ${rec.org_display || org}. Its commons no longer syncs to this box. Everything you installed from it stays yours.`);
