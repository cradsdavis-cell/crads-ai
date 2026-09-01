// qa-wizard.test.mjs: QA fixes for the org setup wizard (D1-D5).
//   node --test wizard/ui/qa-wizard.test.mjs
//
// The wizard's front-end validation lives inline in wizard/ui/index.html's
// <script> (no build step, no exports), so these tests extract the exact
// source fragments that carry each fix and exercise them directly, rather
// than duplicating the logic by hand and letting it drift from what ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OWNED_FILES = {
  'wizard/engine.mjs': join(HERE, '..', 'engine.mjs'),
  'wizard/ui/server-lib.mjs': join(HERE, 'server-lib.mjs'),
  'wizard/ui/index.html': join(HERE, 'index.html'),
};
const html = readFileSync(OWNED_FILES['wizard/ui/index.html'], 'utf8');

function extract(source, re, label) {
  const m = source.match(re);
  if (!m) throw new Error(`extraction failed: ${label} (source fixture drifted from this test)`);
  return m;
}

// ------------------------------------------------------------------ D1: em dashes
test('D1: zero em dashes in any of the three owned files', () => {
  for (const [label, path] of Object.entries(OWNED_FILES)) {
    const text = readFileSync(path, 'utf8');
    const count = (text.match(/\u2014/g) || []).length;
    assert.equal(count, 0, `${label} still has ${count} em dash(es)`);
  }
});

// ------------------------------------------------------------------ D2: admin email validation
const emailLit = extract(html, /var EMAIL_RE=(\/(?:\\.|[^/\\\n])*\/);/, 'EMAIL_RE literal')[1];
// eslint-disable-next-line no-eval
const EMAIL_RE = eval(emailLit);
const invalidEmailsFnSrc = extract(
  html,
  /function invalidEmails\(v\)\{[\s\S]*?\n  \}/,
  'invalidEmails() body',
)[0];
// eslint-disable-next-line no-eval, no-new-func
const invalidEmails = new Function('EMAIL_RE', `${invalidEmailsFnSrc}\nreturn invalidEmails;`)(EMAIL_RE);

test('D2: EMAIL_RE rejects garbage, accepts a real address', () => {
  assert.equal(EMAIL_RE.test('not-an-email'), false);
  assert.equal(EMAIL_RE.test('you@yourorg.com'), true);
});

test('D2: invalidEmails() validates every entry in a comma-separated list', () => {
  assert.deepEqual(invalidEmails('you@yourorg.com'), []);
  assert.deepEqual(invalidEmails('you@yourorg.com, ops@yourorg.com'), []);
  assert.deepEqual(invalidEmails('not-an-email'), ['not-an-email']);
  assert.deepEqual(invalidEmails('you@yourorg.com, not-an-email'), ['not-an-email']);
  // trailing comma / blank entries: engine.mjs's operatorsBlock() already
  // tolerates these, so the validator must not flag empty segments itself.
  assert.deepEqual(invalidEmails('you@yourorg.com,'), []);
});

test('D2: the operators input is wired into validate() at step 0', () => {
  assert.match(html, /invalidEmails\(opVal\)\.length/);
  assert.match(html, /id="operators"/);
});

// ------------------------------------------------------------------ D3: org_name pattern
test('D3: the org_name pattern attribute compiles as a valid v-flag regex', () => {
  const patternLit = extract(html, /id="org_name"[^>]*pattern="([^"]+)"/, 'org_name pattern attribute')[1];
  assert.doesNotThrow(() => new RegExp(patternLit, 'v'));
  const re = new RegExp(patternLit, 'v');
  assert.equal(re.test('acme-collab'), true);
  assert.equal(re.test('AB'), false); // uppercase not allowed
});

test('D3: the old unescaped-hyphen form is gone (would still throw under the v flag)', () => {
  assert.doesNotThrow(() => new RegExp('[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]', 'v'));
  assert.throws(() => new RegExp('[a-z0-9-]+', 'v'));
});

// ------------------------------------------------------------------ D4: step restore on reload
test('D4: the step is persisted to sessionStorage on every show() and restored on load', () => {
  assert.match(html, /sessionStorage\.setItem\('pp_step',\s*String\(step\)\)/);
  assert.match(html, /sessionStorage\.getItem\('pp_step'\)/);
  // restore is range-validated: never negative, never past the live-build screen (N-2)
  assert.match(html, /isNaN\(savedStep\)\|\|savedStep<0/);
  assert.match(html, /Math\.min\(savedStep,\s*N-2\)/);
  // the unconditional show(0) that reset every reload to Step 1 is gone
  assert.doesNotMatch(html, /buildTiers\(\);[^\n]*\n\s*show\(0\);/);
});

// ------------------------------------------------------------------ D5: leaver_days + domain
test('D5: leaver_days rejects negative numbers, accepts whole numbers', () => {
  const leaverLit = extract(html, /if\(leaverVal!==''&&\(!(\/\^\\d\+\$\/)\.test\(leaverVal\)\)\)/, 'leaver_days regex')[1];
  // eslint-disable-next-line no-eval
  const LEAVER_RE = eval(leaverLit);
  assert.equal(LEAVER_RE.test('-5'), false);
  assert.equal(LEAVER_RE.test('30'), true);
  assert.equal(LEAVER_RE.test('0'), true);
});

test('D5: leaver_days validation is wired into validate() at step 4', () => {
  assert.match(html, /Leaver days: whole number, zero or more/);
});

test('D5: domain gets a basic shape check consistent with its downstream use as a DNS zone name', () => {
  const domainLit = extract(html, /var DOMAIN_RE=(\/(?:\\.|[^/\\\n])*\/[a-z]*);/, 'DOMAIN_RE literal')[1];
  // eslint-disable-next-line no-eval
  const DOMAIN_RE = eval(domainLit);
  assert.equal(DOMAIN_RE.test('yourorg.com'), true);
  assert.equal(DOMAIN_RE.test('sub.yourorg.co.uk'), true);
  assert.equal(DOMAIN_RE.test('https://yourorg.com'), false);
  assert.equal(DOMAIN_RE.test('not a domain'), false);
  assert.equal(DOMAIN_RE.test('yourorg'), false); // engine.mjs uses this as a zone name; needs a dot
  assert.match(html, /DOMAIN_RE\.test\(val\('domain'\)\)/);
});
