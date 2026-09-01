// sharing-iter2.test.mjs — panel iteration 2 (2026-08-23) polished the Sharing
// page: per-face toggles, one model of who receives the update, honest chips.
// Run: node --test wizard/panel/sharing-iter2.test.mjs
//
// RETIRED (face collapse, 2026-09-01): the Sharing page died with the thing it
// described. There are no faces to gate toggles by, no anchor rock and no
// joined-rock heartbeat fan-out to disclose, and no Crads AI floor receiving
// anything. What survives is Support access: the member's time-boxed,
// logged, revocable grant that lets the software maker in. That card moved to
// the Help section with its ids and its promises intact, so these pins follow
// it there and hold the rest of the page gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');
const help = html.slice(html.indexOf('<section data-sec="help">'), html.indexOf('</section>', html.indexOf('<section data-sec="help">')));

test('the Sharing page and its face gating are RETIRED (2026-09-01)', () => {
  assert.ok(!html.includes('<section data-sec="sharing">'), 'no Sharing section');
  // A stylesheet selector for #sharingRows lingers as dead CSS; what matters
  // is that no element carries the ids, so nothing can render.
  assert.ok(!html.includes('id="sharingRows"'), 'no consent toggle rows');
  assert.ok(!html.includes('id="sharingSave"'), 'no Save button');
  // Comments still narrate the dead split; nothing may USE it. Strip them,
  // then: no selector keys on the body attribute and no element carries the
  // face classes.
  const live = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!live.includes('body[data-edition'), 'no face attribute for a toggle to hide behind');
  assert.doesNotMatch(live, /class="[^"]*\b(?:memberonly|memonly|orgonly)\b/, 'the face-gating classes are gone with the faces');
});

test('Support access survives on Help, whole: state, grant, revoke, notice, log', () => {
  assert.ok(help.includes('<p class="gtitle">Support access</p>'), 'the card lives in the Help section');
  for (const id of ['supportState', 'supportGrant', 'supportRevoke', 'supportNotice', 'supportEvents']) {
    assert.ok(help.includes(`id="${id}"`), `#${id} moved with it`);
  }
  // The promises are the point of the card; they must survive the move intact.
  assert.ok(help.includes('There is no standing access: nothing opens until you grant it, it expires on its own, you can revoke it at any moment, and every grant is logged right here.'),
    'the no-standing-access promise is intact');
  assert.ok(help.includes('Grant support access for 24 hours'), 'the grant stays time-boxed');
});

test('opening Help loads the support state, so the moved card is live, not decorative', () => {
  assert.match(html, /if \(name === 'help'\) \{ loadOpenFolder\(\); loadSupport\(\); \}/,
    'activateSec wires Help to loadSupport');
  // Get a human still lands a stuck member on the grant control: the old
  // section name rides the sharing-to-help alias and then scrolls to the card.
  assert.match(html, /\$\('getHuman'\)\.onclick[\s\S]{0,200}activateSec\('sharing'\)/, 'Get a human keeps its wiring');
  assert.match(html, /\$\('supportState'\) \|\| \$\('supportEvents'\)/, 'and scrolls to the grant control');
});

test('no em dashes in anything the Help section renders', () => {
  assert.doesNotMatch(help.replace(/<!--[\s\S]*?-->/g, ''), /—/);
});
