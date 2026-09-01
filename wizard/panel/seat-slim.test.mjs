// seat-slim.test.mjs — run: node --test wizard/panel/seat-slim.test.mjs
//
// Sam's 2026-08-09 audit, ruling R3: the seat page slims down. The
// hand-ownership ask was too advanced a surface to show every member; Origin
// and Danger fold away; and the page points at the tab where joining actually
// lives. The face collapse (2026-09-01) went further: promote and the whole
// custody machinery (transfer, ownership grants, standing asks) retired with
// the central directory, and joining now lives on the Communities tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');
const seat = html.slice(html.indexOf('<section data-sec="seat">'), html.indexOf('<section data-sec="network">'));

test('the hand-ownership ask is RETIRED (2026-09-01), and so is the receiving end', () => {
  assert.ok(!html.includes('id="seatHoOrg"'), 'no handle input');
  assert.ok(!html.includes('id="seatHoSend"'), 'no ask button');
  // R3 kept the accept path because a rock could still stage a transfer.
  // Nothing central can stage one any more, so the accept path went with it
  // and the Waits card renders one honest static line instead.
  assert.ok(!html.includes("run('transfer-accept'"), 'the accept path stays gone');
  assert.ok(html.includes("$('seatWaits').textContent = 'Nothing needs your answer.';"),
    'the Waits card is honestly empty');
});

test('promote is RETIRED (2026-09-01): there is no rock edition to promote into', () => {
  // Promote minted an org identity with the central directory. The directory
  // is deleted; acting as a community hub is now a role any mineral takes by
  // initialising a commons, so the seat carries no promote surface at all.
  assert.ok(!html.includes('id="seatPromoteStart"'), 'no promote button');
  assert.ok(!html.includes('seatPromoteForm'), 'no hidden promote form');
  assert.ok(!html.includes('id="seatPromoteHandle"'), 'no handle input');
});

test('Origin and Danger fold shut instead of holding permanent scroll', () => {
  assert.match(seat, /<details>\s*<summary[^>]*>Origin<\/summary>/, 'Origin is a fold');
  assert.match(seat, /<summary[^>]*>Advanced<\/summary>[\s\S]*id="seatDanger"/, 'Danger sits behind Advanced');
});

test('the seat points at the Communities tab for joining, wired not decorative', () => {
  assert.ok(seat.includes('id="seatGoComms"'), 'the pointer exists');
  assert.match(html, /\$\('seatGoComms'\)\.onclick[\s\S]{0,200}activateSec\('commons'\)/, 'and actually switches sections');
});
