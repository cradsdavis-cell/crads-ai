#!/usr/bin/env node
// leave-notice.mjs <slug> --reason "<short why>" — the DELIVERY half of a
// leave (pebble-audit ruling, 2026-08-10: one ender, reason ALWAYS required
// and carried to the person; never a silent cut). Unlike evict-member this
// script closes NOTHING: the rock-side row flip, door detach and edge prune
// stay with the caller (panel-server's member-leave), so an old brain that
// lacks this file still completes the leave and the caller says the words
// could not travel.
//
// What rides down the inbox: leave/notice.json + leave-apply.sh. The apply
// script deliberately does NOT detach channels or re-anchor: a leave keeps
// "Bring back" cheap by design — only the words travel.
import { readFile, writeFile, mkdtemp, cp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const slug = args[0];
const ri = args.indexOf('--reason');
const reason = ri > -1 ? String(args[ri + 1] || '').slice(0, 160) : '';
if (!slug || !reason) { console.error('usage: leave-notice <slug> --reason "<short why, shown to the person>"'); process.exit(2); }

// Finding 173 (run 5): the old end-anchored regex here matched no shipped
// org-policy line (trailing comments) and read the slug, not the display name.
// Anchored to the org: block, comments stripped, display_name first.
const leavePolicyText = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
const leaveOrgField = (key) => (leavePolicyText.match(new RegExp(`^org:\\s*$[\\s\\S]*?^\\s+${key}:\\s*"?([^"\\n#]*)"?`, 'm')) || [])[1]?.trim() || '';
const orgSlug = leaveOrgField('display_name') || leaveOrgField('name') || 'this rock';
const date = new Date().toISOString().slice(0, 10);

const payload = await mkdtemp(path.join(tmpdir(), 'leave-'));
await writeFile(path.join(payload, 'notice.json'),
  JSON.stringify({ org: orgSlug, reason, date, kind: 'leave' }, null, 2) + '\n');
await cp(path.join(repoRoot, 'pebble-template', 'box', 'leave-apply.sh'), path.join(payload, 'leave-apply.sh'));
// --allow-paused for the same reason evict carries it: a lifecycle message,
// not content, and departures commonly follow a frozen row.
const push = await new Promise((res) => execFile('node',
  [path.join(repoRoot, 'orchestrator', 'push-down.mjs'), slug, payload, 'leave', '--allow-paused'],
  { cwd: repoRoot }, (err, so, se) => res({ err, so: String(so), se: String(se) })));
if (push.err) {
  console.error(`WARN: the leave notice could not be delivered (${push.se.trim() || push.err.message}). The departure still proceeds; the reason is recorded on the row but has not reached their screen.`);
  process.exit(1);
}
console.log(`leave notice delivered to ${slug}: they will see who recorded the departure and why.`);
