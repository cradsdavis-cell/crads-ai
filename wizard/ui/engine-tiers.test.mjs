// engine-tiers.test.mjs: structured membership levels (factory#2).
// Placed under wizard/ui/ so it rides the `wizard/ui/*.test.mjs` suite glob.
//   node --test wizard/ui/engine-tiers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseTierItem, splitTiers, buildOrgPolicyYaml, parseOrgPolicy,
  policySlots, renderVocabularyMd, renderIdentity,
} from '../engine.mjs';

// ---------------------------------------------------------------- parseTierItem
test('parseTierItem: splits on the first pipe, trims both sides', () => {
  assert.deepEqual(parseTierItem('standard|Full access'), { name: 'standard', description: 'Full access' });
  assert.deepEqual(parseTierItem('  core  |  Online content only  '), { name: 'core', description: 'Online content only' });
  // only the FIRST pipe splits; later pipes stay in the description
  assert.deepEqual(parseTierItem('pro|a | b | c'), { name: 'pro', description: 'a | b | c' });
});

test('parseTierItem: a plain name (no pipe) has an empty description', () => {
  assert.deepEqual(parseTierItem('standard'), { name: 'standard', description: '' });
  assert.deepEqual(parseTierItem('  standard  '), { name: 'standard', description: '' });
});

// ---------------------------------------------------------------- splitTiers
test('splitTiers: newline-separated name|description rows survive commas in the description', () => {
  const s = 'standard|Full access, weekly call\ncore|Online only';
  assert.deepEqual(splitTiers(s), ['standard|Full access, weekly call', 'core|Online only']);
});

test('splitTiers: legacy comma-list of bare names still splits', () => {
  assert.deepEqual(splitTiers('standard, core'), ['standard', 'core']);
  assert.deepEqual(splitTiers(''), []);
});

// ---------------------------------------------------------------- yaml round-trip
test('buildOrgPolicyYaml: tiers with descriptions serialize as name|description, plain stay plain', () => {
  const yaml = buildOrgPolicyYaml({
    name: 'acme', displayName: 'Acme', domain: 'acme.com', persona: 'Foreman',
    areasLabel: 'Areas', areas: [], expertsLabel: 'Experts', experts: [],
    tiers: splitTiers('standard|Full access to all content\ncore'),
    pulseEnabled: true, pulseName: 'Pulse', pulseLanding: 'notes/pulse/',
    heartbeats: 'minimal', region: 'hel1', dropsDirect: true, accessSsh: true, accessBrowser: true,
    admins: ['a@b.com'], support: [], contentUpdates: 'auto', images: 'pinned', leaverDays: '30',
    outbound: 'propose-confirm', aiDisclosure: true, quietHours: '21:00-06:30', timezone: 'Australia/Sydney',
  });
  assert.match(yaml, /- standard\|Full access to all content/);
  assert.match(yaml, /- core$/m);
  const pol = parseOrgPolicy(yaml);
  assert.deepEqual(pol['vocabulary.tiers'], ['standard|Full access to all content', 'core']);
});

// ---------------------------------------------------------------- slots + md
test('policySlots.TIERS_LIST: name (description) where present, plain otherwise', () => {
  const pol = parseOrgPolicy(buildBare(['standard|Full access', 'core']));
  const slots = policySlots(pol);
  assert.equal(slots.TIERS_LIST, 'standard (Full access), core');
  assert.deepEqual(slots.TIERS.map((t) => t.name), ['standard', 'core']);
});

test('policySlots.TIERS_LIST: legacy plain-name org renders name-only, no crash', () => {
  const slots = policySlots(parseOrgPolicy(buildBare(['standard', 'core'])));
  assert.equal(slots.TIERS_LIST, 'standard, core');
  assert.equal(slots.TIERS_LIST.includes('|'), false);
});

test('policySlots.TIERS_LIST: no tiers falls back to (single tier)', () => {
  assert.equal(policySlots(parseOrgPolicy(buildBare([]))).TIERS_LIST, '(single tier)');
});

test('renderVocabularyMd: one row per tier with a description column', () => {
  const md = renderVocabularyMd(policySlots(parseOrgPolicy(buildBare(['standard|Full access', 'core']))));
  assert.match(md, /\| standard \| Full access \|/);
  assert.match(md, /\| core \|  \|/);
});

test('renderVocabularyMd: no membership table when no tiers configured', () => {
  const md = renderVocabularyMd(policySlots(parseOrgPolicy(buildBare([]))));
  assert.equal(/\| Tier \| Description \|/.test(md), false);
});

test('renderIdentity: a legacy plain-name policy renders without throwing', () => {
  const tpl = 'org {{ORG_DISPLAY_NAME}} tiers {{TIERS_LIST}}';
  const out = renderIdentity(tpl, buildBare(['standard', 'core']));
  assert.match(out.claudeMd, /tiers standard, core/);
});

// minimal valid policy carrying a given tier list (order preserved)
function buildBare(tiers) {
  return buildOrgPolicyYaml({
    name: 'acme', displayName: 'Acme', domain: 'acme.com', persona: 'Foreman',
    areasLabel: 'Areas', areas: [], expertsLabel: 'Experts', experts: [], tiers,
    pulseEnabled: true, pulseName: 'Pulse', pulseLanding: 'notes/pulse/',
    heartbeats: 'minimal', region: 'hel1', dropsDirect: true, accessSsh: true, accessBrowser: true,
    admins: ['a@b.com'], support: [], contentUpdates: 'auto', images: 'pinned', leaverDays: '30',
    outbound: 'propose-confirm', aiDisclosure: true, quietHours: '21:00-06:30', timezone: 'Australia/Sydney',
  });
}

// ---- live-cert finding (2026-08-03): the hub should sit near its operator ----
// The candidate ladder was Europe-only, so choosing Asia-Pacific put the ROCK
// box in Germany. Region legitimately drives member boxes; it should bias the
// hub too, without losing the fallback that a real run needed three times.
test('the rock candidate ladder prefers the chosen region, then falls back', () => {
  const src = readFileSync(new URL('../engine.mjs', import.meta.url), 'utf8');
  assert.match(src, /region: REGION,\n\s+deploymentYaml/, 'the chosen region reaches provisionRock');
  const block = src.slice(src.indexOf('const ladder ='), src.indexOf('for (const cand of cands)'));
  assert.match(block, /preferred/, 'a preferred list is computed');
  assert.match(block, /\['cx33', 'cpx32', 'cax21'\]/, 'a region outside the default ladder still gets real types tried');
  assert.match(block, /\.\.\.preferred, \.\.\.ladder\.filter/, 'preference first, full ladder after: fallback survives');
  assert.match(block, /cfg\.serverType && cfg\.location/, 'an explicit pin still wins over both');
});

test('a reused brain repo whose policy differs is called out, never silently ignored', () => {
  const src = readFileSync(new URL('../engine.mjs', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('GitHub token sees'), src.indexOf('if (rex.ok && repoIsEmpty)'));
  assert.match(block, /contents\/org-policy\.yaml/, 'it reads what is actually in the repo');
  assert.match(block, /existing\.trim\(\) !== String\(orgPolicyYaml\)\.trim\(\)/, 'and compares it to this run');
  assert.match(block, /existing policy STANDS/, 'says which one wins');
  assert.match(block, /is not applied/, 'and that the new answers were not applied');
});
