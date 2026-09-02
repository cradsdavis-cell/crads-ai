// commons-verbs.test.mjs: the commons-repo model's verb surface (self-host
// pivot, 2026-09-01). Member verbs: community-list/join/leave/share. Org
// verbs: commons-status/roster/init/publish/grant/revoke. Pins the flags
// (mutating, adminOnly), the stdin transport for everything typed, the
// engine-too-old rails, and PARITY between the app-side shallow bundle check
// and the engine's authoritative parser over one fixture set.
//   node --test wizard/panel/commons-verbs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../../tests/tmp-dir.mjs';
import { MEMBER_VERBS, VERBS, checkJoinBundle } from './panel-server.mjs';
import { mintBundle, parseBundle } from '../../engine/community/commons-lib.mjs';

const B = (o) => 'cradscommons1:' + Buffer.from(JSON.stringify(o)).toString('base64');

// ---- member verbs ----------------------------------------------------------

test('community-list is read-only, engine-pathed, with a dormant rail for old images', () => {
  const v = MEMBER_VERBS['community-list'];
  assert.ok(!v.mutating);
  const cmd = v.build().command;
  assert.match(cmd, /engine\/community\/community-list\.mjs/);
  assert.match(cmd, /COMMUNITIES_STATE .*dormant/, 'an old image reads as dormant, never as empty');
});

test('community-join: the bundle rides stdin, never the command string', () => {
  const v = MEMBER_VERBS['community-join'];
  assert.equal(v.mutating, true);
  const bundle = mintBundle({ org: 'hg-guild', org_display: 'HG', url: 'https://github.com/hg/c.git' });
  const spec = v.build({ bundle });
  assert.ok(!spec.command.includes(bundle), 'nothing pasted appears in the shell command');
  assert.equal(spec.stdin, bundle + '\n');
  assert.match(spec.command, /community-join\.mjs/);
  assert.match(spec.command, /too old to join communities/, 'old images refuse honestly');
});

test('community-join refuses malformed bundles app-side, loudly', () => {
  const v = MEMBER_VERBS['community-join'];
  for (const bad of ['', 'garbage', 'cradscommons1:!!!', B({ org: 'X X', url: 'https://github.com/a/b' }), B({ org: 'ok-org', url: 'file:///etc/passwd' })]) {
    assert.throws(() => v.build({ bundle: bad }), /bundle|empty/, `refused: ${String(bad).slice(0, 30)}`);
  }
});

test('community-leave and community-share validate every interpolated arg', () => {
  assert.equal(MEMBER_VERBS['community-leave'].mutating, true);
  for (const evil of ['../up', 'a b', 'X', '$(id)', '', 'x'.repeat(70)]) {
    assert.throws(() => MEMBER_VERBS['community-leave'].build({ org: evil }), /community name/);
    assert.throws(() => MEMBER_VERBS['community-share'].build({ org: 'hg-guild', kind: 'skill', id: evil }), /kebab-case/);
  }
  assert.throws(() => MEMBER_VERBS['community-share'].build({ org: 'hg-guild', kind: 'widget', id: 'ok-id' }), /kind must be/);
  const cmd = MEMBER_VERBS['community-share'].build({ org: 'hg-guild', kind: 'skill', id: 'my-skill' }).command;
  assert.match(cmd, /commons-share\.mjs/);
  assert.match(cmd, /hg-guild skill my-skill/);
});

// ---- org verbs -------------------------------------------------------------

test('commons reads are open; every commons write is adminOnly and mutating', () => {
  assert.ok(!VERBS['commons-status'].mutating);
  assert.ok(!VERBS['commons-roster'].mutating);
  for (const w of ['commons-init', 'commons-publish', 'commons-grant', 'commons-revoke']) {
    assert.equal(VERBS[w].adminOnly, true, `${w} is the owner's dial, not Support's`);
    assert.equal(VERBS[w].mutating, true, w);
  }
});

test('commons-init and commons-grant carry their payloads as base64 stdin only', () => {
  const payload = Buffer.from(JSON.stringify({ url: 'https://github.com/hg/c.git', org: 'hg-x', key: 'SECRET' })).toString('base64');
  const spec = VERBS['commons-init'].build({ payload_b64: payload });
  assert.ok(!spec.command.includes('SECRET') && !spec.command.includes(payload), 'the key never reaches the command string');
  assert.equal(spec.stdin, payload + '\n');
  assert.match(spec.command, /base64 -d \| node "\$S" \/state "\$BR" init/);
  assert.throws(() => VERBS['commons-init'].build({ payload_b64: 'not base64!!' }), /base64/);
  const g = VERBS['commons-grant'].build({ payload_b64: payload });
  assert.match(g.command, /grant$/);
  assert.equal(g.stdin, payload + '\n');
});

test('commons-publish and commons-revoke: engine paths, validated args, honest rails', () => {
  const p = VERBS['commons-publish'].build().command;
  assert.match(p, /commons-publish\.mjs/);
  assert.match(p, /too old to run a commons/);
  const r = VERBS['commons-revoke'].build({ id: 'g-abc12345' }).command;
  assert.match(r, /revoke g-abc12345/);
  for (const evil of ['', 'g-UPPER', 'x-abc12345', 'g-abc;id', 'g-' + 'a'.repeat(20)]) {
    assert.throws(() => VERBS['commons-revoke'].build({ id: evil }), /grant id/);
  }
});

test('the member edition gains no commons owner powers', () => {
  for (const w of ['commons-init', 'commons-publish', 'commons-grant', 'commons-revoke', 'commons-status', 'commons-roster', 'commons-create']) {
    assert.ok(!MEMBER_VERBS[w], `${w} is org-only`);
  }
});

// ---- the 2026-09-02 usability verbs ----------------------------------------

test('commons-create: adminOnly, mutating, payload as base64 stdin only, honest old-image rail', () => {
  const v = VERBS['commons-create'];
  assert.equal(v.adminOnly, true, 'starting a community is the owner\'s dial');
  assert.equal(v.mutating, true);
  const payload = Buffer.from(JSON.stringify({ name: 'Harbour Guild', open: false })).toString('base64');
  const spec = v.build({ payload_b64: payload });
  assert.ok(!spec.command.includes('Harbour'), 'nothing typed reaches the command string');
  assert.equal(spec.stdin, payload + '\n');
  assert.match(spec.command, /commons-create\.mjs/);
  assert.match(spec.command, /too old to start a community/);
  assert.throws(() => v.build({ payload_b64: 'not base64!!' }), /base64/);
  assert.throws(() => v.build({}), /base64/);
});

test('commons-revoke: github:true appends the and-github flag and nothing else can', () => {
  const plain = VERBS['commons-revoke'].build({ id: 'g-abc12345' }).command;
  assert.ok(!/and-github/.test(plain), 'the GitHub half is opt-in');
  const both = VERBS['commons-revoke'].build({ id: 'g-abc12345', github: true }).command;
  assert.match(both, /revoke g-abc12345 and-github$/);
  const off = VERBS['commons-revoke'].build({ id: 'g-abc12345', github: 'nonsense' }).command;
  assert.ok(!/and-github/.test(off), 'only an explicit true arms it');
});

test('community-check and community-seen: member verbs, validated org, honest rails', () => {
  for (const [name, rail] of [['community-check', /too old to re-check/], ['community-seen', /too old to track new shared items/]]) {
    const v = MEMBER_VERBS[name];
    assert.ok(v, `${name} exists on the member surface`);
    assert.equal(v.mutating, true, `${name} writes the record`);
    const cmd = v.build({ org: 'hg-guild' }).command;
    assert.match(cmd, new RegExp(`${name}\\.mjs`));
    assert.match(cmd, / hg-guild$/);
    assert.match(cmd, rail);
    for (const evil of ['../up', 'a b', '$(id)', '', 'X', 'x'.repeat(70)]) {
      assert.throws(() => v.build({ org: evil }), /community name/, `${name} refused: ${evil.slice(0, 12)}`);
    }
    assert.ok(!VERBS[name], `${name} is member-side; the org table gains nothing`);
  }
});

// ---- the pickup loop closes on a commons inbox -----------------------------
// The whole point of the transport: a commons checkout at org-inbox.d/<org>/
// with a COMMONS=1 conf is indistinguishable from a joined rock's inbox to
// the existing installers. Run the REAL catalog-install shell (the skill
// path) against a commons-shaped state dir through a local bash, /state
// rewritten to scratch exactly as device-routes.test.mjs rewrites its box
// paths, and watch the skill land with commons provenance.
test('catalog-install (skill path) installs from a commons inbox like any joined inbox', (t) => {
  const state = tmpDir('commons-pickup-');
  writeFileSync(join(state, 'deployment.yaml'), `brain_root: "${state}"\n`);
  mkdirSync(join(state, 'org-inbox.d', 'hg-guild', 'skills', 'tide-tables'), { recursive: true });
  writeFileSync(join(state, 'org-inbox.d', 'hg-guild.conf'), 'COMMONS=1\nORG=hg-guild\n');
  writeFileSync(join(state, 'org-inbox.d', 'hg-guild', 'skills', 'tide-tables', 'SKILL.md'), '# tide tables\n');
  writeFileSync(join(state, 'org-inbox.d', 'hg-guild', 'skills', 'tide-tables', 'skill.yaml'), 'id: tide-tables\nversion: 2\n');
  const spec = MEMBER_VERBS['catalog-install'].build({ id: 'tide-tables' });
  const local = spec.command.split('/state').join(state);
  const r = spawnSync('bash', ['-c', local], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK: \/tide-tables installed/);
  assert.match(readFileSync(join(state, '.claude', 'skills', 'tide-tables', 'SKILL.md'), 'utf8'), /tide tables/);
  const origin = JSON.parse(readFileSync(join(state, '.claude', 'skills', 'tide-tables', '.origin.json'), 'utf8'));
  assert.equal(origin.rock, 'hg-guild', 'provenance names the community');
  assert.equal(origin.version, 2);
});

// ---- parity: app-side shallow check vs the engine's parser -----------------
// The app check exists for a fast honest refusal; the engine re-parses on the
// box and is the authority. Over this fixture set the two must agree exactly,
// so neither can drift into refusing what the other accepts.

test('bundle-check parity with engine parseBundle over the shared fixture set', () => {
  const fixtures = [
    mintBundle({ org: 'hg-guild', org_display: 'HG', url: 'https://github.com/hg/c.git', branch: 'main' }),
    mintBundle({ org: 'aa', url: 'git@github.com:a/b.git' }),
    mintBundle({ org: 'zz-org', url: 'ssh://git@code.example.com/z/commons' }),
    '', 'garbage', 'crads1:abc', 'cradscommons1:', 'cradscommons1:!!!',
    B('not an object'), B({ org: 'Bad Org', url: 'https://github.com/a/b' }),
    B({ org: 'ok-org', url: 'file:///etc/passwd' }),
    B({ org: 'ok-org', url: '/tmp/repo' }),
    B({ org: 'ok-org', url: 'ext::sh -c id' }),
    B({ org: 'ok-org', url: 'https://github.com/a/b', branch: '-e' }),
    'cradscommons1:' + 'x'.repeat(5000),
  ];
  for (const f of fixtures) {
    const app = checkJoinBundle(f);
    const engine = parseBundle(f);
    assert.equal(app.ok, engine.ok, `parity on: ${String(f).slice(0, 50)}`);
  }
});
