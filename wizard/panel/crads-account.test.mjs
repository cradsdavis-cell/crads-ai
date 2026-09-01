// crads-account.test.mjs: RETIREMENT PINS for the ONE Crads account (T5).
//
// The whole account layer left with the self-host pivot (2026-09-01): no
// sign-in, no session file, no app tokens, no central directory to present
// them to. Identity is the SSH key, and a new computer is let in by one that
// already has access (device-routes.mjs, over SSH). This file used to test the
// silent-first / interactive / Google-fallback mint chain in crads-account.mjs;
// what it holds now is the stronger truth that the module STAYS GONE and that
// nothing in the app quietly re-grows a path to it.
// Run: node --test wizard/panel/crads-account.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

test('crads-account.mjs is RETIRED (2026-09-01): the module stays gone', () => {
  // A resurrected file is how a "deleted" system comes back one convenience at
  // a time. The 410 tombstones in panel-server and the door's 404s all rest on
  // this being true.
  assert.ok(!existsSync(join(HERE, 'crads-account.mjs')), 'crads-account.mjs must not return to the tree');
});

test('no production module imports the dead account module', () => {
  // Comments may RECORD the retirement (panel-server's tombstone note does);
  // an import statement would be the account layer growing back. Test files
  // are excluded: this file names the module in its own pins.
  const offenders = readdirSync(HERE)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .filter((f) => /from '\.\/crads-account\.mjs'|import\('\.\/crads-account\.mjs'\)/
      .test(readFileSync(join(HERE, f), 'utf8')));
  assert.deepEqual(offenders, [], `these still import crads-account.mjs: ${offenders.join(', ')}`);
});

test('member-connect keeps nothing that dials a central service', async () => {
  // The connect flows that used to sign requests with the account were DELETED
  // outright with the invite surface (2026-09-01): what survives in
  // member-connect.mjs is local key/config machinery, so the honest-refusal
  // strings this test used to count went with the flows that carried them.
  const src = readFileSync(join(HERE, 'member-connect.mjs'), 'utf8');
  assert.ok(!/fetch\(/.test(src), 'the surviving machinery reaches no network at all');
  assert.ok(!src.includes('directory.crads-ai.com'), 'and names no central host');
});

test('machineName survives the retirement, in machine-name.mjs, junk filter intact', async () => {
  // The one piece of this layer worth keeping was never account-shaped: what
  // to call the computer a member is sitting at. It lives in machine-name.mjs
  // (lifted out 2026-08-13, finding 116) and both surviving enrolment paths
  // still need the navigator.platform junk filter until old app builds die.
  const { machineName, machineSlug } = await import('./machine-name.mjs');
  assert.equal(machineName('Sam laptop'), 'Sam laptop', 'a human-chosen name still rides');
  assert.equal(machineSlug('Sam laptop'), 'sam-laptop');
  const own = machineName();
  assert.ok(own && own.length, 'the fallback is never empty');
  assert.equal(machineName('Win32'), own, 'a platform family is not a machine name');
});
