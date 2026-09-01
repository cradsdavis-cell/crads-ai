// community-listing.test.mjs — a rock can open its own door.
// Run: node --test wizard/panel/community-listing.test.mjs
//
// Why this file exists. The Mountain model's discovery leg shipped in halves.
// The Worker has POST /community-listing, the door has a "Join a community"
// card that reads GET /communities, and the card's own comment says why it
// exists: "direct-is-dearer made rocks the default channel, so strangers must
// SEE the open communities instead of being silently sold the dearest option."
//
// But NOTHING in the app, the engine or the brain template ever called
// /community-listing. Grepped all three repos on 2026-08-04: one hit, the
// Worker's own route. So no rock could ever be listed, GET /communities could
// only return [], and every stranger opening that card read "No communities
// have opened their door yet" — funnelling them to exactly the dearest option
// the design set out to avoid. Verified by hand: calling the Worker with
// certrock's own pull token listed it immediately and the door then rendered it
// with its blurb, so only the caller was missing.
//
// The command is built here rather than added to the brain template on purpose:
// box-side scripts are frozen at stamp time and nothing updates them, so a new
// template script would reach no rock that already exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERBS } from './panel-server.mjs';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const spec = () => VERBS['community-listing'];

// The policy's real shape (brain-template/org-policy.yaml, 2-level FORMAT
// CONTRACT): the org block ships name EMPTY and marked REQUIRED, and `name:`
// appears AGAIN further down under pulse. Both facts matter to the reader.
const POLICY = (name) => `schema_version: 1

org:
  name: "${name}"                    # REQUIRED. DNS-safe org slug
  display_name: "Cert Rock"
  domain: "example.com"
  persona: "Foreman"

pulse:
  name: "Pulse"               # what this org calls the weekly update
  cadence: "weekly"
`;

// Run the command's OWN handle-read + guard against a policy on disk. Every
// assertion above this line is about the built string; none of them ever ran
// the reader, which is exactly how a verb that could not read a real policy
// shipped green and failed on the first rock that pressed the button.
function readHandle(policy) {
  const dir = tmpDir('commlist-');
  writeFileSync(join(dir, 'org-policy.yaml'), policy);
  const c = spec().build({ listed: true }).command;
  // end marker was `tok=$(` until the self-host strip removed the pull-token
  // gate along with the board it authenticated to
  const script = c.slice(c.indexOf('org=$(node'), c.indexOf('base64 -d')) + '\nprintf %s "$org"';
  return spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8' });
}

test('it reads the handle out of a real policy, scoped to the org block', () => {
  const r = readHandle(POLICY('certrock'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, 'certrock', 'the org block\'s name, not pulse\'s');
});

test('an unfilled policy is refused, and the refusal names the real fix', () => {
  const r = readHandle(POLICY(''));
  assert.equal(r.status, 1, 'a nameless rock must not list');
  assert.doesNotMatch(r.stdout, /Pulse/, 'and must never fall through to another name: line');
  assert.match(r.stdout, /org\.name/, 'the message points at the field to fill');
});

test('the verb exists, is admin-only and mutating', () => {
  assert.ok(spec(), 'a rock needs a way to open its door');
  assert.equal(spec().adminOnly, true, 'listing a rock publicly is an admin act');
  assert.equal(spec().mutating, true);
});

test('it holds no credential and calls no service (self-host strip)', () => {
  // Until 2026-09-01 this verb authenticated with ORG_PULL_TOKEN and POSTed to
  // the central directory's /community-listing. Both are gone; what must now
  // hold is that NOTHING network-shaped or credential-shaped remains.
  const c = spec().build({ listed: true, blurb: 'A community.' }).command;
  assert.doesNotMatch(c, /CREATE_PULL_TOKEN|HCLOUD|CF_API|ORG_PULL_TOKEN/, 'no credential goes near a customer box');
  assert.doesNotMatch(c, /curl|directory\.crads-ai\.com/, 'no call to the deleted board');
  assert.match(c, /retired/, 'the verb says plainly that the board is gone');
});

test('the handle comes from the org policy, never from the caller', () => {
  const c = spec().build({ listed: true }).command;
  assert.match(c, /org-policy\.yaml/, 'a caller must not be able to list someone else');
});

test('listed is a real boolean both ways', () => {
  // Asserted on the COMMAND until the payload moved to stdin to keep free text
  // out of the shell; the flag now travels with the blurb, so check it there.
  const body = (listed) => JSON.parse(Buffer.from(spec().build({ listed }).stdin.trim(), 'base64').toString('utf8'));
  assert.equal(body(true).listed, true);
  assert.equal(body(false).listed, false);
});

test('a blurb that cannot be stored is refused before anything runs', () => {
  assert.throws(() => spec().build({ listed: true, blurb: 'x'.repeat(201) }), /blurb/i, 'too long');
  assert.throws(() => spec().build({ listed: true, blurb: 'bad' + String.fromCharCode(0) + 'null' }), /blurb/i, 'control characters');
});

// The blurb is a free-text line a person writes about their community, so it
// must survive ordinary prose AND hostile input without either breaking the
// command or reaching the shell.
//
// The first cut of this verb interpolated it into a single-quoted shell word and
// refused " \ $ and backtick — but NOT the apostrophe, the one character that
// ENDS a single-quoted string. The test that stood here was named "a hostile
// blurb is refused" and tried a double quote and $(whoami), so it passed while
// "We're a builders' collective" silently corrupted the request body and a
// crafted blurb ran arbitrary commands on the rock's rock container.
// A green suite certifying an injection is worse than no test, so this one now
// asserts the PROPERTY that makes escaping unnecessary: the text never appears
// in the command at all.
test('no blurb text ever reaches the command, however hostile', () => {
  for (const blurb of [
    "We're a builders' collective",
    'quote " and $(whoami) and `id`',
    "x'; touch /tmp/pwned; echo '",
    'back\\slash and $HOME',
  ]) {
    const { command, stdin } = spec().build({ listed: true, blurb });
    const marker = blurb.replace(/[^A-Za-z]/g, '').slice(0, 8);
    if (marker) assert.ok(!command.includes(marker), `blurb leaked into the command: ${blurb}`);
    assert.ok(stdin && stdin.length, 'it travels on stdin instead');
    assert.equal(JSON.parse(Buffer.from(stdin.trim(), 'base64').toString('utf8')).blurb, blurb, 'and arrives intact');
  }
});

test('the built command is valid shell for every one of those blurbs', () => {
  for (const blurb of ["it's fine", "two ' apostrophes '", 'plain']) {
    const { command } = spec().build({ listed: true, blurb });
    const r = spawnSync('bash', ['-n'], { input: command, encoding: 'utf8' });
    assert.equal(r.status, 0, `bash -n rejected the command for ${JSON.stringify(blurb)}: ${r.stderr}`);
  }
});

test('an absent blurb is allowed and simply carries none', () => {
  assert.doesNotThrow(() => spec().build({ listed: false }));
});

// ---- the card that drives the verb (2026-08-10) -----------------------------
// The switch shipped as a bare <input type="checkbox"> inside a <label>, which
// the org form rules then wrecked in the only way they could: `.orgsec input`
// stretched the box to width:100%, and `.orgsec label` retyped its own words as
// an uppercase mono FIELD LABEL, stranded at the right edge of the card. So the
// one control that decides whether a rock is visible to strangers read as a
// broken form row. It now rides the panel's own switch surface (.devrow +
// .toggle + switchable()), and the save reads a class, not `.checked`.
const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

test('the door card is RETIRED (2026-09-01): no listing surface remains in the shell', () => {
  // The card, its switch, its four advertisement fields and both write paths
  // (the instant-apply flip and the blurb save) presumed a public board on
  // the directory worker. The worker is deleted and discovery is a join
  // bundle handed person to person, so the stronger truth is that no page
  // wires the listing verb at all. The old .checked / class-state hazard
  // cannot recur on a control that does not exist; if any of these ids come
  // back, the board is growing back and its tests should come back with it.
  assert.ok(!html.includes('id="commCard"'), 'the card markup is gone (its CSS remnants are dead rules)');
  for (const id of ['commListed', 'commBlurb', 'commOffer', 'commAnchorTerms', 'commJoinTerms', 'commSave']) {
    assert.ok(!html.includes(`id="${id}"`), `#${id} stays out of the shell`);
  }
  assert.ok(!html.includes("run('community-listing'"), 'nothing dials the listing verb from the page');
  assert.ok(!html.includes('function govPublish'), 'the governance publisher went with the board');
});

// ---- Sam's ruling at the T8 cert (2026-08-10): no public exposure while the
// rock cannot host. That gate rode rock-answer's anchored accept, and the face
// collapse (2026-09-01) deleted rock-answer with the rest of the tie
// machinery: there are no hosting obligations to gate because nothing can be
// hosted. The listing builder survives for its own tests, un-gated because it
// no longer goes anywhere.
test('cannot-host gate: RETIRED with rock-answer; the listing builder stays un-gated', async () => {
  const { VERBS, MEMBER_VERBS } = await import('./panel-server.mjs');
  const on = VERBS['community-listing'].build({ listed: true, blurb: 'x' }).command;
  assert.ok(!on.includes('resolveOrgGitHub'), 'nothing to gate: the listing goes nowhere');
  const off = VERBS['community-listing'].build({ listed: false }).command;
  assert.ok(!off.includes('resolveOrgGitHub'), 'delisting always works');
  assert.ok(!('rock-answer' in VERBS) && !('rock-answer' in MEMBER_VERBS),
    'rock-answer stays out of both verb tables: an accept that creates hosting obligations must not come back quietly');
});

// ---- trap 37 (2026-08-12): the door save said "see above" over an empty log.
//
// Sam pressed Save door setting and got `saving…` then "Could not save that
// (see above)", with nothing above it, and the actual refusal never reached the
// screen. Two faults: the handler passed no onLine callback to run(), so it
// streamed nothing into its own log; and it picked its verdict by filtering for
// lines starting with OK:/ERROR, which only matches failures the VERB reports.
// Everything that fails BEFORE the verb runs speaks in another voice.
//
// These tests lift the shared helpers OUT of member.html and run them, rather
// than asserting on their source text: the whole point of the trap is that a
// string-shaped check certified a handler that could not report a real failure.
const helpers = (() => {
  const from = html.indexOf('function outLines(r){');
  const to = html.indexOf('// ---- sidebar identity');
  assert.ok(from > -1 && to > from, 'found the shared verb-reporting helpers');
  // eslint-disable-next-line no-new-func
  return new Function('return (function(){' + html.slice(from, to)
    + 'return { verbWhy: verbWhy, verbSaid: verbSaid, boxDown: boxDown, notLetIn: notLetIn };})()')();
})();

const BANNER = '▸ community-listing @ acme-rock';
const failed = (...lines) => ({ ok: false, code: 1, lines: [BANNER, ...lines] });

test('trap 37: every failure shape reaches the human, not just the verb\'s own ERROR:', () => {
  const { verbWhy } = helpers;

  // 1. the verb's own refusal: still wins, still verbatim
  const own = verbWhy(failed('ERROR: this rock has no GitHub account connected, so it cannot host members yet.'), 'Could not save that.');
  assert.match(own, /no GitHub account connected/, 'the verb speaks for itself when it can');

  // 2-4. the panel server's plain-prose HTTP refusals, which run() hands back as
  // a single body line. NONE of these start with ERROR, and all three were
  // silently dropped by the old prefix filter.
  for (const body of [
    'another action is still running: wait for it to finish (watch its log), then try this again',
    'this action needs an Admin login: you are signed in as Support (verb community-listing is admin-only)',
    'host must be a configured <org>-rock target',
  ]) {
    const out = verbWhy({ ok: false, code: -1, lines: [body], http: 409 }, 'Could not save that.');
    assert.match(out, new RegExp(body.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the panel server\'s own words reach the log: ' + body.slice(0, 24));
  }

  // 5. sshd. The app owns a detector for this state; the door consulted neither.
  const denied = verbWhy(failed('sam@1.2.3.4: Permission denied (publickey).'), 'Could not save that.');
  assert.match(denied, /does not know this computer yet/, 'a refused key is named as a refused key');

  // 6. dockerd. Capital E, lowercase rest: the reason an ERROR prefix test misses it.
  const down = verbWhy(failed('Error response from daemon: No such container: ai-os'), 'Could not save that.');
  assert.match(down, /assistant inside it is not running/, 'a dead container gets the shared explanation');
  assert.ok(!/see above/i.test(down + denied + own), 'nothing points at a log any more');
});

test('trap 37: with nothing to go on it hands over the last line, never a pointer', () => {
  const { verbWhy } = helpers;
  assert.equal(verbWhy({ ok: false, lines: [BANNER] }, 'Could not save that.'), 'Could not save that.',
    'a silent failure says only what the caller knows');
  assert.match(verbWhy(failed('git: command not found'), 'Could not save that.'), /command not found/,
    'an unrecognised last word is still handed over');
});

test('trap 37: success prefers the verb\'s own sentence over a generic "Saved."', () => {
  const { verbSaid } = helpers;
  const ok = { ok: true, code: 0, lines: [BANNER, 'OK: your community is now listed on the public board.'] };
  assert.match(verbSaid(ok, 'Saved.', 'Could not save that.'), /now listed on the public board/);
  assert.equal(verbSaid({ ok: true, lines: [BANNER] }, 'Saved.', 'Could not save that.'), 'Saved.',
    'and falls back to the caller\'s wording when the verb said nothing');
});

test('trap 37: the door save is RETIRED with its card; the helpers it taught survive', () => {
  // The handler that once said "see above" over an empty log went with the
  // listing card (face collapse, 2026-09-01). The lesson lives on in the
  // shared helpers exercised above and in the whole-file scan below, which
  // still walks every surviving run() call.
  assert.ok(!html.includes("$('commSave').onclick"), 'no door save handler remains');
  assert.match(html, /function verbSaid\(/, 'the shared success helper survives');
  assert.match(html, /function verbWhy\(/, 'and the shared failure helper');
});

test('trap 37: nobody says "see above" without having streamed something above', () => {
  // The invariant the door broke, checked per run() CALL rather than per
  // message: walk the call's own argument list (paren-balanced, strings
  // skipped) and then the statement chained onto it. A call whose chain tells
  // the human to look above, while its arguments carry no onLine callback, is
  // pointing at a log it never wrote a line to.
  //
  // Sloppier windows give a false pass on the very handler this trap is about:
  // the door's broken filter was `.filter(function(l){...})` INSIDE its .then,
  // so any `function(l)` search that spans the chain certifies it as streaming.
  const skipString = (s, i) => {
    const q = s[i];
    for (i += 1; i < s.length; i += 1) {
      if (s[i] === '\\') { i += 1; continue; }
      if (s[i] === q) return i;
      if (q !== '`' && s[i] === '\n') return i;   // unterminated: bail on the line
    }
    return i;
  };
  // from the '(' of a call, the index just past its matching ')'
  const closeAt = (s, open) => {
    let depth = 0;
    for (let i = open; i < s.length; i += 1) {
      const c = s[i];
      if (c === '"' || c === "'" || c === '`') { i = skipString(s, i); continue; }
      if (c === '(') depth += 1;
      else if (c === ')') { depth -= 1; if (depth === 0) return i + 1; }
    }
    return -1;
  };
  // from there, the rest of the statement (the .then/.catch chain), to the
  // first ';' at depth zero
  const chainEnd = (s, from) => {
    let depth = 0;
    for (let i = from; i < s.length; i += 1) {
      const c = s[i];
      if (c === '"' || c === "'" || c === '`') { i = skipString(s, i); continue; }
      if ('([{'.includes(c)) depth += 1;
      else if (')]}'.includes(c)) depth -= 1;
      else if (c === ';' && depth <= 0) return i;
    }
    return s.length;
  };

  // every run() call, as a span: its arguments, and the chain hung off it
  const calls = [];
  const anchor = /\brun\(/g;
  let m;
  while ((m = anchor.exec(html))) {
    const open = m.index + m[0].length - 1;
    const shut = closeAt(html, open);
    if (shut < 0) continue;
    calls.push({ at: m.index, args: html.slice(open, shut), end: chainEnd(html, shut) });
  }
  assert.ok(calls.length > 40, 'found the run() calls: ' + calls.length);

  const offenders = [];
  const lineAt = (i) => html.slice(0, i).split('\n').length;
  for (let i = html.indexOf('see above'); i > -1; i = html.indexOf('see above', i + 1)) {
    const line = html.split('\n')[lineAt(i) - 1];
    if (line.trim().startsWith('//')) continue;                 // the trap's own story
    // the INNERMOST call this message belongs to, so an outer loader is not
    // blamed for a message printed by a call nested inside its own handler
    const own = calls.filter((c) => c.at < i && c.end > i).sort((a, b) => b.at - a.at)[0];
    if (!own || /function\(l\)/.test(own.args)) continue;
    offenders.push(lineAt(i) + ': ' + line.trim().slice(0, 80));
  }
  assert.deepEqual(offenders, [], 'these callers point at a log they never wrote to');
});
