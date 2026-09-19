// cadence-gate.test.mjs: run `node --test wizard/panel/cadence-gate.test.mjs`
//
// The mineral's OWN Claude sign-in is the gate under everything unattended.
// Scheduled jobs and Run now both go through the kernel, which shells headless
// `claude -p` against /state/.claude-auth on the mineral. Only an interactive
// sign-in ON the mineral writes that file: connecting the Claude Code desktop
// app over SSH signs in the LAPTOP and leaves it empty. Before this, the app let
// a member arm a full cadence on a signed-out mineral, and every job silently
// never fired. Structural pins (trap 6): wiring and refusals, not copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const cockpit = readFileSync(new URL('../../engine/cockpit/box-cockpit.mjs', import.meta.url), 'utf8');

test('the box names the row so the fix is where the row says it is', () => {
  assert.match(cockpit, /name: 'Claude sign-in on this mineral'/, 'the row names the mineral, not "the box"');
  assert.match(cockpit, /sign in from the Terminal tab/, 'the pending status names the surface that can fix it');
  // SAME RULING, ONE LAYER DOWN (2026-08-20 audit). This asserted the literal
  // `!!rd(path.join(box, '.claude-auth', '.credentials.json'))`, and what it was
  // protecting is that the gate comes from THE FILE THE KERNEL READS rather than
  // from some other signal. That is unchanged. What moved is where the read
  // lives: three files asked this question three different ways and two of them
  // counted a zero-byte credential file as a sign-in, so the read is now one
  // shared module. Pin the ruling at both ends, which is stricter than pinning
  // the spelling at one.
  assert.match(cockpit, /readClaudeCredential\(box\)/,
    'the row reads the sign-in through the one shared reader');
  const reader = readFileSync(new URL('../../engine/lib/claude-credential.mjs', import.meta.url), 'utf8');
  assert.match(reader, /CREDENTIAL_REL = \['\.claude-auth', '\.credentials\.json'\]/,
    'and that reader reads the credential file the kernel reads, not a guess');
  // The GATE is presence, deliberately. The row's sentence says more than that
  // now (see box-cockpit), but `state` must stay on presence alone: locking a
  // member out of their own Cadence page over a grant this side cannot verify
  // would be a worse lie than the one being fixed.
  assert.match(cockpit, /state: claudeAuthed \? 'ok' : 'pending'/,
    'the gate is presence, and nothing this side can prove is allowed to tighten it');
});

test('the gate is computed from the mineral, and never fires on ignorance', () => {
  const fn = html.slice(html.indexOf('function mineralSignedIn()'), html.indexOf('var CARDS = ['));
  assert.match(fn, /if \(!state\.data \|\| !state\.data\.connections\) return null;/,
    'unknown is null, so a page that has not read the mineral yet locks nothing');
  assert.match(fn, /return connLive\(state\.data, CLAUDE_SIGNIN_RE, true\);/, 'strict: configured is not signed in');
  // every CALL must test === false, never falsiness. null would gate too, and
  // gating an unread mineral locks a member out of their own Skills page.
  for (const m of html.match(/(?<!function )mineralSignedIn\(\)[^;\n]*/g) || []) {
    assert.ok(m.startsWith('mineralSignedIn() === false'), `mineralSignedIn() used loosely: ${m}`);
  }
});

test('the Skills page shows the gate and locks the schedule controls', () => {
  assert.match(html, /<div class="ccbanner" id="cadGate" style="display:none">/, 'the banner exists, hidden by default');
  assert.match(html, /var gated = mineralSignedIn\(\) === false;\s*\n\s*\$\('cadGate'\)\.style\.display = gated \? 'flex' : 'none';/,
    'renderSkills computes it once and shows the banner');
  assert.match(html, /skillRow\(s, st, gated\)/, 'the gate is passed down to every row');   // (iteration 2: rows render straight from the installed list, no tab entries)
  assert.match(html, /\$\('cadenceSave'\)\.disabled = gated;/, 'the save button is dead while gated');
});

test('a gated switch refuses instead of flipping', () => {
  const row = html.slice(html.indexOf('function skillRow(s, st, gated)'), html.indexOf('function sendToSignIn()'));
  const toggle = row.slice(row.indexOf('tog.onclick = function()'));
  assert.match(toggle.slice(0, toggle.indexOf('entry.enabled =')), /if \(gated\) return sendToSignIn\(\);/,
    'the toggle returns BEFORE it mutates entry.enabled');
  assert.match(row, /runBtn\.disabled = !!gated;/, 'Run now uses the same kernel, so it is gated too');
  assert.match(row, /if \(gated\) return; commit\(\);/, 'the schedule editor cannot commit either');
  assert.match(row, /tog\.classList\.add\('locked'\)/, 'and it looks locked, not merely inert');
  // opening a drawer to READ a skill must not yank you to a terminal: the editor
  // goes inert, and only the switch and the banner navigate.
  assert.match(row, /if \(gated\) controls\.classList\.add\('locked'\);/, 'the editor is inert, not click-to-navigate');
  assert.match(html, /\.sched\.locked\{opacity:\.45;pointer-events:none\}/, 'and CSS makes that true, not just visual');
});

test('the save verb refuses on its own, not only via a disabled button', () => {
  const save = html.slice(html.indexOf("$('cadenceSave').onclick"), html.indexOf("$('cadenceSave').onclick") + 500);
  assert.match(save, /if \(mineralSignedIn\(\) === false\) return sendToSignIn\(\);/,
    'belt and braces: no path writes a cadence the mineral cannot run');
});

test('every gated refusal lands on a terminal with the command already typed', () => {
  const fn = html.slice(html.indexOf('function sendToSignIn()'), html.indexOf('function sendToSignIn()') + 220);
  assert.match(fn, /activateSec\('terminal'\)/);
  // the opener is chosen by signinOpener() from the page's own fixed list (pinned in
  // terminal-deeplink.test.mjs); it is never a string the mineral supplied
  assert.match(fn, /openTerm\(\{ autorun: signinOpener\(\) \}\)/);
  assert.match(html, /\$\('cadGateBtn'\)\.onclick = sendToSignIn;/, 'the banner button shares the one way in');
});

test('the Help page (where the Claude Code guide lives since R17) says plainly that it does not satisfy the gate', () => {
  const sec = html.slice(html.indexOf('<section data-sec="help">'), html.indexOf('id="ohHost"'));
  assert.match(sec, /This is an extra, not a step/, 'the tab disowns the gate up front');
  assert.match(sec, /It does not sign the <b>mineral<\/b> in/, 'and says which sign-in it is not');
});
