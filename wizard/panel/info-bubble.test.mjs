// R28 info bubbles (panel iteration 2, 2026-08-23). The page head keeps ONE
// short sentence; longer explainers move into a circled ? beside the heading
// that opens a popover on click or focus and closes on Escape / click-outside.
// Pins are structural: the component's anatomy, its keyboard contract, and
// the one-sentence rule on every page-head line, never the copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'member.html'), 'utf8');

test('the info bubble component exists: styled button.info, a .tip popover, reduced-motion safe', () => {
  assert.match(html, /\n  button\.info\{[^}]*border-radius:50%/, 'the ? is a circled button');
  assert.match(html, /\n  \.tip\{position:absolute[^}]*box-shadow:var\(--shadow-2\)/, 'the popover is a positioned card with the popover shadow');
  assert.match(html, /@media \(prefers-reduced-motion:reduce\)\{\.tip\{animation:none\}\}/, 'no motion when the OS asks for none');
});

test('the helper opens on click and focus, closes on Escape and click-outside, and marks aria-expanded', () => {
  assert.match(html, /function openTip\(btn\)/);
  assert.match(html, /function closeTip\(\)/);
  assert.match(html, /e\.key === 'Escape' && tipEl\) \{ closeTip\(\);/, 'Escape closes');
  assert.match(html, /addEventListener\('focusin', function\(e\)\{\s*var b = e\.target\.closest && e\.target\.closest\('button\.info'\)/, 'focus opens');
  assert.match(html, /if \(tipEl && !tipEl\.contains\(e\.target\)\) closeTip\(\);/, 'click outside closes');
  assert.match(html, /btn\.setAttribute\('aria-expanded', 'true'\)/);
});

test('every bubble is a real button with a tip and a label', () => {
  const bubbles = html.match(/<button class="info"[^>]*>/g) || [];
  // 7 since the simple-assistant strip (2026-09-09): one per surviving page
  // head (was 12 with Library, Communities, the Catalogue and the Map).
  assert.ok(bubbles.length >= 7, `expected bubbles on the page heads, found ${bubbles.length}`);
  for (const b of bubbles) {
    assert.match(b, /type="button"/, `${b} is type=button`);
    assert.match(b, /aria-label="[^"]+"/, `${b} has an aria-label`);
    assert.match(b, /data-tip="[^"]{20,}"/, `${b} carries its text`);
    assert.ok(!/—/.test(b), `${b} has no em dash`);
  }
});

test('every static page-head line is one short sentence', () => {
  // Eight sections survive the simple-assistant strip (2026-09-09); seven of
  // them carry a static page head (was 14 with the org pages).
  const heads = html.match(/<div class="pagehead">[\s\S]*?<\/div>\s*<\/div>|<div class="pagehead">[\s\S]*?<\/div>/g) || [];
  assert.ok(heads.length >= 7, `found ${heads.length} page heads`);
  for (const h of heads) {
    const p = h.match(/<p(?: id="[^"]*")?>([\s\S]*?)<\/p>/);
    if (!p) continue;
    const text = p[1].replace(/<[^>]+>/g, '');
    assert.ok(text.length <= 120, `page-head line is short: "${text}"`);
    assert.ok(!/[.!?] [A-Z]/.test(text), `page-head line is one sentence: "${text}"`);
  }
});

test('the org-face head overrides are RETIRED (2026-09-01): one face, static heads only', () => {
  // The overrides existed to reword page heads when the shell flipped to the
  // org face. There is no face swap any more, so no page rewrites its head at
  // runtime, and nothing may reach past setHead's anatomy to write the
  // paragraph directly.
  for (const sec of ['dashboard', 'sharing', 'network', 'rocks', 'brain']) {
    assert.ok(!new RegExp(`setHead\\('${sec}', '`).test(html), `no ${sec} face override remains`);
  }
  assert.ok(!/querySelector\('section\[data-sec="[a-z]+"\] \.pagehead p'\)/.test(html), 'nothing writes a page-head paragraph directly');
});
