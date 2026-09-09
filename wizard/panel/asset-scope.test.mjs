// asset-scope.test.mjs — the brain viewer stopped being .md-only on 2026-08-17,
// so this file is the boundary that ".md only" used to be.
// Run: node --test wizard/panel/asset-scope.test.mjs
//
// Why this file exists. Until this change the viewer's secrecy story was a
// side effect of its file filter: brainVerbs said in its own comment that
// machine/secret files were "unreachable by construction, not by deny-list",
// and that construction WAS the `.md` suffix. Sam's ruling widened the filter to
// images and flat text so a member can see their own photos and spreadsheets in
// their own app. The moment that happened, the suffix stopped being a boundary
// and became merely a filter, and the boundary had to be written down somewhere
// it could be tested. Here.
//
// The asserts below are deliberately BY NAME rather than "whatever ASSET_EXT
// happens to say today". A test that reads the allow-list and checks the
// allow-list is a tautology: it would pass just as happily the day somebody adds
// 'env' to it. These name .env, .json, .yaml and the dotfiles explicitly, so
// widening the list far enough to readmit a secret carrier fails HERE, loudly,
// instead of on a member's box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMBER_VERBS } from './panel-server.mjs';

// the one served table (the org VERBS table was deleted 2026-09-09)
const build = (verb, args) => MEMBER_VERBS[verb].build(args);
// A 400 from the arg validators is how a refusal looks on this surface.
const refuses = (verb, args) => {
  try {
    build(verb, args);
    return null;                       // built a command: NOT refused
  } catch (e) {
    assert.equal(e.status, 400, `${verb} threw something that is not a 400: ${e.message}`);
    return e.message;
  }
};

// ---------------------------------------------------------------- the refusals

test('the named secret carriers stay unreachable on both read verbs', () => {
  // The four families the original comment called out, plus the three Sam ruled
  // out on 2026-08-17 (svg carries script, pdf is a transport problem, source
  // files are where a rock's machinery lives).
  const mustRefuse = [
    'notes/.env',
    '.env',
    'registry/index.json',
    'notes/index.json',
    'org-policy.yaml',
    'deployment.yml',
    'notes/diagram.svg',           // script-bearing
    'notes/contract.pdf',          // refused on transport grounds
    'orchestrator/evict-member.mjs',
    'tools/render-identity.js',
    'scripts/deploy.sh',
    'notes/query.sql',
    'tools/build.py',
  ];
  for (const p of mustRefuse) {
    assert.ok(refuses('brain-read', { page: p }), `brain-read must refuse ${p}`);
    assert.ok(refuses('brain-image', { page: p }), `brain-image must refuse ${p}`);
  }
});

test('dotfiles and dot-directories stay unreachable however they are spelled', () => {
  const mustRefuse = [
    '.git/config',
    '.claude-auth/token.md',        // .md suffix does NOT buy a dotdir a way in
    '.kernel/state.txt',
    'notes/.hidden.md',
    'notes/.secret.png',
  ];
  for (const p of mustRefuse) {
    assert.ok(refuses('brain-read', { page: p }), `brain-read must refuse ${p}`);
    assert.ok(refuses('brain-image', { page: p }), `brain-image must refuse ${p}`);
  }
});

test('traversal cannot climb out of the brain', () => {
  for (const p of ['../secrets.md', 'notes/../../etc/passwd.md', '../../x.png', 'a/../../b.txt']) {
    assert.ok(refuses('brain-read', { page: p }), `brain-read must refuse ${p}`);
    assert.ok(refuses('brain-image', { page: p }), `brain-image must refuse ${p}`);
  }
});

test('an extension is not a suffix: a secret file cannot wear a page name', () => {
  // The failure this guards: matching /\.md/ anywhere instead of at the end, so
  // `secrets.md.env` reads as "ends in .md" to a sloppy check.
  for (const p of ['secrets.md.env', 'config.png.json', 'notes/page.md.yaml']) {
    assert.ok(refuses('brain-read', { page: p }), `brain-read must refuse ${p}`);
    assert.ok(refuses('brain-image', { page: p }), `brain-image must refuse ${p}`);
  }
});

test('a missing or non-string page is refused, not coerced', () => {
  for (const v of [undefined, null, '', 42, {}, []]) {
    assert.ok(refuses('brain-read', { page: v }), `brain-read must refuse ${JSON.stringify(v)}`);
    assert.ok(refuses('brain-image', { page: v }), `brain-image must refuse ${JSON.stringify(v)}`);
  }
});

// ---------------------------------------------------------------- the allowals

test('the families Sam allowed really do open', () => {
  for (const p of ['README.md', 'notes/plan.md', 'wiki/_layers/1-north-star.md',
                   'notes/scratch.txt', 'notes/budget.csv', 'notes/rows.tsv']) {
    assert.equal(refuses('brain-read', { page: p }), null, `brain-read must allow ${p}`);
  }
  for (const p of ['notes/shot.png', 'notes/a.jpg', 'photo.jpeg', 'notes/anim.gif', 'notes/x.webp']) {
    assert.equal(refuses('brain-image', { page: p }), null, `brain-image must allow ${p}`);
  }
});

test('the leading underscore keeps working (finding 107 does not regress)', () => {
  // /onboard writes every layer to wiki/_layers/, and requiring a leading
  // alphanumeric once made the entire product of onboarding unopenable.
  for (const p of ['wiki/_layers/8-workflow.md', '_hot.md', 'notes/_mode.md']) {
    assert.equal(refuses('brain-read', { page: p }), null, `brain-read must allow ${p}`);
  }
  assert.equal(refuses('brain-image', { page: 'wiki/_assets/logo.png' }), null);
});

test('the two doors stay separate: text is not read as an image, nor the reverse', () => {
  // One verb with a mode flag would mean one validator deciding two things, and
  // the binary path is the one with a size cap on it.
  assert.ok(refuses('brain-read', { page: 'notes/shot.png' }), 'brain-read must not serve an image');
  assert.ok(refuses('brain-image', { page: 'notes/plan.md' }), 'brain-image must not serve a page');
});

// ---------------------------------------------------------- the built commands

test('the image verb caps size BEFORE it base64s anything', () => {
  const { command } = build('brain-image', { page: 'notes/shot.png' });
  const capAt = command.indexOf('-le ');
  const b64At = command.indexOf('base64');
  assert.ok(capAt > 0, 'there must be a size check');
  assert.ok(b64At > capAt, 'the cap must be checked before base64 runs, or a huge file still wedges the channel');
  assert.match(command, /too large to preview/, 'and it must refuse in words a member can act on');
});

test('the image verb marks its payload so the app never guesses at the bytes', () => {
  const { command } = build('brain-image', { page: 'notes/shot.png' });
  assert.match(command, /__IMAGE__ png/, 'the marker carries the real extension');
});

test('the list verb is built from the allow-list, not a second hand-written one', () => {
  // Finding 107 was one wiki with three readers giving three answers. A hard-coded
  // extension list beside ASSET_EXT would be that bug again.
  const { command } = build('brain-list', {});
  for (const e of ['md', 'txt', 'csv', 'tsv', 'png', 'jpg', 'jpeg', 'gif', 'webp']) {
    assert.ok(command.includes(`-name '*.${e}'`), `brain-list must find .${e}`);
  }
  for (const e of ['env', 'json', 'yaml', 'yml', 'svg', 'pdf', 'mjs', 'sh']) {
    assert.ok(!command.includes(`-name '*.${e}'`), `brain-list must NOT find .${e}`);
  }
});

test('the read verbs stay read-only', () => {
  for (const verb of ['brain-list', 'brain-read', 'brain-image']) {
    assert.notEqual(MEMBER_VERBS[verb].mutating, true, `${verb} must not be a mutating verb`);
  }
});
