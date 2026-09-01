// operator-emails.test.mjs — the extraction that gates a rock's browser door.
//
// docs/operator-live-test-checklist.md called this "the single most fragile
// untested-live piece in the current branch (shell/awk YAML extraction on a
// production path)". On 2026-08-25 a probe found four ways the old awk silently
// produced a WRONG answer, and the caller in provision-rock.sh only warns when
// the list comes back EMPTY, never when it comes back malformed. A bad address
// builds a Cloudflare Access policy that matches no human, the stamp still
// prints `ok ... gated to:`, and the operator finds out by being locked out of
// the box they just paid for.
//
// The second half of the file is the one that matters most: deployment.yaml has
// TWO readers, and they disagreed. Anything asserted here is asserted against
// both.
//
//   node --test provisioning/managed/operator-emails.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, 'lib.sh');
const BOOT = join(HERE, '..', 'rock', 'boot-rock.sh');

// lib.sh refuses to source without a deployment domain, by design.
const ENV = { ...process.env, CF_TUNNEL_ROOT_DOMAIN: 'crads-ai.com', CF_ZONE_NAME: 'crads-ai.com' };

function fixture(body) {
  const f = join(tmpDir('opemails-'), 'deployment.yaml');
  writeFileSync(f, body);
  return f;
}

// The shell side, exactly as provision-rock.sh calls it.
function shellRead(file) {
  const out = execFileSync('bash', ['-c', `. "$1" >/dev/null 2>&1; operator_emails_from "$2"`, '_', LIB, file],
    { encoding: 'utf8', env: ENV });
  return out.split('\n').filter(Boolean);
}

// The node side: boot-rock.sh's `list()`, lifted out by source so the test
// tracks the real implementation rather than a copy of it. Trap 5 in
// docs/traps.md is exactly this: "a smoke exists in ONE place".
function nodeRead(file) {
  const src = readFileSync(BOOT, 'utf8');
  const fn = src.match(/function list\(key\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'boot-rock.sh no longer defines list(key); this test must be updated with it');
  const raw = readFileSync(file, 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function('raw', `${fn[0]}\nreturn list('operator_emails');`)(raw);
}

const CASES = [
  ['a plain block list', 'operator_emails:\n  - sam@crads-ai.com\n  - harriet@ic.com\n', ['sam@crads-ai.com', 'harriet@ic.com']],
  ['double-quoted entries', 'operator_emails:\n  - "sam@crads-ai.com"\n', ['sam@crads-ai.com']],
  ['SINGLE-quoted entries', "operator_emails:\n  - 'sam@crads-ai.com'\n", ['sam@crads-ai.com']],
  ['the inline flow form', 'operator_emails: [sam@crads-ai.com, harriet@ic.com]\n', ['sam@crads-ai.com', 'harriet@ic.com']],
  ['CRLF line endings', 'operator_emails:\r\n  - sam@crads-ai.com\r\n', ['sam@crads-ai.com']],
  ['the list stops at the next key', 'operator_emails:\n  - sam@crads-ai.com\nroles:\n  - admin\n', ['sam@crads-ai.com']],
  ['an absent key', 'deployment_name: acme\n', []],
];

for (const [name, body, want] of CASES) {
  test(`shell reader: ${name}`, () => {
    assert.deepEqual(shellRead(fixture(body)), want);
  });
}

test('a trailing comment does not ride into the address', () => {
  // deployment.example.yaml forbids a hash in a value, so this is malformed
  // input. It must still not produce `sam@crads-ai.com # primary`, because that
  // becomes a live Access rule matching nobody.
  assert.deepEqual(shellRead(fixture('operator_emails:\n  - sam@crads-ai.com # primary\n')), ['sam@crads-ai.com']);
});

test('an entry that is not an address is DROPPED, not passed through', () => {
  assert.deepEqual(shellRead(fixture('operator_emails:\n  - notanemail\n  - real@x.com\n')), ['real@x.com']);
});

test('a CRLF file leaves no carriage return glued to the address', () => {
  const [only] = shellRead(fixture('operator_emails:\r\n  - sam@crads-ai.com\r\n'));
  assert.equal(only, 'sam@crads-ai.com');
  assert.ok(!/\r/.test(only), 'a trailing \\r would silently break the Access rule');
});

test('an unreadable file is empty, not a crash (Access must warn, never abort a stamp)', () => {
  assert.deepEqual(shellRead('/nonexistent/deployment.yaml'), []);
});

// ── the two readers must agree ──────────────────────────────────────────────
// provision-rock.sh builds the Access policy from the shell reader; boot-rock.sh
// sets AIOS_OPERATOR_EMAIL from the node one. Before 2026-08-25 they disagreed
// on quoting and on the inline form, so a box could boot correctly configured
// with its browser door gated to a garbage address.
for (const [name, body] of CASES) {
  test(`parity with boot-rock.sh list(): ${name}`, () => {
    const f = fixture(body);
    assert.deepEqual(shellRead(f), nodeRead(f),
      'the Access policy and AIOS_OPERATOR_EMAIL would be built from different answers');
  });
}

test('parity holds for both quote styles', () => {
  for (const body of ['operator_emails:\n  - "a@x.com"\n', "operator_emails:\n  - 'a@x.com'\n"]) {
    const f = fixture(body);
    assert.deepEqual(shellRead(f), nodeRead(f));
  }
});

test('parity: a NESTED key reads empty in both, per the flat-file contract', () => {
  // deployment.example.yaml says keep it flat. Both readers anchor at column
  // zero, so this is a loud consistent warn rather than a quiet disagreement.
  const f = fixture('deployment:\n  operator_emails:\n    - sam@crads-ai.com\n');
  assert.deepEqual(shellRead(f), []);
  assert.deepEqual(nodeRead(f), []);
});
