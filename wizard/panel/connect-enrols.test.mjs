// connect-enrols.test.mjs — opening a box must put this machine on the roster.
// Run: node --test wizard/panel/connect-enrols.test.mjs
//
// The gap this closes (2026-08-12). Sam clicked through to his rock repeatedly
// and /app/devices never changed, so the account system looked broken. Every
// other link in the chain was healthy: the mineral mirrors its roster to the
// directory every two minutes (enrol-sync, odd minutes) and the account page
// reads that mirror. Checked live on his own rock mid-diagnosis, the last push
// was under two minutes old.
//
// Nothing was wrong with the sync. There was simply never anything new to sync,
// because CONNECTING NEVER ENROLLED. crads-ai://box/<slug> only chooses which
// surface to show (protocol.mjs extractBox returns a slug and nothing else), and
// the roster row was written only by healDevices — which hangs off netOpen, so
// it needs you to open Network — or by a "let me in" button.
//
// Both properties pinned here are the silent kind: a break shows up as an app
// that looks fine and quietly stops enrolling anyone.
//
// NOTE for whoever edits this next: member.html contains the text of script tags
// inside its own comments and strings (page fragments inject their own), so
// splitting the file on script tags does not work. Everything below anchors on
// source positions instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');

const at = (needle) => {
  const i = html.indexOf(needle);
  assert.ok(i > 0, `member.html no longer contains ${needle}`);
  assert.equal(html.indexOf(needle, i + 1), -1, `${needle} appears more than once; this test can no longer anchor on it`);
  return i;
};

/** `function name(){ ... }` sliced out by brace matching, for a parse check. */
function fnSource(name) {
  const start = at(`function ${name}(){`);
  let depth = 0;
  for (let i = html.indexOf('{', start); i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    else if (html[i] === '}') { depth -= 1; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

test('enrolThisMachine parses', () => {
  // An inline script has no build step and no module loader: a syntax error here
  // does not fail anything, it leaves the app dead behind a console message
  // nobody is looking at.
  assert.doesNotThrow(() => new Function(fnSource('enrolThisMachine')));   // eslint-disable-line no-new-func
});

test('opening a box enrols this machine, on the rising edge, for the ONE face', () => {
  const enrol = at('function enrolThisMachine(){');
  const connect = at('function connect(quiet){');

  // same inline script block as connect(). healDevices sits in a LATER block,
  // which has not parsed yet when boot calls connect(), so defining it beside
  // healDevices would throw at exactly the moment it is needed.
  assert.ok(enrol < connect, 'defined before connect()');
  assert.equal(html.slice(enrol, connect).includes('</script'), false,
    'and in the same script block, not one that parses later');

  const okBranch = at('connectAttempts = 0; hideConnError();');
  const call = html.indexOf('enrolThisMachine();', okBranch);
  assert.ok(call > okBranch, 'called from the connected branch');
  // The face collapse (2026-09-01) removed the org early-return this call once
  // had to beat. The old failure mode is structurally gone rather than dodged:
  // there is no face split anywhere in the page for a future edit to move the
  // call behind, and a rock enrols because every mineral runs the same branch.
  assert.equal(html.includes('IS_ORG'), false, 'no face split remains to starve the enrol call');

  assert.match(html.slice(enrol, connect), /'\/devices\/self-heal'/, 'it posts to the self-heal route');
});

test('the only gate is the rising edge', () => {
  // devicesSelfHeal answers { ok, enrolled:false, slug } once the row exists, so
  // one call per rising edge costs a single devices-list in the steady state.
  // connect() also re-runs every 20s as a liveness beat, and that is not an
  // enrolment event — hence !wasOk. If a future edit gates it on some local
  // "already enrolled" flag instead, a machine removed from the roster
  // server-side could never re-enrol by reconnecting, and reconnecting is the
  // obvious repair.
  const line = html.split('\n').find((l) => l.includes('enrolThisMachine();'));
  assert.equal(line.trim(), 'if (!wasOk) enrolThisMachine();');
});
