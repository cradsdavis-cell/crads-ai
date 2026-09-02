// join-community-link.test.mjs — the crads-ai://join-community/<token> deep
// link (commons usability overhaul, 2026-09-02; ruling 3). Pins the whole
// chain and the discipline that makes it safe, the terminal-deeplink way:
//   1. the engine mints the link off the bundle (base64url of its body),
//   2. protocol.mjs extracts the TOKEN from argv on a whitelisted charset,
//   3. app.mjs forwards it as #sec=commons&join=<token> (both the fresh-boot
//      and the already-running reopen paths),
//   4. the page decodes it back into the bundle and only ever assigns it to
//      the invitation FIELD's .value — data, never a command, never a verb
//      call. Joining stays the member's own press.
//
// member.html assertions anchor on source positions and lift the ACTUAL
// regex/function text off the page, so these tests only pass while the
// shipped code behaves (same discipline as terminal-deeplink.test.mjs).
//   node --test wizard/panel/join-community-link.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractJoinToken } from './protocol.mjs';
import { linkForBundle, mintBundle, parseBundle } from '../../engine/community/commons-lib.mjs';

const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
const appSrc = readFileSync(new URL('../app.mjs', import.meta.url), 'utf8');

const BUNDLE = mintBundle({ org: 'hg-guild', org_display: 'Harbour Guild', url: 'https://github.com/hg/hg-commons.git', branch: 'main' });
const LINK = linkForBundle(BUNDLE);
const TOKEN = LINK.slice('crads-ai://join-community/'.length);

test('extractJoinToken takes exactly the minted link and refuses everything else', () => {
  assert.equal(extractJoinToken(['some.exe', LINK]), TOKEN);
  assert.equal(extractJoinToken([LINK + '/']), TOKEN, 'a trailing slash from a launcher is tolerated');
  assert.equal(extractJoinToken([encodeURIComponent(LINK) ? LINK.replace(TOKEN, encodeURIComponent(TOKEN)) : LINK]), TOKEN,
    'a percent-encoded arrival still lands');
  for (const bad of [
    'crads-ai://join-community/has spaces',
    'crads-ai://join-community/' + 'x'.repeat(5000),
    'crads-ai://join-community/',
    'crads-ai://join-community/tok$(id)',
    'crads-ai://box/some-box',
    'https://example.com/join-community/abc',
  ]) {
    assert.equal(extractJoinToken([bad]), '', `refused: ${bad.slice(0, 50)}`);
  }
  assert.equal(extractJoinToken([]), '');
  assert.equal(extractJoinToken(), '');
});

test('the token charset is URL-safe by construction, so chat apps cannot mangle it', () => {
  assert.match(TOKEN, /^[A-Za-z0-9_-]+$/);
  assert.equal(encodeURIComponent(TOKEN), TOKEN, 'nothing in it needs escaping');
});

test('app.mjs forwards the token on BOTH launch paths, as data in the hash', () => {
  // fresh boot: the join link wins the surface pick
  assert.match(appSrc, /const wantJoin = extractJoinToken\(process\.argv\);/);
  assert.match(appSrc, /openUrl = `\$\{panelFlipUrl\}#sec=commons&join=\$\{wantJoin\}`/);
  // already running: the reopen carries the join hash instead of the stale one
  assert.match(appSrc, /const joinTok = extractJoinToken\(process\.argv\);/);
  assert.match(appSrc, /#sec=commons&join=\$\{joinTok\}` : prev\.url/);
});

test('the page decodes the token back to EXACTLY the minted bundle (three-layer parity)', () => {
  const src = (html.match(/function joinBundleFromToken\(t\)\{[\s\S]*?\n  \}/) || [])[0];
  assert.ok(src, 'member.html no longer carries joinBundleFromToken');
  const fn = new Function(`return ${src.replace(/^function joinBundleFromToken/, 'function')}`)();   // eslint-disable-line no-new-func
  const back = fn(TOKEN);
  assert.equal(back, BUNDLE, 'engine mint -> protocol extract -> page decode round-trips byte-identically');
  const p = parseBundle(back);
  assert.equal(p.ok, true, p.error);
  assert.equal(p.community.org, 'hg-guild');
  // the page's decoder refuses off-charset and oversized tokens exactly like
  // the protocol layer, so nothing hostile survives to the field
  for (const bad of ['has spaces', 'x'.repeat(5000), '', '!!!']) assert.equal(fn(bad), '');
});

test('join= is handled in the boot path, whitelisted, and only ever fills the field', () => {
  const handler = html.indexOf("[#&]sec=commons(?:&|$)");
  assert.ok(handler > 0, 'the boot path handles #sec=commons');
  const slice = html.slice(handler, handler + 400);
  assert.match(slice, /activateSec\('commons'\)/);
  // lift the ACTUAL join= match off the page and run it
  const joinSrc = (html.match(/location\.hash\.match\((\/\[#&\]join=.*?\/)\)/) || [])[1];
  assert.ok(joinSrc, 'the join= match is gone or reshaped');
  const joinRe = new Function(`return ${joinSrc}`)();   // eslint-disable-line no-new-func
  assert.equal((`#sec=commons&join=${TOKEN}`.match(joinRe) || [])[1], TOKEN);
  assert.equal(('#sec=commons&join=has spaces'.match(joinRe) || [])[1], undefined, 'off-charset never extracts');
  // the token becomes the invitation FIELD's value and nothing else:
  assert.match(html, /ta\.value = bundle;/, 'a .value assignment, the textContent discipline');
  // no verb call and no terminal open can be fed from the hash anywhere
  assert.equal(/run\([^)]*location\.hash/.test(html), false, 'no hash value ever reaches a verb');
  assert.equal(/autorun:\s*[^}]*location\.hash/.test(html), false);
});

test('several minerals: the pre-filled panel says which mineral joins before the press', () => {
  assert.match(html, /state\.targets && state\.targets\.length > 1/);
  assert.match(html, /switch minerals up there first if you mean a different one\. Then press Join\./);
});
