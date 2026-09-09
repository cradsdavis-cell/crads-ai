#!/usr/bin/env node
// shoot.mjs - capture every declared docs shot from the Driftwood fixture.
//
//   cd wizard/dev-harness && npm i          # once, for playwright
//   node docs/product/pipeline/shoot.mjs [--out <dir>] [--port 4612]
//
// Release step, not a CI step (trap 15: browser rigs are out of the clean
// suite). The contract between pages and shots is pinned by shots.test.mjs,
// which needs no browser; this only produces the pixels.
//
// Output is gitignored. Screenshots are build artefacts: the website build and
// the in-image bundle each run this, so a shot can never be older than the
// release it ships with.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../wizard/dev-harness/node_modules/playwright/index.mjs';
import { navTo } from '../../../wizard/dev-harness/nav.mjs';
import { SHOTS } from './shots.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const OUT = resolve(arg('--out', join(REPO, 'docs', 'product', 'shots')));
const PORT = parseInt(arg('--port', '4612'), 10);
const BASE = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });

const harness = spawn(process.execPath,
  [join(REPO, 'wizard', 'dev-harness', 'harness.mjs'), '--port', String(PORT)], { stdio: 'pipe' });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('harness did not start')), 8000);
  harness.stdout.on('data', (d) => { if (String(d).includes('dev-harness up')) { clearTimeout(t); res(); } });
  harness.on('exit', (c) => rej(new Error(`harness exited early (${c})`)));
});

const browser = await chromium.launch();
const failures = [];
const report = [];

for (const s of SHOTS) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  const errors = [];
  let warn = null;
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  try {
    // Every world is picked through /state/<world>, the only route that also
    // fires resetFlows(): a per-shot world has to be a fresh one.
    await page.goto(`${BASE}/state/${s.world}`, { waitUntil: 'load' });
    // The join page needs its #v1.… fragment; the harness hands out a complete
    // demo URL from /join-url, which is the only form it guarantees to serve.
    // `query` rides the page URL: the harness reads page-level switches from
    // the referer (`?provision=ready`, `?setup=done`), the same way `?state=`
    // picks a world, so a shot can open a flow on a chosen screen.
    let url = `${BASE}/${s.surface}${s.query ? `?${s.query}` : ''}`;
    if (s.surface === 'join') {
      const r = await page.goto(`${BASE}/join-url`, { waitUntil: 'load' });
      url = JSON.parse(await r.text()).url;
    }
    await page.goto(url, { waitUntil: s.waitUntil });
    if (s.sec) await navTo(page, s.sec);
    // Readiness is a CONDITION, not a stopwatch. The first docs capture of the
    // Overview page used a 1200ms wait and photographed eleven grey skeleton
    // cards: a shot that looks like the product is broken. Wait for the
    // skeletons to clear, then let the last paint land.
    await page.waitForFunction(
      () => document.querySelectorAll('.skel, .h1skel').length === 0,
      null, { timeout: 15000 },
    ).catch(() => { warn = 'skeletons never cleared'; });
    await page.waitForTimeout(s.waitMs);
    for (const sel of s.clicks) {
      const el = await page.$(sel);
      if (!el) throw new Error(`click ${sel} matched nothing`);
      await el.click();
      await page.waitForTimeout(600);
    }
    // ACTS: the reader's own gestures, in order, for a screen that only exists
    // partway through a flow (the wizard's token form, its catalogue, its
    // build screen). Same rule as clicks and marks: a selector that matches
    // nothing FAILS the shot, because a screenshot of the wrong screen is a
    // page that lies with a straight face.
    for (const a of s.acts) {
      if (a.wait) { await page.waitForTimeout(a.wait); continue; }
      const sel = a.click || a.fill;
      const el = await page.$(sel);
      if (!el) throw new Error(`act ${a.click ? 'click' : 'fill'} ${sel} matched nothing`);
      if (a.fill) await el.fill(String(a.value ?? ''));
      else await el.click();
      await page.waitForTimeout(600);
    }
    // The version chip reads "Dev build" when the harness serves the page: a
    // harness artefact, not product truth, and published docs should not
    // photograph it (v1 finding 3, ruled at the 2026-08-25 fix-all). Hidden,
    // not removed, so layout does not shift.
    await page.evaluate(() => {
      for (const e of document.querySelectorAll('*')) {
        if (e.children.length === 0 && e.textContent.trim() === 'Dev build') e.style.visibility = 'hidden';
      }
    });
    // ANNOTATIONS, resolved from the live page. Each mark's element box is
    // recorded as PERCENTAGES of the captured image, so the callout follows the
    // control when the UI moves. A selector that matches nothing is a FAILED
    // shot, not a quiet omission: an annotation that silently disappears leaves
    // a page describing a numbered callout the reader cannot see.
    const marks = [];
    if (s.marks.length) {
      const shotBox = s.full
        ? await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }))
        : page.viewportSize();
      const W = shotBox.w || shotBox.width;
      const H = shotBox.h || shotBox.height;
      for (const [i, m] of s.marks.entries()) {
        const el = await page.$(m.sel);
        if (!el) throw new Error(`mark ${i + 1} (${m.sel}) matched nothing`);
        const b = await el.boundingBox();
        if (!b) throw new Error(`mark ${i + 1} (${m.sel}) is not visible`);
        // A mark must land INSIDE the captured image. boundingBox() is in page
        // coordinates, so on a viewport capture an element below the fold
        // produces a percentage over 100 and the marker renders on top of the
        // prose underneath the figure. Found by looking at the rendered page:
        // the Health card's callout was drawn across the legend. Refused rather
        // than clamped, because a clamped box points at the wrong control, and
        // the fix is either `full: true` or a mark that is actually visible.
        const pct = {
          x: (b.x / W) * 100, y: (b.y / H) * 100,
          w: (b.width / W) * 100, h: (b.height / H) * 100,
        };
        if (pct.y + pct.h > 100.5 || pct.x + pct.w > 100.5 || pct.x < -0.5 || pct.y < -0.5) {
          throw new Error(`mark ${i + 1} (${m.sel}) falls outside the captured image `
            + `(y ${pct.y.toFixed(1)}% + h ${pct.h.toFixed(1)}%). `
            + 'Give the shot `full: true`, or annotate something in view.');
        }
        marks.push({
          n: i + 1, say: m.say, sel: m.sel,
          x: +pct.x.toFixed(2), y: +pct.y.toFixed(2),
          w: +pct.w.toFixed(2), h: +pct.h.toFixed(2),
        });
      }
    }
    await page.screenshot({ path: join(OUT, `${s.id}.png`), fullPage: s.full });
    if (marks.length) writeFileSync(join(OUT, `${s.id}.marks.json`), JSON.stringify(marks, null, 1));
    report.push({ id: s.id, ok: true, warn, marks: marks.length, consoleErrors: errors });
  } catch (e) {
    failures.push(`${s.id}: ${e.message}`);
    report.push({ id: s.id, ok: false, error: e.message, consoleErrors: errors });
  }
  await ctx.close();
}

await browser.close();
harness.kill();
writeFileSync(join(OUT, 'shot-report.json'), JSON.stringify({ taken: report.length, failures, report }, null, 2));

console.log(`${SHOTS.length - failures.length}/${SHOTS.length} shots -> ${OUT}`);
if (failures.length) { for (const f of failures) console.error(`  FAIL ${f}`); process.exit(1); }
