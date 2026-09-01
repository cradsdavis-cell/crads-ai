// wizard/panel/marks.test.mjs: spec R20, every connector wears a mark.
//
// Pins: (1) every catalogue key plus the featured six, google, github, telegram
// and claude resolve through markFor() to an svg, an img or an initial disc,
// never a throw or undefined, and since 2026-08-23 none of the catalogue is
// left on an initial; (2) every vendored .svg is one <svg> with a viewBox and
// carries no script or external reference (the panel CSP forbids both), every
// .png is a real PNG under 6 KB; (3) the LICENSE + SOURCES notes ship alongside;
// (4) the initial hue is deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CATALOGUE } from './mcp-catalogue.mjs';
import { MARKS, NO_MARK, markFor, hueFor } from './vendor/marks/index.mjs';

const DIR = path.join(import.meta.dirname, 'vendor', 'marks');
const FEATURED = ['notion', 'linear', 'sentry', 'canva', 'vercel', 'apify'];
const EXTRA = ['google', 'github', 'telegram', 'claude'];

test('every catalogue + featured + account key resolves to svg or initial', () => {
  const keys = new Set([...CATALOGUE.map((e) => e.key), ...FEATURED, ...EXTRA]);
  assert.ok(keys.size >= 60, `expected 60+ keys, got ${keys.size}`);
  for (const key of keys) {
    const label = CATALOGUE.find((e) => e.key === key)?.label;
    const m = markFor(key, label);
    assert.ok(m && (m.kind === 'svg' || m.kind === 'img' || m.kind === 'initial'), `${key}: ${JSON.stringify(m)}`);
    if (m.kind === 'svg') {
      assert.match(m.svg, /^data:image\/svg\+xml;utf8,/, `${key} svg is a data URI`);
      assert.match(m.hex, /^#[0-9A-F]{6}$/, `${key} hex`);
      assert.ok(fs.existsSync(path.join(DIR, `${key}.svg`)), `${key}.svg file exists`);
    } else if (m.kind === 'img') {
      assert.match(m.src, /^data:image\/(svg\+xml;utf8|png;base64),/, `${key} img src is a data URI`);
      assert.match(m.hex, /^#[0-9A-F]{6}$/, `${key} hex`);
      assert.ok(fs.existsSync(path.join(DIR, `${key}.svg`)) || fs.existsSync(path.join(DIR, `${key}.png`)), `${key}.svg or .png file exists`);
    } else {
      assert.match(m.letter, /^[A-Z0-9]$/, `${key} letter`);
      assert.ok(Number.isInteger(m.hue) && m.hue >= 0 && m.hue < 360, `${key} hue`);
      assert.ok(NO_MARK.includes(key), `${key} falls back to initial but is not listed in NO_MARK`);
    }
  }
  // every catalogue key has a real mark now (the 17 simple-icons lacked were
  // sourced by hand on 2026-08-23, see SOURCES.md); a new catalogue entry
  // without one must be a deliberate NO_MARK listing, not a silent initial.
  for (const e of CATALOGUE) assert.notEqual(markFor(e.key, e.label).kind, 'initial', `${e.key} is still an initial disc`);
});

test('the hand-sourced 17 resolve to a real mark of the recorded kind', () => {
  const masked = ['canva', 'context7', 'semgrep', 'globalping', 'heroku', 'exa', 'polar'];
  const img = ['apify', 'close', 'amplitude', 'attio', 'plaid', 'klaviyo', 'readwise', 'honeycomb', 'stytch', 'workos'];
  for (const k of masked) assert.equal(markFor(k).kind, 'svg', k);
  for (const k of img) assert.equal(markFor(k).kind, 'img', k);
  assert.match(markFor('apify').src, /^data:image\/svg\+xml/, 'apify: the three-colour vendor symbol, as an svg img');
  assert.match(markFor('amplitude').src, /^data:image\/png;base64,/, 'amplitude: png');
  assert.equal(NO_MARK.length, 0, 'nothing is left on the deliberate-initial list');
});

test('the svg files are one <svg> each, with a viewBox, no script, no external href', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.svg'));
  assert.ok(files.length > 0);
  const pngs = fs.readdirSync(DIR).filter((f) => f.endsWith('.png'));
  assert.equal(files.length + pngs.length, Object.keys(MARKS).length, 'one file per MARKS entry');
  for (const f of pngs) {
    const b = fs.readFileSync(path.join(DIR, f));
    assert.ok(b.length <= 6 * 1024, `${f}: ${b.length} bytes, over the 6 KB cap`);
    assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${f}: PNG signature`);
    const key = f.replace(/\.png$/, '');
    assert.ok(!files.includes(`${key}.svg`), `${f}: a png never shadows an svg of the same key`);
    assert.equal(MARKS[key].png, 'data:image/png;base64,' + b.toString('base64'), `${f}: inlined bytes match the file`);
  }
  for (const f of files) {
    const s = fs.readFileSync(path.join(DIR, f), 'utf8');
    assert.equal((s.match(/<svg\b/g) || []).length, 1, `${f}: exactly one <svg>`);
    assert.match(s, /viewBox="0 0 24 24"/, `${f}: 24x24 viewBox`);
    assert.match(s, /fill="currentColor"/, `${f}: currentColor`);
    const body = s.replace('xmlns="http://www.w3.org/2000/svg"', '');   // the one namespace URL that is not a fetch
    assert.doesNotMatch(body, /<script|<title|<image|<use|\son[a-z]+=|href=|url\(|https?:/i, `${f}: no script/title/href/external`);
    const key = f.replace(/\.svg$/, '');
    assert.equal(decodeURIComponent(MARKS[key].svg.replace(/^data:image\/svg\+xml;utf8,/, '')), s.trim(), `${f}: inlined bytes match the file`);
  }
});

test('LICENSE note ships with the marks and states CC0 + nominative use', () => {
  const s = fs.readFileSync(path.join(DIR, 'LICENSE'), 'utf8');
  assert.match(s, /CC0-1\.0/);
  assert.match(s, /simple-icons/);
  assert.match(s, /nominative/);
  assert.match(s, /no sponsorship, affiliation or endorsement/);
  assert.match(s, /SOURCES\.md/, 'points at the per-key provenance of the hand-sourced marks');
});

test('SOURCES.md records provenance for every mark that is not from simple-icons', () => {
  const s = fs.readFileSync(path.join(DIR, 'SOURCES.md'), 'utf8');
  for (const key of ['canva', 'apify', 'context7', 'semgrep', 'globalping', 'heroku', 'exa', 'amplitude', 'close', 'attio', 'plaid', 'klaviyo', 'readwise', 'honeycomb', 'stytch', 'workos', 'polar']) {
    const row = s.split('\n').find((l) => l.startsWith(`| ${key} |`));
    assert.ok(row, `${key}: a row in SOURCES.md`);
    assert.match(row, /https?:\/\//, `${key}: a source URL`);
    assert.match(row, /2026-\d\d-\d\d/, `${key}: a fetch date`);
  }
});

test('initial hue is deterministic and label-independent', () => {
  // unknown keys (apify and exa used to be the examples; they have marks now)
  assert.equal(hueFor('acme-crm'), hueFor('acme-crm'));
  assert.equal(markFor('acme-crm', 'Acme CRM').kind, 'initial');
  assert.equal(markFor('acme-crm', 'Acme CRM').hue, markFor('acme-crm', 'Something Else').hue);
  assert.equal(markFor('acme-crm', 'Acme CRM').letter, 'A');
  assert.equal(markFor('example-search', 'Example').letter, 'E');
  assert.notEqual(hueFor('acme-crm'), hueFor('example-search'));
  assert.equal(markFor('cloudflare-obs').kind, 'svg');
  assert.equal(markFor('cloudflare-bindings').svg, markFor('cloudflare-obs').svg);
});
