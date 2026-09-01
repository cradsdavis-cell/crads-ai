// console-request-injection.test.mjs — a request subject must never become shell.
// Run: node --test wizard/panel/console-request-injection.test.mjs
//
// Why this file exists. console-request validated `subject` against
// /[\x00-\x1f'"\\]/ — control characters, both quote styles and backslash —
// and let $ ( ) and backtick through. The command it builds ends with
//
//   echo "OK: <kind> request sent to <to_org> re <subject>."
//
// in a DOUBLE-quoted shell string, and the re-anchor branch has a second one:
//
//   echo "ERROR: could not read the registry row for <subject>; ..."
//
// so command substitution evaluated inside the rock's ROCK container,
// which holds its Hetzner, Cloudflare and GitHub tokens plus the deprovision
// scripts. The member face closed this exact class on the box-rename verb; the
// org face still had it.
//
// Both halves are closed here: the validator refuses the substitution
// characters outright, and the two echoes no longer interpolate into double
// quotes, so neither alone is load-bearing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERBS } from './panel-server.mjs';

const build = (over = {}) => VERBS['console-request'].build({ kind: 'ask-read', to_org: 'acme', subject: 'jane01', ...over });

test('the honest path still builds', () => {
  const c = build().command;
  assert.match(c, /jane01/, 'the subject still reaches the request');
});

test('command substitution in a subject is refused', () => {
  for (const evil of ['$(whoami)', '`whoami`', 'jane$(id)', 'a`id`b', 'x$USER']) {
    assert.throws(() => build({ subject: evil }), /subject/i, `must refuse ${evil}`);
  }
});

test('the quote and control-character refusals still hold', () => {
  for (const evil of ["jane'x", 'jane"x', 'jane\\x', 'jane' + String.fromCharCode(10) + 'x']) {
    assert.throws(() => build({ subject: evil }), /subject/i);
  }
});

test('no double-quoted shell string interpolates the subject', () => {
  // Belt and braces: even if a future validator loosens, the echoes must be
  // structurally safe. Every echo carrying the subject must be single-quoted.
  const c = build().command;
  for (const m of c.matchAll(/echo "([^"]*)"/g)) {
    assert.doesNotMatch(m[1], /jane01/, `subject interpolated into a double-quoted echo: ${m[0]}`);
  }
});

test('the re-anchor branch is covered too, not just the tail', () => {
  const c = VERBS['console-request'].build({ kind: 're-anchor', to_org: 'acme', subject: 'jane01' }).command;
  for (const m of c.matchAll(/echo "([^"]*)"/g)) {
    assert.doesNotMatch(m[1], /jane01/, `re-anchor leaked the subject into a double-quoted echo: ${m[0]}`);
  }
});

test('a framework name keeps the quote rules, and keeps its brackets', () => {
  // `subject` is tightened against $ ( ) and backtick because it is a slug and
  // it genuinely reached a double-quoted echo. `framework` is PROSE and only
  // ever lands inside JSON.stringify(payload) within a single-quoted `node -e`
  // script, where those characters are inert. Tightening it too bought no safety
  // and refused legitimate names, so that was reverted on review.
  const build = (framework) => VERBS['console-request'].build({ kind: 'reframe', to_org: 'acme', subject: 'jane01', framework });
  assert.doesNotThrow(() => build('GROW (coaching model)'), 'brackets are ordinary in a framework name');
  for (const evil of ["it's", 'a "quoted" name', 'back\\slash']) {
    assert.throws(() => build(evil), /framework|reframe/i, `quotes and backslashes stay refused: ${evil}`);
  }
});

test('the framework never reaches a double-quoted shell string either', () => {
  const c = VERBS['console-request'].build({ kind: 'reframe', to_org: 'acme', subject: 'jane01', framework: 'GROW (coaching model)' }).command;
  for (const m of c.matchAll(/echo "([^"]*)"/g)) {
    assert.doesNotMatch(m[1], /GROW/, `framework interpolated into a double-quoted echo: ${m[0]}`);
  }
});

// 2026-08-20 audit: the shell could not be broken out of, but the PATH could.
// The class above refuses quotes, backslash, dollar, backtick and brackets, and
// it permits '/' and '.'. For kind 're-anchor' the subject is interpolated into
// readFileSync("registry/members/<subject>.yaml"), the one such interpolation in
// the file that never went through slugArg, so '../../org-policy' resolved
// outside the directory it was meant to be confined to.
test('a re-anchor subject cannot escape registry/members/', () => {
  for (const bad of ['../../org-policy', '../people/sam', 'a/b', './x', '..']) {
    assert.throws(() => VERBS['console-request'].build({ kind: 're-anchor', to_org: 'acme', subject: bad }),
      /short username/i, `traversal must be refused: ${bad}`);
  }
});

test('an ordinary re-anchor subject still builds', () => {
  const out = VERBS['console-request'].build({ kind: 're-anchor', to_org: 'acme', subject: 'jane01' });
  assert.match(out.command, /registry\/members\/jane01\.yaml/, 'the real path is still assembled');
});

test('the other kinds keep taking free-text subjects', () => {
  // Only the re-anchor leg uses subject as a path, so tightening every kind
  // would refuse legitimate prose the reframe flow depends on.
  assert.doesNotThrow(() => VERBS['console-request'].build({ kind: 'ask-read', to_org: 'acme', subject: 'the pricing page' }));
});
