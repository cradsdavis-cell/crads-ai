// brain-public.test.mjs — the rock-side half of the public brain (S9, ruling
// R7 2026-08-09; LOCAL ONLY since the self-host strip 2026-09-01). The pins
// that matter: the guards (personal/** + enclave) hold at BOTH gates (set-time
// and push-time), the wiki scope keeps machinery out, and neither push nor
// toggle touches the network any more. Run:
// node --test engine/ops/brain-public.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'brain-public.mjs');

function makeRock() {
  const root = tmpDir('pubbrain-');
  const br = join(root, 'brain'); mkdirSync(br);
  writeFileSync(join(br, 'org-policy.yaml'), 'org:\n  name: "acme"\n  display_name: "Acme"\n');
  // A stale .env still naming the dead directory must be inert, so keep one in
  // the fixture: the script must never read CRADS_DIRECTORY_URL again.
  writeFileSync(join(br, '.env'), `ORG_PULL_TOKEN=tok-123\nCRADS_DIRECTORY_URL=http://127.0.0.1:9\n`);
  writeFileSync(join(br, 'priorities.md'), '# Priorities\n\nShip the thing.\n');
  mkdirSync(join(br, 'notes'));
  writeFileSync(join(br, 'notes', 'vision.md'), '---\ntitle: Vision\n---\n# Vision\n');
  mkdirSync(join(br, 'notes', 'personal'));
  writeFileSync(join(br, 'notes', 'personal', 'diary.md'), '# Diary\n');
  writeFileSync(join(br, 'notes', 'therapy.md'), '---\nenclave: true\n---\n# Sessions\n');
  mkdirSync(join(br, 'registry'));
  writeFileSync(join(br, 'registry', 'index.md'), '# machinery\n');
  const state = join(root, 'state'); mkdirSync(state);
  return { br, state };
}
const runIt = (br, state, args, opts = {}) =>
  execFileSync(process.execPath, [SCRIPT, br, ...args],
    { encoding: 'utf8', env: { ...process.env, AIOS_STATE_DIR: state }, ...opts });

test('list walks the wiki proper only and reports guard states', () => {
  const { br, state } = makeRock();
  const out = runIt(br, state, ['list']);
  const d = JSON.parse(out.slice(out.indexOf('PUBLIC_BRAIN ') + 'PUBLIC_BRAIN '.length));
  const byPage = Object.fromEntries(d.pages.map((p) => [p.page, p]));
  assert.ok(byPage['priorities.md'] && byPage['notes/vision.md'], 'wiki pages listed');
  assert.ok(!byPage['registry/index.md'], 'machinery is not even nameable here');
  assert.equal(byPage['notes/personal/diary.md'].guarded, true, 'personal/** guarded');
  assert.equal(byPage['notes/therapy.md'].guarded, true, 'enclave guarded');
  assert.equal(d.public, 0);
});

test('set writes the frontmatter flag; the guards refuse at set time', () => {
  const { br, state } = makeRock();
  runIt(br, state, ['set', 'notes/vision.md', 'on']);
  assert.match(readFileSync(join(br, 'notes', 'vision.md'), 'utf8'), /^---\npublic: true\n/m, 'flag lands inside the existing frontmatter');
  runIt(br, state, ['set', 'priorities.md', 'on']);
  assert.match(readFileSync(join(br, 'priorities.md'), 'utf8'), /^---\npublic: true\n---\n/, 'a bare page grows a frontmatter block');
  runIt(br, state, ['set', 'priorities.md', 'off']);
  assert.match(readFileSync(join(br, 'priorities.md'), 'utf8'), /^public: false$/m);
  for (const guarded of ['notes/personal/diary.md', 'notes/therapy.md']) {
    assert.throws(() => runIt(br, state, ['set', guarded, 'on']), /refused/i, guarded + ' refused at set time');
  }
});

test('push counts exactly the marked, unguarded pages, POSTs nowhere, and says so', () => {
  // Self-host strip: the .env in the fixture names a dead host on purpose. A
  // push that still tried it would error here; a push that quietly succeeded
  // by fetching anywhere would be worse. It must be synchronous-safe (no HTTP
  // stub needed at all) and honest in its words.
  const { br, state } = makeRock();
  runIt(br, state, ['set', 'notes/vision.md', 'on']);
  // gate 2: a flag hand-edited onto an enclave page must still never count
  writeFileSync(join(br, 'notes', 'therapy.md'), '---\npublic: true\nenclave: true\n---\n# Sessions\n');
  const out = runIt(br, state, ['push']);
  assert.match(out, /^OK: 1 public page marked shareable/m, 'one public page, zero guarded ones');
  assert.match(out, /nothing is pushed anywhere/, 'the words must not imply a publish that no longer happens');
  // --if-changed still detects a no-op second run
  runIt(br, state, ['push', '--if-changed']);
  const out3 = runIt(br, state, ['push', '--if-changed']);
  assert.match(out3, /unchanged/, 'the change guard survives the strip');
});

test('toggle mirrors sharing.json for the card + the cron gate, with no network', () => {
  const { br, state } = makeRock();
  runIt(br, state, ['toggle', 'on']);
  const sh = JSON.parse(readFileSync(join(state, 'cockpit', 'sharing.json'), 'utf8'));
  assert.equal(sh.public_brain, true, 'the mirror the Sharing card and the cron read');
  runIt(br, state, ['toggle', 'off']);
  assert.equal(JSON.parse(readFileSync(join(state, 'cockpit', 'sharing.json'), 'utf8')).public_brain, false);
});

test('brain-public holds no network client at all (self-host strip)', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.ok(!/fetch\s*\(/.test(src), 'no fetch left in brain-public.mjs');
  assert.ok(!/directory\.crads-ai\.com|CRADS_DIRECTORY_URL/.test(src.replace(/^\s*\/\/.*$/gm, '')),
    'no directory URL or env read outside comments');
});

// --- finding 107: the onboarded brain must be shareable at all ---------------
//
// Driven on a fully onboarded rock: `list` returned exactly CLAUDE.md,
// README.md and notes/README.md. /onboard writes eight layers to wiki/_layers/
// and people to wiki/people/, and none appeared. They were not merely unshared,
// they were UNSHAREABLE: `set` refuses a page `list` does not know, so there was
// no way to mark them public at all. Sharing the brain with tied pebbles is the
// reason a rock exists.
test('107: wiki/ pages are in scope, so an onboarded brain can be shared', () => {
  const { br, state } = makeRock();
  mkdirSync(join(br, 'wiki', '_layers'), { recursive: true });
  mkdirSync(join(br, 'wiki', 'people'), { recursive: true });
  writeFileSync(join(br, 'wiki', '_layers', '1-north-star.md'), '# North Star\n');
  writeFileSync(join(br, 'wiki', 'people', 'sam-davis.md'), '# Sam\n');

  const listed = (JSON.parse(runIt(br, state, ['list']).replace(/^PUBLIC_BRAIN /, '')).pages || [])
    .map((p) => p.page);
  assert.ok(listed.includes('wiki/_layers/1-north-star.md'),
    `an onboarding layer must be listable, got: ${listed.join(', ')}`);
  assert.ok(listed.includes('wiki/people/sam-davis.md'),
    `a person page must be listable, got: ${listed.join(', ')}`);

  // and listable means markable: `set` is gated on the same scope
  runIt(br, state, ['set', 'wiki/_layers/1-north-star.md', 'on']);
  const after = (JSON.parse(runIt(br, state, ['list']).replace(/^PUBLIC_BRAIN /, '')).pages || [])
    .find((p) => p.page === 'wiki/_layers/1-north-star.md');
  assert.equal(after && after.public, true, 'a layer must be markable public, not just visible');
});

// The guard that must NOT loosen with the scope: machinery and dotdirs stay out.
test('107: widening the scope does not let machinery or dotfiles in', () => {
  const { br, state } = makeRock();
  mkdirSync(join(br, 'wiki'), { recursive: true });
  writeFileSync(join(br, 'wiki', 'ok.md'), '# ok\n');
  const listed = (JSON.parse(runIt(br, state, ['list']).replace(/^PUBLIC_BRAIN /, '')).pages || [])
    .map((p) => p.page);
  assert.ok(!listed.some((p) => p.startsWith('registry/')), 'registry/ is machinery, never a page');
  assert.ok(!listed.some((p) => p.includes('/.')), 'no dotdirs');
});
