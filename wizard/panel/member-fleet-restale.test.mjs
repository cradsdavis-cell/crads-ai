// member-fleet-restale.test.mjs: QA findings 165, 166 and the rock-side half of 130.
//
// 165 (which is 134 with the mechanism found). After a successful End the
// Pebbles summary strip flipped LEFT 3 -> 4 while the ended member's own card
// still rendered as ACTIVE and still offered Transfer / End / Manage. Pressing
// the page's own Refresh moved the counters again and left the cards alone.
// Only a hard location.reload() repainted them.
//
// The brief said to find the two different data paths. There are not two: the
// summary strip and the cards are both built from the same `rows` array, one
// screenful apart in renderFleet, and both come from orgx.index. What actually
// happened is that renderFleet PRESERVES the live DOM node of any card carrying
// class .open, and cardFlows adds .open to a card the moment one of its flow
// buttons is pressed. So the card the operator just acted on is precisely the
// one that stops being re-rendered, and Refresh cannot help because Refresh
// re-runs the render that preserves it. The counters were never re-reading from
// somewhere better; the card was simply not being drawn.
//
// The preservation is load-bearing (trap 44 and review 2026-08-09 finding 1: a
// rebuild collapses the fold, wipes a typed teardown arming and detaches a live
// verb's log), so the fix is not to delete it. It is to stop it outliving the
// row it was built from: the card stamps data-shape, and a preserved card is
// only kept while the row still hashes to the same shape.
//
// 166 / 130. `decommissioned` is the one field that can say a mineral's metal is
// gone, and it is written by exactly ONE verb, deprovision-member, which refuses
// before it reaches the stamp whenever owner=member. Every pebble stamped from a
// rock is owner=member, so on those rows an empty `decommissioned` carries no
// information. The copy is not allowed to read it as "the machine is fine".
//
// HOW THE BEHAVIOURAL TEST WORKS. It drives the real page in headless Chromium
// against the real panel-server (via .superpowers/qa/qa-harness.mjs), clicks the
// real End flow, and intercepts only the `stall-board` verb so the registry read
// AFTER the End returns what the real one returns after member-leave writes
// status "left" and runs build-index.mjs. Nothing else is stubbed.
//
// Shown to FAIL on HEAD before the fix: with member.html reverted, the
// behavioural test reports the summary strip at "1 left" while jane01's card
// still carries button[data-flow="end"], which is finding 165 exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const HTML = readFileSync(path.join(HERE, 'member.html'), 'utf8');
const FIXTURES_PATH = path.join(ROOT, '.superpowers', 'qa', 'fixtures-org.json');
const CHROME_PATH = process.env.AIOS_QA_CHROME || '';

// Trap 15: playwright + the pinned Chromium come from the gitignored
// dev-harness install. Absent, skip loudly instead of failing as if the code
// were broken (this file and rock-tie-names-the-mineral escape the qa-* name
// filter, so they were the two that broke the clean-checkout suite).
const PW_PATH = path.join(ROOT, '.superpowers', 'qa', 'node_modules', 'playwright-core', 'index.mjs');
if (!existsSync(PW_PATH) || !CHROME_PATH || !existsSync(CHROME_PATH)) {
  console.error('SKIP member-fleet-restale.test.mjs: dev-harness install absent (cd wizard/dev-harness && npm i) (trap 15)');
  process.exit(0);
}
const { chromium } = await import('../../.superpowers/qa/node_modules/playwright-core/index.mjs');

// ------------------------------------------------------------------ unit level
// The same extraction the finding-154 tests use: run the real functions rather
// than assert on their source, because source reading fine is how 165 survived.
// LAZY on purpose. Extracting at module load makes a missing cardShape kill the
// whole file, including the behavioural test, and a run that never gets as far
// as opening a browser has not shown you the bug. Each test pulls what it needs.
let _fleet = null;
const loadFleet = () => (_fleet || (_fleet = (() => {
  const shapeFrom = HTML.indexOf('function cardShape(m, y){');
  const shapeTo = HTML.indexOf('function renderFleet(){');
  assert.ok(shapeFrom > -1 && shapeTo > shapeFrom, 'found cardShape in member.html');
  const churnFrom = HTML.indexOf('// ---- Churn-risk model');
  const churnTo = HTML.indexOf('// ---- Catalogue');
  assert.ok(churnFrom > -1 && churnTo > churnFrom, 'found the churn-risk model');
  const readFrom = HTML.indexOf('function statusRead(m, y, hb, risk){');
  const readTo = HTML.indexOf('// The facts that used to ride the card face', readFrom);
  assert.ok(readFrom > -1 && readTo > readFrom, 'found statusRead');
  const seenFrom = HTML.indexOf('function seenPhrase(hb){');
  const seenTo = HTML.indexOf('function statusRead(', seenFrom);
  // statusRead leans on cap/esc/skillsGloss; stub only what it needs to speak.
  // eslint-disable-next-line no-new-func
  return new Function('return (function(){'
    + 'var orgx = { membersLoaded: true };'
    + 'function cap(s){ s = String(s); return s.charAt(0).toUpperCase() + s.slice(1); }'
    + 'function skillsGloss(){ return "gloss"; }'
    + HTML.slice(churnFrom, churnTo)
    + HTML.slice(seenFrom, seenTo)
    + HTML.slice(readFrom, readTo)
    + HTML.slice(shapeFrom, shapeTo)
    + 'return { cardShape: cardShape, statusRead: statusRead, stallRisk: stallRisk, orgx: orgx };})()')();
})()));

test('165: an End changes the row SHAPE, which is what a preserved card is allowed to be preserved against', () => {
  const { cardShape } = loadFleet();
  const before = { slug: 'jane01', status: 'active', attached: '2026-08-15', wired: '2026-08-16' };
  const y = { owner: 'member', pending_transfer: '' };
  const after = Object.assign({}, before, { status: 'left' });
  assert.notEqual(cardShape(before, y), cardShape(after, y),
    'an End must break the shape, or the card stays frozen through it');
  // The other three ways a card can start lying while a fold is open.
  assert.notEqual(cardShape(before, y), cardShape(before, { owner: 'org', pending_transfer: '' }),
    'ownership decides the controls, so it is part of the shape');
  assert.notEqual(cardShape(before, y), cardShape(before, { owner: 'member', pending_transfer: 'to-member 2026-08-16' }),
    'a handover in flight earns its own line, so it is part of the shape');
  assert.notEqual(cardShape(before, y), cardShape(Object.assign({}, before, { wired: '' }), y),
    'wiring decides the status sentence, so it is part of the shape');
});

test('165: a heartbeat ticking is NOT a shape change, so a poll cannot wipe a half-typed arming (trap 44)', () => {
  const { cardShape } = loadFleet();
  // The whole reason the preservation exists. If age went into the shape, every
  // background poll would rebuild every open card and we would have traded 165
  // for trap 44.
  const row = { slug: 'jane01', status: 'active', attached: '2026-08-15', wired: '2026-08-16' };
  const y = { owner: 'member', pending_transfer: '' };
  const a = cardShape(row, y);
  const b = cardShape(Object.assign({}, row, { last_seen: 'anything', packs: 4, host: 'moved' }), y);
  assert.equal(a, b, 'facts that cannot make the card lie stay out of the shape');
});

test('165: the preserved-card branch actually compares the shape (structural pin)', () => {
  // The unit test above proves cardShape discriminates. This proves renderFleet
  // uses it. Delete the comparison and the shape function still passes its own
  // tests while the bug is fully back, which is the trap this pin exists for.
  const from = HTML.indexOf('var liveBySlug = {};');
  assert.ok(from > -1, 'found the preservation block');
  const branch = HTML.slice(from, HTML.indexOf("d.className = 'fleet-card'", from));
  assert.match(branch, /live\.getAttribute\('data-shape'\) === cardShape\(m, x\.y\)/,
    'the preserve branch is conditional on the shape being unchanged');
  assert.doesNotMatch(branch, /if \(m\.slug && liveBySlug\[m\.slug\]\) \{ wrap\.appendChild/,
    'the unconditional preserve is gone');
  assert.match(branch, /d\.setAttribute\('data-shape', cardShape\(m, x\.y\)\)/,
    'and every card carries the shape it was built from');
});

test('165: the End outcome sentence lands somewhere the rebuild cannot take with it', () => {
  // The fix repaints the card on success, which throws away the fold holding
  // the "Ended: ..." line. #fleetLog lives outside #fleetCards and survives.
  const ef = HTML.slice(HTML.indexOf('function endFlow(m, y, o){'), HTML.indexOf('// ---- Churn-risk model'));
  assert.match(ef, /if \(rr\.ok\) logTo\(\$\('fleetLog'\), okMsg\);/,
    'a successful End also writes its outcome to the page-level log');
  const markup = HTML.slice(HTML.indexOf('id="fleetCards"'), HTML.indexOf('id="fleetLog"'));
  assert.ok(!markup.includes('</section>'), '#fleetLog is a sibling of the grid, not inside it');
});

test('166: a left row stops asserting the mineral survived', () => {
  const { statusRead } = loadFleet();
  const left = statusRead({ slug: 'qa-member-four', status: 'left', decommissioned: '' }, {}, null, null);
  assert.equal(left.level, 'gone');
  assert.match(left.text, /no record of whether their mineral still exists/,
    'the card says what the rock actually knows about the metal, which is nothing');
  // The one case where the rock DOES know, because it did the destroying itself.
  const torn = statusRead({ slug: 'x', status: 'left', decommissioned: '2026-08-15' }, {}, null, null);
  assert.match(torn.text, /Torn down 2026-08-15/, 'a real teardown still says so, unchanged');
  assert.doesNotMatch(torn.text, /no record/, 'and does not hedge a fact it holds');
});

test('166: the Bring-back control no longer claims the machine is still there', () => {
  // Assert on the STRING THE OPERATOR READS, not on the surrounding block: the
  // block also holds the comment quoting the old copy, and a naive
  // doesNotMatch over the block flags that quotation as the defect.
  const from = HTML.indexOf("else if (m.status === 'left' && orgx.role !== 'support')");
  assert.ok(from > -1, 'found the Bring-back branch');
  const title = HTML.slice(HTML.indexOf('bb.title = ', from)).match(/^bb\.title = '((?:[^'\\]|\\.)*)'/);
  assert.ok(title, 'the control still carries an explanation');
  assert.ok(!/never destroyed/.test(title[1]),
    'the false claim is gone from the copy: nothing on this page can know that');
  assert.match(title[1], /returns a membership row pointing at nothing/,
    'and it names the outcome finding 166 actually observed');
  assert.ok(!/[—]/.test(title[1]), 'no em dash in the new copy');
});

test('130: a reading of a heartbeat is dated, and silence outranks what the last report said', () => {
  const { stallRisk } = loadFleet();
  const at = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const row = { slug: 'cert-one', status: 'active', attached: '2026-08-14', wired: '2026-08-14' };

  // The live case. cert-one's server is gone; its last heartbeat is 2026-08-14
  // with auth_ok:false, onboarded:false, and on 2026-08-16 the card read
  // "Not signed in to Claude yet on their mineral" as a statement about now.
  const stale = stallRisk(row, { generated_at: at(2), auth_ok: false, onboarded: false });
  assert.match(stale.reason, /last reported 2d ago/, 'the sentence dates the claim to the report');
  assert.ok(!/^not signed in to Claude yet/.test(stale.reason), 'and stops asserting it in the present tense');
  assert.ok(stale.age > 1.9 && stale.age < 2.1, 'the verdict carries the real age, not 0');

  // age: 0 on a two-day-old report also sorted the row as the freshest thing on
  // the page, ahead of members whose silence was measured honestly.
  const fresh = stallRisk(row, { generated_at: at(0.2), auth_ok: false, onboarded: false });
  assert.ok(fresh.age < stale.age, 'a fresher report ranks fresher, which age: 0 made impossible');

  // Past the silence threshold no reading of the report may be spoken at all.
  const silent = stallRisk(row, { generated_at: at(9), auth_ok: false, onboarded: false });
  assert.match(silent.reason, /silent 9d/, 'silence wins over anything the last report said');

  // A report with no date can still be read, it just cannot be dated.
  const undated = stallRisk(row, { auth_ok: false, onboarded: false });
  assert.match(undated.reason, /at a time it did not record/);
  assert.equal(undated.age, 0, 'and carries no age it cannot justify');
  for (const r of [stale, fresh, silent, undated])
    assert.doesNotMatch(r.reason, /Infinity|NaN|undefined/, 'finding 129 stays fixed');
});

// ------------------------------------------------------------------ behavioural

const launchChromium = () => chromium.launch({ headless: true, executablePath: CHROME_PATH, args: ['--no-sandbox'] });

function waitForReady(proc) {
  return new Promise((resolve, reject) => {
    let out = '';
    const onData = (d) => {
      out += d.toString();
      const m = out.match(/READY \S+ http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { proc.stdout.off('data', onData); resolve(parseInt(m[1], 10)); }
    };
    proc.stdout.on('data', onData);
    proc.on('error', reject);
    proc.on('exit', (code) => { if (code !== null && !/READY/.test(out)) reject(new Error('harness exited before READY, code ' + code)); });
    setTimeout(() => reject(new Error('harness did not print READY within 10s')), 10000);
  });
}

// The panel's /run is SSE; one frame per line, then __DONE__ for exit 0.
const sse = (lines) => lines.concat(['__DONE__']).map((l) => 'data: ' + JSON.stringify(l) + '\n\n').join('');

test('165 behavioural: after a real End the card follows the counters, in the real page', async () => {
  // What the registry says right now. The End flips it exactly as member-leave
  // does on a rock (status "left", then build-index.mjs), and the next
  // stall-board poll is the thing that carries it back to the page.
  let index = [
    { slug: 'jane01', display_name: 'Jane Ellis', status: 'active', owner: 'member', tier: 'pebble', host: 'jane01-box' },
    { slug: 'omar02', display_name: 'Omar Diaz', status: 'invited', owner: 'org', tier: 'pebble', host: 'omar02-box' },
  ];
  const hbs = { jane01: { generated_at: new Date().toISOString(), auth_ok: true, onboarded: true, skills_installed: 2, skills_enabled: ['daily'], skill_runs: { daily: new Date().toISOString() } } };

  const harness = spawn(process.execPath,
    ['.superpowers/qa/qa-harness.mjs', 'org', '--port', '0', '--fixtures', FIXTURES_PATH],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    const port = await waitForReady(harness);
    browser = await launchChromium();
    const page = await (await browser.newContext()).newPage();

    // Intercept ONLY stall-board. Every other verb hits the real panel-server.
    await page.route('**/run', async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch { /* not ours */ }
      if (body.verb !== 'stall-board') return route.continue();
      const lines = ['▸ stall-board @ ic-rock', '__INDEX__', JSON.stringify(index), '__HEARTBEATS__'];
      for (const slug of Object.keys(hbs)) lines.push('=== ' + slug, JSON.stringify(hbs[slug]));
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse(lines) });
    });

    await page.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil: 'networkidle' });
    await page.click('button[data-group-toggle="network"]');
    await page.click('button[data-sec="pebbles"]');
    const jane = page.locator('.fleet-card[data-slug="jane01"]');
    await jane.waitFor({ timeout: 10000 });
    assert.equal(await jane.locator('button[data-flow="end"]').count(), 1, 'jane01 starts as an active member with an End');

    // Open the End fold. THIS is what marks the card .open, and .open is what
    // used to freeze it forever.
    await jane.locator('button[data-flow="end"]').click();
    await jane.locator('.flowpanel details.endopt summary').first().click();
    await jane.locator('.flowpanel input.reasonin').fill('qa: finding 165');
    await jane.locator('.flowpanel button.endpick').first().click();   // keep the door cheap to reopen

    // The rock writes the row and rebuilds the index while the verb runs, so the
    // NEXT stall-board is the one that carries "left" back.
    index = index.map((r) => (r.slug === 'jane01' ? Object.assign({}, r, { status: 'left' }) : r));
    await jane.locator('.flowpanel button.mini', { hasText: 'End the membership' }).last().click();

    // The summary strip is the half that always worked. Wait on it, so the
    // assertion below is about the CARD and not about timing. 79695ca (run-6
    // lifecycle redesign): a status:'left' row buckets to "ended" on the strip.
    await page.waitForFunction(() => /1\s*ended/.test((document.getElementById('fleetSummary').textContent || '').replace(/\s+/g, ' ')), { timeout: 10000 });

    const summary = (await page.locator('#fleetSummary').innerText()).replace(/\s+/g, ' ');
    assert.match(summary, /1\s*ended/i, 'the counters moved, as they always did');

    // 79695ca (run-6 lifecycle redesign): an ended member no longer renders as
    // a .fleet-card at all — it becomes a compact .fleet-erow under the Ended
    // section, which satisfies finding 165 structurally: the stale ACTIVE card
    // cannot survive because it is not re-appended, and an erow carries no
    // flow buttons to offer.
    assert.equal(await page.locator('.fleet-card[data-slug="jane01"]').count(), 0,
      'FINDING 165: the ended member must not still render as an active card');
    const card = page.locator('.fleet-erow[data-slug="jane01"]');
    await card.waitFor({ timeout: 10000 });
    const cardText = await card.innerText();
    assert.equal(await card.locator('button[data-flow]').count(), 0,
      'FINDING 165: an ended row offers no End / Transfer / Manage');
    assert.match(cardText, /left/i, 'the row says what the counters say');

    // 166, in the same page: the row that just left offers Bring back, and the
    // copy no longer promises the mineral survived (this row predates exit
    // records, so the honest sentence is the does-not-know one).
    assert.match(cardText, /does not know what happened to their mineral/,
      'FINDING 166: the row admits the rock cannot see the metal');
    // R6 (panel iteration 2): the ended row also carries Forget, so pick the
    // Bring back control by name rather than by position.
    const bb = card.locator('.eact button.mini', { hasText: 'Bring back' });
    assert.equal(await bb.innerText(), 'Bring back', 'the control is still there, because refusing would be the same guess');
    const title = await bb.getAttribute('title');
    assert.ok(!/never destroyed/.test(title || ''), 'and it stops claiming the machine is fine');

    // And the outcome sentence survived the repaint.
    assert.match(await page.locator('#fleetLog').innerText(), /Ended:/,
      'the confirming sentence did not vanish with the fold');
  } finally {
    if (browser) await browser.close();
    harness.kill('SIGKILL');
  }
});
