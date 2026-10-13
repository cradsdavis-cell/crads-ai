// skill-copy.test.mjs: shipped skills carry no operator's personal data and no
// hosted-era model (13 Oct 2026 review).
//   node --test engine/skills/skill-copy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const skills = readdirSync(HERE).filter((f) => f.endsWith('.md'))
  .map((f) => ({ f, md: readFileSync(join(HERE, f), 'utf8') }));

test('no skill ships a personal address, a hard-coded zone or a provenance table naming real people', () => {
  for (const { f, md } of skills) {
    assert.doesNotMatch(md, /@gmail\.com|cradsdavis/i, `${f}: personal address`);
    assert.doesNotMatch(md, /\bAEST\b/, `${f}: hard-coded timezone`);
    assert.doesNotMatch(md, /Sam-coupled|Sam-specific/, `${f}: provenance table`);
    assert.doesNotMatch(md, /—/, `${f}: em dash`);
  }
});

test('inbox and followup read the mailbox connected on the mineral, not an operator-owned one', () => {
  const inbox = skills.find((s) => s.f === 'inbox.md').md;
  const follow = skills.find((s) => s.f === 'followup.md').md;
  assert.doesNotMatch(inbox + follow, /operator-owned/);
  assert.match(inbox, /mail connection on this mineral/);
  assert.match(follow, /mail connection on this mineral/);
});

test('onboard confirms an existing name instead of asking for one', () => {
  const md = skills.find((s) => s.f === 'onboard.md').md;
  assert.match(md, /Read `box-name` at the brain root/, 'reads where the app reads');
  assert.match(md, /identity\.assistant_name/, 'with the same fallback');
  assert.match(md, /Do NOT ask for a name/);
  assert.doesNotMatch(md, /stamp gate|stamp-gate|folder on the member's own computer/);
});

test('descriptions shown on the Skills page speak to the person, not about a member or client', () => {
  for (const { f, md } of skills) {
    const d = (md.match(/^description:\s*(.+)$/m) || [])[1] || '';
    assert.doesNotMatch(d, /\bthe (member|client)'s\b|\bmembers?\b|yin|yang|\bSETS\b/, `${f}: ${d}`);
  }
});
