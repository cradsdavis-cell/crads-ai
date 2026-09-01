// rock-tie-names-the-mineral.test.mjs: the UI half of finding 152's siblings.
//   node --test wizard/panel/rock-tie-names-the-mineral.test.mjs
//
// Commit 215353c made /rock-tie-downgrade, /rock-tie-leave and /rock-tie-end
// refuse with 409 when a caller holds several ties and names none, because the
// directory had been sorting and acting on whichever mineral was newest. Both
// of its comments justify the optional slug by asserting the caller already
// sends it:
//
//   "The Rocks page has the slug on every row it draws (/rock-mine returns
//    it), so it says which"
//   "the rock has the slug on every row of /rock-ties, which is where the
//    End-tie button is drawn from, so it says which"
//
// NEITHER UI CALLER DID. Driven against the real page on HEAD, both dead-ended:
//
//   member face, Rocks page   the two anchored pebbles collapsed into ONE row
//                             with ONE "Leave your anchor"; it sent
//                             {org, tie} and the directory answered "say which
//                             one to leave (slug)" onto a screen holding no
//                             mineral name at all
//   rock face, Pebbles page   two correctly named tie cards; pressing End on
//                             pebble-four's card built its body with an empty
//                             5th argument, so no slug key reached the wire,
//                             while the fold above it read "Ending the tie
//                             with pebble-four"
//
// A better failure than the silent corruption it replaced, and still a dead end
// for the person in front of it. So the rule is now: the surface that draws a
// tie row acts on THAT row, and where one row stands for several minerals the
// SCREEN asks which, in front of the request, rather than the request 409ing
// after the fact.
//
// These are behavioural on purpose. The source-level assertions in
// panel.test.mjs (§ WHICH MINERAL THE ACT LANDS ON) already passed on HEAD for
// the verb builder and the panel-server relay: the builder took a slug, the
// relay forwarded a slug, and no page sent one. Reading the pieces is exactly
// how this survived, so these open the page and press the button.
//
// SHOWN TO FAIL ON HEAD, both of them, with wizard/panel/member.html reverted
// to 110d91c and everything else as committed. Verbatim:
//   ✖ the member Rocks page leaves the mineral the reader picked, and only that one
//     AssertionError: both minerals are offered a way out by name
//       actual: 0, expected: 2
//   ✖ the rock console ends the tie on the card it was pressed from
//     AssertionError: the slug of the card the operator pressed reaches the body
//       '' !== 'pebble-four'
//   ✖ a tie row with no name to send says so instead of drawing a button that can only 409
//     AssertionError: no End flow that could only be refused
//       1 !== 0
// The member one stops at the buttons rather than at the request, because on
// HEAD there is only one button and it carries no name: the assertion that
// would have caught the empty body is two lines further down and never runs.
// That is the finding, not a weakness of the test. The empty body itself was
// observed separately, by driving the same page by hand (see above).
//
// Real page, real panel-server, real Chromium. Only the directory beyond
// panel-server is faked, which is the same seam every hermetic test here uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createPanelServer } from './panel-server.mjs';

const CHROME_PATH = process.env.AIOS_QA_CHROME || '';
// Trap 15: skip loudly on a checkout without the dev-harness install, instead
// of failing as if the code were broken (see member-fleet-restale.test.mjs).
const PW_URL = new URL('../../.superpowers/qa/node_modules/playwright-core/index.mjs', import.meta.url);
if (!existsSync(PW_URL) || !CHROME_PATH || !existsSync(CHROME_PATH)) {
  console.error('SKIP rock-tie-names-the-mineral.test.mjs: dev-harness install absent (cd wizard/dev-harness && npm i) (trap 15)');
  process.exit(0);
}
const { chromium } = await import('../../.superpowers/qa/node_modules/playwright-core/index.mjs');
const HTML_PATH = new URL('./member.html', import.meta.url).pathname;
const launch = () => chromium.launch({ headless: true, executablePath: CHROME_PATH, args: ['--no-sandbox'] });
const listen = (opts) => new Promise((resolve) => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlPath: HTML_PATH, ...opts });
  s.on('listening', () => resolve(s));
});
const idToken = (email) => 'x.' + Buffer.from(JSON.stringify({ email })).toString('base64url') + '.sig';

// ---------------------------------------------------------------- member face
test('the member Rocks page leaves the mineral the reader picked, and only that one', async () => {
  const sent = [];
  // One person, two pebbles, BOTH anchored to one rock: the state finding 131
  // made possible by putting the slug in the edge key.
  const edges = [
    { org: 'acme', role: 'member', status: 'active', slug: 'pebble-four', rel: 'anchored', box: 'pebble-four.crads-ai.com' },
    { org: 'acme', role: 'member', status: 'active', slug: 'pebble-five', rel: 'anchored', box: 'pebble-five.crads-ai.com' },
  ];
  const communityFetcher = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/rock-tie-leave')) {
      const body = JSON.parse(init.body);
      sent.push(body);
      // The DEPLOYED worker's answer, copied from directory/worker.js
      // /rock-tie-leave after 215353c: two live anchored edges and no name is
      // a refusal, not a pick. Faked here so the test fails on the PAGE's
      // omission rather than on a network round trip.
      if (!String(body.slug || '')) {
        return { ok: false, status: 409, json: async () => ({ error: `more than one of your minerals holds that tie to ${body.org}: say which one to leave (slug). Nothing has been changed.` }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (u.includes('/edges')) return { ok: true, status: 200, json: async () => ({ edges }) };
    if (u.includes('/rock-tie-notices')) return { ok: true, status: 200, json: async () => ({ notices: [] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const s = await listen({
    edition: 'member',
    bridge: {
      targets: () => [{ host: 'pebble-four-box', kind: 'member', org: 'pebble-four' }],
      stream: (h, c, o = {}) => { const p = new EventEmitter(); p.kill = () => {}; setImmediate(() => { if (o.onStdout) o.onStdout(''); p.emit('close', 0); }); return p; },
      tty: () => {},
    },
    directoryUrl: 'https://dir.example',
    communityFetcher,
    communitySignIn: async () => ({ ok: true, idToken: idToken('jane@example.com') }),
  });
  const base = `http://127.0.0.1:${s.address().port}`;
  let browser;
  try {
    // warm the edges the way the page's own Sign in button does
    await fetch(`${base}/rock-mine/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await new Promise((r) => setTimeout(r, 200));

    browser = await launch();
    const page = await (await browser.newContext()).newPage();
    const confirms = [];
    page.on('dialog', (d) => { confirms.push(d.message()); d.accept(); });
    await page.goto(base + '#rocks', { waitUntil: 'domcontentloaded' });

    const row = page.locator('#rockMine [data-rock="acme"]');
    await row.waitFor({ timeout: 15000 });
    await row.evaluate((el) => el.classList.add('open'));

    // THE SCREEN ASKS. One row (the drawer is the rock's brain and catalogue,
    // identical for both minerals) and one named way out per mineral.
    const leaves = row.locator('.drawer button[data-leave-slug]');
    assert.equal(await leaves.count(), 2, 'both minerals are offered a way out by name');
    assert.deepEqual(await leaves.evaluateAll((bs) => bs.map((b) => b.getAttribute('data-leave-slug'))),
      ['pebble-four', 'pebble-five'], 'and the names are the minerals, not the rock');
    assert.match(await row.locator('.drawer').innerText(), /2 of your minerals are anchored here/,
      'the reader is told why there are two buttons before they press one');

    await row.locator('.drawer button[data-leave-slug="pebble-four"]').click();
    await page.waitForFunction(() => /Left/.test(document.getElementById('rockNotice').innerText), { timeout: 10000 });

    assert.equal(sent.length, 1, 'one leave, one request');
    assert.equal(sent[0].slug, 'pebble-four', 'the page must name the mineral it is leaving');
    assert.equal(sent[0].tie, 'anchored');
    assert.match(confirms[0] || '', /This one: pebble-four/, 'and the confirm says which one, before it goes');

    // ONLY THAT ROW LEAVES THE CACHE. Blind to the slug this dropped both of a
    // member's ties and repainted the page as if two had ended, which is the
    // same defect panel-server.mjs fixed in its own copy of this cache.
    // Since finding 200 the surviving tie is pebble-five's and pebble-four is
    // picked, so it no longer draws on THIS page at all: the page shows the
    // picked mineral's honest empty state, and the survivor is read back
    // through /rock-mine — the same cache the page repaints from.
    await page.waitForFunction(() => /is not tied to any rocks/.test(document.getElementById('rockMine').innerText), { timeout: 10000 });
    assert.match(await page.locator('#rockMine').innerText(), /pebble-four is not tied to any rocks/,
      'the picked mineral\'s empty state, never the other pebble\'s tie');
    const after = await (await fetch(`${base}/rock-mine`)).json();
    assert.deepEqual(after.mine.map((m) => m.slug), ['pebble-five'],
      'the tie that still stands survives the cache, scoped to the slug that left');
  } finally {
    if (browser) await browser.close();
    s.close();
  }
});

// ------------------------------------------------------------------ rock face
const E = 'a'.repeat(64);   // ONE person, TWO pebbles on this rock

const orgServer = (ties, ran) => listen({
  edition: 'org', role: 'admin',
  bridge: {
    targets: () => [{ host: 'acme-rock', kind: 'rock', org: 'acme' }],
    stream: (host, command, o = {}) => {
      ran.push(String(command));
      const p = new EventEmitter(); p.kill = () => {};
      const out = [];
      if (/rock-tie-requests/.test(command)) out.push('ROCK_STATE ' + JSON.stringify({ requests: [], ties }));
      else if (/__INDEX__/.test(command)) out.push('__INDEX__', '[]', '__HEARTBEATS__');
      else if (/rock-tie-end/.test(command)) out.push('{"ok":true}', 'OK: tie ended, and they will see why.');
      else out.push('');
      setImmediate(() => { out.forEach((l) => o.onStdout && o.onStdout(l)); p.emit('close', 0); });
      return p;
    },
    tty: () => {},
  },
  directoryUrl: 'https://dir.example',
  communityFetcher: async () => ({ ok: true, status: 200, json: async () => ({}) }),
});

test('the rock console ends the tie on the card it was pressed from', async () => {
  const ran = [];
  const ROCK_STATE = { requests: [], ties: [
    { e: E, tie: 'anchored', slug: 'pebble-four', box: 'pebble-four.crads-ai.com', status: 'active', updated: Date.now() - 2 * 86400e3 },
    { e: E, tie: 'anchored', slug: 'pebble-five', box: 'pebble-five.crads-ai.com', status: 'active', updated: Date.now() - 86400e3 },
  ] };
  const s = await listen({
    edition: 'org', role: 'admin',
    bridge: {
      targets: () => [{ host: 'acme-rock', kind: 'rock', org: 'acme' }],
      stream: (host, command, o = {}) => {
        ran.push(String(command));
        const p = new EventEmitter(); p.kill = () => {};
        const out = [];
        if (/rock-tie-requests/.test(command)) out.push('ROCK_STATE ' + JSON.stringify(ROCK_STATE));
        else if (/__INDEX__/.test(command)) out.push('__INDEX__', '[]', '__HEARTBEATS__');
        else if (/rock-tie-end/.test(command)) out.push('{"ok":true}', 'OK: tie ended, and they will see why.');
        else out.push('');
        setImmediate(() => { out.forEach((l) => o.onStdout && o.onStdout(l)); p.emit('close', 0); });
        return p;
      },
      tty: () => {},
    },
    directoryUrl: 'https://dir.example',
    communityFetcher: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  const base = `http://127.0.0.1:${s.address().port}`;
  let browser;
  try {
    browser = await launch();
    const page = await (await browser.newContext()).newPage();
    await page.goto(base + '#pebbles', { waitUntil: 'domcontentloaded' });

    // loadRockState is on a 6s first-fire timer on this face; the cards are
    // what we wait on, never a sleep.
    const cards = page.locator('#fleetCards .fleet-card.tied');
    await cards.first().waitFor({ timeout: 20000 });
    assert.equal(await cards.count(), 2, 'a tie row per mineral, as /rock-ties returns them');
    assert.equal(await cards.nth(0).locator('.fcid .nm').innerText(), 'pebble-four');

    const four = cards.nth(0);
    await four.locator('.cardacts button[data-flow="end"]').click();
    await four.locator('.flowpanel details.endopt summary').click();
    await four.locator('.flowpanel input.reasonin').fill('Left the programme');
    await four.locator('.flowpanel button.mini', { hasText: 'End the tie' }).click();
    await page.waitForFunction(() => /Tie with pebble-four ended/.test(document.getElementById('rockTieLog').innerText), { timeout: 10000 });

    // The verb builds the body ON the rock with node, so the slug is the 5th
    // argv. Empty 5th argument means no slug key in the JSON at all, which is
    // exactly what HEAD sent, and what the directory refuses.
    const end = ran.filter((c) => /rock-tie-end/.test(c)).pop();
    assert.ok(end, 'the End reached the bridge');
    const args = end.match(/process\.stdout\.write\(JSON\.stringify\(b\)\)' "\$ORG" '([0-9a-f]{64})' '(\w+)' "\$RSN" '([a-z0-9-]*)'/);
    assert.ok(args, 'the body builder call is recognisable');
    assert.equal(args[1], E, 'the person is the one on the card');
    assert.equal(args[2], 'anchored');
    assert.equal(args[3], 'pebble-four', 'the slug of the card the operator pressed reaches the body');
  } finally {
    if (browser) await browser.close();
    s.close();
  }
});

test('a tie row with no name to send says so instead of drawing a button that can only 409', async () => {
  // Edge rows written before finding 131 put the slug in the edge key carry no
  // slug, so /rock-ties hands the console a row it cannot name. Alone that is
  // still fine: the directory resolves the single live tie of that kind. Beside
  // a SECOND tie of the same kind for the same person it is a refusal with
  // nothing on screen that can clear it, which is the dead end this whole file
  // is about, arriving by a different door.
  const ran = [];
  const s = await orgServer([
    { e: E, tie: 'anchored', slug: 'pebble-four', box: 'pebble-four.crads-ai.com', status: 'active', updated: Date.now() - 2 * 86400e3 },
    { e: E, tie: 'anchored', box: 'legacy.crads-ai.com', status: 'active', updated: Date.now() - 86400e3 },
  ], ran);
  const base = `http://127.0.0.1:${s.address().port}`;
  let browser;
  try {
    browser = await launch();
    const page = await (await browser.newContext()).newPage();
    await page.goto(base + '#pebbles', { waitUntil: 'domcontentloaded' });
    const cards = page.locator('#fleetCards .fleet-card.tied');
    await cards.first().waitFor({ timeout: 20000 });
    assert.equal(await cards.count(), 2);

    // the named one still ends normally: the guard is narrow
    const named = cards.nth(0);
    assert.equal(await named.locator('.fcid .nm').innerText(), 'pebble-four');
    await named.locator('.cardacts button[data-flow="end"]').click();
    assert.equal(await named.locator('.flowpanel details.endopt').count(), 1, 'the nameable tie keeps its End flow');

    // the unnameable one explains itself and offers nothing that would refuse
    const bare = cards.nth(1);
    await bare.locator('.cardacts button[data-flow="end"]').click();
    const body = bare.locator('.flowpanel .fbody');
    assert.equal(await body.locator('details.endopt').count(), 0, 'no End flow that could only be refused');
    assert.equal(await body.locator('input.reasonin').count(), 0, 'and no reason box inviting one');
    assert.match(await body.innerText(), /would not say which/, 'it says why, in the operator’s words');
    assert.match(await body.innerText(), /their own Organisations page/, 'and names the surface that CAN end it');
    assert.ok(!(await body.innerText()).includes('—'), 'no em dash in the copy');
  } finally {
    if (browser) await browser.close();
    s.close();
  }
});
