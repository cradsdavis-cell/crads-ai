// console-request-injection.test.mjs — RETIRED (2026-09-01, the face collapse).
// Run: node --test wizard/panel/console-request-injection.test.mjs
//
// What this file used to hold. console-request built a shell command whose
// echoes once interpolated the request subject into double-quoted strings, so
// command substitution would have evaluated inside the rock container next to
// its Hetzner, Cloudflare and GitHub tokens; a later audit also closed a path
// traversal in the re-anchor leg. The self-host pivot deleted the verb with
// the whole console-request machinery (nothing asks a directory for consent
// any more), so the strongest form of both fixes is that the verb cannot
// build anything at all. The injection lesson itself lives on in the verbs
// that survive: slugArg and the single-quoted echo discipline are pinned by
// their own files (box-rename in panel.test.mjs, commons-verbs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMBER_VERBS } from './panel-server.mjs';

test('console-request is RETIRED: the verb stays out of both tables', () => {
  assert.equal(MEMBER_VERBS['console-request'], undefined, 'console-request must stay deleted');
  assert.equal(MEMBER_VERBS['console-withdraw'], undefined, 'and console-withdraw with it');
  assert.equal(MEMBER_VERBS['console-request'], undefined, 'the member table never had it and never gains it');
});
