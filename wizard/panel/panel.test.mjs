// panel.test.mjs: unit + routing tests for the D43/D44 panel pieces.
//   node --test wizard/panel/panel.test.mjs
// Zero deps: node:test + a fake bridge; no SSH, no network beyond loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { listPanelTargets } from './ssh-bridge.mjs';
import { createPanelServer, VERBS, MEMBER_VERBS } from './panel-server.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

// ---------------------------------------------------------------- targets
test('listPanelTargets: rock + member aliases, wildcards and dupes ignored', () => {
  const dir = tmpDir('pp-test-');
  const cfg = join(dir, 'config');
  writeFileSync(cfg, [
    'Host ic-rock',
    '  HostName 192.0.2.1',
    'Host *-rock',                 // wildcard: never a target
    'Host jane01-box',
    '  HostName 192.0.2.2',
    'Host ic-rock jane01-box',     // dupes on a multi-alias line
    'Host github.com',               // unrelated host: ignored
    'Host UPPER-rock',             // uppercase: not a slug, ignored
  ].join('\n'));
  const t = listPanelTargets(cfg);
  assert.deepEqual(t, [
    { host: 'ic-rock', org: 'ic', kind: 'rock' },
    { host: 'jane01-box', org: 'jane01', kind: 'member' },
  ]);
});

test('listPanelTargets: missing config -> empty', () => {
  assert.deepEqual(listPanelTargets(join(tmpdir(), 'nope-' + Date.now(), 'config')), []);
});

// ---------------------------------------------------------------- verb builds
test('brain-read: valid page paths pass, traversal and non-md refuse', () => {
  const build = VERBS['brain-read'].build;
  assert.match(build({ page: 'notes/priorities.md' }).command, /notes\/priorities\.md/);
  assert.match(build({ page: 'log.md' }).command, /cd "\$BR"/);
  for (const evil of ['../../etc/passwd.md', 'a/../b.md', '.env', 'x.md; rm -rf /', 'notes/.hidden.md',
    '-flag.md', 'a b.md', 'x.json', '', 'a//b.md']) {
    assert.throws(() => build({ page: evil }), /page must be/, `should refuse: ${evil}`);
  }
});

test('member brain verbs root at /state/wiki, org at the resolved brain_root', () => {
  assert.match(MEMBER_VERBS['brain-list'].build().command, /cd \/state\/wiki/);
  const orgList = VERBS['brain-list'].build().command;
  // resolved from deployment.yaml, env fallback, /state/brain last resort
  assert.match(orgList, /deployment\.yaml/);
  assert.match(orgList, /\$\{BRAIN_ROOT:-\/state\/brain\}/);
  assert.match(orgList, /cd "\$BR"/);
  assert.match(MEMBER_VERBS['brain-read'].build({ page: 'priorities.md' }).command, /cd \/state\/wiki/);
});

test('org brain-list scopes to the wiki proper; member brain-list stays repo-wide', () => {
  // 2026-08-17: the list finds the asset families too (images + flat text), so
  // the pin matches the grouped predicate rather than a bare -name '*.md'.
  // asset-scope.test.mjs owns WHICH extensions; this pin owns WHERE they look.
  const org = VERBS['brain-list'].build().command;
  assert.match(org, /-maxdepth 1 \\\( -name '\*\.md'/, 'root-level pages listed');
  assert.match(org, /notes decisions insights/, 'wiki dirs listed');
  assert.ok(!/find \. \\\( -name '\*\.md'[^\n]*-not -path/.test(org), 'no repo-wide find in the org list');
  const mem = MEMBER_VERBS['brain-list'].build().command;
  assert.match(mem, /find \. \\\( -name '\*\.md'/, 'member wiki is the whole tree');
  assert.match(mem, /-not -path '\.\/\.git\/\*'/, 'and .git stays out of it');
});

test('every org verb resolves brain_root instead of hardcoding /state/brain', () => {
  for (const [name, spec] of Object.entries(VERBS)) {
    if (name === 'catalog-sync' || name === 'box-refresh' || name === 'whoami') continue; // no brain paths
    if (name === 'approve-device') continue; // needs a real key/fingerprint pair; path shape matches member-revoke
    const c = spec.build(name === 'brain-read' || name === 'brain-public-set' ? { page: 'a.md', public: true }
      : name === 'brain-image' ? { page: 'a.png' }
      : name === 'member-set-status' ? { slug: 'jane01', status: 'active' }
      : name === 'member-forget' ? { slug: 'jane01' }
      : name === 'skill-scrub' ? { id: 'brief-me' }
      : name === 'skill-push' ? { slug: 'jane01', skill_id: 'brief-me' }
      : name === 'governance-write' ? { content_b64: 'YQ==' }
      : name === 'catalog-policy-write' ? { content_b64: 'e30=' }
      : name === 'prompt-write' ? { pack: 'demo', name: 'kickoff', content_b64: 'YQ==' }
      : name === 'page-write' ? { pack: 'demo', id: 'welcome', content_b64: 'YQ==' }
      : name === 'people-add' ? { slug: 'joe', name: 'J', email: 'j@o.com', role: 'admin', pubkey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBEqBeSfd/bTMrQlFHEMSnBr k' }
      : name === 'people-add-key' ? { slug: 'joe', pubkey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBEqBeSfd/bTMrQlFHEMSnBr k' }
      : name === 'member-revoke' ? { slug: 'joe', confirm: 'joe' }
      : name === 'people-revoke' || name === 'invite-reissue' ? { slug: 'joe' }
      : name === 'approve-device' ? null
      : name === 'stamp-member' || name === 'invite-member' ? { slug: 'jane01', name: 'Jane', email: 'j@x.com', provider: 'google' }
      : name === 'pebble-request' ? { name: 'Jane', email: 'j@x.com' }
      : name === 'member-leave' ? { slug: 'jane01', confirm: 'jane01', reason: 'moving on' }
      : name === 'deprovision-member' || name === 'transfer-to-member' || name === 'transfer-complete' || name === 'transfer-to-org' || name === 'transfer-org-complete' || name === 'transfer-revoke' ? { slug: 'jane01', confirm: 'jane01' }
      : name === 'join-approve' ? { id: 'aaaa1111aaaa1111aaaa', slug: 'jane01', name: 'Jane', email: 'j@x.com' }
      : name === 'join-decline' ? { id: 'aaaa1111aaaa1111aaaa' }
      : name === 'console-answer' ? { id: 'aaaa1111aaaa1111aaaa', answer: 'accepted' }
      : name === 'rock-answer' ? { id: 'aaaa1111aaaa1111aaaa', decision: 'accept' }
      : name === 'rock-tie-end' ? { e: 'a'.repeat(64), tie: 'joined', reason: 'unpaid' }
      : name === 'console-request' ? { kind: 'transfer', to_org: 'beta', subject: 'jane01' }
      : name === 'console-withdraw' ? { id: 'aaaa1111aaaa1111aaaa' }
      : name === 'ask-push' ? { slug: 'jane01', kind: 'ask-read' }
      : name === 'evict-member' ? { slug: 'jane01', reason: 'unpaid' }
      : name === 'membership-drop' ? { slug: 'jane01', org: 'beta' }
      : name === 'demote' ? { org: 'beta', confirm: 'beta' }
      : name === 'community-catalog-push' ? { ids: ['brief-me'] }
      : name === 'commons-init' || name === 'commons-grant' || name === 'commons-create' ? { payload_b64: 'e30=' }
      : name === 'commons-revoke' ? { id: 'g-abc12345' }
      : {});
    if (c === null) continue; // approve-device needs a real fingerprint pair; covered below
    assert.ok(!c.command.includes('/state/brain/'), `${name} must not hardcode a /state/brain path`);
    assert.match(c.command, /\$BR|\$\{BRAIN_ROOT:-\/state\/brain\}/, `${name} must resolve brain_root`);
  }
});

test('pending-devices + broker-register are RETIRED (2026-09-01): no broker remains', async () => {
  // Both verbs served the directory's device broker: pending-devices listed
  // what invite-reconcile staged, broker-register announced the box to the
  // broker. The broker died with the central directory; a new computer is now
  // let in by an existing one over SSH (wizard-local device-add), so neither
  // verb may come back.
  assert.equal(VERBS['pending-devices'], undefined, 'pending-devices stays gone');
  assert.equal(VERBS['broker-register'], undefined, 'broker-register stays gone');
  assert.equal(MEMBER_VERBS['pending-devices'], undefined, 'and neither reaches the one table');
  assert.equal(MEMBER_VERBS['broker-register'], undefined);
});

// approve-device was DELETED 2026-08-09 (Sam: "kill it, the link is the proof").
// The acts it performed — install the key, flip status active, push the key down,
// consume the broker staging — are now done by control/auto-approve.mjs on the
// box itself, with no human step. The two-party check this test pinned was inert:
// the panel supplied confirmed_fp and pubkey from the SAME broker payload, so the
// local re-derivation compared broker data with broker data and was equal by
// construction; only the hand-typed fallback could ever trip it, and that fold is
// gone too. What replaces the test is the invariant that matters now.
test('no panel verb can enrol a device: the box decides, on the invite-token binding', () => {
  assert.equal(VERBS['approve-device'], undefined,
    'an approve override would let an admin defeat the invite-token binding, which is now the only proof a device is that member\'s');
  for (const [name, spec] of Object.entries(VERBS)) {
    if (!spec || typeof spec.build !== 'function') continue;
    if (name === 'people-add' || name === 'people-add-key') continue;   // OPERATOR keys, a different door
    let cmd = '';
    try { cmd = spec.build({ slug: 'jane01', pubkey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBEqBeSfd/bTMrQlFHEMSnBr jane01-box', name: 'Jane', email: 'j@example.com' }).command || ''; }
    catch { continue; }   // a verb that refuses these args cannot be an enrolment path
    assert.ok(!/registry\/members\/keys/.test(cmd),
      `${name} writes a member device key: enrolment belongs to auto-approve on the box`);
  }
});
test('member verb table: no chat anywhere, no org verbs, no adminOnly', () => {
  assert.equal(VERBS.chat, undefined, 'chat was removed from the org edition too (2026-07-23)');
  assert.equal(MEMBER_VERBS.chat, undefined);
  assert.equal(MEMBER_VERBS['stamp-member'], undefined);
  assert.equal(MEMBER_VERBS['governance-write'], undefined);
  assert.equal(MEMBER_VERBS['deprovision-member'], undefined);
  for (const [name, spec] of Object.entries(MEMBER_VERBS)) {
    assert.ok(!spec.adminOnly, `${name} must not be adminOnly in the member edition`);
  }
});

test('layout-write: base64 JSON only, size-capped', () => {
  const build = MEMBER_VERBS['layout-write'].build;
  const ok = build({ content_b64: Buffer.from('{"order":[],"hidden":[]}').toString('base64') });
  assert.match(ok.command, /layout\.json/);
  assert.throws(() => build({ content_b64: '' }), /base64/);
  assert.throws(() => build({ content_b64: 'not*base64!' }), /base64/);
  assert.throws(() => build({ content_b64: 'A'.repeat(30000) }), /base64/);
});

// ---------------------------------------------------------------- server routing
// A fake bridge: targets are fixed; stream() echoes the command as one stdout
// line then closes 0, so tests can assert exactly what would run.
function fakeBridge(targets) {
  const ran = [];
  return {
    ran,
    targets: () => targets,
    stream: (host, command, o = {}) => {
      ran.push({ host, command });
      const pebble = new EventEmitter();
      pebble.kill = () => {};
      setImmediate(() => { if (o.onStdout) o.onStdout(`RAN:${command}`); pebble.emit('close', 0); });
      return pebble;
    },
  };
}

const listen = (opts) => new Promise((resolve) => {
  const s = createPanelServer({ port: 0, host: '127.0.0.1', htmlText: '<html>x</html>', ...opts });
  s.on('listening', () => resolve(s));
});
const post = (s, body) => fetch(`http://127.0.0.1:${s.address().port}/run`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const targetsOf = (s) => fetch(`http://127.0.0.1:${s.address().port}/targets`).then((r) => r.json());

const ROCK = { host: 'ic-rock', org: 'ic', kind: 'rock' };
const MEMBER = { host: 'jane01-box', org: 'jane01', kind: 'member' };

test('one face: every configured target is served, both alias shapes, no edition field', async () => {
  const s = await listen({ bridge: fakeBridge([ROCK, MEMBER]) });
  try {
    const t = await targetsOf(s);
    assert.equal(t.edition, undefined, 'the edition field died with the editions');
    assert.deepEqual(t.targets, [ROCK, MEMBER], 'a legacy -rock alias and a -box alias both serve');
    assert.equal((await post(s, { host: 'ic-rock', verb: 'no-such-verb' })).status, 400);
    assert.equal((await post(s, { host: 'jane01-box', verb: 'whoami' })).status, 200);
    assert.equal((await post(s, { host: 'ic-rock', verb: 'whoami' })).status, 200);
  } finally { s.close(); }
});

test('the org verbs are not served: one table, and it is the member table plus the catalogue', async () => {
  const s = await listen({ bridge: fakeBridge([ROCK, MEMBER]) });
  try {
    // the fleet/registry/people/governance families lost their pages and left
    // the served table with the face collapse (their builders stay exported
    // for unit tests until the machinery is deleted)
    for (const verb of ['chat', 'stamp-member', 'governance-write', 'deprovision-member', 'fleet-index']) {
      const r = await post(s, { host: 'jane01-box', verb });
      assert.equal(r.status, 400, `${verb} must 400`);
      assert.match(await r.text(), /unknown verb/, `${verb} is not in the one table`);
    }
    // member self-management answers for every target, the legacy rock included
    for (const host of ['jane01-box', 'ic-rock']) {
      const ok = await post(s, { host, verb: 'brain-list' });
      assert.equal(ok.status, 200);
      assert.match(await ok.text(), /\/state\/wiki/, `${host}: one brain, the box's own wiki`);
    }
  } finally { s.close(); }
});

// Landing: '/' is the app itself, which opens on Overview. The edition stamp
// died with the face collapse (2026-09-01): the shell ships as-is, so a
// leftover placeholder in a caller-supplied body is served untouched.
test('the front face is the one app shell, served unstamped', async () => {
  const shell = "<html><script>var AIOS_EDITION = '__AIOS_EDITION__';</script>the app shell</html>";
  const s = await listen({ bridge: fakeBridge([ROCK, MEMBER]), htmlText: shell });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { redirect: 'manual' });
    assert.equal(r.status, 200, 'the front face is the app, never a console bounce');
    assert.match(await r.text(), /'__AIOS_EDITION__'/, 'no stamping: the placeholder passes through verbatim');
  } finally { s.close(); }
});

test('support role: the adminOnly commons verbs 403, plain reads still answer', async () => {
  const s = await listen({ bridge: fakeBridge([ROCK]), role: 'support' });
  try {
    assert.equal((await post(s, { host: 'ic-rock', verb: 'commons-publish' })).status, 403);
    assert.equal((await post(s, { host: 'ic-rock', verb: 'skills-list' })).status, 200);
  } finally { s.close(); }
});

test('SSE stream carries the fake bridge output and __DONE__', async () => {
  const bridge = fakeBridge([MEMBER]);
  const s = await listen({ bridge, edition: 'member' });
  try {
    const r = await post(s, { host: 'jane01-box', verb: 'dashboard-data' });
    const text = await r.text();
    assert.match(text, /RAN:.*box-cockpit\.mjs/);
    assert.match(text, /__DONE__/);
    assert.equal(bridge.ran.length, 1);
    assert.match(bridge.ran[0].command, /__DATA__.*__LAYOUT__/s);
  } finally { s.close(); }
});

test('ruling 10 (2026-08-10), completed by the collapse: no verb births a mineral for somebody else', () => {
  // stamp-member died 2026-08-10 (no caller-supplied key at birth); the face
  // collapse (2026-09-01) then deleted invite-member too, the last verb that
  // could create Hetzner infrastructure for another person. A person gets a
  // mineral by building their own through the door's wizard.
  assert.equal(VERBS['stamp-member'], undefined, 'the direct-key stamp verb stays gone');
  assert.equal(VERBS['invite-member'], undefined, 'and the invite-stamp path went with the Members page');
  assert.equal(MEMBER_VERBS['stamp-member'], undefined);
  assert.equal(MEMBER_VERBS['invite-member'], undefined);
});

test('people verbs: validation + shapes (D46)', () => {
  const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBEqBeSfd/bTMrQlFHEMSnBr joe-laptop';
  const add = VERBS['people-add'].build;
  const c = add({ slug: 'joe', name: 'Joe', email: 'joe@org.com', role: 'admin', pubkey: key }).command;
  assert.match(c, /people\/joe\.yaml/);
  assert.match(c, /people-sync\.mjs/);
  assert.match(c, /aios-op \(Admin\)/);
  // Support was DELETED 2026-08-05. Refused with its own message rather than
  // silently coerced to admin, so an older app still offering the choice is told
  // what happened instead of quietly granting more access than it asked for.
  assert.throws(() => add({ slug: 'joe', name: 'J', email: 'joe@org.com', role: 'support', pubkey: key }), /Support role has been removed/);
  assert.throws(() => add({ slug: 'joe', name: 'J', email: 'joe@org.com', role: 'superuser', pubkey: key }), /role/);
  assert.throws(() => add({ slug: 'joe', name: 'J', email: 'not-an-email', role: 'admin', pubkey: key }), /email/);
  assert.throws(() => add({ slug: 'joe', name: 'J', email: 'j@o.com', role: 'admin', pubkey: "ssh-ed25519 AAAA' ; id" }), /pubkey/);
  assert.match(VERBS['people-revoke'].build({ slug: 'joe' }).command, /status: "revoked"/);
  assert.match(VERBS['people-add-key'].build({ slug: 'joe', pubkey: key }).command, /people-sync/);
  for (const v of ['people-add', 'people-add-key', 'people-revoke']) assert.ok(VERBS[v].adminOnly, `${v} adminOnly`);
  assert.ok(!VERBS['people-list'].adminOnly, 'people-list stays a plain read');
  for (const v of ['people-list', 'people-add', 'people-revoke']) assert.equal(MEMBER_VERBS[v], undefined, `${v} absent from member edition`);
});

test('devices verbs: validation + shapes (device roster phase 1)', () => {
  const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBEqBeSfd/bTMrQlFHEMSnBr laptop';
  const add = MEMBER_VERBS['devices-add'].build;
  const c = add({ slug: 'laptop', label: 'Work laptop', pubkey: key }).command;
  assert.match(c, /roster-cli\.mjs/);
  assert.match(c, /\/state add laptop /);
  assert.match(c, /'Work laptop'/);
  assert.ok(c.includes(key), 'the key rides the command');
  assert.throws(() => add({ slug: 'UPPER', label: 'L', pubkey: key }), /slug/);
  assert.throws(() => add({ slug: 'laptop', label: '', pubkey: key }), /label/i);
  // a control character in a label is REFUSED, never escaped through to the shell
  assert.throws(() => add({ slug: 'laptop', label: 'bad\u0000name', pubkey: key }), /label/i);
  assert.throws(() => add({ slug: 'laptop', label: 'L', pubkey: "ssh-ed25519 AAAA' ; id" }), /pubkey/);
  // a quote in a label is ESCAPED, never rejected, and never reaches the shell bare
  const quoted = add({ slug: 'laptop', label: "Jo's mac", pubkey: key }).command;
  assert.ok(quoted.includes(`'Jo'\\''s mac'`), 'label is POSIX-escaped');

  assert.match(MEMBER_VERBS['devices-revoke'].build({ slug: 'laptop' }).command, /revoke laptop$/);
  assert.throws(() => MEMBER_VERBS['devices-revoke'].build({ slug: '../etc' }), /slug/);
  assert.match(MEMBER_VERBS['devices-rename'].build({ slug: 'laptop', label: 'Home mac' }).command, /rename laptop 'Home mac'$/);
  assert.match(MEMBER_VERBS['devices-list'].build().command, /roster-cli\.mjs \/state list$/);

  for (const v of ['devices-add', 'devices-revoke', 'devices-rename']) {
    assert.ok(MEMBER_VERBS[v].mutating, `${v} mutating`);
  }
  assert.ok(!MEMBER_VERBS['devices-list'].mutating, 'devices-list is read-only');
  // the member's own box: no admin gate, and the rock edition does not get these
  for (const v of ['devices-list', 'devices-add', 'devices-revoke', 'devices-rename']) {
    assert.ok(!MEMBER_VERBS[v].adminOnly, `${v} not adminOnly`);
    assert.equal(VERBS[v], undefined, `${v} absent from the rock edition`);
  }
});

test('adminOnly verbs get the box-side AIOS_LOGIN guard prefixed', async () => {
  // commons-publish is the served table's adminOnly representative since the
  // face collapse (the governance/fleet verbs are no longer served).
  const bridge = fakeBridge([ROCK]);
  const s = await listen({ bridge });
  try {
    await post(s, { host: 'ic-rock', verb: 'commons-publish' }).then((r) => r.text());
    assert.match(bridge.ran[0].command, /^\[ "\$\{AIOS_LOGIN:-\}" != "aios-support" \]/);
    await post(s, { host: 'ic-rock', verb: 'skills-list' }).then((r) => r.text());
    assert.ok(!bridge.ran[1].command.includes('AIOS_LOGIN'), 'non-admin verbs unprefixed');
  } finally { s.close(); }
});

test('update routes: status echoes the injected updater; apply gated on availability', async () => {
  let applied = 0;
  const updater = { status: { available: false, current: { sha: 'aaa' } }, apply: () => { applied++; return Promise.resolve(); } };
  const s = await listen({ bridge: fakeBridge([ROCK]), updater });
  try {
    const st = await fetch(`http://127.0.0.1:${s.address().port}/update-status`).then((r) => r.json());
    assert.equal(st.current.sha, 'aaa');
    const deny = await fetch(`http://127.0.0.1:${s.address().port}/update-apply`, { method: 'POST' });
    assert.equal(deny.status, 400);
    updater.status = { available: true, current: { sha: 'aaa' }, latest: { sha: 'bbb' } };
    const go = await fetch(`http://127.0.0.1:${s.address().port}/update-apply`, { method: 'POST' });
    assert.equal(go.status, 200);
    assert.equal(applied, 1);
  } finally { s.close(); }
});

test('invite-member is RETIRED (2026-09-01), and no served verb reaches stamp-pebble', () => {
  // The D49 onboarding gate guarded a birth verb that no longer exists: the
  // face collapse deleted invite-member with the Members page. Nothing served
  // may stamp a pebble on someone's behalf.
  assert.equal(VERBS['invite-member'], undefined, 'the birth verb stays gone');
  for (const [name, spec] of Object.entries(MEMBER_VERBS)) {
    if (typeof spec.build !== 'function') continue;
    let cmd = '';
    try { cmd = spec.build({}).command || ''; } catch { continue; }
    assert.ok(!cmd.includes('stamp-pebble.sh'), `${name} must not reach the stamp machinery`);
  }
});
test('skill verbs (D49): skill-list read-only, skill-push adminOnly + validated', () => {
  assert.ok(!VERBS['skill-list'].adminOnly, 'skill-list readable by support');
  assert.match(VERBS['skill-list'].build().command, /skills-library/);
  assert.ok(VERBS['skill-push'].adminOnly && VERBS['skill-push'].mutating, 'skill-push admin+mutating');
  const c = VERBS['skill-push'].build({ slug: 'jane01', skill_id: 'brief-me' }).command;
  assert.match(c, /push-skill\.mjs jane01 brief-me/);
  assert.throws(() => VERBS['skill-push'].build({ slug: 'jane01', skill_id: 'Bad Skill' }), /kebab/);
  assert.throws(() => VERBS['skill-push'].build({ slug: 'jane01', skill_id: 'x; touch pwned' }), /kebab/);
  assert.equal(MEMBER_VERBS['skill-push'], undefined, 'no skill-push in member edition');
});

test('catalog-sync verb (D57): adminOnly + mutating, runs the engine sync, org edition only', () => {
  assert.ok(VERBS['catalog-sync'].adminOnly && VERBS['catalog-sync'].mutating, 'catalog-sync admin+mutating');
  assert.match(VERBS['catalog-sync'].build().command, /catalog-sync\.mjs/);
  assert.equal(MEMBER_VERBS['catalog-sync'], undefined, 'no catalog-sync in member edition');
});

test('cadence verbs (D49, member edition): list read-only, write JSON-validated', () => {
  assert.match(MEMBER_VERBS['cadence-list'].build().command, /\.claude\/skills.*skill\.yaml/s);
  assert.match(MEMBER_VERBS['cadence-list'].build().command, /cadence\.json/);
  // three-layer v2: the same call carries the run ledger + the machinery-job
  // state (auto-update opt-out, last heartbeat) so the app can show the
  // protected job floor read-only next to the member's own cadence.
  const cl = MEMBER_VERBS['cadence-list'].build().command;
  assert.match(cl, /__RUNS__/);
  assert.match(cl, /skill-runs\.json/);
  assert.match(cl, /__AUTOUPDATE__/);
  assert.match(cl, /auto-update\.json/);
  assert.match(cl, /__HEARTBEAT__/);
  assert.match(cl, /heartbeat-full\.json/);
  const w = MEMBER_VERBS['cadence-write'].build({ content_b64: Buffer.from('{"brief-me":{"enabled":true}}').toString('base64') });
  assert.match(w.command, /cadence\.json/);
  assert.throws(() => MEMBER_VERBS['cadence-write'].build({ content_b64: '' }), /base64/);
  assert.equal(VERBS['cadence-list'], undefined, 'cadence is member-edition only');
});

test('stall-board verb (D48): read-only, reads registry index + heartbeats', () => {
  assert.ok(!VERBS['stall-board'].adminOnly, 'stall-board readable by support');
  const c = VERBS['stall-board'].build().command;
  assert.match(c, /registry\/index\.json/);
  assert.match(c, /heartbeats\/.*\.json/s);
  assert.equal(MEMBER_VERBS['stall-board'], undefined, 'stall-board is org-edition only');
});

test('sharing verbs (D49, member edition): list read-only, write JSON-validated', () => {
  assert.match(MEMBER_VERBS['sharing-list'].build().command, /sharing\.json/);
  assert.match(MEMBER_VERBS['sharing-list'].build().command, /heartbeat-full\.json/);
  const w = MEMBER_VERBS['sharing-write'].build({ content_b64: Buffer.from('{"skill_engagement":false}').toString('base64') });
  assert.match(w.command, /sharing\.json/);
  assert.throws(() => MEMBER_VERBS['sharing-write'].build({ content_b64: '' }), /base64/);
  assert.equal(VERBS['sharing-list'], undefined, 'sharing is member-edition only');
});

test('D52 nav: /door redirects when the door is live, explains itself otherwise; /targets carries doorUrl', async () => {
  let doorUrl = '';
  const s = await listen({ bridge: fakeBridge([ROCK]), doorUrl: () => doorUrl });
  try {
    // 2026-07-30: a bare 404 here STRANDED the member, because since the cutover
    // this is the one link out of the console. It now serves a page that says the
    // start screen is not open and offers working exits.
    const miss = await fetch(`http://127.0.0.1:${s.address().port}/door`, { redirect: 'manual' });
    assert.equal(miss.status, 200);
    const body = await miss.text();
    assert.match(body, /not open in this session/, 'explains why');
    assert.match(body, /href="\/console"/, 'offers a way back to the box');
    assert.match(body, /href="\/panel\.html"/, 'offers the full app');
    assert.equal((await targetsOf(s)).doorUrl, null);
    doorUrl = 'http://127.0.0.1:9997/';
    const hit = await fetch(`http://127.0.0.1:${s.address().port}/door`, { redirect: 'manual' });
    assert.equal(hit.status, 302);
    assert.equal(hit.headers.get('location'), doorUrl);
    assert.equal((await targetsOf(s)).doorUrl, doorUrl);
  } finally { s.close(); }
});

test('D52: onboard-state is a read-only org verb reading onboarding-state.json', () => {
  const c = VERBS['onboard-state'].build().command;
  assert.match(c, /onboarding-state\.json/);
  assert.ok(!VERBS['onboard-state'].mutating, 'must be read-only');
  assert.ok(!VERBS['onboard-state'].adminOnly, 'Support may see the banner too');
  assert.equal(MEMBER_VERBS['onboard-state'], undefined, 'org edition only');
});

test('D53 terminal: host validated, bytes buffered then streamed, input reaches stdin, close kills', async () => {
  const ttys = [];
  const bridge = {
    ...fakeBridge([ROCK]),
    tty: (host) => {
      const pebble = new EventEmitter();
      pebble.stdout = new EventEmitter();
      pebble.stderr = new EventEmitter();
      pebble.written = [];
      pebble.stdin = { write: (b) => pebble.written.push(b.toString('utf8')) };
      pebble.killed = false;
      pebble.kill = () => { pebble.killed = true; };
      pebble.host = host;
      ttys.push(pebble);
      return pebble;
    },
  };
  const s = await listen({ bridge });
  const base = `http://127.0.0.1:${s.address().port}`;
  const jpost = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await jpost('/term/open', { host: 'jane01-box' })).status, 400, 'member host refused in org edition');
    const open = await jpost('/term/open', { host: 'ic-rock', cols: 100, rows: 30 });
    assert.equal(open.status, 200);
    const { id } = await open.json();
    assert.equal(ttys.length, 1);
    assert.equal(ttys[0].host, 'ic-rock');

    ttys[0].stdout.emit('data', Buffer.from('hello '));           // before the viewer attaches: buffered
    const stream = await fetch(`${base}/term/stream?id=${id}`);
    assert.equal(stream.status, 200);
    const rd = stream.body.getReader();
    const dec = new TextDecoder();
    let text = dec.decode((await rd.read()).value, { stream: true });
    ttys[0].stderr.emit('data', Buffer.from('world'));            // live after attach
    while (!text.includes(Buffer.from('world').toString('base64'))) text += dec.decode((await rd.read()).value, { stream: true });
    assert.ok(text.includes(`data: ${Buffer.from('hello ').toString('base64')}`), 'buffered bytes flushed first');

    assert.equal((await jpost('/term/input', { id, data_b64: Buffer.from('ls\n').toString('base64') })).status, 200);
    assert.deepEqual(ttys[0].written, ['ls\n']);
    assert.equal((await jpost('/term/input', { id, data_b64: 'not*base64' })).status, 400);
    assert.equal((await jpost('/term/input', { id: 'nope', data_b64: 'YQ==' })).status, 404);

    assert.equal((await jpost('/term/close', { id })).status, 200);
    assert.equal(ttys[0].killed, true);
    assert.equal((await fetch(`${base}/term/stream?id=${id}`)).status, 404, 'closed session is gone');
  } finally { s.close(); }
});

test('D53 vendor route: serves the vendored terminal assets, unknown names 404', async () => {
  const s = await listen({ bridge: fakeBridge([ROCK]), vendor: { 'xterm.js': Buffer.from('FAKE_XTERM'), 'xterm.css': Buffer.from('.x{}') } });
  const base = `http://127.0.0.1:${s.address().port}`;
  try {
    const js = await fetch(`${base}/vendor/xterm.js`);
    assert.equal(js.status, 200);
    assert.equal(await js.text(), 'FAKE_XTERM');
    assert.match((await fetch(`${base}/vendor/xterm.css`)).headers.get('content-type'), /text\/css/);
    assert.equal((await fetch(`${base}/vendor/no-such-file.js`)).status, 404);
  } finally { s.close(); }
});

test('D55 box-refresh: org admin-only, member self-serve, kill detached + delayed', () => {
  const org = VERBS['box-refresh'];
  assert.ok(org.adminOnly && org.mutating, 'org edition: adminOnly + mutating');
  const c = org.build().command;
  // the kill must be delayed, backgrounded and detached from every session fd,
  // or ssh hangs on the open pipes / the SSE stream dies before __DONE__
  assert.match(c, /\(sleep 2; kill 1\) <\/dev\/null >\/dev\/null 2>&1 &/);
  assert.ok(c.indexOf('kill 1') > c.indexOf('about a minute'), 'outage copy emitted before the kill is scheduled');
  const mem = MEMBER_VERBS['box-refresh'];
  assert.ok(!mem.adminOnly && mem.mutating, 'member edition: self-serve, still serialized');
  assert.match(mem.build().command, /\(sleep 2; kill 1\) <\/dev\/null >\/dev\/null 2>&1 &/);
  assert.match(mem.build().command, /rock has published/, 'member copy states the org-pinned bound');
});

test('D54 org-teardown is RETIRED (2026-09-01): the route answers nothing', async () => {
  // The teardown route destroyed hosted infrastructure the panel's operator
  // provisioned for an org. All Sam-hosted metal is gone; a self-hosted
  // mineral is deleted where it lives, at its owner's hosting provider, so
  // the route (and both of its guardrail ladders) stays deleted.
  const teardownCalls = [];
  const orgTeardown = (args, emit) => { teardownCalls.push(args); emit('engine: rock gone'); return Promise.resolve(); };
  const good = { host: 'ic-rock', confirm: 'delete ic forever', hcloud_token: 'h1', cf_api_token: 'c1', github_token: 'g1' };
  const s = await listen({ bridge: fakeBridge([ROCK]), orgTeardown });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/org-teardown`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(good) });
    assert.equal(r.status, 404, 'the route stays gone');
    assert.equal(teardownCalls.length, 0, 'and the engine hook is never invoked, even when injected');
  } finally { s.close(); }
});

// The hosted-rock refusal (2026-08-09) and the guardrail ladder are retired
// with the route: opts.orgProvisioned no longer exists, and /targets stamps
// no provisioned flag, because there is nothing left that this computer could
// have provisioned for somebody else.
test('D54 hosted-rock machinery is RETIRED: /targets carries no provisioned flag', async () => {
  const s = await listen({ bridge: fakeBridge([ROCK]), orgProvisioned: () => true });
  try {
    const t = await targetsOf(s);
    assert.equal(t.targets[0].provisioned, undefined, 'no provisioned stamp, even with the old option injected');
  } finally { s.close(); }
});

test('device-activity is RETIRED (2026-09-01): the auto-approve feed died with the broker', () => {
  // The feed listed what control/auto-approve.mjs let in off the broker
  // staging. The broker is gone; a device is added by a computer that already
  // has access, over SSH, so there is no feed left to read.
  assert.equal(VERBS['device-activity'], undefined, 'the verb stays gone');
  assert.equal(MEMBER_VERBS['device-activity'], undefined, 'and never reaches the one table');
});

test('membership levels stay dead: no served verb accepts or forwards a tier', () => {
  // Sam's verb-interview ruling 2026-08-03 killed levels; the birth verbs
  // that could still carry a tier flag died with the face collapse. Nothing
  // served may reintroduce the flag.
  for (const [name, spec] of Object.entries(MEMBER_VERBS)) {
    if (typeof spec.build !== 'function') continue;
    let cmd = '';
    try { cmd = spec.build({ tier: 'Core' }).command || ''; } catch { continue; }
    assert.ok(!cmd.includes('--tier'), `${name}: a tier flag never reaches a command`);
  }
});

test('P4 join verbs are RETIRED (2026-09-01): joining is a bundle, not a queue', () => {
  // join-requests/approve/decline ran the directory's request queue and could
  // stamp a box on approval. Joining a community is now a cradscommons1:
  // bundle pasted on the member's own Communities page and applied locally;
  // nothing queues, nothing stamps.
  for (const v of ['join-requests', 'join-approve', 'join-decline']) {
    assert.equal(VERBS[v], undefined, `${v} stays gone`);
    assert.equal(MEMBER_VERBS[v], undefined, `${v} never reaches the one table`);
  }
  assert.ok(MEMBER_VERBS['community-join'], 'the bundle path is what replaced the queue');
});

test('pause is DEAD (ruling 2026-08-10): member-set-status is resume-only, and the delivery tap is gone with it', () => {
  const v = VERBS['member-set-status'];
  assert.ok(v && v.mutating && v.adminOnly);
  // A rock does not lock a member out of their own box: the pause half of this
  // verb was removed outright, not gated. Only the release survives.
  assert.throws(() => v.build({ slug: 'jane01', status: 'paused' }), /pause was removed/);
  assert.throws(() => v.build({ slug: 'jane01', status: 'left' }), /pause was removed|status must be active/);
  const resume = v.build({ slug: 'jane01', status: 'active' }).command;
  assert.match(resume, /status: "active"/);
  assert.match(resume, /push-member-key\.mjs jane01/, 'resume restores the approved key');
  assert.match(resume, /edges-reflect\.mjs/, 'resume reflects the released edge');
  assert.match(resume, /R=''/, 'a legacy paused_reason is cleared on release, never left stale');
  assert.ok(!/deprovision|delete.*server|hcloud/i.test(resume), 'release must NOT touch the box');
  // the sibling pause surface died with it
  assert.equal(VERBS['console-delivery'], undefined, 'console-delivery (delivery pause) no longer exists');
});

test('P5 leave: deprovision-member prunes the edge and never deletes the member brain repo', () => {
  const c = VERBS['deprovision-member'].build({ slug: 'jane01', confirm: 'jane01' }).command;
  assert.match(c, /deprovision-pebble\.sh jane01/, 'org-managed teardown = VM/DNS/tunnel only');
  assert.match(c, /status: "left"/);
  assert.match(c, /edges-reflect\.mjs/, 'edge pruned');
  assert.ok(!/repos.*jane01|delete_repo|api\.github\.com\/repos/i.test(c), 'never deletes a GitHub brain repo');
  assert.throws(() => VERBS['deprovision-member'].build({ slug: 'jane01', confirm: 'wrong' }), /confirm/i);
});

// ---- device-link gate (ruling 2026-08-10, second grill) ----------------------
test('invite-reissue is RETIRED (2026-09-01): no rock mints device links at all', () => {
  // The gate refused a rock re-minting a device link for a LIVE member-owned
  // pebble. The whole minting surface died with the directory: a new device
  // is approved by one that already has access, so no verb hands out links.
  assert.equal(VERBS['invite-reissue'], undefined, 'the verb stays gone');
  assert.equal(MEMBER_VERBS['invite-reissue'], undefined, 'and never reaches the one table');
  // The self-host sweep (same day) retired the last invite verb with it: rows
  // still status "invited" render on the roster as history, nothing polls.
  assert.equal(VERBS['invite-pending-list'], undefined, 'and no invite queue to poll');
  assert.equal(MEMBER_VERBS['invite-pending-list'], undefined, 'on either table');
});

test('invite-reissue gate: the bash fragment refuses live member-owned, passes org and invited (fixture)', () => {
  const runGate = (row) => {
    try {
      return _efs('bash', ['-c',
        `set -e; f=$(mktemp); printf '%b' '${row.replace(/\n/g, "\\n")}' > "$f"; `
        + `own=$(sed -n 's/^owner: *"\\{0,1\\}\\([a-z0-9-]*\\)"\\{0,1\\}.*/\\1/p' "$f" | head -1); own=\${own:-member}; `
        + `st=$(sed -n 's/^status: *"\\{0,1\\}\\([a-z]*\\)"\\{0,1\\}.*/\\1/p' "$f" | head -1); rm -f "$f"; `
        + `if [ "$own" = "member" ] && [ "$st" != "invited" ]; then echo REFUSED; exit 1; fi; echo PROCEED`,
      ], { encoding: 'utf8' }).trim();
    } catch (e) { return String(e.stdout || '').trim(); }
  };
  assert.equal(runGate('owner: "member"\nstatus: "active"'), 'REFUSED', 'live member-owned: no rock-minted device link');
  assert.equal(runGate('status: "active"'), 'REFUSED', 'absent owner fails closed');
  assert.equal(runGate('owner: "member"\nstatus: "invited"'), 'PROCEED', 'never-enrolled birth invite stays re-sendable');
  assert.equal(runGate('owner: "org"\nstatus: "active"'), 'PROCEED', 'the rock re-keys its own work asset');
  assert.equal(runGate('owner: "impact-colab"\nstatus: "active"'), 'PROCEED', 'the pointer form counts as org-owned');
});

test('member-leave: a reason is REQUIRED, recorded, and delivered before the row flips (ruling 2026-08-10)', () => {
  const v = VERBS['member-leave'];
  assert.throws(() => v.build({ slug: 'jane01', confirm: 'jane01' }), /reason is required/, 'no silent cut, no exceptions');
  assert.throws(() => v.build({ slug: 'jane01', confirm: 'jane01', reason: 'x'.repeat(161) }), /too long/);
  const c = v.build({ slug: 'jane01', confirm: 'jane01', reason: "the member's own call" }).command;
  assert.match(c, /left_reason/, 'the reason lands on the row');
  assert.ok(c.includes('"$R"'), 'as argv, never re-parsed as shell');
  const notice = c.indexOf('leave-notice.mjs');
  assert.ok(notice > -1 && notice < c.indexOf('status: "left"'), 'delivery is attempted BEFORE the row flips (push-down refuses non-active rows)');
  assert.match(c, /could NOT be delivered/, 'an old brain fail-softs with honest words instead of stranding the leave');
});

test('P5 member-leave (soft): status left + door detached + edge pruned, box RETAINED', () => {
  const v = VERBS['member-leave'];
  assert.ok(v && v.adminOnly && v.mutating);
  const c = v.build({ slug: 'jane01', confirm: 'jane01', reason: 'moving on' }).command;
  assert.match(c, /status: "left"/);
  assert.match(c, /push-member-key\.mjs jane01/, 'door detached via empty key');
  assert.match(c, /edges-reflect\.mjs/);
  assert.ok(!/deprovision|hcloud|servers\/|cfd_tunnel/i.test(c), 'member-leave keeps the box (no teardown)');
  assert.throws(() => v.build({ slug: 'jane01' }), /confirm/i);
});

// ---- D60 O4: leave semantics branch on the registry owner --------------------
import { execFileSync as _efs } from 'node:child_process';

test('O4: member-leave reads the registry owner and branches the outcome copy', () => {
  const c = VERBS['member-leave'].build({ slug: 'jane01', confirm: 'jane01', reason: 'moving on' });
  assert.match(c.command, /own=\$\(sed -n/, 'member-leave extracts owner from the registry row');
  assert.match(c.command, /own=\$\{own:-member\}/, 'member-leave defaults absent owner to member (pre-O1 rows)');
  assert.match(c.command, /\[ "\$own" != "member" \]/, 'member-leave branches org-owned on ANY non-member owner (T1.5: the pointer form)');
  assert.match(c.command, /rock/, 'member-leave carries the org-owned copy');
  // the historical member-owned guarantee stays present verbatim
  assert.match(c.command, /mineral and their brain repo are untouched/);
});

// ---- teardown gate (Sam's ruling 2026-08-10: never without consent) ---------
// The old shape read the owner one statement AFTER deprovision-pebble.sh — by
// which point the VM, volume, tunnel and DNS were gone — and used it only to
// pick the closing sentence. The old test PINNED that as intended behaviour.
// This one pins the refusal.
test('teardown gate: deprovision-member refuses member-owned metal BEFORE destroying anything', () => {
  const c = VERBS['deprovision-member'].build({ slug: 'jane01', confirm: 'jane01' }).command;
  const destroyAt = c.indexOf('deprovision-pebble.sh');
  assert.ok(destroyAt > 0, 'the destructive call exists');
  const ownAt = c.indexOf('own=$(sed -n');
  assert.ok(ownAt > -1 && ownAt < destroyAt, 'the owner is read BEFORE the destroy');
  assert.match(c, /own=\$\{own:-member\}/, 'absent owner defaults to member, so the gate fails CLOSED');
  const refuseAt = c.indexOf('REFUSED');
  assert.ok(refuseAt > -1 && refuseAt < destroyAt, 'the refusal precedes the destroy');
  assert.match(c, /if \[ "\$own" = "member" \]; then echo "REFUSED[^"]*"; exit 1; fi/,
    'member-owned refuses and exits non-zero');
  const rowCheckAt = c.indexOf('there is no member called');
  assert.ok(rowCheckAt > -1 && rowCheckAt < destroyAt, 'a missing registry row errors before the destroy');
  assert.ok(!c.includes('their own brain repo, if they claimed one, is untouched'),
    'the member-owned success sentence is GONE: that path is refused, not narrated');
});

test('teardown gate: the bash fragment refuses member/absent and passes org (fixture)', () => {
  const runGate = (row) => {
    try {
      return _efs('bash', ['-c',
        `set -e; f=$(mktemp); printf '%s\\n' '${row}' > "$f"; own=$(sed -n 's/^owner: *"\\{0,1\\}\\([a-z0-9-]*\\)"\\{0,1\\}.*/\\1/p' "$f" | head -1); own=\${own:-member}; rm -f "$f"; if [ "$own" = "member" ]; then echo REFUSED; exit 1; fi; echo PROCEED`,
      ], { encoding: 'utf8' }).trim();
    } catch (e) {
      return String(e.stdout || '').trim();
    }
  };
  assert.equal(runGate('owner: "member"'), 'REFUSED');
  assert.equal(runGate('slug: "x"'), 'REFUSED', 'absent owner refuses (fail-closed)');
  assert.equal(runGate('owner: "org"'), 'PROCEED');
  assert.equal(runGate('owner: "impact-colab"'), 'PROCEED', 'an org-slug pointer owner proceeds');
});

test('O4: the owner extraction fragment resolves org/member/absent correctly (bash fixture)', () => {
  const frag = (row) => _efs('bash', ['-c',
    `f=$(mktemp); printf '%s\\n' '${row}' > "$f"; own=$(sed -n 's/^owner: *"\\{0,1\\}\\([a-z0-9-]*\\)"\\{0,1\\}.*/\\1/p' "$f" | head -1); own=\${own:-member}; echo "$own"; rm -f "$f"`,
  ], { encoding: 'utf8' }).trim();
  assert.equal(frag('owner: "org"'), 'org');
  assert.equal(frag('owner: "member"'), 'member');
  assert.equal(frag('slug: "x"'), 'member', 'absent owner defaults to member');
  // T1.5: the owner is a POINTER now; slugs with digits must extract whole
  assert.equal(frag('owner: "acme2"'), 'acme2', 'pointer slugs with digits extract whole');
  assert.equal(frag('owner: "impact-colab"'), 'impact-colab', 'pointer slugs extract whole');
});

test('O4: deprovision-member bridges GH_OWNER -> ORG_GH_OWNER before the org echo (gate fix)', () => {
  const c = VERBS['deprovision-member'].build({ slug: 'jane01', confirm: 'jane01' }).command;
  // Structural, not a copied string: the bridge grew a legacy name and a
  // connected-account rung on 2026-08-10 (ORG_GH_RESOLVE), and pinning its exact
  // text made an unrelated fix look like a regression.
  const bridge = c.indexOf('export ORG_GH_OWNER="${ORG_GH_OWNER:-');
  const use = c.indexOf('${ORG_GH_OWNER:-the rock}');
  assert.ok(bridge > -1, 'the naming bridge is present');
  assert.ok(use > bridge, 'the bridge precedes the org-echo reference');
  assert.match(c, /\$\{GH_OWNER:-\}/, 'and the staged wizard-format name is still in the chain');
  // runtime: with only GH_OWNER staged (the wizard format), the org echo names the repo
  const out = _efs('bash', ['-c',
    'export ORG_GH_OWNER="${ORG_GH_OWNER:-${GH_OWNER:-}}"; own=org; '
    + 'if [ "$own" = "org" ]; then echo "repo (${ORG_GH_OWNER:-the rock}/jane01-brain)"; fi',
  ], { encoding: 'utf8', env: { ...process.env, GH_OWNER: 'acme-org', ORG_GH_OWNER: '' } }).trim();
  assert.equal(out, 'repo (acme-org/jane01-brain)');
});

// ---- D60 O5a: transfer-to-member (grant -> member receive -> complete) -------
test('O5a: transfer verbs exist, admin-only, absent from the member edition', () => {
  for (const name of ['transfer-to-member', 'transfer-complete']) {
    assert.ok(VERBS[name], `${name} exists`);
    assert.ok(VERBS[name].adminOnly && VERBS[name].mutating, `${name} is adminOnly + mutating`);
    assert.equal(MEMBER_VERBS[name], undefined, `${name} not in the member edition`);
    assert.throws(() => VERBS[name].build({ slug: 'jane01', confirm: 'nope' }), /type|confirm/i);
  }
});

test('O5a: transfer-to-member gates on org-owned, grants, stamps pending, never flips owner', () => {
  const c = VERBS['transfer-to-member'].build({ slug: 'jane01', confirm: 'jane01' }).command;
  assert.match(c, /own=\$\(sed -n/, 'reads the registry owner');
  assert.match(c, /\[ "\$own" != "member" \] \|\|/, 'refuses member-owned rows (T1.5: any org POINTER is org-owned)');
  assert.match(c, /transfer-grant\.mjs jane01 grant/, 'runs the grant orchestrator');
  assert.match(c, /pending_transfer: \\?"to-member/, 'stamps the pending marker (sed-escaped quote in the built string)');
  assert.ok(!/s\|\^owner:/.test(c), 'transfer-to-member must NOT flip owner (that is transfer-complete)');
  assert.match(c, /completes it in their app|Own my brain/, 'echo points at the member app step');
  assert.match(c, /keeps its copy|keeps its repo/, 'echo states the org retains its repo');
  // Structural: the bridge gained rungs on 2026-08-10 (ORG_GH_RESOLVE), so pin
  // that it resolves ORG_GH_OWNER from the staged name, not its exact spelling.
  assert.match(c, /export ORG_GH_OWNER="\$\{ORG_GH_OWNER:-.*\$\{GH_OWNER:-\}/, 'naming bridge present');
});

test('O5a: transfer-complete requires the pending marker, flips owner, clears, reflects', () => {
  const c = VERBS['transfer-complete'].build({ slug: 'jane01', confirm: 'jane01' }).command;
  assert.match(c, /pending_transfer: "to-member/, 'gates on the pending marker');
  assert.match(c, /s\|\^owner:.*owner: "member"/, 'flips the registry owner to member');
  assert.match(c, /s\|\^pending_transfer:.*pending_transfer: ""/, 'clears the marker');
  assert.match(c, /edges-reflect\.mjs/, 'mirrors the flip to the directory edge');
  assert.match(c, /rock keeps|retains/, 'echo states the org keeps its repo');
});

test('O5a: the pending-marker grep gate resolves set/unset correctly (bash fixture)', () => {
  const probe = (row) => _efs('bash', ['-c',
    `f=$(mktemp); printf '%s\\n' '${row}' > "$f"; if grep -q '^pending_transfer: "to-member' "$f"; then echo armed; else echo bare; fi; rm -f "$f"`,
  ], { encoding: 'utf8' }).trim();
  assert.equal(probe('pending_transfer: "to-member 2026-07-25"'), 'armed');
  assert.equal(probe('pending_transfer: ""'), 'bare');
  assert.equal(probe('slug: "x"'), 'bare');
});

// ---- D60 O5b: transfer-to-org (member hands custody to the rock) ------
test('O5b: transfer-to-org verb gates + invitation + no owner flip', () => {
  assert.equal(MEMBER_VERBS['transfer-to-org'], undefined);
  const spec = VERBS['transfer-to-org'];
  assert.ok(spec.adminOnly && spec.mutating);
  assert.throws(() => spec.build({ slug: 'jane01', confirm: 'wrong' }), /type the member/);
  const c = spec.build({ slug: 'jane01', confirm: 'jane01' }).command;
  assert.match(c, /own=\$\(sed -n/, 'extracts owner');
  assert.match(c, /\[ "\$own" = "member" \]/, 'gates on member-owned');
  assert.match(c, /already the rock's/, 'org-owned refusal copy');
  assert.match(c, /grep -q .\^pending_transfer: "to-. "\$f"; then/, 'crossed-transfer guard: refuses when a transfer is already pending (absent field passes)');
  assert.match(c, /gh repo view|gh repo create/, 'creates the org repo');
  assert.match(c, /branches\/main/, 'main-existence init gate (the O2 defect-2 fix)');
  assert.match(c, /transfer-invite\.mjs jane01 invite/, 'runs the invite orchestrator');
  assert.match(c, /pending_transfer: \\"to-org \$\(date \+%F\)\\"/, 'stamps the to-org pending marker');
  assert.ok(!/s\|\^owner:/.test(c), 'must NOT flip owner at invite time');
});

test('O5b: transfer-org-complete verb gates + flips + reflects', () => {
  const spec = VERBS['transfer-org-complete'];
  assert.ok(spec.adminOnly && spec.mutating);
  const c = spec.build({ slug: 'jane01', confirm: 'jane01' }).command;
  assert.match(c, /grep -q .\^pending_transfer: "to-org/, 'requires the to-org pending marker');
  assert.match(c, /transfer-org-complete\.mjs jane01/, 'runs the key-registration orchestrator');
  assert.match(c, /s\|\^owner:.*owner: "org"/, 'flips the registry owner to org');
  assert.match(c, /pending_transfer: ""/, 'clears the pending marker');
  assert.match(c, /edges-reflect\.mjs/, 'mirrors the flip to the directory');
  assert.match(c, /personal repo|their own/i, 'copy: the member keeps any personal repo');
});

test('O5b: transfer-to-member gains the crossed-transfer guard (regression)', () => {
  const c = VERBS['transfer-to-member'].build({ slug: 'jane01', confirm: 'jane01' }).command;
  assert.match(c, /grep -q .\^pending_transfer: "to-. "\$f"; then/, 'refuses when any transfer is already pending (absent field passes)');
});

test('O5b: member transfer-accept verb exists, not adminOnly, refuses cleanly without an invitation', () => {
  const spec = MEMBER_VERBS['transfer-accept'];
  assert.ok(spec, 'member verb exists');
  assert.ok(!spec.adminOnly, 'member-runnable');
  // consent (2026-08-19): the verb needs the receipt the app got from the
  // directory with the member's own sign-in; bare, it refuses
  assert.throws(() => spec.build({}), /consent receipt/, 'no receipt, no run');
  const c = spec.build({ receipt: 'ab'.repeat(16) }).command;
  assert.match(c, /\/state\/transfer-accept\.sh/, 'runs the image copy (fleet-updated) first');
  assert.match(c, /org-inbox\/transfer\/transfer-accept\.sh/, 'falls back to the inbox-delivered script');
  assert.match(c, /No transfer invitation/i, 'clean refusal copy when nothing is staged');
  assert.equal(VERBS['transfer-accept'], undefined, 'not an org verb');
});

test('O5b: the transfer-accept UI is RETIRED (2026-09-01); the verb lingers unwired', () => {
  // Nothing central can stage a transfer any more, so the accept surface
  // (taRow, syncTransferRow, acceptTransfer) left the shell with the custody
  // machinery. The MEMBER verb still exists as an exported builder, but no
  // page runs it: a control must never outlive the thing it does
  // (phantom-control.test.mjs holds the rest of that law).
  const html = _rf(new URL('./member.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /run\('transfer-accept'/, 'no surface runs the verb at all');
  assert.ok(!html.includes('acceptTransfer()'), 'the consent step is gone');
  assert.ok(!html.includes('<div id="taRow"'), 'and so is the action row');
});
import { readFileSync as _rf } from 'node:fs';

// ---- D60 O5b gate round 1: sed-wedge + env-bridge + revoke fixes -------------
test('O5b gate: append-if-absent guards protect pre-O1/pre-O5a rows in all four transfer verbs', () => {
  for (const name of ['transfer-to-member', 'transfer-to-org']) {
    const c = VERBS[name].build({ slug: 'jane01', confirm: 'jane01' }).command;
    assert.match(c, /grep -q "\^pending_transfer:" "\$f" \|\| printf/, `${name} appends the pending line when absent`);
  }
  for (const name of ['transfer-complete', 'transfer-org-complete']) {
    const c = VERBS[name].build({ slug: 'jane01', confirm: 'jane01' }).command;
    assert.match(c, /grep -q "\^owner:" "\$f" \|\| printf/, `${name} appends the owner line when absent`);
  }
  // the exact wedge repro from the gate: a row lacking both lines must round-trip
  const frag = _efs('bash', ['-c', `
    f=$(mktemp); printf 'slug: "lena"\\nstatus: "active"\\nrole: "member"' > "$f"
    [ -z "$(tail -c1 "$f")" ] || echo >> "$f"
    grep -q "^pending_transfer:" "$f" || printf 'pending_transfer: ""\\n' >> "$f"
    sed -i "s|^pending_transfer:.*|pending_transfer: \\"to-org 2026-07-25\\"|" "$f"
    grep -q '^pending_transfer: "to-org' "$f" && echo STAMPED
    grep -q "^owner:" "$f" || printf 'owner: "member"\\n' >> "$f"
    sed -i 's|^owner:.*|owner: "org"|' "$f"
    grep -q '^owner: "org"' "$f" && echo FLIPPED; rm -f "$f"`], { encoding: 'utf8' });
  assert.match(frag, /STAMPED/); assert.match(frag, /FLIPPED/);
});

test('O5b gate: the env bridge reaches every leg that needs org credentials', () => {
  for (const name of ['transfer-to-member', 'transfer-org-complete', 'transfer-revoke']) {
    const c = VERBS[name].build({ slug: 'jane01', confirm: 'jane01' }).command;
    assert.match(c, /provisioning\.env\.local/, `${name} sources the factory env (SOFT_FACTORY_ENV)`);
  }
});

test('O5b gate: transfer-revoke withdraws either direction, clears the marker, no-ops cleanly', () => {
  const spec = VERBS['transfer-revoke'];
  assert.ok(spec.adminOnly && spec.mutating);
  assert.equal(MEMBER_VERBS['transfer-revoke'], undefined);
  const c = spec.build({ slug: 'jane01', confirm: 'jane01' }).command;
  assert.match(c, /transfer-invite\.mjs jane01 revoke/, 'to-org branch revokes the invitation');
  assert.match(c, /transfer-grant\.mjs jane01 revoke/, 'to-member branch revokes the grant');
  assert.match(c, /pending_transfer: ""/, 'clears the row marker');
  assert.match(c, /Nothing to withdraw/, 'clean no-op copy when nothing is pending');
  // the crossed-guard refusal copy now names a verb that exists
  for (const name of ['transfer-to-member', 'transfer-to-org']) {
    assert.match(VERBS[name].build({ slug: 'jane01', confirm: 'jane01' }).command, /transfer-revoke/,
      `${name} refusal copy names the real exit`);
  }
});

// ---------------------------------------------------------------- member-page sandbox (three-layer v2, 2026-07-27)
test('member pages render sandboxed: iframe + verb whitelist, no raw pageApi bridge, cards data-only', () => {
  const html = _rf(new URL('./member.html', import.meta.url), 'utf8');
  // fragments go into a sandboxed iframe with an opaque origin (no allow-same-origin)
  assert.match(html, /setAttribute\('sandbox', 'allow-scripts'\)/, 'iframe sandbox attr present');
  const sandboxAttrs = [...html.matchAll(/setAttribute\('sandbox', '([^']*)'\)/g)].map((m) => m[1]);
  assert.ok(sandboxAttrs.length >= 1 && sandboxAttrs.every((v) => v === 'allow-scripts'),
    'every sandbox attribute is exactly allow-scripts (never allow-same-origin)');
  // the srcdoc CSP blocks all network so box data cannot leak as a rendering side effect
  assert.match(html, /Content-Security-Policy" content="default-src \\'none\\'/, 'srcdoc carries a deny-all CSP');
  // pages may only call read-only brain verbs through the bridge
  assert.match(html, /PAGE_RUN_WHITELIST = \{ 'brain-list': 1, 'brain-read': 1 \}/, 'run() whitelist is exactly the read-only brain verbs');
  // the old privileged bridge (every member verb incl. support-grant/box-refresh) is gone
  assert.ok(!/window\.pageApi = \{ run: run/.test(html), 'no direct pageApi bridge into the app verb runner');
  // cards.json is data-only: the raw html passthrough is retired
  assert.ok(!/if \(c\.html\) return sub\(c\.html\)/.test(html), 'card html passthrough removed');
});

// Whitelist parity (spec 2026-08-25 § 5.1). member.html enforces
// PAGE_RUN_WHITELIST at runtime; page-lint.mjs refuses the same verbs at
// publish. They were two literals that happened to agree, so widening one
// silently diverged from the other. Neither can now move alone.
test('the runtime page whitelist and the build-time one are the same list', async () => {
  const { PAGE_API_VERBS } = await import('../../engine/appshell/page-lint.mjs');
  const html = _rf(new URL('./member.html', import.meta.url), 'utf8');
  const m = html.match(/PAGE_RUN_WHITELIST = \{([^}]*)\}/);
  assert.ok(m, 'member.html still declares PAGE_RUN_WHITELIST');
  const runtime = [...m[1].matchAll(/'([a-z-]+)'\s*:/g)].map((x) => x[1]);
  assert.deepEqual(runtime.slice().sort(), PAGE_API_VERBS.slice().sort(),
    'member.html PAGE_RUN_WHITELIST and page-lint PAGE_API_VERBS must be the same set');
});

test('the protected job floor renders read-only on the Health card (moved 2026-08-09, R6)', () => {
  const html = _rf(new URL('./member.html', import.meta.url), 'utf8');
  // Anchored on the rendered preamble, not the old "Always-on machinery" copy:
  // that phrase now survives only in a comment, so the pin passed while proving
  // nothing about the block.
  // R19a (2026-08-23): the preamble is the fold summary's title; the rows sit
  // behind <details class="machfold">, open only when a job is not ok.
  assert.match(html, /<details class="machfold"' \+ \(sick \? ' open' : ''\) \+ '>'/, 'machinery block folds, open only when something is not ok');
  assert.match(html, /summary title="These look after themselves\. Listed so nothing runs invisibly\."/, 'the preamble survives on hover');
  assert.match(html, /Nightly software update/, 'auto-update job listed');
  assert.match(html, /Heartbeat/, 'heartbeat job listed');
  // read-only: the machinery rows must carry no toggles or selects
  const block = html.split('function machineryRows')[1].split('function machineryHtml')[0]
    + html.split('function machineryHtml')[1].split('\n  }')[0];
  assert.ok(!/toggle|<select|onclick/.test(block), 'machinery rows carry no controls');
});

// ---------------------------------------------------------------- invitee door (spec 2026-07-27 § 3)
test('terminal ramp: openTerm(opts) with a single-shot auto-typed opener', () => {
  const html = _rf(new URL('./member.html', import.meta.url), 'utf8');
  assert.match(html, /function openTerm\(opts\)/, 'terminal open logic is callable, not button-only');
  assert.match(html, /\$\('termBtn'\)\.onclick = function\(\)\{ openTerm\(\{\}\); \};/, 'button delegates to openTerm');
  assert.match(html, /var MEET_OPENER = /, 'the opener line is a named constant');
  assert.match(html, /termAutorun = ''/, 'autorun is cleared (single-shot) so it can never re-fire');
  // the opener rides the existing /term/input transport
  const autorunBlock = html.split('function openTerm(opts)')[1].split('$' + '(\'termBtn\').onclick')[0];
  assert.match(autorunBlock, /term\/input/, 'opener sent via /term/input');
  // double-open race guard: re-clicking during a pending /term/open must be a no-op
  assert.match(html, /var termOpening = false;/, 'termOpening flag declared at module scope');
  assert.match(autorunBlock, /if \(termId \|\| termOpening\) \{ if \(term\) term\.focus\(\); return; \}/,
    'entry guard rejects re-entry while a /term/open call is in flight');
  assert.match(autorunBlock, /termOpening = true;\s*\n\s*fetch\('\/term\/open'/, 'termOpening set true immediately before the /term/open fetch');
  assert.match(autorunBlock, /termId = j\.id;\s*\n\s*termOpening = false;/, 'termOpening cleared once the open succeeds');
  assert.match(autorunBlock, /\.catch\(function\(e\)\{ termOpening = false;/, 'termOpening cleared on a failed open too');
});

test('landing: one oversized Meet-your-assistant step; desktop app framed as upgrade', () => {
  const html = _rf(new URL('./member.html', import.meta.url), 'utf8');
  assert.match(html, /Meet your assistant/, 'the mega CTA copy exists');
  assert.match(html, /ccBannerBtn'\)\.onclick = function\(\)\{ activateSec\('terminal'\); openTerm\(\{ autorun: MEET_OPENER \}\); \};/,
    'the landing CTA opens the terminal ramp pre-scripted, not the install guide');
  assert.ok(!/Connecting takes about two minutes/.test(html), 'prerequisite framing gone from the banner');
  assert.match(html, /adds a nicer window onto the same assistant/, 'the Help page frames the desktop app as an upgrade');
  // post-onboarding hero CTA repoints to the terminal ramp, not the claudecode tab,
  // and does nothing more than switch section — onboarded members choose when to open a session
  assert.match(html, /\$\('heroTalk'\)\.onclick = function\(\)\{ activateSec\('terminal'\); \};/,
    'heroTalk routes to the terminal tab only, no auto-open');
});

test('sidebar footer names the Terminal tab first, Claude Code as the fuller experience', () => {
  // The memonly gate fell off with the faces (2026-09-01): the one footer
  // shows to everyone.
  const html = _rf(new URL('./member.html', import.meta.url), 'utf8');
  assert.match(html, /class="foot">/, 'sidebar footer present, ungated');
  const foot = html.split('class="foot">')[1].split('</div>')[0];
  assert.match(foot, /use the <b>Terminal<\/b> tab above/, 'footer points at the terminal ramp first');
  assert.match(foot, /<b>Claude Code<\/b> app is the fuller desktop experience/, 'the Claude Code app named as the fuller experience, not the only way to talk');
  // Terminal must be named before Claude Code in reading order
  assert.ok(foot.indexOf('Terminal') < foot.indexOf('Claude Code'), 'Terminal tab named before Claude Code tab');
});

test('cliff screen: escape hatch persistent, failure copy owns the fault, never a dead end', () => {
  const html = _rf(new URL('./member.html', import.meta.url), 'utf8');
  assert.match(html, /id="termHelp"/, 'help row exists on the terminal section');
  const helpRow = html.split('id="termHelp"')[1].split('</div>')[0];
  assert.match(helpRow, /full desktop|desktop app/i, 'ramp two reachable from the cliff');
  assert.match(html, /getHuman'\)\.onclick/, 'get-a-human is wired');
  assert.match(html, /That's on us, not you\./, 'failure copy owns the fault');
  // #termHelp's "row" class has no CSS in this file, so gap only takes effect
  // once display:flex is set inline alongside it
  assert.match(html, /id="termHelp" style="[^"]*display:flex[^"]*gap:14px/, 'termHelp is inline-flexed so gap actually applies');
});

test('org contact flows to the member escape hatch', () => {
  const cl = MEMBER_VERBS['pages-list'].build().command;
  assert.match(cl, /__ORGCONTACT__/, 'pages-list carries the org-contact segment');
  assert.match(cl, /org-contact\.json/, 'reads the file factory\/stamp-pebble\.sh stages alongside ownership.json');
  assert.match(cl, /__OWNERSHIP__[\s\S]*__ORGCONTACT__/, 'org-contact segment appended after ownership, per the wire order');
  const html = _rf(new URL('./member.html', import.meta.url), 'utf8');
  assert.match(html, /state\.orgContact = JSON\.parse\(seg\('__ORGCONTACT__'\)/, 'member app parses the segment in loadPagesList');
  assert.match(html, /seg\('__OWNERSHIP__', '__ORGCONTACT__'\)/, 'ownership segment boundary updated so it does not swallow org-contact');
  // dynamic-insert design: state.orgContact arrives async off pages-list, so the
  // mailto line cannot be baked into the static #termHelp markup -- assert the
  // insertion function + mailto template string exist instead of a static <a>.
  assert.match(html, /function renderOrgContact\(\)/, 'dedicated render function, called from loadPagesList');
  assert.match(html, /renderMemberNav\(\); renderPagesSection\(\); renderOwnership\(\); renderCards\(\); renderOrgContact\(\);/, 'wired into the pages-list load, alongside the Pages management list (2026-08-25)');
  // 2026-07-27 review: .href is a DOM property, never HTML-parsed, so esc()
  // (HTML-escaping) on it would corrupt an email containing '&'. Only the
  // visible label (org name) needs esc(); the href must carry the raw email.
  assert.match(html, /a\.href = 'mailto:' \+ email;/, 'mailto href uses the raw email, unescaped');
  assert.doesNotMatch(html, /a\.href = 'mailto:' \+ esc\(email\)/, 'href no longer HTML-escapes the email');
  const fn = html.split('function renderOrgContact()')[1].split('\n  }')[0];
  assert.match(fn, /if \(!email\) return;/, 'renders nothing when admin_email is empty');
  assert.match(fn, /getElementById\('orgContactLink'\); if \(old\) old\.remove\(\);/, 'removes any prior injected link first, so repeated loads stay idempotent');
  assert.match(fn, /esc\(org\)/, 'org name (the visible label) still escaped');
  assert.doesNotMatch(fn, /esc\(email\)/, 'email is never passed through esc() anywhere in the function');
});

test('the New Pebble surfaces are RETIRED (2026-09-01): nobody births a mineral for another', () => {
  // "New Pebble" was the Members page's birth flow over invite-member. Both
  // died with the face collapse; a person gets a mineral through the door's
  // wizard, on their own account.
  const raw = _rf(new URL('./member.html', import.meta.url), 'utf8');
  // an old comment still narrates the vocabulary; only rendered surfaces count
  const html = raw.replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!html.includes('New Pebble'), 'the birth CTA stays gone');
  assert.ok(!html.includes('id="st_name"'), 'and its form fields with it');
  assert.ok(!html.includes("'invite-member'"), 'no surface wires the deleted birth verb');
  assert.ok(!html.includes('fleetEmptyAdd'), 'no day-zero empty-state CTA either');
});

// ---------------------------------------------------------------- role-gate invariants (2026-07-28 QA sweep)
// stamp-member shipped without adminOnly while every sibling had it, so a Support
// login could provision a member box carrying a caller-supplied SSH key, bypassing
// approve-device's two-party fingerprint gate. These assertions pin the INVARIANT
// rather than the one verb, so the next verb added cannot reintroduce the class.
test('every mutating org verb is adminOnly; no member verb is', () => {
  const ungated = Object.entries(VERBS).filter(([, v]) => v.mutating && !v.adminOnly).map(([n]) => n);
  assert.deepEqual(ungated, [], 'a mutating org verb without adminOnly is a Support-role privilege escalation');
  const memberAdmin = Object.entries(MEMBER_VERBS).filter(([, v]) => v.adminOnly).map(([n]) => n);
  assert.deepEqual(memberAdmin, [], 'the member edition has one person and no roles: adminOnly is meaningless there');
});

// invite-member's adminOnly pin and the T3.1 ownership choice both retired
// with the verb (2026-09-01): its deletion is held by the ruling-10 pin above.
// Ownership needs no choice any more: whoever runs the wizard on their own
// Hetzner token owns the mineral, by construction.
test('T3.1: the ownership choice is RETIRED with the birth verb', () => {
  assert.equal(VERBS['invite-member'], undefined, 'no verb carries an --owner flag to stamp-pebble');
});

// ---- E6.1/E6.2 · the minimum console verbs (org seat) -------------------------
test('console-state: read-only, emits one CONSOLE_STATE JSON from the org plane', () => {
  const v = VERBS['console-state'];
  assert.ok(v, 'console-state verb exists');
  assert.ok(!v.mutating, 'reads never take the busy lock');
  const c = v.build().command;
  assert.match(c, /registry\/members/, 'reads the registry rows');
  assert.match(c, /org-requests\.json/, 'carries the requests inbox');
  assert.match(c, /CONSOLE_STATE/, 'emits the parseable marker line');
  assert.match(c, /normalize-row\.mjs/, 'prefers the brain\'s own normalize module');
});

test('console-answer is RETIRED (2026-09-01): no directory holds requests to answer', () => {
  // The verb answered directory consent requests with the box-held org token.
  // The directory is deleted; console-state keeps its box-local read with the
  // directory pulls stubbed, and the answer verb stays gone.
  assert.equal(VERBS['console-answer'], undefined, 'the verb stays gone');
  assert.equal(MEMBER_VERBS['console-answer'], undefined, 'and never reaches the one table');
});

// ---- E6.1 · the member console seat ------------------------------------------
test('member-console-state: reads only the box\'s own truth, emits CONSOLE_STATE', () => {
  const v = MEMBER_VERBS['member-console-state'];
  assert.ok(v, 'member-console-state exists in the MEMBER edition');
  assert.ok(!v.mutating);
  const c = v.build().command;
  assert.match(c, /ownership\.json/, 'the dials come from ownership.json');
  assert.match(c, /org-contact\.json/, 'the anchor card names the org');
  assert.match(c, /to-org\.json/, 'surfaces a waiting transfer invitation');
  assert.match(c, /to-member\.json/, 'surfaces a waiting ownership grant');
  assert.match(c, /CONSOLE_STATE/, 'same marker contract as the org seat');
  assert.ok(!/registry\/members/.test(c), 'a member seat never reads a registry (one-hop sight)');
  // Backup status (2026-07-30): the console must be able to say whether the brain is
  // connected to the owner's own repo AND when a copy last actually left the box.
  // "Connected" without a push is not a backup.
  assert.match(c, /backup=\{connected:false/, 'backup state is reported');
  assert.match(c, /brain-push\.log/, 'last-push time comes from the push log');
  // Field-wise, not adjacency-wise (2026-08-13): this asserted the literal run
  // `anchored,name:nm,backup,` and so failed the moment the payload gained the
  // anchor SLUG between them (finding 114). What matters is that each field
  // rides the line, not what sits next to it.
  for (const f of ['anchored', 'name:nm', 'backup', 'ties']) {
    assert.match(c, new RegExp('[{,]' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[,}]'),
      `${f} rides the CONSOLE_STATE payload`);
  }
  assert.match(c, /anchor:\(own\.anchor/, "and so does the anchor's slug, which a bool cannot stand in for");
  // the remote URL carries a credential in the HTTPS form; it must be stripped before
  // it reaches the app, because this string is rendered in the UI
  assert.match(c, /replace\(\/\\\/\\\/\[\^@\\\/\]\*@\/,"\/\/"\)/, 'any token in the remote URL is stripped');
});

// A6, RETIRED (2026-09-01): the member's hand-over ask relayed to the
// directory's handover-request endpoint with a verified identity. Custody asks
// died with the directory; ownership does not move between accounts any more,
// it is established at create time by whose SSH key the wizard installs.
test('/handover-ask is RETIRED: the route 404s and dials nothing', async () => {
  let dialled = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://dir.example')) return realFetch(url, init);
    dialled = true;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  try {
    const s = await listen({
      bridge: { targets: () => [{ host: 'jane01-box', kind: 'member', org: 'jane01' }], stream: () => {}, tty: () => {} },
      directoryUrl: 'https://dir.example',
      handoverSignIn: async () => ({ ok: true, idToken: 'stub.id.token' }),
    });
    try {
      const r = await fetch(`http://127.0.0.1:${s.address().port}/handover-ask`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ org: 'acme' }) });
      assert.equal(r.status, 404, 'the route stays gone');
      assert.equal(dialled, false, 'and nothing ever dials a directory, even with the old options injected');
    } finally { s.close(); }
  } finally { globalThis.fetch = realFetch; }
});

// The brain graph is the member's picture of their own brain, so a page or a link
// missing from it reads as work that was never done. It has now failed that way twice:
// once because the builder died on the layers rename and served frozen data, once
// because capitalised wikilinks resolved to nothing. The data side is pinned in
// engine/cockpit/box-cockpit-graph.test.mjs; these are the viewer-side invariants,
// asserted statically the way the door contract is (a canvas cannot be asserted in
// node, and browser-driving this page needs a live box).
test('member brain graph: renders every node, defaults to whole for a real brain (static)', () => {
  const html = _rf(new URL('./member.html', import.meta.url), 'utf8');
  // whole-brain mode takes ALL nodes, filtered only by the type legend, never a slice
  assert.match(html, /G\.nodes\.filter\(function\s*\(n\)\s*\{\s*return\s*!G\.hidden\.has\(n\.type\)/,
    'whole mode includes every node whose type is not hidden');
  assert.ok(!/G\.nodes\.slice\(0,\s*\d+\)/.test(html), 'the viewer must never cap the node count');
  // a client brain is small, so it should open showing everything rather than a
  // one-hop neighbourhood the member has to discover a button to escape
  assert.match(html, /G\.nodes\.length <= 60\) showWhole\(\)/, 'a small brain opens whole');
  assert.match(html, /id="gWhole"/, 'and the whole-brain control is always available');
  // links are filtered to the visible node set, never truncated
  assert.match(html, /G\.vLinks = G\.links\.filter\(/, 'links come from the full link set');
  assert.ok(!/links\.slice\(0,\s*\d+\)/.test(html), 'the viewer must never cap the link count');
});

// The no-GitHub answer: a member gets their whole brain as one file. The exclusions
// are the security-critical part, so they are pinned by name, not by shape.
test('/brain-download streams the brain and leaves every credential behind', async () => {
  let ranCmd = '';
  const s = await listen({
    edition: 'member',
    bridge: { targets: () => [{ host: 'jane01-box', kind: 'member', org: 'jane01' }], stream: () => {}, tty: () => {} },
    downloadProbe: async () => ({ code: 0, stdout: 'READY', stderr: '' }),
    downloadStream: async (host, cmd) => {
      ranCmd = cmd;
      const { Readable } = await import('node:stream');
      const pebble = Readable.from([Buffer.from('fake-tar-bytes')]);
      return { stdout: pebble, on: () => {}, kill: () => {} };
    },
  });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/brain-download?box=jane01-box`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/gzip');
    assert.match(r.headers.get('content-disposition'), /attachment; filename="jane01-brain-\d{4}-\d{2}-\d{2}\.tar\.gz"/);
    assert.equal(await r.text(), 'fake-tar-bytes');
    // every credential path, plus .git (a secret committed once must not ride out in history)
    for (const p of ['.git', '.env', 'secrets', '*.key', '*.pem', '.ssh', '.claude-auth', '.kernel', '.mcp.json']) {
      assert.ok(ranCmd.includes(`--exclude=${p}`), `must exclude ${p}`);
    }
    assert.match(ranCmd, /tar czf - -C "\$BR"/, 'streams a tar from the brain root');
  } finally { s.close(); }
});

test('/brain-download refuses before sending bytes when the box is unreachable', async () => {
  const s = await listen({
    edition: 'member',
    bridge: { targets: () => [{ host: 'jane01-box', kind: 'member', org: 'jane01' }], stream: () => {}, tty: () => {} },
    downloadProbe: async () => { throw new Error('unreachable'); },
    downloadStream: async () => { throw new Error('must not be reached'); },
  });
  try {
    // the probe exists so a failure is a real status code, not a truncated file
    const r = await fetch(`http://127.0.0.1:${s.address().port}/brain-download`);
    assert.equal(r.status, 502);
    assert.match(await r.text(), /Could not reach your mineral/);
  } finally { s.close(); }
});

test('/brain-download needs a configured box (the edition gate died with the editions)', async () => {
  const none = await listen({ bridge: { targets: () => [], stream: () => {}, tty: () => {} } });
  try { assert.equal((await fetch(`http://127.0.0.1:${none.address().port}/brain-download`)).status, 400); }
  finally { none.close(); }
});

// The /go/connect hop is DELETED (2026-09-01): the invite page it resolved to
// left with the invitation system. backup-handoff.test.mjs pins the 404.

// The embedded probe is a STRING, so a syntax error in it would only surface on a
// live box. Parse it here instead. The command now runs behind the shared
// brain-root fragment (which contains its own `node -e`), so the probe is the
// LAST node -e in the string, and the resolved $BR reaches it as env.
test('member-console-state: the embedded probe is valid JavaScript', async () => {
  const { BRAIN_ROOT_SH } = await import('../../engine/lib/brain-root.mjs');
  const cmd = MEMBER_VERBS['member-console-state'].build().command;
  assert.ok(cmd.startsWith(BRAIN_ROOT_SH), 'the probe runs behind the shared brain-root resolver');
  const inner = cmd.slice(cmd.lastIndexOf("node -e '")).replace(/^node -e '/, '').replace(/'$/, '');
  assert.doesNotThrow(() => new Function(inner), 'the probe body must parse');
  assert.match(inner, /process\.env\.BR/, 'the probe reads the resolved root, not a hand copy');
});

// ---- E6.3 · console verbs wired to the choreography ---------------------------
test('console-request and console-withdraw are RETIRED (2026-09-01): no request fabric', () => {
  // Both verbs drove the directory's org-to-org request fabric (transfer,
  // late-attach, reframe asks) with the box-held token. The fabric died with
  // the directory; anything two communities agree on now happens over their
  // own channels and commons repos.
  assert.equal(VERBS['console-request'], undefined, 'the create verb stays gone');
  assert.equal(VERBS['console-withdraw'], undefined, 'and the withdraw verb with it');
  assert.equal(MEMBER_VERBS['console-request'], undefined);
  assert.equal(MEMBER_VERBS['console-withdraw'], undefined);
});

// 'console-delivery' was removed 2026-08-10 with the pause concept; the
// resume-only test above pins its absence so it cannot quietly return.

test('secrets verbs: stdin transport, tier enum, name safety (secret store)', () => {
  const put = MEMBER_VERBS['secrets-put'].build;
  const b64 = Buffer.from('ya29.the-token').toString('base64');
  const hot = put({ name: 'gmail-token', label: 'Gmail', tier: 'hot', content_b64: b64 });
  assert.match(hot.command, /vault-cli\.mjs \/state put-hot gmail-token 'Gmail'$/);
  assert.match(hot.command, /^base64 -d \| /, 'value arrives via stdin, decoded box-side');
  assert.equal(hot.stdin, b64 + '\n');
  assert.ok(!hot.command.includes('ya29'), 'THE POINT: no secret value anywhere in argv');

  const cold = put({ name: 'bank-login', label: 'Bank', tier: 'cold', content_b64: b64 });
  assert.match(cold.command, /put-cold bank-login 'Bank'$/);

  assert.throws(() => put({ name: 'gmail-token', tier: 'warm', content_b64: b64 }), /tier/);
  assert.throws(() => put({ name: '../escape', tier: 'hot', content_b64: b64 }), /name/i);
  assert.throws(() => put({ name: 'gmail-token', tier: 'hot', content_b64: 'not base64!' }), /content_b64/);
  assert.throws(() => put({ name: 'gmail-token', tier: 'hot', content_b64: '' }), /content_b64/);
  // label defaults to the name rather than going empty
  assert.match(put({ name: 'gmail-token', tier: 'hot', content_b64: b64 }).command, /'gmail-token'$/);

  assert.match(MEMBER_VERBS['secrets-remove'].build({ name: 'gmail-token' }).command, /remove gmail-token$/);
  assert.throws(() => MEMBER_VERBS['secrets-remove'].build({ name: 'a/b' }), /name/i);
  assert.match(MEMBER_VERBS['secrets-list'].build().command, /vault-cli\.mjs \/state list$/);
  assert.match(MEMBER_VERBS['secrets-envelopes'].build().command, /vault-cli\.mjs \/state envelopes$/);

  for (const v of ['secrets-put', 'secrets-remove']) assert.ok(MEMBER_VERBS[v].mutating, `${v} mutating`);
  for (const v of ['secrets-list', 'secrets-envelopes']) assert.ok(!MEMBER_VERBS[v].mutating, `${v} read-only`);
  for (const v of ['secrets-list', 'secrets-put', 'secrets-remove', 'secrets-envelopes']) {
    assert.ok(!MEMBER_VERBS[v].adminOnly, `${v} not adminOnly`);
    assert.equal(VERBS[v], undefined, `${v} absent from the rock edition`);
  }
});

// ---------------------------------------------------------------- rock for a member
// Verb-interview ruling 2026-08-03: the relay FORCES the rock shape server-side,
// so a tampered client body cannot post arbitrary create-requests through it.
test('rocks cannot create rocks (2026-08-09 second loop): /rock-request is gone from every edition', async () => {
  const org = await listen({ bridge: fakeBridge([{ host: 'ic-rock', org: 'ic', kind: 'rock' }]) });
  const mem = await listen({ bridge: fakeBridge([{ host: 'j-box', org: 'j', kind: 'member' }]), edition: 'member' });
  try {
    for (const srv of [org, mem]) {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}/rock-request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 404, 'the concierge route died with the mountain-model ladder rule');
    }
  } finally { org.close(); mem.close(); }
});

// ---------------------------------------------------------------- pause removal
// The pause-honesty contract (reason rides argv, never sed) died with pause
// itself (ruling 2026-08-10). What remains: releasing a legacy paused row must
// clear the old reason field via the same argv-not-sed shape, pinned in the
// resume-only test above (R='' + "$R"). A reason argument is simply ignored.
test('pause removal: a reason argument no longer exists on member-set-status', () => {
  const c = VERBS['member-set-status'].build({ slug: 'jane01', status: 'active', reason: 'ignored' }).command;
  assert.ok(!c.includes('ignored'), 'stray reason input never reaches the command');
  assert.ok(c.includes('"$R"'), 'the legacy-reason clear still travels as argv, never re-parsed');
});


// ---------------------------------------------------------------- 30d offer TTL
test('staged transfer offers lapse: both Complete verbs refuse a stage older than 30 days', () => {
  for (const [verb, marker] of [['transfer-complete', 'to-member'], ['transfer-org-complete', 'to-org']]) {
    const c = VERBS[verb].build({ slug: 'jane01', confirm: 'jane01' }).command;
    assert.ok(c.includes(`pending_transfer: "${marker} \\([0-9-]*\\)`), `${verb}: parses the staged date off the marker`);
    assert.match(c, /-gt 30/, `${verb}: 30 day deadline`);
    assert.match(c, /offer lapsed|invitation lapsed/, `${verb}: refuses in plain words`);
    assert.match(c, /transfer-revoke/, `${verb}: names the way out`);
  }
});

test('verified Complete: transfer-complete runs the receipt verifier before any flip; older brains keep the promise path', () => {
  const c = VERBS['transfer-complete'].build({ slug: 'jane01', confirm: 'jane01' }).command;
  const verify = c.indexOf('transfer-member-verify.mjs');
  const flip = c.indexOf('owner: "member"');
  assert.ok(verify > -1, 'the verifier runs');
  assert.ok(flip > verify, 'verification comes BEFORE the flip');
  assert.match(c, /\[ -f orchestrator\/transfer-member-verify\.mjs \]/, 'a brain without the script keeps the human-promise behaviour instead of bricking');
});

// ---------------------------------------------------------------- ask channel (slice 2)
test('ask-push: admin-only org verb, kinds validated, reframe needs its framework', () => {
  const ap = VERBS['ask-push'];
  assert.ok(ap && ap.adminOnly && ap.mutating);
  assert.match(ap.build({ slug: 'jane01', kind: 'ask-read' }).command, /push-ask\.mjs jane01 ask-read/);
  assert.match(ap.build({ slug: 'jane01', kind: 'reframe', framework: 'five pillars' }).command, /--framework 'five pillars' --intensity overlay/);
  assert.match(ap.build({ slug: 'jane01', kind: 'ask-install', withdraw: true }).command, /--withdraw/);
  assert.throws(() => ap.build({ slug: 'jane01', kind: 'nonsense' }), /kind must be/);
  assert.throws(() => ap.build({ slug: 'jane01', kind: 'reframe' }), /names the framework/);
  assert.throws(() => ap.build({ slug: 'jane01', kind: 'reframe', framework: "x'y" }), /no quotes/);
});

test('ask-answer: member verb records locally, publishes up the heartbeat, honest without a channel', () => {
  const aa = MEMBER_VERBS['ask-answer'];
  assert.ok(aa && aa.mutating && !aa.adminOnly, 'answering is the person\'s own act, never admin-gated');
  const c = aa.build({ kind: 'ask-read', answer: 'declined' }).command;
  assert.match(c, /org-inbox\/asks\/ask-read\.json/, 'answers only an ask that is actually open');
  assert.match(c, /\/state\/asks\/ask-read-answer\.json/, 'records locally so the card clears');
  assert.match(c, /heartbeat_deploy_key/, 'publishes up the same channel transfer-accept uses');
  assert.match(c, /No rock channel exists/, 'honest when self-sovereign');
  assert.throws(() => aa.build({ kind: 'ask-read', answer: 'maybe' }), /accepted or declined/);
  assert.throws(() => aa.build({ kind: 'weird', answer: 'accepted' }), /kind must be/);
});

test('member-console-state ships pending asks, filtered by already-answered markers', () => {
  const c = MEMBER_VERBS['member-console-state'].build().command;
  assert.match(c, /org-inbox\/asks\//, 'reads the inbox asks');
  assert.match(c, /asks\/.*-answer\.json/, 'checks the local answer marker');
  assert.match(c, /done&&done\.asked===a\.asked/, 'a re-ask after an answer shows again (asked date differs)');
  assert.match(c, /,asks\}/, 'asks ride the waiting payload');
});

test('leave-org: unilateral, typed-word armed, honest about what ends and what stays', () => {
  const lv = MEMBER_VERBS['leave-org'];
  assert.ok(lv && lv.mutating && !lv.adminOnly, 'leaving is the person\'s own act');
  assert.throws(() => lv.build({}), /type the word leave/);
  assert.throws(() => lv.build({ confirm: 'LEAVE' }), /type the word leave/, 'exact word, no shouting');
  const c = lv.build({ confirm: 'leave' }).command;
  assert.match(c, /org-inbox\.conf/, 'only an anchored box has something to leave');
  assert.match(c, /leave\.json/, 'the marker rides the heartbeat');
  assert.match(c, /your brain stay yours|brain stay yours/i, 'the copy says what stays');
  assert.match(c, /invite away/, 'and that the way back exists');
});

test('evict-member verb (Mountain model): reason required and bounded, admin-only, lands on the orchestrator', () => {
  const v = VERBS['evict-member'];
  assert.equal(v.adminOnly, true);
  assert.equal(v.mutating, true);
  const cmd = v.build({ slug: 'jane01', reason: 'membership unpaid since June' }).command;
  assert.match(cmd, /orchestrator\/evict-member\.mjs jane01 --reason/);
  assert.match(cmd, /'membership unpaid since June'/);
  assert.throws(() => v.build({ slug: 'jane01' }), /reason is required/);
  assert.throws(() => v.build({ slug: 'jane01', reason: '   ' }), /reason is required/);
  assert.throws(() => v.build({ slug: '../evil', reason: 'x' }), /slug/i);
});

test('the evict UI is RETIRED (2026-09-01): no card offers to end somebody\'s membership', async () => {
  // Evict was the Members card's staged End-flow outcome. The Members page is
  // gone and no mineral holds authority over another, so no ending surface
  // may come back. The evict-member builder above stays pinned (reason
  // required) only until the machinery is deleted.
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
  assert.ok(!/id="evictBtn"/.test(html), 'the global evict form stays dead');
  assert.ok(!html.includes('flowOption('), 'the staged End flow stays gone');
  assert.ok(!html.includes('End the membership'), 'and its copy with it');
});

// ---- rock ties (rulings 2026-08-05 + 2026-08-09), RETIRED 2026-09-01 --------

test('rock-answer and rock-tie-end are RETIRED: no directory holds ties to answer or end', () => {
  // Both verbs spoke to the directory's tie endpoints with the box-held org
  // token. Ties died with the directory: a community relationship is now a
  // commons repo a member pulls, ended by either side without a fabric.
  assert.equal(VERBS['rock-answer'], undefined, 'the tie answer verb stays gone');
  assert.equal(VERBS['rock-tie-end'], undefined, 'and the tie ender with it');
  assert.equal(MEMBER_VERBS['rock-answer'], undefined);
  assert.equal(MEMBER_VERBS['rock-tie-end'], undefined);
});

test('console-state no longer dials the directory: the tie pulls are stubbed empty', () => {
  const c = VERBS['console-state'].build().command;
  assert.ok(!c.includes('rock-tie-requests?org='), 'no tie-ask pull');
  assert.ok(!c.includes('rock-ties?org='), 'no live-tie pull');
  assert.ok(!c.includes('curl'), 'nothing is dialled at all');
  assert.match(c, /TIEREQ="\{\}"; TIES="\{\}";/, 'the marked line carries empty lists for those fields');
});

const askRockRoute = (s, path, body) => fetch(`http://127.0.0.1:${s.address().port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
});

// ---- the /rock-* ask routes, RETIRED (2026-09-01) ---------------------------
// join-ask, anchor-ask, leave, mine and mine/refresh all relayed tie state to
// the directory with a verified identity. Ties died with the directory:
// joining a community is a bundle pasted on the Communities page, leaving is
// community-leave against the box, and the Map reads community-list. These
// pins hold the whole route family gone and undialled.
test('the tie ask routes are gone, and nothing dials a directory through them', async () => {
  let dialled = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://dir.example')) return realFetch(url, init);
    dialled = true;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  try {
    const s = await listen({
      bridge: { targets: () => [{ host: 'jane01-box', kind: 'member', org: 'jane01' }], stream: () => {}, tty: () => {} },
      directoryUrl: 'https://dir.example',
      communitySignIn: async () => ({ ok: true, idToken: 'stub.id.token' }),
    });
    try {
      for (const path of ['/rock-join-ask', '/rock-anchor-ask', '/rock-leave', '/rock-mine/refresh']) {
        assert.equal((await askRockRoute(s, path, { org: 'acme', tie: 'joined' })).status, 404, `${path} stays gone`);
      }
      assert.equal((await fetch(`http://127.0.0.1:${s.address().port}/rock-mine`)).status, 404, '/rock-mine stays gone');
      assert.equal(dialled, false, 'no route dials a directory, even with the old options injected');
      // the replacement surfaces are box-verbs, served in the one table
      assert.ok(MEMBER_VERBS['community-join'], 'joining is the bundle verb');
      assert.ok(MEMBER_VERBS['community-leave'], 'leaving is the box-local verb');
      assert.ok(MEMBER_VERBS['community-list'], 'and the list the Map draws from');
    } finally { s.close(); }
  } finally { globalThis.fetch = realFetch; }
});

test('the Network map draws from the BOX, never from directory state (R9, sharpened by the collapse)', () => {
  // R9's law was that the map reads the box, not the panel's directory cache.
  // The collapse made the law total: worldFacts states only what the box says
  // about itself (box, devices, support), the tie fields are gone, and the
  // communities layer comes from the box's own community-list, page-side.
  const src = _rf(new URL('./panel-server.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function worldFacts'), src.indexOf('async function topologyWorld'));
  assert.ok(fn.length > 100, 'worldFacts found');
  assert.ok(!/state\.ties/.test(fn), 'the tie fields died with the directory');
  assert.ok(!/_communityMine/.test(fn), 'and the directory cache stays out of render, as R9 demanded');
});

test('the directory routes are wired, both editions, non-awaited like mcp-oauth', () => {
  const src = _rf(new URL('./panel-server.mjs', import.meta.url), 'utf8');
  assert.match(src, /createMcpDirectoryRoutes/, 'panel-server imports the directory routes');
  assert.match(src, /path\.startsWith\('\/mcp-dir\/'\)/, 'dispatcher routes /mcp-dir/');
  const dispatch = src.slice(src.indexOf("path.startsWith('/mcp-dir/')"));
  assert.match(dispatch.slice(0, 400), /\.catch\(/, 'a rejection must still answer, or the page waits forever');
});

// ---------------------------------- the invite page is GONE (2026-09-01)
// member-connect.html and its server were deleted with the invitation system,
// after a long run of ceremony bugs this block used to pin one by one. What is
// left to pin is the absence: the file stays out of the tree, and the shell
// never links the surface again.
test('the invite page and its hop stay deleted', () => {
  assert.ok(!existsSync(new URL('./member-connect.html', import.meta.url)), 'member-connect.html must not return');
  const shell = readFileSync(new URL('./member.html', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!shell.includes('/go/connect'), 'the shell links no invite hop');
});

// --- finding 107: the app must be able to OPEN what onboarding wrote ---------
//
// PAGE_RE required every path segment to start alphanumeric, and /onboard writes
// every layer to `wiki/_layers/<n>-<name>.md`. So the entire product of the
// onboarding interview was refused by brain-read, while `wiki/people/*.md` beside
// it was allowed. Driven live on a fully onboarded rock: the Brain graph drew all
// eight layers and invited "click any to focus", and the reader answered
// "page must be a relative .md path".
//
// The dotfile ban is the guard that actually matters here and it must NOT
// loosen: it is what keeps .git/, .claude-auth/ and .kernel/ out of a page
// reader, alongside the `..` traversal refusal.
test('107: brain-read accepts the paths /onboard actually writes', async () => {
  const { VERBS } = await import('./panel-server.mjs');
  for (const page of [
    'wiki/_layers/1-north-star.md',
    'wiki/_layers/8-workflow.md',
    'wiki/people/sam-davis.md',
    'CLAUDE.md',
    'notes/README.md',
  ]) {
    assert.doesNotThrow(() => VERBS['brain-read'].build({ page }), `must open ${page}`);
  }
});

test('107: widening for underscores does not open dotfiles or traversal', async () => {
  const { VERBS } = await import('./panel-server.mjs');
  for (const page of [
    '.git/config.md',
    'wiki/../../etc/passwd.md',
    '../secrets.md',
    '.claude-auth/creds.md',
    'wiki/.hidden/x.md',
  ]) {
    assert.throws(() => VERBS['brain-read'].build({ page }), `must refuse ${page}`);
  }
});

test('107: the Files tree walks wiki/, the same scope the graph walks', async () => {
  const { VERBS } = await import('./panel-server.mjs');
  const cmd = VERBS['brain-list'].build().command;
  assert.match(cmd, /notes decisions insights wiki/,
    'brain-list must include wiki/ or the tree lists 3 pages beside a graph of 12');
});

// ---------------------------------------------------------------------------
// WHICH MINERAL THE ACT LANDS ON (2026-08-16, the siblings of finding 152).
// A member hash names a PERSON and a tie kind names a TIER; neither names a
// mineral, and since finding 131 one person may hold two pebbles on one rock.
// The directory used to sort and act on the newest. Both callers here hold the
// slug already: /rock-ties gives the console one per tie row, /rock-mine gives
// the member's Rocks page one per row. They have to send it.
// Finding 131's slug plumbing (rock-tie-end and /rock-leave naming WHICH of a
// person's minerals a tie row belongs to) is RETIRED with the tie machinery
// (2026-09-01). The disambiguation problem itself is gone: a community
// relationship lives on the mineral that joined, so leaving is always about
// exactly the box the verb is run against.
test('the tie slug plumbing is RETIRED: leaving is box-local and needs no slug', () => {
  assert.equal(VERBS['rock-tie-end'], undefined, 'the tie ender stays gone');
  const c = MEMBER_VERBS['community-leave'].build({ org: 'acme' }).command;
  assert.match(c, /community-leave\.mjs/, 'leaving runs the box-local engine script');
  assert.ok(!c.includes('curl'), 'and dials nothing');
  assert.throws(() => MEMBER_VERBS['community-leave'].build({ org: 'Not A Handle' }), /org/i,
    'junk community names are refused before any command exists');
});
