// p2-authoring-verbs.test.mjs — pack authoring (Phase 5, task 2): editing
// prompts and pages inside a pack that already exists.
//   node --test wizard/panel/p2-authoring-verbs.test.mjs
//
// THE RULE THIS FILE IS BUILT AROUND, from panel-server.mjs's own history at
// the community-blurb verb: content NEVER reaches the shell. The first cut of
// that verb interpolated a free-text blurb into a single-quoted shell word
// and refused " \ $ and backtick, but NOT the apostrophe, which is the one
// character that ENDS a single-quoted string — so "We're a builders'
// collective" corrupted the request and a crafted blurb ran arbitrary
// commands on the rock's container. Its own test tried only a double quote
// and $(whoami), so a green suite certified it safe. The test below tries
// the apostrophe on purpose, and asserts the PROPERTY (content never in the
// command, always on stdin) rather than a list of escaped characters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERBS } from './panel-server.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rewrite = (root, cmd) => cmd.replace(/\/state(?=[\/;"' ])/g, root + '/state').split('/app/engine/').join(root + '/app/engine/');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// Same fixture idiom as p2-library-verb.test.mjs: a temp root standing in for
// the box, `rewrite()` maps /state and /app/engine/ into it, verbs run for
// real through bash -c so the actual command (not a paraphrase of it) is what
// gets exercised.
function box({ withEngine = true } = {}) {
  const root = tmpDir('p2auth-');
  // The org brain resolves to <root>/state/brain because that directory
  // exists (brain-root.mjs's `[ -d "$BR" ] || BR=/state` leg) — same trick
  // p2-library-verb.test.mjs uses for /state/brain/library.
  mkdirSync(path.join(root, 'state', 'brain'), { recursive: true });
  if (withEngine) {
    const dst = path.join(root, 'app', 'engine', 'appshell');
    mkdirSync(dst, { recursive: true });
    // prompts-list.mjs (final review, 2026-08-26, F1): pack-content.mjs now
    // imports isDeliverablePromptFile from it, so a fixture that stages
    // pack-content.mjs without its sibling fails at run time with a module
    // resolution error, not a clean dormant fallback.
    for (const f of ['pack-content.mjs', 'page-lint.mjs', 'prompts-list.mjs']) {
      cpSync(path.join(HERE, '..', '..', 'engine', 'appshell', f), path.join(dst, f));
    }
  }
  const w = (rel, body) => {
    const p = path.join(root, 'state', rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
  };
  const run = (cmd, { stdin } = {}) => {
    let out = '', code = 0;
    try {
      out = execFileSync('bash', ['-c', rewrite(root, cmd)], {
        encoding: 'utf8', cwd: root, env: { ...process.env, BRAIN_ROOT: '' }, input: stdin,
      });
    } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); code = e.status; }
    return { out, code };
  };
  const brainPath = (rel) => path.join(root, 'state', 'brain', rel);
  return { root, w, run, brainPath, done: () => rmSync(root, { recursive: true, force: true }) };
}

// A pack that already exists — the only kind this plan's verbs are allowed
// to touch (creating a pack, and pack.yaml itself, are out of scope).
function seedPack(b, pack) {
  b.w(`brain/packs/${pack}/pack.yaml`, `id: "${pack}"\ntitle: "Demo pack"\nprompts: []\npages: []\n`);
}

// Runs a verb exactly the way the browser does: build() first (which is
// where the argument regexes and bad() live), then the built command through
// a real shell with the built stdin piped in.
function runVerb(b, name, args) {
  const built = VERBS[name].build(args);
  return { ...b.run(built.command, { stdin: built.stdin }), built };
}

test('shape: prompt-write and page-write are adminOnly and mutating; pack-content-list is neither', () => {
  assert.equal(VERBS['prompt-write'].adminOnly, true, 'prompt-write is an admin act');
  assert.equal(VERBS['prompt-write'].mutating, true, 'prompt-write writes to disk');
  assert.equal(VERBS['page-write'].adminOnly, true, 'page-write is an admin act');
  assert.equal(VERBS['page-write'].mutating, true, 'page-write writes to disk');
  assert.notEqual(VERBS['pack-content-list'].adminOnly, true, 'reading pack content needs no admin role');
  assert.notEqual(VERBS['pack-content-list'].mutating, true, 'reading pack content never mutates');
});

test('a prompt saves into packs/<pack>/prompts/<name>.md with byte-identical content', () => {
  const b = box();
  seedPack(b, 'demo');
  const body = '# Kickoff\n\nSay hello, then ask what they are building.\n';
  const r = runVerb(b, 'prompt-write', { pack: 'demo', name: 'kickoff', content_b64: b64(body) });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^OK:/m, r.out);
  assert.equal(readFileSync(b.brainPath('packs/demo/prompts/kickoff.md'), 'utf8'), body);
  b.done();
});

// The injection proof, written deliberately (see file header). Every
// character that broke the blurb verb is here, plus the apostrophe itself,
// twice. The canary paths live inside this test's OWN temp dir, never /tmp,
// so a real failure here cannot escape the fixture.
test('the injection proof: a hostile prompt body never reaches the shell', () => {
  const b = box();
  seedPack(b, 'demo');
  const canary1 = path.join(b.root, 'pwned-CANARY');
  const canary2 = path.join(b.root, 'pwned-CANARY2');
  const body = "We're a builders' collective. $(touch " + canary1 + ') `touch ' + canary2 + '` "quoted" \\\\ backslash';
  const r = runVerb(b, 'prompt-write', { pack: 'demo', name: 'hostile', content_b64: b64(body) });
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(b.brainPath('packs/demo/prompts/hostile.md'), 'utf8'), body,
    'byte-identical, including the apostrophes, the substitutions and the backslash');
  assert.ok(!existsSync(canary1), 'no command executed: canary 1 was never created');
  assert.ok(!existsSync(canary2), 'no command executed: canary 2 was never created');
  b.done();
});

test('a page with a clean body saves', () => {
  const b = box();
  seedPack(b, 'demo');
  const body = '<!doctype html>\n<html><body><h1>Welcome</h1></body></html>\n';
  const r = runVerb(b, 'page-write', { pack: 'demo', id: 'welcome', content_b64: b64(body) });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^OK:/m, r.out);
  assert.equal(readFileSync(b.brainPath('packs/demo/pages/welcome.html'), 'utf8'), body);
  b.done();
});

test('a page calling an unlisted verb is refused, nothing is written, and the message names the page and the verb', () => {
  const b = box();
  seedPack(b, 'demo');
  const body = '<script>pageApi.run(\'box-refresh\')</script>';
  const r = runVerb(b, 'page-write', { pack: 'demo', id: 'bad', content_b64: b64(body) });
  assert.notEqual(r.code, 0, 'the linter refuses it');
  assert.match(r.out, /ERROR:/, r.out);
  assert.match(r.out, /bad\.html/, 'the message names the page, not a temp filename');
  assert.match(r.out, /box-refresh/, 'the message names the offending verb');
  assert.ok(!existsSync(b.brainPath('packs/demo/pages/bad.html')), 'nothing was written');
  b.done();
});

test('a page save with no linter available succeeds and warns', () => {
  const b = box({ withEngine: false });
  seedPack(b, 'demo');
  const body = '<p>a plain page</p>';
  const r = runVerb(b, 'page-write', { pack: 'demo', id: 'plain', content_b64: b64(body) });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /WARN:/, r.out);
  assert.equal(readFileSync(b.brainPath('packs/demo/pages/plain.html'), 'utf8'), body);
  b.done();
});

// --- Final review fixes (F3) ------------------------------------------------
//
// panel-server.mjs chained mkdir/base64/mv with bare `;`, so the command's
// own exit code was whatever the trailing `echo "OK: ..."` returned: always
// 0. A failed write reported success while nothing (or only part of
// something) landed on disk, and member.html clears the operator's only
// copy of what they typed on r.ok. Each write step now checks its own exit
// status explicitly.

test('F3: prompt-write reports an error, never OK, when the prompts path cannot be created (a file sits where a directory belongs)', () => {
  const b = box();
  seedPack(b, 'demo');
  // A plain file at packs/demo/prompts blocks `mkdir -p packs/demo/prompts`
  // deterministically, on any platform and any uid, unlike a permission bit.
  b.w('brain/packs/demo/prompts', 'not a directory');
  const r = runVerb(b, 'prompt-write', { pack: 'demo', name: 'kickoff', content_b64: b64('# hi') });
  assert.notEqual(r.code, 0, 'a failed mkdir must not exit 0');
  assert.match(r.out, /^ERROR:/m, r.out);
  assert.doesNotMatch(r.out, /^OK:/m, 'never reports success on a failed write');
  b.done();
});

test('F3: page-write reports an error, never OK, when the pages path cannot be created (a file sits where a directory belongs)', () => {
  const b = box();
  seedPack(b, 'demo');
  b.w('brain/packs/demo/pages', 'not a directory');
  const body = '<p>a plain page</p>';
  const r = runVerb(b, 'page-write', { pack: 'demo', id: 'plain', content_b64: b64(body) });
  assert.notEqual(r.code, 0, 'a failed mkdir must not exit 0');
  assert.match(r.out, /^ERROR:/m, r.out);
  // page-lint.mjs itself prints its own "OK: <name>" diagnostic line on a
  // passing lint, a separate concern from the write itself; what must never
  // appear is the VERB'S OWN final success line, which member.html's r.ok
  // is derived from the exit code, not this text, but the operator reads
  // the text -- and it must never claim the save that did not happen.
  assert.doesNotMatch(r.out, /^OK: page /m, 'never reports the verb\'s own save-succeeded line on a failed write');
  assert.ok(!existsSync(b.brainPath('packs/demo/pages/plain.html')), 'nothing was written');
  b.done();
});

test('F3: prompt-write reports an error, never OK, when mv itself fails (prompts/ exists but is not writable)', { skip: process.getuid?.() === 0 ? 'skipped on root (chmod no-op)' : undefined }, () => {
  const b = box();
  seedPack(b, 'demo');
  const promptsDir = b.brainPath('packs/demo/prompts');
  mkdirSync(promptsDir, { recursive: true });
  chmodSync(promptsDir, 0o555); // mkdir -p on an existing dir needs no write bit, so this isolates the mv failure specifically
  const r = runVerb(b, 'prompt-write', { pack: 'demo', name: 'kickoff', content_b64: b64('# hi') });
  chmodSync(promptsDir, 0o755); // restore so b.done() can clean up
  assert.notEqual(r.code, 0, 'a failed mv must not exit 0');
  assert.match(r.out, /^ERROR:/m, r.out);
  assert.doesNotMatch(r.out, /^OK:/m, 'never reports success on a failed write');
  assert.ok(!existsSync(b.brainPath('packs/demo/prompts/kickoff.md')), 'nothing was written');
  b.done();
});

test('overwrite: a second save is refused by default and succeeds with overwrite true', () => {
  const b = box();
  seedPack(b, 'demo');
  const first = 'first version';
  const r1 = runVerb(b, 'prompt-write', { pack: 'demo', name: 'n', content_b64: b64(first) });
  assert.equal(r1.code, 0, r1.out);

  const second = 'second version';
  const r2 = runVerb(b, 'prompt-write', { pack: 'demo', name: 'n', content_b64: b64(second) });
  assert.notEqual(r2.code, 0, 'no overwrite flag: refused');
  assert.match(r2.out, /ERROR:/, r2.out);
  assert.equal(readFileSync(b.brainPath('packs/demo/prompts/n.md'), 'utf8'), first, 'the original is untouched');

  const r3 = runVerb(b, 'prompt-write', { pack: 'demo', name: 'n', content_b64: b64(second), overwrite: true });
  assert.equal(r3.code, 0, r3.out);
  assert.equal(readFileSync(b.brainPath('packs/demo/prompts/n.md'), 'utf8'), second, 'overwrite true replaces it');
  b.done();
});

test('a missing pack is refused by name, and no directory is created for it', () => {
  const b = box();
  const rPrompt = runVerb(b, 'prompt-write', { pack: 'ghost-pack', name: 'n', content_b64: b64('x') });
  assert.notEqual(rPrompt.code, 0);
  assert.match(rPrompt.out, /ghost-pack/, 'the refusal names the missing pack');
  assert.ok(!existsSync(b.brainPath('packs/ghost-pack')), 'no directory was created for the missing pack');

  const rPage = runVerb(b, 'page-write', { pack: 'ghost-pack', id: 'n', content_b64: b64('x') });
  assert.notEqual(rPage.code, 0);
  assert.match(rPage.out, /ghost-pack/, 'the refusal names the missing pack');
  assert.ok(!existsSync(b.brainPath('packs/ghost-pack')), 'no directory was created for the missing pack');
  b.done();
});

test('a bad pack, name or id is refused by bad() before any command runs', () => {
  assert.throws(() => VERBS['prompt-write'].build({ pack: 'Demo Pack', name: 'n', content_b64: b64('x') }), /pack/i);
  assert.throws(() => VERBS['prompt-write'].build({ pack: 'demo', name: 'N a m e', content_b64: b64('x') }), /name/i);
  assert.throws(() => VERBS['prompt-write'].build({ pack: 'demo', name: '../etc/passwd', content_b64: b64('x') }), /name/i);
  assert.throws(() => VERBS['page-write'].build({ pack: 'demo', id: '../../etc/passwd', content_b64: b64('x') }), /id/i);
  assert.throws(() => VERBS['page-write'].build({ pack: '', id: 'n', content_b64: b64('x') }), /pack/i);
});

test('pack-content-list reports dormant on an old image, never a hard error', () => {
  const b = box({ withEngine: false });
  const { command } = VERBS['pack-content-list'].build();
  const r = b.run(command);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PACKS_STATE/, r.out);
  const json = JSON.parse(r.out.slice(r.out.indexOf('PACKS_STATE') + 'PACKS_STATE '.length));
  assert.deepEqual(json.packs, []);
  assert.match(json.dormant || '', /update/i, 'the operator is told the box needs an update, not shown an error');
  b.done();
});

test('pack-content-list reports what a real pack ships, with the engine present', () => {
  const b = box();
  seedPack(b, 'demo');
  b.w('brain/packs/demo/prompts/kickoff.md', '# hi');
  const { command } = VERBS['pack-content-list'].build();
  const r = b.run(command);
  assert.equal(r.code, 0, r.out);
  const json = JSON.parse(r.out.slice(r.out.indexOf('PACKS_STATE') + 'PACKS_STATE '.length));
  const demo = json.packs.find((p) => p.id === 'demo');
  assert.ok(demo, 'the demo pack is reported');
  assert.ok(demo.prompts.some((p) => p.name === 'prompts/kickoff.md'), 'the prompt on disk is reported');
  b.done();
});
