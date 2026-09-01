#!/usr/bin/env node
// join-result.mjs <id> approved <invite-link> | <id> declined [note]
// Posts a join-request outcome back through the broker (D58 P4) and consumes the
// request, then prunes control/join-requests.json. Fail-open: if the broker is
// unreachable the caller still holds the invite link (printed by join-approve.sh),
// so the manual send fallback stands. Exit 0 unless the ARGUMENTS are wrong.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries((await readFile(path.join(repoRoot, '.env'), 'utf8').catch(() => ''))
  .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const policy = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
const ORG = (policy.match(/^\s*name:\s*"?([^"\n#]+)"?/m) || [])[1]?.trim();

const [id, status, ...rest] = process.argv.slice(2);
if (!/^[0-9a-f]{8,40}$/.test(String(id || '')) || !['approved', 'declined'].includes(status)) {
  console.error('usage: join-result.mjs <id> approved <invite-link> | <id> declined [note]');
  process.exit(2);
}
const invite = status === 'approved' ? String(rest[0] || '') : '';
const note = status === 'declined' ? String(rest.join(' ') || '') : '';
if (status === 'approved' && !/^https:\/\/crads-ai\.com\/join#v1\./.test(invite)) {
  console.error('approved needs the invite link as the third argument');
  process.exit(2);
}

// SELF-HOST STRIP (2026-09-01): the broker delivery is gone — the central
// directory is deleted, so no outcome can reach a member's app through it.
// The decision still lands locally (prune below), and the operator carries the
// news themselves, which was always the fallback. Authored upstream in
// brain-template; keep the two copies identical.
const posted = false;
console.log(`NOTE: there is no central broker any more, so the member will not see this in their app. Send them the ${status === 'approved' ? 'invite link' : 'news'} yourself.`);

// prune the panel's list either way: the decision is made
const listPath = path.join(repoRoot, 'control', 'join-requests.json');
try {
  const list = JSON.parse(await readFile(listPath, 'utf8'));
  if (Array.isArray(list)) await writeFile(listPath, JSON.stringify(list.filter((e) => e && e.id !== id), null, 2));
} catch { /* no list yet */ }
console.log(`join-result: ${id} ${status}${posted ? ' (delivered to the member\'s app)' : ''}`);
