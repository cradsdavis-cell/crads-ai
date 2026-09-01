// last-used.test.mjs — the launch decision (ruling 6: launch = last-used box).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readLastUsed, writeLastUsed, launchTarget, lastUsedPath } from './last-used.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const tmp = () => join(tmpDir('lastused-'), 'last-used.json');

// The operator's own record, as a value. Nothing in this suite -- or in any
// harness -- may change it, and "unchanged" is the honest assertion: the app
// legitimately writes this file, so "absent" would fail on the machine of
// anyone who has opened their own product.
const realRecord = () => (existsSync(lastUsedPath()) ? readFileSync(lastUsedPath(), 'utf8') : null);

test('a record round-trips', () => {
  const p = tmp();
  assert.equal(readLastUsed(p), '', 'no file is no record, not a crash');
  assert.equal(writeLastUsed('aster-box', p), true);
  assert.equal(readLastUsed(p), 'aster-box');
  assert.equal(writeLastUsed('acme-rock', p), true);
  assert.equal(readLastUsed(p), 'acme-rock', 'the newest wins');
});

test('only wizard-installed alias shapes are accepted, in BOTH directions', () => {
  // This value picks a surface at launch, so a hand-edited or corrupted file
  // must not be able to steer the launcher. Validated on write AND on read.
  const p = tmp();
  for (const bad of ['', '../../etc/passwd', 'aster', 'Aster-Box', 'aster-box; rm -rf /', 'http://x/']) {
    assert.equal(writeLastUsed(bad, p), false, `${JSON.stringify(bad)} is refused on write`);
  }
  assert.equal(existsSync(p), false, 'and nothing was written at all');
  writeFileSync(p, JSON.stringify({ alias: '../../evil' }));
  assert.equal(readLastUsed(p), '', 'a hand-edited file is refused on read too');
});

test('unreadable or malformed files are "no record", never a throw', () => {
  const p = tmp();
  writeFileSync(p, 'not json at all');
  assert.equal(readLastUsed(p), '');
  writeFileSync(p, '{}');
  assert.equal(readLastUsed(p), '');
  assert.match(lastUsedPath(), /last-used\.json$/);
});

// ---------------------------------------------------------------- the decision
const ROCK = { host: 'acme-rock', org: 'acme', kind: 'rock' };
const PEB = { host: 'aster-box', org: 'aster', kind: 'member' };

test('the last-used mineral is what opens', () => {
  assert.deepEqual(launchTarget([ROCK, PEB], 'aster-box'),
    { open: 'member', host: 'aster-box', slug: 'aster', why: 'last used' });
  assert.deepEqual(launchTarget([ROCK, PEB], 'acme-rock'),
    { open: 'panel', host: 'acme-rock', why: 'last used' });
});

test('every way the record cannot be honoured falls back to the door', () => {
  // The safety of the whole feature. A mineral forgotten, torn down or renamed
  // since the record was written must not strand the app pointing at nothing,
  // and the door is the only screen that can CREATE, so the fallback is never a
  // dead end.
  assert.equal(launchTarget([ROCK, PEB], '').open, 'door', 'no record');
  assert.equal(launchTarget([ROCK, PEB], 'gone-box').open, 'door', 'forgotten since');
  assert.equal(launchTarget([], 'aster-box').open, 'door', 'nothing installed at all');
  assert.equal(launchTarget(null, 'aster-box').open, 'door', 'and a missing list is not a crash');
  assert.match(launchTarget([ROCK], 'gone-box').why, /no longer on this computer/,
    'the reason is nameable, so a launch that surprises someone is diagnosable');
});

test('a promoted box is ONE mineral, and opens its rock face', () => {
  // ssh-bridge's PROMOTED overlay emits both kinds under one alias. Same call
  // the inventory's collapse makes: it is a rock, and the rock face is fuller.
  const promoted = [
    { host: 'aster-box', org: 'aster', kind: 'member' },
    { host: 'aster-box', org: 'aster', kind: 'rock', promoted: true },
  ];
  assert.deepEqual(launchTarget(promoted, 'aster-box'),
    { open: 'panel', host: 'aster-box', why: 'last used' });
});

test('junk targets never produce a launch', () => {
  assert.equal(launchTarget([null, {}, { org: 'x' }], 'aster-box').open, 'door');
});

// ---------------------------------------------------------------- the wiring
test('the DASHBOARD is the writer, and app.mjs is the reader', () => {
  // Writing this at the door would miss three of the four ways into a mineral:
  // the picker, a crads-ai://box link from a ready email, and the direct launch
  // a single-mineral machine gets. The dashboard sees all four.
  const member = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
  assert.match(member, /fetch\('\/last-used', \{ method: 'POST'/, 'the dashboard records what it opened');
  assert.match(member, /body: JSON\.stringify\(\{ alias: state\.host \}\)/, 'by alias, which is what launchTarget matches on');

  const panel = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');
  assert.match(panel, /path === '\/last-used'/, 'panel-server accepts it');
  assert.match(panel, /writeLastUsed\(JSON\.parse\(body \|\| '\{\}'\)\.alias, opts\.lastUsedPath\)/,
    'and validates through the module, never by hand, honouring the test override');

  const app = readFileSync(new URL('../app.mjs', import.meta.url), 'utf8');
  assert.match(app, /import \{ launchTarget, readLastUsed, lastUsedPath \} from '\.\/panel\/last-used\.mjs'/, 'app.mjs reads it');
  assert.match(app, /const pick = launchTarget\(allTargets, readLastUsed\(\)\);/, 'and decides with the tested function');

  // and it is the ONE writer: both faces it boots opt into the real file, and
  // nothing else in the tree may (enumerated in the harness test below).
  assert.equal((app.match(/lastUsedPath: lastUsedPath\(\)/g) || []).length, 2,
    'the org face and the member face each opt in, because a pebble owner opens the member one');
});

test('an explicit destination always beats the stored preference', () => {
  // An invite link, a crads-ai://box link and AIOS_FORCE_WIZARD all say where to
  // go. A remembered choice must never override something just clicked, so the
  // last-used branch is LAST in the chain.
  const app = readFileSync(new URL('../app.mjs', import.meta.url), 'utf8');
  const chain = app.slice(app.indexOf('const invitedLink = extractInvite'), app.indexOf('console.log(`Crads-AI'));
  const at = (needle) => chain.indexOf(needle);
  assert.ok(at('extractBox(process.argv)') > -1 && at('launchTarget(allTargets') > -1);
  for (const earlier of ['invitedLink && memberConnectUrl', 'wantBox && memberUrl', 'wantBox && panelFlipUrl', 'AIOS_FORCE_WIZARD']) {
    assert.ok(at(earlier) > -1 && at(earlier) < at('launchTarget(allTargets'),
      `${earlier} is decided BEFORE the stored preference`);
  }
});

test('the real record has exactly ONE writer, and no default destination', () => {
  const before = realRecord();
  // Found FOUR times, 2026-08-13 and 2026-08-14. Every time the same shape:
  // something that is not the app boots the real panel-server, a browser loads
  // member.html, member.html POSTs /last-used as it does on every boot, and the
  // operator's own ~/.crads-ai/last-used.json changes which mineral their app
  // opens next launch. {"alias":"ic-rock"} from .superpowers/qa/qa-harness.mjs,
  // {"alias":"keith-box"} from qa-not-let-in.test.mjs, then qa-topology, each
  // fixed by naming that one harness and handing it a temp path.
  //
  // The fourth was {"alias":"qa-member-two-box"}, and it broke the pattern the
  // earlier fixes assumed: the writer was /tmp/panel-member.mjs, two lines of
  // scratch driver from a live QA session, still listening on 8861 a day later.
  // Not under `node --test`, so the runner guard did not apply; not in the repo,
  // so no enumeration of harnesses could ever have reached it. So the fix is no
  // longer "find the writers". writeLastUsed has NO default destination: a
  // caller that does not name a file writes nothing, and app.mjs is the only
  // caller in the tree that names one. This test pins both halves.
  const root = join(new URL('.', import.meta.url).pathname, '..', '..');
  // .claude holds this checkout's sibling WORKTREES, i.e. whole copies of the
  // repo: scanning them would report another session's app.mjs as an offender.
  const SKIP = new Set(['node_modules', '.git', '.claude']);
  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      if (e.isDirectory()) walk(join(dir, e.name), out);
      else if (e.name.endsWith('.mjs')) out.push(join(dir, e.name));
    }
    return out;
  };
  // Whole tree, not two hand-listed directories, and not filtered down to the
  // files that happen to mention playwright: qa-harness.mjs drives no browser
  // of its own and panel-drive.mjs boots the real server from harness/, which
  // neither of the old roots covered. The invariant is about who may NAME the
  // operator's file, so it has to be asked of every file there is.
  const allowed = new Set(['wizard/app.mjs', 'wizard/panel/last-used.mjs', 'wizard/panel/last-used.test.mjs']);
  const offenders = walk(root)
    .map((f) => f.slice(root.length).replace(/^\/+/, ''))
    .filter((rel) => !allowed.has(rel))
    .filter((rel) => /\blastUsedPath\s*\(/.test(readFileSync(join(root, rel), 'utf8')));
  assert.deepEqual(offenders, [],
    `only the app may name the operator's real last-used record; these also do: ${offenders.join(', ')}`);

  const panel = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');
  assert.match(panel, /writeLastUsed\(JSON\.parse\(body \|\| '\{\}'\)\.alias, opts\.lastUsedPath\)/,
    'the route passes the opt-in straight through, and has no fallback of its own');

  // Belt and braces, kept from the 2026-08-14 morning fix: every boot site that
  // runs the real panel-server OUTSIDE the runner still names its own file. The
  // wall is now the missing default below, not this list -- a site that forgets
  // writes nowhere rather than into the operator's record -- but an embedder
  // that means to remember a choice should say where, and this keeps the two
  // known CLI/spawned boot sites honest about it.
  const outside = [];
  for (const dir of [join(root, 'wizard', 'panel'), join(root, 'wizard', 'dev-harness'),
    join(root, '.superpowers', 'qa'), join(root, 'harness')]) {
    if (!existsSync(dir)) continue;   // optional QA roots; absent in the extraction repo
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.mjs') || f.endsWith('.test.mjs') || f === 'panel-server.mjs') continue;
      const src = readFileSync(join(dir, f), 'utf8');
      if (!/createPanelServer\(\{/.test(src)) continue;
      if (!/lastUsedPath/.test(src)) outside.push(f);
    }
  }
  assert.deepEqual(outside, [],
    `these boot a real panel-server outside the runner without naming a destination: ${outside.join(', ')}`);

  // The behavioural half, and the one a scratch driver reproduces: no path is
  // no write, whether or not we are under the runner. The old guard keyed on
  // NODE_TEST_CONTEXT, which is exactly why /tmp/panel-member.mjs sailed past.
  const wasUnderRunner = process.env.NODE_TEST_CONTEXT;
  assert.notEqual(wasUnderRunner, undefined, 'we are under the runner');
  assert.equal(writeLastUsed('aster-box'), false, 'a caller that names no file writes nothing');
  delete process.env.NODE_TEST_CONTEXT;
  try {
    assert.equal(writeLastUsed('aster-box'), false,
      'and still nothing outside the test runner, which is where the fourth leak lived');
  } finally { process.env.NODE_TEST_CONTEXT = wasUnderRunner; }

  // ...and the operator's real file is untouched by any of that. Compared
  // rather than asserted absent: the app itself writes this file in normal use,
  // so "it does not exist" would fail on any machine whose owner opened their
  // own product. What must never change is that OUR calls changed it.
  assert.deepEqual(realRecord(), before, 'the operator\'s own record is exactly as we found it');
  assert.notEqual(readLastUsed(lastUsedPath()), 'aster-box', 'the fixture alias never reached it');

  // the dev harness must not write at all: a screenshot run has even less
  // business changing what the operator's app opens
  const dev = readFileSync(new URL('../dev-harness/harness.mjs', import.meta.url), 'utf8');
  assert.match(dev, /path === '\/last-used'/, 'the dev harness answers the call the page makes on every boot');
  assert.doesNotMatch(dev, /writeLastUsed/, 'but never persists it');
});
