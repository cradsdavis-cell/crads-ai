// rock-custody.test.mjs: run `node --test wizard/panel/rock-custody.test.mjs`
//
// RETIRED SUBJECT (the face collapse, 2026-09-01). This file grew up around
// Your rock's "Custody & backup" card: three findings (89, 195, 198) about one
// mineral's backup facts leaking onto another's card, two-clock repaints that
// contradicted a sign-in the box had just verified, and a cul-de-sac where a
// backed-up card offered nothing to press. The card, the page it sat on, the
// renderRockBackup painter and the /org-github/* flow behind it all left with
// the org face: there are no hosted rocks, so there is no org brain for this
// app to custody. What survives is the SEAT's own Backup card, which was
// always the member-side half of the same question ("if this mineral died
// today, is my brain safe"), and the mineral-switch hygiene the findings
// taught, which still guards whatever per-mineral state the switcher keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('./panel-server.mjs', import.meta.url), 'utf8');

test('the org custody card is RETIRED: no card, no painter, no org GitHub flow', () => {
  // The stronger truth the old tests collapse into: the whole surface stays
  // gone. If any of these names come back, the org face is growing back with
  // them, and every finding this file used to pin becomes reachable again.
  for (const gone of ['rockCustodyCard', 'renderRockBackup', 'orgGhStart', 'orgGhPoll', 'factoryNeedsGh']) {
    assert.ok(!html.includes(gone), `${gone} stays out of the shell`);
  }
  assert.ok(!server.includes("path.startsWith('/org-github/')"),
    'panel-server no longer mounts the org GitHub routes');
  assert.ok(!html.includes("run('org-brain-push'"),
    'and the dumb push verb the card once outgrew stays unreached');
});

test('the seat Backup card survives, with the own-brain flow rendering beside it', () => {
  // The member-side answer to "is my brain safe" is now the only one. The live
  // flow region sits OUTSIDE #seatBackup on purpose: finishing repaints that
  // card from the mineral, and an earlier cut put the flow inside it, so the
  // "Done" line was wiped by its own success.
  const card = html.slice(html.indexOf('id="seatBackupCard"'), html.indexOf('id="seatWaits"'));
  assert.match(card, /<div class="gtitle">Backup<\/div>/, 'the card keeps its name');
  assert.match(card, /id="seatBackup"/, 'the state line renders from the mineral');
  assert.match(card, /id="seatObLive"/, 'the flow region exists');
  assert.ok(card.indexOf('id="seatObLive"') > card.indexOf('</div>'),
    'and it sits outside the repainted state line');
  assert.match(html, /fetch\('\/own-brain\/start'/, 'the in-place device flow starts from the page');
  assert.match(server, /if \(path\.startsWith\('\/own-brain\/'\) && ownBrainRoute\(req, res, path\)\) return;/,
    'and panel-server still mounts it, un-gated by any edition');
});

// FINDING 89 / 198, the survivable lesson: switching minerals must drop the
// previous one's per-mineral answers, and zero the throttle so the replacement
// read is not delayed. The custody card that taught it is gone; the switcher
// still keeps per-mineral state, so the forget must outlive the card.
test('89/198: switching minerals still drops the previous one’s kept state', () => {
  const onchange = html.match(/sel\.onchange = function\(\)\{[\s\S]*?\n {4}\};/)[0];
  assert.match(onchange, /state\.orgBackupState = null;/,
    'the backup slot is cleared even though nothing paints it any more');
  assert.match(onchange, /state\.strength = null;/,
    'derived strength flags do not survive the switch');
  assert.match(onchange, /strengthAt = 0;/,
    'and the throttle cannot delay the replacement read');
});

test('89: a failed or empty strength read forgets instead of leaving stale answers', () => {
  const sync = html.match(/function strengthSync\(\)\{[\s\S]*?\n {2}\}/)[0];
  // A bare return is not neutral: it leaves whatever was there, which is the
  // previously selected mineral's answer.
  assert.doesNotMatch(sync, /if \(!line\) return;/, 'an empty read must not bare-return');
  assert.doesNotMatch(sync, /catch \(e\) \{ return; \}/, 'nor an unparseable one');
});
