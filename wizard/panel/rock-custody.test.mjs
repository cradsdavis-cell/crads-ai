// rock-custody.test.mjs: run `node --test wizard/panel/rock-custody.test.mjs`
//
// Your rock's "Custody & backup" card. It shipped as three static sentences, one
// of which ("Backup state is not readable from this app yet") stopped being true
// the day org-backup-status shipped for the strength card, and none of which was
// pressable. So "Back up the org brain" sent a rock owner to a page whose only
// instruction was to go and type a command somewhere else.
//
// It drives `connect-github` rather than growing a second GitHub flow: that
// script already detects a rock via /state/brain/org-policy.yaml and targets the
// org brain, and since 2026-08-09 a self-serve rock's brain is born with no
// remote, so it is the ONLY way that brain ever gets an offsite copy. The
// pebble's one-click device flow is mounted member-edition only (panel-server
// gates /own-brain/ on edition === 'member'), so it is not available here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');
const connectGh = readFileSync(new URL('../../engine/connect-github.sh', import.meta.url), 'utf8');
// The whole function, not a fixed-width slice: the body grew past 2000 chars on
// 2026-08-10 and the assertions started failing on text that was still there.
const fn = html.match(/function renderRockBackup\(\)\{[\s\S]*?\n {2}\}/)[0];

test('the card no longer claims the backup state is unreadable', () => {
  const cardHtml = html.slice(html.indexOf('id="rockCustodyCard"'), html.indexOf('id="commCard"'));
  assert.ok(!/not readable from this app/i.test(cardHtml), 'that claim was false once org-backup-status shipped');
  assert.match(cardHtml, /<div id="rockBackup"/, 'the card has a live region instead');
});

test('it reads the truth the strength card already fetches, rather than a second probe', () => {
  assert.match(html, /state\.orgBackupState = st;/, 'org-backup-status result is kept for the card');
  assert.match(html, /renderRockBackup\(\);/, 'and the card repaints when it lands');
  assert.match(html, /renderRockIdentity\(\); renderRockBackup\(\);/, 'opening Your rock paints it too');
});

test('the three states are distinct, and connected-but-never-pushed is not "backed up"', () => {
  // UNKNOWN SAYS UNKNOWN, and since 2026-08-13 it distinguishes the two kinds of
  // unknown. "checking…" forever is its own small untruth once the read has
  // actually FAILED, and it is indistinguishable from a slow box. It matters
  // here more than anywhere else on the surface: this is the half of finding 89
  // where a failed read used to leave the PREVIOUS mineral's repository on
  // screen, so the card confidently told an owner their brain was safe in
  // another organisation's repo.
  assert.match(fn, /if \(!st\) \{/, 'unknown is still handled before anything is claimed');
  assert.match(fn, /state\.orgBackupUnknown/, 'a failed read is distinguished from a slow one');
  assert.match(fn, /Could not read this rock’s backup just now/, 'and it says so rather than claiming anything');
  assert.match(fn, /'checking…'/, 'while a genuinely pending first read still says checking');
  // `st.last` alone was BOTH too strict and too loose (2026-08-12). Too loose:
  // it is only ever set from brain-push.log, so it says nothing about whether
  // the wired remote was ever reachable. Too strict: only the 03:50 cron writes
  // that log, so a rock that had backed up ten seconds ago read as unbacked
  // until the next morning. `st.pushed` is git's own answer — a remote-tracking
  // ref exists, so a push landed — and it is the one that decides.
  assert.match(fn, /if \(st\.connected && \(st\.pushed \|\| st\.last\)\)\{/, 'backed up needs a push, not just a remote');
  assert.match(fn, /st\.connected\s*\n?\s*\? 'Wired to/, 'wired-but-unpushed is its own sentence');
  assert.match(fn, /No offsite copy yet/, 'and never-connected is its own');
  assert.match(fn, /okword/, 'only the fully-backed-up state gets the good-news styling');
});

// FINDING 195: the card offered "Connect GitHub" directly above its own green
// "Connected as <login>, your brain backs up to <repo>" line.
//
// Nothing was wrong on the box: origin and the tracking ref were both correct
// the whole time. The card answers from TWO CLOCKS. The outcome line is written
// the instant the flow reports done; the headline, the button and the hint are
// derived from `state.orgBackupState`, which does not exist until an SSH read of
// the mineral comes back (~4s, longer if the verb queues). For that window the
// card showed the pre-press prompt under the success it had just announced,
// which is the one contradiction this card cannot afford: it is the surface that
// answers "if this mineral died today, is my brain safe".
//
// Trap 23's rule was "a result a repaint can erase is a result the user never
// had". Its other half, missed until now: a repaint that cannot see the result
// is a repaint that contradicts it.
test('195: the done handler writes the box’s verified answer, rather than only printing it', () => {
  const poll = html.match(/function orgGhPoll\(\)\{[\s\S]*?\n {2}\}/)[0];
  assert.match(poll, /state\.orgBackupState = \{ connected: true, repo: st\.repo, pushed: true/,
    'a repo in the done payload is a verified push, so the card may say so at once');
  // `pushed: true` is not a guess: the box asked GitHub for that repository's
  // tip and got back a commit this brain holds before it ever emitted BACKUP_REPO.
  const routes = readFileSync(new URL('./org-github-routes.mjs', import.meta.url), 'utf8');
  assert.match(routes, /BACKUP_REPO=\$SLUG/, 'which is the only thing that emits a repo');
  assert.match(routes, /git cat-file -e "\$TIP\^\{commit\}"/, 'and it is emitted only after GitHub is asked');
  assert.match(poll, /last: ''/, 'but the timestamp is left for the confirming read (finding 104)');
  assert.match(poll, /renderRockBackup\(\);\s*\n\s*renderCards\(\);/,
    'and both surfaces repaint in the same tick as the outcome');
  // No repo means the token landed and the copy did not, and the box unwires a
  // remote it could not push to. Claiming nothing is the only honest move; what
  // it must never do is fall back to the prompt to connect an account that is
  // already connected.
  assert.match(poll, /state\.orgBackupState = null;/, 'a failed copy claims nothing');
  assert.match(poll, /state\.orgBackupUnknown = false;/, 'and reads as pending, not as a failed read');
});

test('195: every branch of the card carries the live region', () => {
  // It used to be emitted by the never-connected branch alone. So the two states
  // reachable AFTER a successful sign-in, backed-up and unknown-while-re-reading,
  // both destroyed the outcome the flow had just painted.
  assert.match(fn, /var live = '<div id="rockBackupLive"/, 'one variable, not a per-branch afterthought');
  assert.equal((fn.match(/\+ live/g) || []).length, 3, 'appended by every paint: unknown, backed up, and the button states');
  assert.doesNotMatch(fn, /el\.textContent =/,
    'the unknown branch used textContent, which cannot carry the live region at all');
  assert.equal((fn.match(/id="rockBackupLive"/g) || []).length, 1,
    'and the id is built in one place, so no branch can emit a second one');
});

// FINDING 89: a rock's Custody card showed ANOTHER rock's backup repository.
//
// Every store was individually correct. No store-level reconcile could ever have
// seen it, because it is the UI attributing one mineral's fact to another, and
// that is the whole argument for driving these surfaces as a user.
//
// Two mechanisms, and BOTH have to be closed or the lie comes back by the other
// route. Custody is the card that answers "if this mineral died today, is my
// brain safe"; in a cohort where one operator administers several rocks it is
// the card most likely to be trusted and least likely to be double-checked.
test('89: switching minerals drops the previous one’s custody facts', () => {
  const onchange = html.match(/sel\.onchange = function\(\)\{[\s\S]*?\n {4}\};/)[0];
  assert.match(onchange, /state\.orgBackupState = null;/,
    'the previous mineral’s backup must not survive the switch');
  assert.match(onchange, /state\.strength = null;/,
    'nor its derived strength flags, which feed the same card');
  assert.match(onchange, /strengthAt = 0;/,
    'and the throttle must not delay the replacement read by up to a minute');
});

// FINDING 198: the flow OUTCOME survived the mineral switch, the third
// mechanism behind the same contradictory screen (after 195's two clocks and
// 89's kept state). orgGhOutcome is held in a variable so repaints re-emit it
// (trap 23), so the 89 forget alone re-painted the PREVIOUS mineral's green
// "your brain backs up to <that rock's repo>" under the NEW mineral's honest
// "No offsite copy yet". Observed live 2026-08-17: qa-r2-gmail's connect
// outcome under institute-of-shenanigans' never-connected card.
test('198: switching minerals ends the flow conversation, not just the state', () => {
  const onchange = html.match(/sel\.onchange = function\(\)\{[\s\S]*?\n {4}\};/)[0];
  assert.match(onchange, /orgGhOutcome = '';/,
    'the previous mineral’s outcome sentence must not survive the switch');
  assert.match(onchange, /orgGhStop\(\);/,
    'an in-flight poll must not write one mineral’s result into another’s card');
  assert.match(onchange, /orgGhBusy = false;/,
    'nor may the new mineral’s button stay disabled for a flow it never ran');
  assert.match(onchange, /orgGhUi = \{ btn: 'factoryGhBtn', live: 'factoryGhLive', done: null \};/,
    'the UI thread returns to its default owner');
});

test('89: a failed or empty read clears the card instead of leaving it', () => {
  const sync = html.match(/function strengthSync\(\)\{[\s\S]*?\n {2}\}/)[0];
  // The original was `if (!line) return;` and `catch (e) { return; }`. A bare
  // return is not neutral: it leaves whatever was there, which is the previously
  // selected mineral's repository.
  assert.doesNotMatch(sync, /if \(!line\) return;/,
    'a bare return leaves the previous mineral’s backup rendered');
  assert.doesNotMatch(sync, /catch \(e\) \{ return; \}/,
    'and so does a bare return on unparseable output');
  assert.match(sync, /if \(!line\) \{ forget\(\); return; \}/, 'an empty read forgets');
  assert.match(sync, /catch \(e\) \{ forget\(\); return; \}/, 'an unparseable read forgets');
  assert.match(sync, /\}\)\.catch\(forget\);/, 'and so does a rejected verb');
  assert.match(sync, /state\.orgBackupState = null;/, 'forgetting really drops the card’s source');
});

test('the button runs the sign-in IN PLACE; it never opens a terminal', () => {
  // THIS TEST USED TO ASSERT THE OPPOSITE, and was right to at the time: the
  // one-click device flow was mounted member-edition only, so the rock's only
  // route really was `connect-github` in a terminal. On 2026-08-10 Sam pressed
  // this button and got the GitHub CLI's arrow-key picker: "pretty intimidating
  // for a non-technical user". The org edition now serves the same flow at
  // /org-github/*, so the terminal hop is gone and this pins its absence.
  assert.doesNotMatch(fn, /activateSec\('terminal'\);\s*\n\s*openTerm\(\{ autorun: 'connect-github' \}\);\s*\n\s*\}/,
    'the unconnected path must not land anyone in a terminal');
  assert.match(fn, /orgGhStart\(\{ btn: 'rockBackupGh'/, 'it runs the device flow into this card');
  // and the already-connected branch runs the PUSH in place too, rather than
  // the terminal hop it used to take (2026-08-10, "/state is not a git
  // repository" from a sign-in script asked to do a push).
  // ...and since 2026-08-12 that push is the FULL backup leg, not a bare git
  // push. The bare one had no idea the remote could be another box's repo, so
  // once the adopt-by-name failure wired one, this button could do nothing but
  // repeat the same non-fast-forward rejection with no way back to Connect
  // GitHub. Sam: "There is no option to Connect GitHub again. I already have."
  assert.match(fn, /if \(st\.connected\) \{ orgGhBackup\(\); return; \}/);
  assert.doesNotMatch(html, /run\('org-brain-push'/,
    'the card must not reach for the dumb verb again: it cannot repoint, name or verify');
  assert.match(server, /edition === 'org' && path\.startsWith\('\/org-github\/'\)/,
    'which requires the org edition to serve those routes');

  // connect-github is still the box-side truth the flow drives, and it is still
  // rock-aware, so reusing it rather than reimplementing the repo rules is safe.
  assert.match(connectGh, /org-policy\.yaml/, 'connect-github detects a rock');
  assert.match(connectGh, /BOX=\/state\/brain/, 'and targets the org brain');
  // and typing it by hand is gentle now too: no interactive picker
  assert.match(connectGh, /gh-device-login\.mjs/, 'the terminal route is promptless as well');
});

test('the repo name is shown but never a credential', () => {
  // org-backup-status strips any user:token@ from the remote URL before it ever
  // leaves the box, so the repo name this card renders cannot carry a credential
  assert.ok(server.includes(String.raw`[^@\\/]*@`), 'the verb strips user:token@ from the remote URL');
  assert.match(fn, /esc\(st\.repo \|\| 'your repository'\)/, 'and the app escapes what it renders');
});

// ---- backed up is not always signed in (ingrid, 2026-08-17) ---------------
// On a born rock one sign-in covers backup AND building pebbles, so the
// backed-up branch never needed a button. A promoted rock's backup rides the
// member-era connection it brought with it, while the rock's own sign-in has
// never happened — and the Overview's "Connect GitHub" step pointed at a card
// showing only "Backed up" with nothing to press. The 2026-08-10 cul-de-sac
// ("There is no option to Connect GitHub again"), second shape.
test('the backed-up custody card still offers Connect GitHub when the factory says it is missing', () => {
  const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
  const branch = html.match(/if \(st\.connected && \(st\.pushed \|\| st\.last\)\)\{[\s\S]*?return;\n    \}/);
  assert.ok(branch, 'the backed-up branch must still exist');
  assert.match(branch[0], /factoryNeedsGh === true/, 'gated on the factory’s own verdict, so card and ladder cannot disagree');
  assert.match(branch[0], /rockBackupGh/, 'the connect button renders in the backed-up state');
  assert.match(branch[0], /orgGhStart\(/, 'wired to the same sign-in flow the unconnected branch runs');
  assert.match(branch[0], /loadFactoryStatus\(\)/, 'and a finished sign-in re-asks the factory, so the rung clears');
  assert.match(branch[0], /rock’s own sign-in/, 'the copy says whose sign-in is missing, not just "connect"');
});

test('the factory answer repaints the custody card, so the offer is not a first-paint race', () => {
  const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
  const lfs = html.match(/function loadFactoryStatus\(\)\{[\s\S]*?\n  \}/);
  assert.ok(lfs, 'loadFactoryStatus must still exist');
  assert.match(lfs[0], /renderRockBackup\(\);/, 'factory verdict arriving repaints the card that renders on it');
});

// The repaint above closes the window from the far end; this closes it at the
// near end. A finished sign-in painted the backed-up branch while
// factoryNeedsGh still held the answer from BEFORE that sign-in, so for the
// length of one SSH round-trip the card offered "Connect GitHub" directly
// under "Connected as <account>": finding 195's own defect, surviving in the
// one field that fix did not cover because the button did not exist yet
// (ingrid added it the same day). The flow IS the rock's GitHub sign-in, so
// the verdict is knowable in the same tick. Caught by the driven test in
// qa-checklist-landing.test.mjs, which reads the whole card atomically at the
// instant the outcome lands.
test('a finished sign-in clears the stale GitHub gap BEFORE it repaints the custody card', () => {
  const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
  // anchored on the finding-195 comment, which is unique; the assignment lines
  // inside this block are not (orgBackupUnknown is cleared on three paths).
  const done = html.split('THE PAINT FOLLOWS THE RESULT (finding 195')[1];
  assert.ok(done, 'the done-stage handler must still exist');
  const clearIdx = done.indexOf('\n        factoryNeedsGh = false;');
  const paintIdx = done.indexOf('\n        renderRockBackup();');
  assert.ok(clearIdx > -1, 'the stale GitHub gap is cleared on a successful connect');
  assert.ok(paintIdx > -1, 'sanity: the done handler repaints the custody card');
  assert.ok(clearIdx < paintIdx, 'and it is cleared BEFORE the paint, not after it');
  assert.ok(done.indexOf('loadFactoryStatus()') > paintIdx,
    'the box still confirms it a moment later, so this is a same-tick answer, not a replacement for the read');
});
