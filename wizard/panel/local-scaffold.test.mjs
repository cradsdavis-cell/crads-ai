// local-scaffold.test.mjs: a brain folder comes to life on this computer
// (2026-09-11), against a temp dir, from the real engine files.
//   node --test wizard/panel/local-scaffold.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { LAYERS } from '../../engine/onboarding/layers.mjs';
import { loadEngineAssets, scaffoldLocalBrain, initialOnboardingState, dirState, setBrainName, seedPages, LOCAL_ASSET_FILES, LOCAL_SKILL_IDS, REPO_ROOT } from './local-scaffold.mjs';

const assets = loadEngineAssets();

test('the asset list is the engine truth: every engine/skills/*.md is listed, every listed file exists', () => {
  const onDisk = readdirSync(join(REPO_ROOT, 'engine', 'skills')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort();
  assert.deepEqual([...LOCAL_SKILL_IDS].sort(), onDisk, 'LOCAL_SKILL_IDS must name every engine skill (the exe cannot list a directory of assets)');
  for (const f of LOCAL_ASSET_FILES) assert.ok(existsSync(join(REPO_ROOT, f)), `${f} is a real file`);
  assert.equal(Object.keys(assets.skills).length, LOCAL_SKILL_IDS.length);
  assert.ok(assets.interviewSpec.includes('modules:') && assets.profileSchema.includes('assistant_name') && assets.brainIgnore.includes('.claude-auth/') && assets.claudeMd.includes('# This folder is your brain'));
});

test('the scaffold makes box-up.sh\'s first-run shape, with git initialised and credentials ignored', async () => {
  const box = join(tmpDir('scaffold-'), 'idris');
  const r = await scaffoldLocalBrain(box, { name: 'Idris', assets });
  for (const p of ['wiki/people', 'secrets', '.claude-auth', '.kernel', 'profile.yaml', 'onboarding-state.json', 'wiki/priorities.md',
    'dashboard/pages.json', 'dashboard/cards.json', 'dashboard/pages/welcome.html', 'ownership.json', 'box-name', '.gitignore', 'CLAUDE.md',
    '.claude/skills/onboard/SKILL.md', '.claude/skills/daily/SKILL.md']) {
    assert.ok(existsSync(join(box, p)), `${p} exists`);
  }
  assert.equal(readFileSync(join(box, 'box-name'), 'utf8'), 'Idris');
  assert.match(readFileSync(join(box, 'profile.yaml'), 'utf8'), /assistant_name: "Idris"/, 'one name, both files');
  const st = JSON.parse(readFileSync(join(box, 'onboarding-state.json'), 'utf8'));
  assert.equal(st.phase, 'interview');
  assert.deepEqual(Object.keys(st.layers), LAYERS, 'seeded with the 8 layers /onboard writes, not the legacy 11 modules');
  assert.equal(st.layers['1-north-star'].status, 'in-progress', 'layer 1 is in progress, as init-state.mjs writes it');
  assert.equal(st.current_layer, '1-north-star');
  assert.ok(!st.modules, 'no legacy modules map alongside the layers');
  const own = JSON.parse(readFileSync(join(box, 'ownership.json'), 'utf8'));
  assert.equal(own.owner, 'member'); assert.equal(own.hosting, 'local');
  const ig = readFileSync(join(box, '.gitignore'), 'utf8');
  for (const pat of ['.env', 'secrets/', '.claude-auth/', '.kernel/', '.mcp.json', '*.key']) assert.ok(ig.split('\n').includes(pat), `${pat} ignored`);
  assert.equal(r.git, 'initialised');
  const tracked = execFileSync('git', ['-C', box, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(tracked.includes('profile.yaml') && tracked.includes('CLAUDE.md'), 'the scaffold is committed');
  assert.ok(!tracked.some((f) => f.startsWith('.claude/') || f.startsWith('secrets/') || f.startsWith('.kernel/')), 'nothing credential-shaped is tracked');
  assert.equal(dirState(box), 'brain');
});

test('running it again touches nothing: a member\'s edits survive, the name is kept, git is kept', async () => {
  const box = join(tmpDir('scaffold2-'), 'idris');
  await scaffoldLocalBrain(box, { name: 'Idris', assets });
  writeFileSync(join(box, 'wiki', 'priorities.md'), '# mine\n');
  writeFileSync(join(box, 'dashboard', 'pages', 'welcome.html'), '<p>edited</p>');
  const r = await scaffoldLocalBrain(box, { name: 'Other', assets });
  assert.equal(readFileSync(join(box, 'wiki', 'priorities.md'), 'utf8'), '# mine\n');
  assert.equal(readFileSync(join(box, 'dashboard', 'pages', 'welcome.html'), 'utf8'), '<p>edited</p>');
  assert.equal(readFileSync(join(box, 'box-name'), 'utf8'), 'Idris', 'a name once set is never clobbered');
  assert.equal(r.git, 'kept');
});

test('the packaged shape: no directory on disk, the bag alone scaffolds the same skills', async () => {
  const bag = { ...assets, skillsDir: '' };
  const box = join(tmpDir('scaffold3-'), 'b');
  await scaffoldLocalBrain(box, { name: 'B', assets: bag, git: false });
  assert.deepEqual(readdirSync(join(box, '.claude', 'skills')).sort(), [...LOCAL_SKILL_IDS].sort());
  assert.equal(readFileSync(join(box, '.claude', 'skills', 'onboard', 'SKILL.md'), 'utf8'), assets.skills.onboard);
  assert.ok(!existsSync(join(box, '.git')), 'git: false means no repo');
});

test('dirState names the four cases the create route switches on', () => {
  const root = tmpDir('ds-');
  assert.equal(dirState(join(root, 'nope')), 'missing');
  assert.equal(dirState(root), 'empty');
  writeFileSync(join(root, 'stray.txt'), 'x');
  assert.equal(dirState(root), 'occupied');
  writeFileSync(join(root, 'profile.yaml'), 'schema_version: 0.1\n');
  assert.equal(dirState(root), 'brain');
});

test('initialOnboardingState and setBrainName are faithful ports', () => {
  // the spec text no longer decides the seed: the 8 layers do, whatever is passed
  for (const arg of [undefined, 'nothing here', 'modules:\n  - id: a\n  - id: b\n']) {
    const st = initialOnboardingState(arg);
    assert.deepEqual(Object.keys(st.layers), LAYERS);
    assert.equal(st.phase, 'interview'); assert.equal(st.scope, 'person');
  }
  const box = tmpDir('name-');
  writeFileSync(join(box, 'profile.yaml'), 'identity:\n  user_name: ""\n');
  setBrainName(box, 'Nia "quoted"');
  assert.equal(readFileSync(join(box, 'box-name'), 'utf8'), 'Nia quoted', 'quotes stripped so the yaml line cannot break');
  assert.match(readFileSync(join(box, 'profile.yaml'), 'utf8'), /identity:\n  assistant_name: "Nia quoted"/);
});

test('seedPages tombstones win: a deleted example page stays deleted on the next seed', () => {
  const box = tmpDir('seed-');
  assert.ok(seedPages(box, assets) > 0);
  writeFileSync(join(box, 'dashboard', 'pages.deleted.json'), JSON.stringify(['welcome']));
  execFileSync('rm', [join(box, 'dashboard', 'pages', 'welcome.html')]);
  seedPages(box, assets);
  assert.ok(!existsSync(join(box, 'dashboard', 'pages', 'welcome.html')));
});
