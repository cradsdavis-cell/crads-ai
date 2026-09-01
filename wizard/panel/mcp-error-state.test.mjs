// mcp-error-state.test.mjs — a failed read must not leave the page claiming to
// be checking. Sam hit this live: the Connections card showed "Checking…" and an
// SSH error at once, which reads as hung and gives no clue which half is true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

test('the failure path REPLACES the checking placeholder, not just adds a notice', () => {
  const fn = html.match(/function loadMcp\(\)\{[\s\S]*?\n  \}/);
  assert.ok(fn, 'loadMcp exists');
  const body = fn[0];
  const fail = body.slice(body.indexOf('if (!d || !d.services)'));
  assert.match(fail, /\$\('mcpRows'\)\.innerHTML/, 'the row area must be rewritten on failure');
  // and it must say unknown, not empty: "nothing connected" would be a lie when
  // the box simply could not be reached
  assert.match(fail, /unknown rather than empty/i);
  assert.ok(fail.indexOf("$('mcpRows')") < fail.indexOf("notice('mcpNotice'"),
    'clear the placeholder before showing the error');
});

// The two halves of this feature update on different clocks: the app republishes
// minutes after a push, the box image only on a promote plus a restart the member
// chooses. So "app is newer than box" is not an edge case, it is guaranteed on
// every release, and it showed Sam a raw MODULE_NOT_FOUND stack trace.
import { MEMBER_VERBS } from './panel-server.mjs';

test('every mcp verb survives a box that predates the script', () => {
  for (const v of ['mcp-status', 'mcp-add', 'mcp-remove']) {
    const cmd = MEMBER_VERBS[v].build({ key: 'gmail' }).command;
    assert.match(cmd, /\[ -f \/app\/engine\/comms\/mcp-connect\.mjs \]/, `${v} must test for the script first`);
    assert.match(cmd, /box-too-old/, `${v} must name the state instead of crashing`);
  }
});

test('an old box is explained in words, with the one click that fixes it', () => {
  const fn = html.match(/function loadMcp\(\)\{[\s\S]*?\n  \}/)[0];
  const branch = fn.slice(fn.indexOf("box-too-old"));
  assert.match(branch, /Update and restart/, 'name the button that fixes it');
  assert.doesNotMatch(branch, /MODULE_NOT_FOUND|stack/i);
  // and it must not read as an error the member caused or must debug
  assert.match(branch, /needs a newer version/i);
});

test('pressing Connect on an old box does not surface the raw marker', () => {
  const handler = html.match(/data-mcp-add\],\[data-mcp-remove\][\s\S]*?\n  \}\);/)[0];
  assert.ok(handler.indexOf("d.error === 'box-too-old'") < handler.indexOf("notice('mcpNotice'"),
    'the old-box case must be caught before the generic error notice');
});

// The directory is app-side: it owes the member a browsable list whatever the
// box is doing. Both failure branches used to return before loadMcpDir(), so
// #mcpDirRows sat on "Loading the directory…" forever. Connect still refuses,
// through the mcpBoxOk guard, which is an honest refusal; the spinner was not.
test('a box that cannot be read still gets a rendered directory, not a stuck spinner', () => {
  const fn = html.match(/function loadMcp\(\)\{[\s\S]*?\n  \}/)[0];
  const tooOld = fn.slice(fn.indexOf("d.error === 'box-too-old'"), fn.indexOf('if (!d || !d.services)'));
  assert.match(tooOld, /loadMcpDir\(\)/, 'the too-old branch must still load browse');
  assert.ok(tooOld.indexOf('loadMcpDir()') < tooOld.lastIndexOf('return;'), 'before its early return');

  const noAnswer = fn.slice(fn.indexOf('if (!d || !d.services)'), fn.indexOf('mcpBoxOk = true'));
  assert.match(noAnswer, /loadMcpDir\(\)/, 'the no-answer branch must still load browse');
  assert.ok(noAnswer.indexOf('loadMcpDir()') < noAnswer.lastIndexOf('return;'), 'before its early return');

  // and Connect must still refuse, which is what makes the render honest
  assert.match(tooOld, /mcpBoxOk = false/);
  assert.match(noAnswer, /mcpBoxOk = false/);
  const connect = html.match(/function mcpDirConnect\([\s\S]*?\n  \}/)[0];
  assert.match(connect, /if \(!mcpBoxOk\)/, 'the browse Connect is gated on the box having answered');
});

test('a failed read takes the sign-in card down with the rows', () => {
  // it is derived from the data we just said we cannot see; leaving it up
  // asserts "3 sign-ins left" from a stale read, under a line admitting we
  // do not know. Sam had exactly this on screen.
  const fn = html.match(/function loadMcp\(\)\{[\s\S]*?\n  \}/)[0];
  const fail = fn.slice(fn.indexOf('if (!d || !d.services)'));
  assert.match(fail, /mcpSigninHide\(\)/);
});

test('no mcp handler ever shows the bare box-too-old marker', () => {
  // Sam pressed Sign in on a not-yet-restarted box and read "box-too-old" raw.
  // The status path translated it; the sign-in and custom-add paths did not.
  assert.match(html, /function mcpErr\(/, 'one shared translation exists');
  assert.match(html, /MCP_TOO_OLD = 'That needs a newer version of your mineral/, 'and it speaks in words');
  const section = html.slice(html.indexOf('function mcpErr'), html.indexOf('function loadMcp'));
  for (const m of html.matchAll(/notice\('mcp(?:Notice|SigninNotice|CustNotice)', ([^)]+)\)/g)) {
    assert.doesNotMatch(m[1], /d && d\.error\) \|\| outText/, `untranslated error path: ${m[0]}`);
  }
});

test('Update and restart verifies the outcome instead of announcing success', () => {
  // "Restart scheduled" was unfalsifiable: an ignored kill and a failed image
  // download both read as success. The handler must compare the box's identity
  // and running commit before and after, and name all the honest outcomes.
  const start = html.indexOf("$('boxRefreshBtn').onclick");
  const h = html.slice(start, html.indexOf('\n  };', start));
  assert.match(h, /boxVersion\(\)/, 'reads the version before firing');
  assert.match(h, /did not happen: the mineral ignored the signal/i, 'an ignored kill is named');
  assert.match(h, /still running the same software/i, 'a failed download is named');
  assert.match(h, /Done: the mineral restarted/i, 'and success is only claimed on evidence');
  assert.doesNotMatch(h, /back in about a minute'/, 'the old blind promise is gone');
});

// ---- box/page version skew (2026-08-09)
//
// The app and the box update on different schedules, so this feature's two
// halves can always skew. The box verb's guard only checks that the script
// EXISTS, so an OLDER box answers normally and just omits whatever the page has
// since come to rely on. Live on keith: the box predated `url` on rows, the page
// posted a blank one, and every Sign in press said "bad server url" instead of
// the one-click "your box is behind" this page already knows how to show.
test('a box below the needed contract is treated as too old, not as working', () => {
  const fn = html.match(/function loadMcp\(\)\{[\s\S]*?\n  \}/);
  assert.ok(fn, 'loadMcp exists');
  const body = fn[0];
  const guard = /\(d\.contract \|\| 0\) < MCP_CONTRACT_NEEDED/;
  assert.match(body, guard, 'the page must compare the box contract against what it needs');
  // absent must read as 0, never as "fine": every box built before the field
  // exists answers without it, and those are exactly the ones to catch
  assert.match(body, /d\.contract \|\| 0/, 'a missing contract must count as 0');
  assert.ok(body.search(guard) < body.indexOf("d.error === 'box-too-old'"),
    'the check must run BEFORE the too-old branch so it reuses that message');
});

// The one number that must move in lockstep with the box. Bumping CONTRACT in
// mcp-connect.mjs without teaching the page is harmless; the reverse silently
// re-opens exactly the failure this pair exists to close, on every box that has
// not updated yet.
test('the page never demands a contract the box cannot yet report', () => {
  const engine = readFileSync(new URL('../../engine/comms/mcp-connect.mjs', import.meta.url), 'utf8');
  const boxSide = engine.match(/const CONTRACT = (\d+)/);
  const pageSide = html.match(/var MCP_CONTRACT_NEEDED = (\d+)/);
  assert.ok(boxSide, 'the box declares a CONTRACT');
  assert.ok(pageSide, 'the page declares what it needs');
  assert.ok(Number(pageSide[1]) <= Number(boxSide[1]),
    `page needs ${pageSide[1]} but the newest box only reports ${boxSide[1]}`);
});
