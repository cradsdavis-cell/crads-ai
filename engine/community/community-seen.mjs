#!/usr/bin/env node
// community-seen.mjs: record that the member has looked at a community's
// shared library (commons usability overhaul, 2026-09-02; ruling 4).
//
//   node community-seen.mjs <state-dir> <org>
//
// Stamps the community record with what the checkout carries RIGHT NOW
// ({kind:id -> version}), so community-list can mark what arrived or changed
// since the member's last look, and the new things lead the list. Box-side
// state only: nothing leaves the box, nothing reaches the commons, and the
// owner never learns what was looked at.
import { ORG_RE, readCommonsItems, readCommunity, seenKey, writeCommunity } from './commons-lib.mjs';

const [state, org] = process.argv.slice(2).map((s) => String(s || ''));
const die = (msg) => { console.log(`ERROR: ${msg}`); process.exit(1); };
if (!state || !org) die('usage: community-seen <state-dir> <org>');
if (!ORG_RE.test(org)) die('org must be the community name shown on the Communities page');

const rec = readCommunity(state, org);
if (!rec) die(`this box is not a member of a community named ${org}.`);

const seen = {};
for (const it of readCommonsItems(state, org)) seen[seenKey(it)] = it.version;
writeCommunity(state, { ...rec, seen, seen_at: new Date().toISOString() });
console.log(`OK: caught up with ${rec.org_display || org} (${Object.keys(seen).length} item(s) noted).`);
