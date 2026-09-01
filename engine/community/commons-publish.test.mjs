// commons-publish.test.mjs: the rock's publish leg against a REAL local bare
// git repo, and the full loop: publish from a rock brain, pull on a member
// state, and find every kind sitting in the inbox shape the pickup verbs read
// (self-host pivot, 2026-09-01).
//   node --test engine/community/commons-publish.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { pullOne } from './commons-pull.mjs';
import { writeCommunity } from './commons-lib.mjs';

before(() => { process.env.AIOS_COMMONS_ALLOW_FILE = '1'; });
after(() => { delete process.env.AIOS_COMMONS_ALLOW_FILE; });

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PUBLISH = path.join(HERE, 'commons-publish.mjs');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const w = (p, content) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, content); };

// A rock brain with one of every library zone, one pack, one lint-clean page
// and one page that violates the page contract.
function rockRig() {
  const root = tmpDir('publish-');
  const state = path.join(root, 'state');
  const brain = path.join(root, 'brain');
  const bare = path.join(root, 'commons.git');
  git(['init', '--bare', '-b', 'main', bare]);
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'commons.conf'), `URL=${bare}\nBRANCH=main\nORG=harbour-guild\nORG_DISPLAY=Harbour Guild\n`);
  // skills-library
  w(path.join(brain, 'skills-library', 'tide-tables', 'SKILL.md'), '# tide tables\n');
  w(path.join(brain, 'skills-library', 'tide-tables', 'skill.yaml'), 'id: tide-tables\nversion: 2\ncategory: briefing\ndescription: "tomorrow\'s tides in your brief"\n');
  w(path.join(brain, 'skills-library', '_draft', 'SKILL.md'), 'never ships\n');
  // prompts-library
  w(path.join(brain, 'prompts-library', 'kickoff', 'prompt.yaml'), 'title: "Kickoff"\ncategory: comms\n');
  w(path.join(brain, 'prompts-library', 'kickoff', 'PROMPT.md'), 'Start my week with three priorities.\n');
  // pages-library: one clean, one violating
  w(path.join(brain, 'pages-library', 'pipeline', 'page.yaml'), 'title: "Pipeline"\ncategory: org\n');
  w(path.join(brain, 'pages-library', 'pipeline', 'page.html'), '<h2>Pipeline</h2><script>pageApi.run("brain-list")</script>');
  w(path.join(brain, 'pages-library', 'sneaky', 'page.yaml'), 'title: "Sneaky"\n');
  w(path.join(brain, 'pages-library', 'sneaky', 'page.html'), '<h2>s</h2><script>fetch("https://evil.example/x")</script>');
  // dirs-library
  w(path.join(brain, 'dirs-library', 'coaching-templates', 'dir.yaml'), 'title: "Coaching templates"\nkind: templates\ncategory: org\n');
  w(path.join(brain, 'dirs-library', 'coaching-templates', 'files', 'welcome.md'), '# welcome\n');
  // a pack with a skill, a page, a prompt, a context file and a folder
  w(path.join(brain, 'packs', 'starter-kit', 'pack.yaml'),
    'id: starter-kit\nversion: 1\ncategory: other\ndescription: "a starter set"\ncontents:\n  skills: [tide-tables]\n  pages: [wins]\n  prompts: [prompts/kickstart.md]\n  context: [context/pricing.md]\n  dirs: [starter-templates]\n');
  w(path.join(brain, 'packs', 'starter-kit', 'pages', 'wins.html'), '<h2>Wins</h2>');
  w(path.join(brain, 'packs', 'starter-kit', 'prompts', 'kickstart.md'), '---\ntitle: "Kickstart"\n---\nGo.\n');
  w(path.join(brain, 'packs', 'starter-kit', 'context', 'pricing.md'), '# pricing\n');
  w(path.join(brain, 'packs', 'starter-kit', 'dirs', 'starter-templates', 'a.md'), 'a\n');
  w(path.join(brain, 'packs', 'starter-kit', 'dirs', 'starter-templates.yaml'), 'kind: templates\n');
  return { root, state, brain, bare };
}

const runPublish = (state, brain) => spawnSync(process.execPath, [PUBLISH, state, brain], { encoding: 'utf8', env: { ...process.env } });

function clonedView(bare) {
  const view = tmpDir('publish-view-');
  git(['clone', '-q', bare, path.join(view, 'c')]);
  return path.join(view, 'c');
}

test('publish lays the catalogue out in the inbox shape, with the manifest, and pushes', () => {
  const { state, brain, bare } = rockRig();
  const r = runPublish(state, brain);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK: published \d+ item\(s\) to the Harbour Guild commons/);
  assert.match(r.stdout, /SKIPPED: sneaky \(page fails the page contract/, 'the violating page is named, never shipped');
  const c = clonedView(bare);
  // every kind, in the exact paths the member-side verbs read
  assert.ok(existsSync(path.join(c, 'skills', 'tide-tables', 'SKILL.md')));
  assert.ok(!existsSync(path.join(c, 'skills', '_draft')), 'underscore drafts never ship');
  assert.ok(existsSync(path.join(c, 'packs', 'starter-kit', 'pack.yaml')));
  assert.ok(existsSync(path.join(c, 'pages', 'starter-kit', 'wins.html')), 'pack page at pages/<pack>/<id>.html');
  assert.ok(!existsSync(path.join(c, 'offers-pages', 'sneaky.html')), 'lint gate holds at publish');
  assert.equal(readFileSync(path.join(c, 'offers-pages', 'pipeline.html'), 'utf8').includes('brain-list'), true);
  assert.match(readFileSync(path.join(c, 'offers-pages', 'pipeline.json'), 'utf8'), /"title":"Pipeline"/);
  assert.match(readFileSync(path.join(c, 'prompts', 'library', 'kickoff.md'), 'utf8'), /^---\ntitle: "Kickoff"\n---\nStart my week/);
  assert.ok(existsSync(path.join(c, 'prompts', 'starter-kit', 'kickstart.md')), 'pack prompt under prompts/<pack>/');
  assert.ok(existsSync(path.join(c, 'context', 'pricing.md')));
  assert.ok(existsSync(path.join(c, 'dirs', 'library', 'coaching-templates', 'welcome.md')), 'standalone folder under dirs/library/');
  assert.match(readFileSync(path.join(c, 'dirs', 'library', 'coaching-templates.yaml'), 'utf8'), /kind: templates/);
  assert.ok(existsSync(path.join(c, 'dirs', 'starter-kit', 'starter-templates', 'a.md')), 'pack folder under dirs/<pack>/');
  assert.match(readFileSync(path.join(c, 'dirs', 'starter-kit', 'starter-templates.yaml'), 'utf8'), /kind: templates/);
  // the manifest
  const cat = JSON.parse(readFileSync(path.join(c, 'catalog', 'catalog.json'), 'utf8'));
  assert.equal(cat.rock, 'Harbour Guild');
  const byId = Object.fromEntries(cat.items.map((i) => [`${i.kind}/${i.id}`, i]));
  assert.equal(byId['skill/tide-tables'].version, 2);
  assert.equal(byId['skill/tide-tables'].category, 'briefing');
  assert.equal(byId['skill/tide-tables'].rock_id, 'harbour-guild');
  assert.deepEqual(byId['pack/starter-kit'].contents, { skills: ['tide-tables'], dirs: ['starter-templates'], pages: 1, files: 1 });
  assert.equal(byId['page/pipeline'].title, 'Pipeline');
  assert.equal(byId['prompt/kickoff'].title, 'Kickoff');
  assert.equal(byId['dir/coaching-templates'].title, 'Coaching templates');
  assert.equal(byId['page/sneaky'], undefined, 'a skipped page is not advertised either');
  assert.match(readFileSync(path.join(c, 'commons.yaml'), 'utf8'), /org: harbour-guild/);
});

test('republish is idempotent, and an edit republishes as an update', () => {
  const { state, brain, bare } = rockRig();
  assert.equal(runPublish(state, brain).status, 0);
  const again = runPublish(state, brain);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already matches your catalogue/);
  writeFileSync(path.join(brain, 'prompts-library', 'kickoff', 'PROMPT.md'), 'Start my week with ONE priority.\n');
  const update = runPublish(state, brain);
  assert.match(update.stdout, /OK: published/);
  assert.match(readFileSync(path.join(clonedView(bare), 'prompts', 'library', 'kickoff.md'), 'utf8'), /ONE priority/);
});

test('symlinks in a library zone are never followed into the commons', () => {
  const { state, brain, bare } = rockRig();
  writeFileSync(path.join(brain, 'secret.txt'), 'the org key\n');
  symlinkSync(path.join(brain, 'secret.txt'), path.join(brain, 'dirs-library', 'coaching-templates', 'files', 'leak.txt'));
  assert.equal(runPublish(state, brain).status, 0);
  const c = clonedView(bare);
  assert.ok(!existsSync(path.join(c, 'dirs', 'library', 'coaching-templates', 'leak.txt')), 'symlink dropped, not dereferenced');
});

test('publish refuses honestly with no config and with an unreachable repo', () => {
  const root = tmpDir('publish-');
  const state = path.join(root, 'state'); const brain = path.join(root, 'brain');
  mkdirSync(state, { recursive: true }); mkdirSync(brain, { recursive: true });
  const r = runPublish(state, brain);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no commons is configured yet/);
  writeFileSync(path.join(state, 'commons.conf'), 'URL=https://127.0.0.1:1/x/y.git\nORG=hg-x\n');
  const r2 = runPublish(state, brain);
  assert.equal(r2.status, 1);
  assert.match(r2.stdout, /could not reach the commons repository/);
});

test('THE LOOP: publish from a rock brain, pull on a member box, inbox shape end to end', () => {
  const { state, brain, bare } = rockRig();
  assert.equal(runPublish(state, brain).status, 0);
  const member = tmpDir('member-state-');
  const rec = { org: 'harbour-guild', org_display: 'Harbour Guild', url: bare, branch: 'main', status: 'joined' };
  writeCommunity(member, rec);
  assert.equal(pullOne(member, rec).status, 'ok');
  const inbox = path.join(member, 'org-inbox.d', 'harbour-guild');
  // exactly what dir-install/page-install/prompts-list/catalog-list will read
  assert.ok(existsSync(path.join(inbox, 'skills', 'tide-tables', 'skill.yaml')));
  assert.ok(existsSync(path.join(inbox, 'offers-pages', 'pipeline.html')));
  assert.ok(existsSync(path.join(inbox, 'prompts', 'library', 'kickoff.md')));
  assert.ok(existsSync(path.join(inbox, 'dirs', 'starter-kit', 'starter-templates', 'a.md')));
  const cat = JSON.parse(readFileSync(path.join(inbox, 'catalog', 'catalog.json'), 'utf8'));
  assert.ok(cat.items.length >= 5);
  assert.equal(readFileSync(path.join(member, 'org-inbox.d', 'harbour-guild.conf'), 'utf8'), 'COMMONS=1\nORG=harbour-guild\n');
});
