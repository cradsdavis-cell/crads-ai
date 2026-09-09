// verb-said.test.mjs: trap 37 lives here (moved 2026-09-09 from
// community-listing.test.mjs, which died with the community surfaces).
// Run: node --test wizard/panel/verb-said.test.mjs
//
// The shared verb-reporting helpers in member.html (verbWhy / verbSaid /
// boxDown / notLetIn) are what every button consults to tell a human why an
// action failed. They are lifted OUT of member.html and executed, never
// asserted on as source text: the whole point of the trap is that a
// string-shaped check certified a handler that could not report a real failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');

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

const BANNER = '▸ skill-run @ acme-mineral';
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
    'this action needs an Admin login: you are signed in as Support (verb skill-remove is admin-only)',
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
  const ok = { ok: true, code: 0, lines: [BANNER, 'OK: the skill ran and wrote its note.'] };
  assert.match(verbSaid(ok, 'Saved.', 'Could not save that.'), /ran and wrote its note/);
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
