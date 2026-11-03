// skills-skip.test.mjs: a brain opts out of engine skills it has its own of.
// Run: node --test engine/kernel/lib/skills-skip.test.mjs
//
// The first adopted brain has its own capture, daily, followup, inbox, weekly
// and week planner, so six crads- twins doubled its skill list on every session
// and came back on every drain however often they were deleted. `skills.skip`
// in profile.yaml is the opt-out. These tests pin: the profile is read in both
// list shapes, a skipped skill is never installed, a copy an earlier sync left
// is removed only when it carries the engine marker, and every other engine
// skill still installs exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../../tests/tmp-dir.mjs';
import { syncSkills, readSkillSkip, ENGINE_MARKER, ADOPTED_ONLY } from './skills.mjs';

const ENGINE_SKILLS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
const SKIP = ['capture', 'daily', 'followup', 'inbox', 'weekly', 'plan-week'];
const engineNames = () => readdirSync(ENGINE_SKILLS).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));

function brain({ adopted = true, profile = '' } = {}) {
  const d = tmpDir('skills-skip-');
  writeFileSync(join(d, 'ownership.json'), JSON.stringify(adopted ? { adopted: true } : { owner: 'member' }) + '\n');
  writeFileSync(join(d, 'profile.yaml'), profile);
  return d;
}
const skillsDir = (d) => join(d, '.claude', 'skills');

test('readSkillSkip: block list, flow list, crads- prefixes, quotes and comments', () => {
  const block = 'identity:\n  user_short: "Pat"\nskills:\n  enabled:\n    - daily\n  skip:            # mine already\n    - capture\n    - "crads-daily"   # written as the installed name\n    - \'inbox\'\n  bespoke: []\ncompliance:\n  skip:\n    - weekly\n';
  assert.deepEqual(readSkillSkip(block), ['capture', 'daily', 'inbox'], 'only skills.skip, not another block\'s skip');
  assert.deepEqual(readSkillSkip('skills:\n  skip: [capture, crads-weekly, "plan-week"]  # flow\n'), ['capture', 'weekly', 'plan-week']);
  assert.deepEqual(readSkillSkip('skills:\n  enabled:\n    - daily\n'), [], 'no skip key');
  assert.deepEqual(readSkillSkip('skills:\n  skip: []\n'), []);
  assert.deepEqual(readSkillSkip(''), []);
});

test('adopted: a skipped skill is not installed and every other engine skill still is', async () => {
  const d = brain({ profile: `skills:\n  skip:\n${SKIP.map((s) => `    - ${s}`).join('\n')}\n` });
  const n = await syncSkills(d, ENGINE_SKILLS);
  for (const name of SKIP) {
    assert.ok(!existsSync(join(skillsDir(d), `crads-${name}`)), `crads-${name} skipped`);
    assert.ok(!existsSync(join(skillsDir(d), name)), `no bare ${name} either`);
  }
  const kept = engineNames().filter((x) => !SKIP.includes(x));
  for (const name of kept) {
    const target = ADOPTED_ONLY.includes(name) ? name : `crads-${name}`;
    assert.ok(existsSync(join(skillsDir(d), target, ENGINE_MARKER)), `${target} still installs`);
  }
  assert.equal(n, kept.length);
});

test('adopted: marked copies an earlier sync installed are removed; unmarked dirs and the person\'s files stay', async () => {
  const d = brain();
  await syncSkills(d, ENGINE_SKILLS);                       // the old world: every crads- twin installed
  for (const name of SKIP) assert.ok(existsSync(join(skillsDir(d), `crads-${name}`, ENGINE_MARKER)));
  // the person dropped a note into one of ours, and has their own unmarked dirs
  writeFileSync(join(skillsDir(d), 'crads-weekly', 'notes.md'), 'mine\n');
  for (const name of ['capture', 'daily']) {
    mkdirSync(join(skillsDir(d), name), { recursive: true });
    writeFileSync(join(skillsDir(d), name, 'SKILL.md'), `---\nname: ${name}\n---\nthe person's own\n`);
  }
  // a crads- dir the person made themselves, no marker
  mkdirSync(join(skillsDir(d), 'crads-inbox-mine'), { recursive: true });
  // an earlier engine's bare, marked copy of a skipped skill
  mkdirSync(join(skillsDir(d), 'followup'), { recursive: true });
  writeFileSync(join(skillsDir(d), 'followup', 'SKILL.md'), 'old engine copy\n');
  writeFileSync(join(skillsDir(d), 'followup', ENGINE_MARKER), 'engine skill\n');

  writeFileSync(join(d, 'profile.yaml'), `skills:\n  skip: [${SKIP.join(', ')}]\n`);
  await syncSkills(d, ENGINE_SKILLS);
  for (const name of SKIP.filter((x) => x !== 'weekly')) assert.ok(!existsSync(join(skillsDir(d), `crads-${name}`)), `crads-${name} removed`);
  assert.ok(!existsSync(join(skillsDir(d), 'crads-weekly', 'SKILL.md')) && !existsSync(join(skillsDir(d), 'crads-weekly', ENGINE_MARKER)), 'our two files leave crads-weekly');
  assert.equal(readFileSync(join(skillsDir(d), 'crads-weekly', 'notes.md'), 'utf8'), 'mine\n', 'the person\'s file and its dir stay');
  assert.ok(!existsSync(join(skillsDir(d), 'followup')), 'the marked bare copy is removed');
  for (const name of ['capture', 'daily']) {
    assert.equal(readFileSync(join(skillsDir(d), name, 'SKILL.md'), 'utf8'), `---\nname: ${name}\n---\nthe person's own\n`, `${name} untouched`);
  }
  assert.ok(existsSync(join(skillsDir(d), 'crads-inbox-mine')), 'an unmarked crads- dir is never touched');
  assert.ok(existsSync(join(skillsDir(d), 'crads-explain', ENGINE_MARKER)), 'an unskipped skill stays');

  // dropping a name from the list brings that skill back on the next sync
  writeFileSync(join(d, 'profile.yaml'), 'skills:\n  skip: [capture]\n');
  await syncSkills(d, ENGINE_SKILLS);
  assert.ok(existsSync(join(skillsDir(d), 'crads-daily', ENGINE_MARKER)));
  assert.ok(!existsSync(join(skillsDir(d), 'crads-capture')));
});

test('adopted, move-in mode (only): the skip list still applies', async () => {
  const d = brain({ profile: 'skills:\n  skip: [move-in]\n' });
  assert.equal(await syncSkills(d, ENGINE_SKILLS, { only: ADOPTED_ONLY }), 0);
  assert.ok(!existsSync(join(skillsDir(d), 'move-in')));
});

test('pebble: a skipped skill is not written, and an existing copy (no marker to prove it ours) is left', async () => {
  const d = brain({ adopted: false });
  await syncSkills(d, ENGINE_SKILLS);
  assert.ok(existsSync(join(skillsDir(d), 'daily', 'SKILL.md')));
  const fresh = brain({ adopted: false, profile: 'skills:\n  skip: [daily]\n' });
  await syncSkills(fresh, ENGINE_SKILLS);
  assert.ok(!existsSync(join(skillsDir(fresh), 'daily')), 'never installed');
  assert.ok(existsSync(join(skillsDir(fresh), 'capture', 'SKILL.md')), 'the rest still install');
  writeFileSync(join(d, 'profile.yaml'), 'skills:\n  skip: [daily]\n');
  await syncSkills(d, ENGINE_SKILLS);
  assert.ok(existsSync(join(skillsDir(d), 'daily', 'SKILL.md')), 'unmarked, so left alone');
});

test('an explicit skip option overrides the profile', async () => {
  const d = brain({ profile: 'skills:\n  skip: [daily]\n' });
  await syncSkills(d, ENGINE_SKILLS, { skip: [] });
  assert.ok(existsSync(join(skillsDir(d), 'crads-daily', ENGINE_MARKER)));
});
