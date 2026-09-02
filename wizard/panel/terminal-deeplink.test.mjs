// terminal-deeplink.test.mjs — the door's finish checklist sends "Connect
// Claude" to the app as #box=<slug>&sec=terminal&run=signin (2026-09-02). Pins
// the three halves that make that safe and working:
//   1. the box-from-hash match tolerates a compound hash (it used to anchor on
//      end-of-string, so any suffix silently dropped the box and opened the
//      wrong mineral),
//   2. the sec=terminal arrival lands on the Terminal tab,
//   3. run= is a WHITELIST: only `signin`, mapped to the page's own
//      SIGNIN_OPENER constant — a URL must never be able to type an arbitrary
//      command into a terminal on the mineral.
//
// NOTE: member.html contains script-tag text inside its own strings, so
// everything below anchors on source positions, not on tag splitting
// (same discipline as connect-enrols.test.mjs).
//   node --test wizard/panel/terminal-deeplink.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

const at = (needle) => {
  const i = html.indexOf(needle);
  assert.ok(i > 0, `member.html no longer contains ${needle}`);
  return i;
};

test('the box-from-hash match accepts a compound hash and still extracts the box', () => {
  // lift the ACTUAL regex literals off the page and run them, so this test can
  // only pass while the shipped pattern behaves
  const boxSrc = (html.match(/location\.hash\.match\((\/\^#box=.*?\/)\)/) || [])[1];
  assert.ok(boxSrc, 'the #box= match is gone or reshaped');
  const boxRe = new Function(`return ${boxSrc}`)();   // eslint-disable-line no-new-func
  assert.equal(('#box=fern&sec=terminal&run=signin'.match(boxRe) || [])[1], 'fern');
  assert.equal(('#box=fern'.match(boxRe) || [])[1], 'fern', 'the plain hash still works');

  const hostSrc = (html.match(/location\.hash\.match\((\/\^#host=.*?\/)\)/) || [])[1];
  assert.ok(hostSrc, 'the #host= match is gone or reshaped');
  const hostRe = new Function(`return ${hostSrc}`)();   // eslint-disable-line no-new-func
  assert.equal(('#host=acme-rock&sec=terminal'.match(hostRe) || [])[1], 'acme-rock');
  assert.equal(('#host=acme-rock'.match(hostRe) || [])[1], 'acme-rock');
});

test('sec=terminal lands on the Terminal tab, in the boot path, after the box is chosen', () => {
  const boxPick = at('askedBox ? askedBox + \'-box\' : \'\'');
  const handler = at('[#&]sec=terminal(?:&|$)');
  const boot = at('// ---- boot');
  assert.ok(handler > boxPick, 'the deep link is honoured after the box is resolved');
  assert.ok(handler > boot, 'and inside the boot path, not some later block');
  const slice = html.slice(handler, handler + 400);
  assert.match(slice, /activateSec\('terminal'\)/);
});

test('run= is whitelisted to signin -> SIGNIN_OPENER; no raw hash value ever reaches openTerm', () => {
  const handler = at('[#&]run=signin(?:&|$)');
  const slice = html.slice(handler, handler + 200);
  assert.match(slice, /openTerm\(\{ autorun: SIGNIN_OPENER \}\)/,
    'the opener is the page constant, never text from the URL');
  // the page must not build an autorun from the hash anywhere
  assert.equal(/autorun:\s*[^}]*location\.hash/.test(html), false);
});

test('SIGNIN_OPENER is still the bare claude sign-in', () => {
  assert.match(html, /var SIGNIN_OPENER = 'claude';/);
});
