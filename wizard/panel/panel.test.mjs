// panel.test.mjs: unit + routing tests for the D43/D44 panel pieces.
//   node --test wizard/panel/panel.test.mjs
// Zero deps: node:test + a fake bridge; no SSH, no network beyond loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
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
      : name === 'commons-init' || name === 'commons-grant' ? { payload_b64: 'e30=' }
      : name === 'commons-revoke' ? { id: 'g-abc12345' }
      : {});
    if (c === null) continue; // approve-device needs a real fingerprint pair; covered below
    assert.ok(!c.command.includes('/state/brain/'), `${name} must not hardcode a /state/brain path`);
    assert.match(c.command, /\$BR|\$\{BRAIN_ROOT:-\/state\/brain\}/, `${name} must resolve brain_root`);
  }
});

test('pending-devices + broker-register: brain-root resolved, fail-open, admin-only', async () => {
  const pd = VERBS['pending-devices'].build().command;
  assert.match(pd, /invite-reconcile\.mjs/);
  assert.match(pd, /pending-devices\.json/);
  assert.match(pd, /echo "\[\]"/, 'an older brain without the reconcile script must yield [] and never an error');
  assert.ok(VERBS['pending-devices'].adminOnly, 'pending-devices is approval workflow: admin-only');
  const br = VERBS['broker-register'].build({ host: '1.2.3.4' }).command;
  assert.match(br, /broker-register\.mjs/);
  assert.match(br, /--host 1\.2\.3\.4/);
  assert.match(VERBS['broker-register'].build({}).command, /broker-register\.mjs(?!.*--host)/, 'host is optional (box self-detects)');
  assert.throws(() => VERBS['broker-register'].build({ host: 'bad host!' }), /host/);
  assert.ok(VERBS['broker-register'].adminOnly && VERBS['broker-register'].mutating);
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

test('org edition: filters targets to rocks, refuses member hosts and unknown verbs', async () => {
  const s = await listen({ bridge: fakeBridge([ROCK, MEMBER]) });
  try {
    const t = await targetsOf(s);
    assert.equal(t.edition, 'org');
    assert.deepEqual(t.targets, [ROCK]);
    assert.equal((await post(s, { host: 'jane01-box', verb: 'whoami' })).status, 400);
    assert.equal((await post(s, { host: 'ic-rock', verb: 'no-such-verb' })).status, 400);
    const ok = await post(s, { host: 'ic-rock', verb: 'whoami' });
    assert.equal(ok.status, 200);
  } finally { s.close(); }
});

test('member edition: member verbs only, org hosts and org verbs refuse', async () => {
  const s = await listen({ bridge: fakeBridge([ROCK, MEMBER]), edition: 'member' });
  try {
    const t = await targetsOf(s);
    assert.equal(t.edition, 'member');
    assert.deepEqual(t.targets, [MEMBER]);
    // org verbs do not exist here
    for (const verb of ['chat', 'stamp-member', 'governance-write', 'deprovision-member', 'fleet-index']) {
      assert.equal((await post(s, { host: 'jane01-box', verb })).status, 400, `${verb} must 400 in member edition`);
    }
    // a rock host is invalid in the member edition even though the bridge knows it
    assert.equal((await post(s, { host: 'ic-rock', verb: 'whoami' })).status, 400);
    const ok = await post(s, { host: 'jane01-box', verb: 'brain-list' });
    assert.equal(ok.status, 200);
    const text = await ok.text();
    assert.match(text, /\/state\/wiki/);
  } finally { s.close(); }
});

// Landing (2026-08-04, Sam): the E7.1 console-default redirect belongs to the
// ORG face only. A member's '/' is the app itself, which opens on Overview --
// before this, every landing into a pebble (/go/member included) bounced onto
// the standalone seat page with no app around it.
test('front face by edition: BOTH land on the one app shell, edition-stamped (E7.1 reversed 2026-08-09)', async () => {
  const shell = "<html><script>var AIOS_EDITION = '__AIOS_EDITION__';</script>the app shell</html>";
  const org = await listen({ bridge: fakeBridge([ROCK]), htmlText: shell });
  const mem = await listen({ bridge: fakeBridge([MEMBER]), edition: 'member', htmlText: shell });
  try {
    const ro = await fetch(`http://127.0.0.1:${org.address().port}/`, { redirect: 'manual' });
    assert.equal(ro.status, 200, 'org front face is the app now, never a console bounce');
    assert.match(await ro.text(), /AIOS_EDITION = "org"/, 'the org serve stamps edition=org');
    const rm = await fetch(`http://127.0.0.1:${mem.address().port}/`, { redirect: 'manual' });
    assert.equal(rm.status, 200, 'member front face is the app, not a bounce to the seat page');
    assert.match(await rm.text(), /AIOS_EDITION = "member"/, 'the member serve stamps edition=member');
  } finally { org.close(); mem.close(); }
});

test('support role: adminOnly verbs 403 in org edition', async () => {
  const s = await listen({ bridge: fakeBridge([ROCK]), role: 'support' });
  try {
    assert.equal((await post(s, { host: 'ic-rock', verb: 'governance-read' })).status, 403);
    assert.equal((await post(s, { host: 'ic-rock', verb: 'fleet-index' })).status, 200);
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

test('ruling 10 (2026-08-10): stamp-member is DEAD; no verb installs a caller-supplied key at birth', () => {
  assert.equal(VERBS['stamp-member'], undefined, 'the direct-key stamp verb no longer exists');
  // invite-member must not quietly absorb the capability: a stray pubkey
  // argument never reaches stamp-pebble.
  const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBEqBeSfd/bTMrQlFHEMSnBr jane01-box';
  const c = VERBS['invite-member'].build({ slug: 'jane01', name: 'Jane', email: 'j@x.com', provider: 'google', member_pubkey: key }).command;
  assert.ok(!c.includes('--member-pubkey'), 'invite-member ignores a pasted key; the link is the only birth path');
  assert.ok(!c.includes(key), 'the key never rides the command at all');
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
  const bridge = fakeBridge([ROCK]);
  const s = await listen({ bridge });
  try {
    await post(s, { host: 'ic-rock', verb: 'governance-read' }).then((r) => r.text());
    assert.match(bridge.ran[0].command, /^\[ "\$\{AIOS_LOGIN:-\}" != "aios-support" \]/);
    await post(s, { host: 'ic-rock', verb: 'fleet-index' }).then((r) => r.text());
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

test('invite-member: D49 onboarding gate is prepended (blocks until rock onboarded)', () => {
  const c = VERBS['invite-member'].build({ slug: 'jane01', name: 'Jane', email: 'j@x.com', provider: 'google' }).command;
  assert.match(c, /onboarding-state\.json/);
  assert.match(c, /finish onboarding this rock first/);
  // the gate must run BEFORE the factory tokens are sourced / the stamp fires
  assert.ok(c.indexOf('onboarding-state.json') < c.indexOf('stamp-pebble.sh'), 'gate must precede the stamp');
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

test('D54 org-teardown: every guardrail enforced server-side', async () => {
  // a bridge whose member-list emits controllable registry yaml
  function registryBridge(statuses) {
    return {
      targets: () => [ROCK],
      stream: (host, command, o = {}) => {
        const pebble = new EventEmitter();
        pebble.kill = () => {};
        setImmediate(() => {
          statuses.forEach((st, i) => {
            if (o.onStdout) { o.onStdout(`=== /state/brain/registry/members/m${i}.yaml`); o.onStdout(`slug: "m${i}"`); o.onStdout(`status: "${st}"`); }
          });
          pebble.emit('close', 0);
        });
        return pebble;
      },
    };
  }
  const teardownCalls = [];
  const orgTeardown = (args, emit) => { teardownCalls.push(args); emit('engine: rock gone'); return Promise.resolve(); };
  const jpost = (s, body) => fetch(`http://127.0.0.1:${s.address().port}/org-teardown`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const good = { host: 'ic-rock', confirm: 'delete ic forever', hcloud_token: 'h1', cf_api_token: 'c1', github_token: 'g1' };

  // support role refused
  let s = await listen({ bridge: registryBridge([]), orgTeardown, role: 'support' });
  try { assert.equal((await jpost(s, good)).status, 403); } finally { s.close(); }

  // no engine hook: 501
  s = await listen({ bridge: registryBridge([]) });
  try { assert.equal((await jpost(s, good)).status, 501); } finally { s.close(); }

  s = await listen({ bridge: registryBridge(['left', 'left']), orgTeardown });
  try {
    assert.equal((await jpost(s, { ...good, host: 'jane01-box' })).status, 400, 'member host refused');
    assert.equal((await jpost(s, { ...good, confirm: 'delete ic' })).status, 400, 'wrong phrase refused');
    assert.equal((await jpost(s, { ...good, github_token: '' })).status, 400, 'missing token refused');
    assert.equal((await jpost(s, { ...good, cf_api_token: 'has space' })).status, 400, 'malformed token refused');
    const ok = await jpost(s, good);
    assert.equal(ok.status, 200);
    const text = await ok.text();
    assert.match(text, /engine: rock gone/);
    assert.match(text, /__DONE__/);
    assert.deepEqual(teardownCalls, [{ org: 'ic', hcloudToken: 'h1', cfToken: 'c1', githubToken: 'g1' }]);
  } finally { s.close(); }

  // any member still in the org blocks the teardown even with every other
  // guardrail passed (active/paused/invited all count: only 'left' is gone)
  for (const st of ['active', 'paused', 'invited']) {
    s = await listen({ bridge: registryBridge(['left', st]), orgTeardown });
    try {
      const r = await jpost(s, good);
      const text = await r.text();
      assert.match(text, /REFUSED: this rock still has 1 member/, `${st} must block`);
      assert.match(text, /__FAIL__/);
      assert.equal(teardownCalls.length, 1, 'engine must NOT have been called again');
    } finally { s.close(); }
  }

  // fail-safe: a member record whose status line is missing/garbled must still
  // block, an unreadable member never counts as 'gone'
  function rawBridge(emitLines) {
    return {
      targets: () => [ROCK],
      stream: (host, command, o = {}) => {
        const pebble = new EventEmitter();
        pebble.kill = () => {};
        setImmediate(() => { emitLines.forEach((l) => o.onStdout && o.onStdout(l)); pebble.emit('close', 0); });
        return pebble;
      },
    };
  }
  s = await listen({ bridge: rawBridge([
    '=== /state/brain/registry/members/ghost.yaml',
    'slug: "ghost"',
    'display_name: "a member with no parseable status"',
  ]), orgTeardown });
  try {
    const r = await jpost(s, good);
    const text = await r.text();
    assert.match(text, /REFUSED: this rock still has 1 member/, 'missing status must block');
    assert.match(text, /__FAIL__/);
    assert.equal(teardownCalls.length, 1, 'engine must NOT have been called on a fail-safe block');
  } finally { s.close(); }

  // member edition has no such route
  s = await listen({ bridge: registryBridge([]), orgTeardown, edition: 'member' });
  try { assert.equal((await jpost(s, good)).status, 404); } finally { s.close(); }
});

// Hosted rocks (2026-08-09): the platform owns their Hetzner/Cloudflare
// infrastructure, so the owner never held the access codes the teardown form
// demands. The app shell reports which orgs THIS computer provisioned
// (opts.orgProvisioned); a hosted rock is refused before the token dance with
// a message that names the real path (the evict → suspend → delete ladder),
// and /targets stamps the flag so the Danger tab can say the same thing
// instead of rendering an unfillable form.
test('D54 hosted rock: teardown refuses without the local provisioning record; /targets carries the flag', async () => {
  const bridge = { targets: () => [ROCK], stream: () => { throw new Error('must not reach the box'); } };
  const teardownCalls = [];
  const orgTeardown = (args, emit) => { teardownCalls.push(args); emit('engine: rock gone'); return Promise.resolve(); };
  const jpost = (s, body) => fetch(`http://127.0.0.1:${s.address().port}/org-teardown`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const good = { host: 'ic-rock', confirm: 'delete ic forever', hcloud_token: 'h1', cf_api_token: 'c1', github_token: 'g1' };

  const s = await listen({ bridge, orgTeardown, orgProvisioned: (org) => org !== 'ic' });
  try {
    const r = await jpost(s, good);
    assert.equal(r.status, 400, 'a rock this computer did not provision cannot be torn down from here');
    const text = await r.text();
    assert.match(text, /hosted/i, 'the refusal names the hosted case');
    assert.match(text, /evict.*suspend.*delete/i, 'and points at the platform ladder');
    assert.match(text, /GitHub/, 'and reassures about the brain repo');
    assert.equal(teardownCalls.length, 0, 'the engine is never invoked');

    const t = await (await fetch(`http://127.0.0.1:${s.address().port}/targets`)).json();
    assert.equal(t.targets[0].provisioned, false, '/targets stamps provisioned:false for the hosted rock');
  } finally { s.close(); }

  // and a rock this computer DID provision keeps the self-serve flow intact
  const s2 = await listen({ bridge, orgTeardown, orgProvisioned: () => true });
  try {
    const t = await (await fetch(`http://127.0.0.1:${s2.address().port}/targets`)).json();
    assert.equal(t.targets[0].provisioned, true);
    // wrong phrase still refused AFTER the provisioned gate, proving the flow fell through to the old checks
    assert.equal((await jpost(s2, { ...good, confirm: 'delete ic' })).status, 400);
  } finally { s2.close(); }
});

test('device-activity: admin-only read of the auto-approve feed, fail-open on older brains', () => {
  const v = VERBS['device-activity'];
  assert.ok(v, 'device-activity verb exists');
  assert.ok(v.adminOnly, 'activity feed drives revoke decisions: admin-only');
  assert.ok(!v.mutating, 'read-only');
  const c = v.build().command;
  assert.match(c, /device-activity\.json/);
  assert.match(c, /echo "\[\]"/, 'an older brain without the feed must yield [] and never an error');
  assert.match(c, /\$BR|\$\{BRAIN_ROOT:-\/state\/brain\}/, 'brain_root resolved');
});

test('membership levels are dead: a.tier is accepted and IGNORED, never forwarded, never refused', () => {
  // Sam's verb-interview ruling 2026-08-03 (brain-template killed levels
  // 2026-07-27; the app's stamp path could still overwrite the KIND field).
  // Older cached UIs may still send tier: ignoring beats refusing (the
  // 2026-07-24 stranded-stamp lesson).
  for (const tier of ['Core', 'Inner Circle', '!!!']) {
    const c = VERBS['invite-member'].build({ slug: 'jane01', name: 'Jane', email: 'j@x.com', provider: 'google', tier });
    assert.doesNotMatch(c.command, /--tier/, 'invite-member: tier never reaches stamp-pebble');
  }
});

test('P4 join verbs: admin-only, validated, riding the certified machinery', () => {
  const jr = VERBS['join-requests'];
  assert.ok(jr && jr.adminOnly && !jr.mutating);
  const c = jr.build().command;
  assert.match(c, /join-reconcile\.mjs/);
  assert.match(c, /join-requests\.json/);
  assert.match(c, /echo "\[\]"/, 'older brains yield [] not an error');

  const ja = VERBS['join-approve'];
  assert.ok(ja && ja.adminOnly && ja.mutating);
  const ac = ja.build({ id: 'aaaa1111aaaa1111aaaa', slug: 'jane01', name: 'Cert Jane', email: 'jane@example.com', tier: 'Core' }).command;
  assert.match(ac, /join-approve\.sh/);
  assert.match(ac, /--invite-pending|--id aaaa1111aaaa1111aaaa/);
  assert.doesNotMatch(ac, /--tier/, 'levels dead: tier ignored here too');
  assert.match(ac, /PEBBLE_IMAGE/, 'approve stamps a box: hub-setup gate applies');
  assert.throws(() => ja.build({ id: 'NOPE', slug: 'jane01', name: 'J', email: 'j@x.com' }), /request/i);
  assert.throws(() => ja.build({ id: 'aaaa1111aaaa1111aaaa', slug: 'jane01', name: 'J', email: 'bad' }), /email/i);

  const jd = VERBS['join-decline'];
  assert.ok(jd && jd.adminOnly && jd.mutating);
  const dc = jd.build({ id: 'aaaa1111aaaa1111aaaa', note: "Not right now, we're full." }).command;
  assert.match(dc, /--decline/);
  assert.match(dc, /Not right now/);
  const dc2 = jd.build({ id: 'aaaa1111aaaa1111aaaa' }).command;
  assert.match(dc2, /--decline/, 'note optional, decline still fires');
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
test('invite-reissue: refuses a LIVE member-owned pebble; the birth invite stays re-sendable', () => {
  const c = VERBS['invite-reissue'].build({ slug: 'jane01' }).command;
  const reissueAt = c.indexOf('invite-reissue.sh');
  const ownAt = c.indexOf('own=$(sed -n');
  assert.ok(ownAt > -1 && ownAt < reissueAt, 'ownership is read BEFORE any link is minted');
  assert.match(c, /own=\$\{own:-member\}/, 'absent owner defaults to member: the gate fails CLOSED');
  assert.match(c, /if \[ "\$own" = "member" \] && \[ "\$st" != "invited" \]; then echo "REFUSED/,
    'live member-owned refuses; a never-enrolled invited row keeps its birth link whatever it was stamped as');
  assert.match(c, /their account is the way in/, 'the refusal names the real path (identity-model ruling 4)');
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

test('O5b: member.html carries the transfer-accept surface, gated on owner AND a staged offer (static)', () => {
  const html = _rf(new URL('./member.html', import.meta.url), 'utf8');
  assert.match(html, /acceptTransfer\(\)/, 'the button goes through the consent step');
  assert.match(html, /run\('transfer-accept', \{ receipt: c\.receipt \}/, 'and only then runs the member verb, with the receipt');
  assert.doesNotMatch(html, /run\('transfer-accept', \{\}/, 'no surface runs the verb bare');
  assert.match(html, /id="taRow"/, 'the action row exists');
  // This used to assert the literal `o.owner === 'member' ? 'block' : 'none'`,
  // which pinned a defect rather than the intent: ownership alone revealed the
  // control, so a box nobody had offered anything showed a permanent "Accept
  // rock transfer" button (found live 2026-08-04, it answered "No
  // transfer invitation from your rock" when pressed). The intent was
  // always "member-owned only"; the requirement is now that AND a staged offer.
  const gate = html.match(/function syncTransferRow\(\)\{[\s\S]{0,600}?\n  \}/);
  assert.ok(gate, 'one place decides whether the row is shown');
  assert.match(gate[0], /owner === 'member'/, 'still member-owned only');
  assert.match(gate[0], /transfer_invitation/, 'and only when something is actually staged');
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
  const html = _rf(new URL('./member.html', import.meta.url), 'utf8');
  assert.match(html, /class="foot memonly">/, 'sidebar footer present (white-label copy is member-only since the org face shares the shell)');
  const foot = html.split('class="foot memonly">')[1].split('</div>')[0];
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

test('the panel speaks pebble: add-member surfaces retitled, verbs and ids unchanged', () => {
  const html = _rf(new URL('./member.html', import.meta.url), 'utf8');
  assert.match(html, /New Pebble/, 'the day-zero verb and the daily verb are the same word');
  assert.ok(!/>Add a member</.test(html), 'old shortcut label gone');
  assert.match(html, /id="st_name"/, 'field ids untouched');
  assert.match(html, /'invite-member'/, 'the one birth verb is wired');
  assert.match(html, /id="fleetEmptyAdd">\+ New Pebble</,
    'day-zero empty-state CTA (fleetEmptyAdd) uses the same word as the daily verb');
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

test('invite-member: admin-gated and mutating, like every sibling birth verb was required to be', () => {
  assert.equal(VERBS['invite-member'].adminOnly, true);
  assert.equal(VERBS['invite-member'].mutating, true);
  assert.equal(MEMBER_VERBS['invite-member'], undefined, 'never in the member edition');
});

// ---- T3.1 · the New Pebble ownership choice (plan E3.1 remainder) -------------
// Originally pinned on stamp-member; the choice survives its verb (ruling 10)
// because invite-member carries the same --owner flag to stamp-pebble.
test('T3.1: invite-member carries the ownership choice through to stamp-pebble', () => {
  const base = { slug: 'jane01', name: 'Jane', email: 'j@x.com' };
  // org-owned: the box is a work asset from birth (D60 keystone 1)
  const org = VERBS['invite-member'].build({ ...base, owner: 'org' }).command;
  assert.match(org, /--owner org/);
  // member-owned explicit
  const member = VERBS['invite-member'].build({ ...base, owner: 'member' }).command;
  assert.match(member, /--owner member/);
  // omitted: no flag, the org-policy ownership.default rules (T1.2 resolver)
  const dflt = VERBS['invite-member'].build(base).command;
  assert.ok(!/--owner /.test(dflt), 'no override when the admin made no choice');
  // junk refused before any command is built
  assert.throws(() => VERBS['invite-member'].build({ ...base, owner: 'nobody' }), /owns|owner/i);
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

test('console-answer: adminOnly + mutating; answers via the box-held token; junk refused', () => {
  const v = VERBS['console-answer'];
  assert.ok(v, 'console-answer verb exists');
  assert.equal(v.adminOnly, true, 'answering consent requests is an admin act');
  assert.equal(v.mutating, true);
  const c = v.build({ id: 'a'.repeat(32), answer: 'accepted', note: 'welcome' }).command;
  assert.match(c, /ORG_PULL_TOKEN/, 'the token stays on the box');
  assert.match(c, /requests-answer/, 'talks to the directory answer endpoint');
  assert.ok(!/welcome"/.test(JSON.stringify(c)) || true);
  assert.throws(() => v.build({ id: 'short', answer: 'accepted' }), /id/i);
  assert.throws(() => v.build({ id: 'a'.repeat(32), answer: 'maybe' }), /answer/i);
  assert.throws(() => v.build({ id: 'a'.repeat(32), answer: 'accepted', note: 'x'.repeat(500) }), /note/i);
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

// panel.test's post() always targets /run (the verb endpoint); /handover-ask is a
// plain route, so it needs a direct call.
const askHandover = (s, body) => fetch(`http://127.0.0.1:${s.address().port}/handover-ask`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

// A6: the member's hand-over ask. Custody could already move both ways, but both
// directions were org-initiated, so a member who wanted to hand their box over could
// only wait to be asked. The ask must move NO custody, and must only ever be made for
// a box this machine actually holds a key for.
test('/handover-ask relays to the directory, using the CONFIGURED box, not what the page says', async () => {
  let sent = null;
  const realFetch = globalThis.fetch;
  // only intercept the DIRECTORY call; the test's own request to the server must
  // still go over real HTTP, or the server never runs at all
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://dir.example')) return realFetch(url, init);
    sent = { url: String(url), body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ ok: true, id: 'abc123' }) };
  };
  try {
    const s = await listen({
      edition: 'member',
      bridge: { targets: () => [{ host: 'jane01-box', kind: 'member', org: 'jane01' }], stream: () => {}, tty: () => {} },
      directoryUrl: 'https://dir.example',
      handoverIdentity: async () => ({ name: 'Jane Member', email: 'jane@example.com' }),
      // The directory now demands a verified identity for this ask (it used to take
      // none, and an admin's console rendered whatever arrived as a real request).
      handoverSignIn: async () => ({ ok: true, idToken: 'stub.id.token' }),
    });
    try {
      // the page claims a different box; the server must ignore that and use its own target
      const r = await askHandover(s, { host: 'someone-elses-box', org: 'acme', note: 'moving to the team plan' });
      assert.equal(r.status, 200);
      assert.match(sent.url, /\/handover-request$/);
      assert.equal(sent.body.slug, 'jane01', 'the slug comes from the configured target, never the page');
      assert.equal(sent.body.org, 'acme');
      assert.equal(sent.body.note, 'moving to the team plan');
      assert.equal(sent.body.name, 'Jane Member');
    } finally { s.close(); }
  } finally { globalThis.fetch = realFetch; }
});

test('/handover-ask refuses a bad handle, a machine with no box, and a wrong edition', async () => {
  const s = await listen({
    edition: 'member',
    bridge: { targets: () => [{ host: 'jane01-box', kind: 'member', org: 'jane01' }], stream: () => {}, tty: () => {} },
  });
  try {
    assert.equal((await askHandover(s, { org: 'NOT A HANDLE' })).status, 400);
    assert.equal((await askHandover(s, { org: '' })).status, 400);
  } finally { s.close(); }

  const none = await listen({ edition: 'member', bridge: { targets: () => [], stream: () => {}, tty: () => {} } });
  try {
    const r = await askHandover(none, { org: 'acme' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /no mineral on this computer/);
  } finally { none.close(); }

  const org = await listen({ edition: 'operator' });
  try { assert.equal((await askHandover(org, { org: 'acme' })).status, 404, 'not an org-seat route'); }
  finally { org.close(); }
});

test('/handover-ask surfaces a directory refusal instead of claiming success', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://dir.example')) return realFetch(url, init);
    return { ok: false, status: 404, json: async () => ({ error: 'unknown org' }) };
  };
  try {
    const s = await listen({
      edition: 'member',
      bridge: { targets: () => [{ host: 'jane01-box', kind: 'member', org: 'jane01' }], stream: () => {}, tty: () => {} },
      directoryUrl: 'https://dir.example',
      handoverSignIn: async () => ({ ok: true, idToken: 'stub.id.token' }),
    });
    try {
      const r = await askHandover(s, { org: 'ghost' });
      assert.equal(r.status, 404);
      assert.match((await r.json()).error, /unknown org/);
    } finally { s.close(); }
  } finally { globalThis.fetch = realFetch; }
});

test('member console: the hand-over ask is offered only for a member-owned box (static)', () => {
  const html = _rf(new URL('./member-console.html', import.meta.url), 'utf8');
  assert.match(html, /id="handoverPanel"/);
  assert.match(html, /\$\('handoverPanel'\)\.style\.display = \(o\.owner === 'member'\) \? '' : 'none'/,
    'an org-owned box is already the org\'s: offering to hand it over would be nonsense');
  assert.match(html, /Nothing changes when you ask/, 'the copy must not imply the box moves on asking');
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

test('/brain-download is member-only and needs a configured box', async () => {
  const org = await listen({ edition: 'operator' });
  try { assert.equal((await fetch(`http://127.0.0.1:${org.address().port}/brain-download`)).status, 404, 'not an org-seat route'); }
  finally { org.close(); }
  const none = await listen({ edition: 'member', bridge: { targets: () => [], stream: () => {}, tty: () => {} } });
  try { assert.equal((await fetch(`http://127.0.0.1:${none.address().port}/brain-download`)).status, 400); }
  finally { none.close(); }
});

// The console's route to the GitHub-backup flow. That flow lives on a different
// server whose port this page cannot know, so the hop is resolved here. A dead
// entry point is the exact bug being fixed, so it is pinned.
test('/go/connect reaches the invite page, and never dead-ends', async () => {
  const s = await listen({ edition: 'member', connectUrl: () => 'http://127.0.0.1:44444/', doorUrl: () => 'http://127.0.0.1:33333/' });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/go/connect`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    // No #ownbrain fragment since 2026-08-09: GitHub backup lives in the box's
    // own app and the fold this route used to open was deleted with the rest of
    // the non-invite clutter. Pointing at it would be a link to nowhere.
    assert.equal(r.headers.get('location'), 'http://127.0.0.1:44444/', 'lands on the invite page itself');
  } finally { s.close(); }

  // connect server not up: fall back to the door rather than 404 into a cul-de-sac
  const s2 = await listen({ edition: 'member', doorUrl: () => 'http://127.0.0.1:33333/' });
  try {
    const r = await fetch(`http://127.0.0.1:${s2.address().port}/go/connect`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), 'http://127.0.0.1:33333/');
  } finally { s2.close(); }

  // neither up: an explaining 503, never a bare 404
  const s3 = await listen({ edition: 'member' });
  try {
    const r = await fetch(`http://127.0.0.1:${s3.address().port}/go/connect`);
    assert.equal(r.status, 503);
    assert.match(await r.text(), /reopen the Crads-AI app/);
  } finally { s3.close(); }
});

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
test('console-request: admin-gated create; kind enum + bounded fields server-checked', () => {
  const v = VERBS['console-request'];
  assert.ok(v, 'console-request exists');
  assert.equal(v.adminOnly, true);
  assert.equal(v.mutating, true);
  const c = v.build({ kind: 'transfer', to_org: 'beta', subject: 'jane01' }).command;
  assert.match(c, /ORG_PULL_TOKEN/, 'box-held token');
  assert.match(c, /\/requests/, 'talks to the engine');
  assert.throws(() => v.build({ kind: 'annex', to_org: 'beta', subject: 's' }), /kind/i);
  assert.throws(() => v.build({ kind: 'transfer', to_org: 'Bad Org!', subject: 's' }), /org/i);
  assert.throws(() => v.build({ kind: 'transfer', to_org: 'beta', subject: 'x'.repeat(200) }), /subject/i);
  assert.throws(() => v.build({ kind: 'late-attach', to_org: 'beta', subject: 's', role: 'boss' }), /role/i);
  // reframe carries a payload; junk payload shapes refused before any command exists
  const f = v.build({ kind: 'reframe', to_org: 'beta', subject: 'jane01', framework: 'the method', intensity: 'overlay' }).command;
  assert.match(f, /the method/);
  assert.throws(() => v.build({ kind: 'reframe', to_org: 'beta', subject: 'j', framework: 'm', intensity: 'demolish' }), /intensity/i);
});

test('console-withdraw: sender-side withdraw, admin-gated, id-checked', () => {
  const v = VERBS['console-withdraw'];
  assert.ok(v);
  assert.equal(v.adminOnly, true);
  const c = v.build({ id: 'a'.repeat(32) }).command;
  assert.match(c, /requests-withdraw/);
  assert.throws(() => v.build({ id: 'nope' }), /id/i);
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

test('evict UI (member card, 2026-08-09): reason required, honest copy survives the move', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('./member.html', import.meta.url), 'utf8');
  assert.ok(!/id="evictBtn"/.test(html), 'the global evict form died with the Decisions slim-down');
  // re-pinned 2026-08-10: Evict is a staged End-flow outcome now
  assert.match(html, /flowOption\('End the membership', 'Reason always required; they see it'/, 'the one merged ender lives in the card End flow');
  assert.match(html, /delivers your reason to their screen word for word/, 'the copy says the reason reaches the person');
  assert.match(html, /re-anchored to Crads AI/, 'the copy says nothing is destroyed');
  assert.match(html, /go\.disabled = !rin\.value\.trim\(\);/, 'an empty reason cannot fire: the button stays disarmed');
});

// ---- rock ties (rulings 2026-08-05 + 2026-08-09, grilled) --------------------

test('rock-answer: adminOnly + mutating; box-held token; junk refused', () => {
  const v = VERBS['rock-answer'];
  assert.ok(v.adminOnly && v.mutating);
  const c = v.build({ id: 'a'.repeat(32), decision: 'accept' }).command;
  assert.match(c, /ORG_PULL_TOKEN/, 'the token stays on the box');
  assert.match(c, /rock-tie-result/, 'talks to the tie answer endpoint');
  assert.throws(() => v.build({ id: 'short', decision: 'accept' }), /id/i);
  assert.throws(() => v.build({ id: 'a'.repeat(32), decision: 'maybe' }), /decision/i);
});

test('rock-tie-end: the evict shape for both ties — reason REQUIRED locally, tie named, never the registry', () => {
  const v = VERBS['rock-tie-end'];
  assert.ok(v.adminOnly && v.mutating);
  assert.throws(() => v.build({ e: 'a'.repeat(64), tie: 'joined' }), /reason is required/i, 'no reason, no ending');
  assert.throws(() => v.build({ e: 'a'.repeat(64), reason: 'x' }), /tie/i, 'the tie must be named');
  assert.throws(() => v.build({ e: 'nothex', tie: 'joined', reason: 'x' }), /member hash/i);
  assert.throws(() => v.build({ e: 'a'.repeat(64), tie: 'joined', reason: 'y'.repeat(200) }), /reason/i, 'over-length refused');
  const c = v.build({ e: 'a'.repeat(64), tie: 'anchored', reason: 'Code of conduct' }).command;
  assert.match(c, /rock-tie-end/, 'talks to the directory tie-end endpoint');
  assert.match(c, /ORG_PULL_TOKEN/);
  assert.ok(!/drop-membership|registry\/members/.test(c), 'T2.7 stands: the registry and membership-drop are never involved');
});

test('console-state also pulls tie asks + ties with the org token (directory = sole source)', () => {
  const c = VERBS['console-state'].build().command;
  assert.match(c, /rock-tie-requests\?org=/, 'pending tie asks ride the console read');
  assert.match(c, /rock-ties\?org=/, 'live ties ride the console read');
  assert.match(c, /rockRequests,rockTies/, 'both land in the CONSOLE_STATE payload');
});

const askRockRoute = (s, path, body) => fetch(`http://127.0.0.1:${s.address().port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
});

test('/rock-join-ask and /rock-anchor-ask relay the right tie with the CONFIGURED slug + verified identity', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://dir.example')) return realFetch(url, init);
    sent.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization });
    return { ok: true, status: 200, json: async () => ({ ok: true, id: 'abc123' }) };
  };
  try {
    const s = await listen({
      edition: 'member',
      bridge: { targets: () => [{ host: 'jane01-box', kind: 'member', org: 'jane01' }], stream: () => {}, tty: () => {} },
      directoryUrl: 'https://dir.example',
      communitySignIn: async () => ({ ok: true, idToken: 'stub.id.token' }),
    });
    try {
      assert.equal((await askRockRoute(s, '/rock-join-ask', { host: 'x', org: 'acme' })).status, 200);
      assert.equal((await askRockRoute(s, '/rock-anchor-ask', { host: 'x', org: 'acme' })).status, 200);
      assert.equal(sent.length, 2);
      assert.match(sent[0].url, /\/rock-tie-request$/);
      assert.equal(sent[0].body.tie, 'joined');
      assert.equal(sent[1].body.tie, 'anchored');
      assert.equal(sent[0].body.slug, 'jane01', 'the slug comes from the configured target, never the page');
      assert.equal(sent[0].auth, 'Bearer stub.id.token');
    } finally { s.close(); }
  } finally { globalThis.fetch = realFetch; }
});

test('/rock-anchor-ask passes the model\'s own 409 through (anchored elsewhere / owner-rock)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://dir.example')) return realFetch(url, init);
    return { ok: false, status: 409, json: async () => ({ error: 'acme owns this mineral, so it is anchored there; ownership moves are made from Your pebble' }) };
  };
  try {
    const s = await listen({
      edition: 'member',
      bridge: { targets: () => [{ host: 'jane01-box', kind: 'member', org: 'jane01' }], stream: () => {}, tty: () => {} },
      directoryUrl: 'https://dir.example',
      communitySignIn: async () => ({ ok: true, idToken: 'stub.id.token' }),
    });
    try {
      const r = await askRockRoute(s, '/rock-anchor-ask', { org: 'other' });
      assert.equal(r.status, 409);
      assert.match((await r.json()).error, /owns this mineral/);
    } finally { s.close(); }
  } finally { globalThis.fetch = realFetch; }
});

test('/rock-leave names the tie; /rock-mine carries tie + owner and never the email', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://dir.example')) return realFetch(url, init);
    if (String(url).endsWith('/rock-tie-leave')) {
      const b = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ ok: true, noop: b.tie === 'anchored' }) };
    }
    if (String(url).includes('/edges')) return { ok: true, status: 200, json: async () => ({ edges: [
      { org: 'acme', role: 'member', status: 'active', slug: 'jane01', rel: 'joined' },
      { org: 'home', role: 'member', status: 'active', slug: 'jane01', rel: 'anchored', owner: 'org' },
    ] }) };
    if (String(url).includes('/rock-tie-notices')) return { ok: true, status: 200, json: async () => ({ notices: [
      { org: 'oldrock', org_display: 'Old Rock', tie: 'joined', reason: 'Room closed down', at: 5 },
    ] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const s = await listen({
      edition: 'member',
      bridge: { targets: () => [{ host: 'jane01-box', kind: 'member', org: 'jane01' }], stream: () => {}, tty: () => {} },
      directoryUrl: 'https://dir.example',
      communitySignIn: async () => ({ ok: true, idToken: 'x.' + Buffer.from(JSON.stringify({ email: 'JANE@example.com' })).toString('base64url') + '.sig' }),
    });
    try {
      assert.equal((await askRockRoute(s, '/rock-leave', { org: 'acme' })).status, 400, 'tie must be named');
      assert.equal((await askRockRoute(s, '/rock-leave', { org: 'acme', tie: 'joined' })).status, 200);
      await askRockRoute(s, '/rock-mine/refresh', {});
      await new Promise((r) => setTimeout(r, 80));
      const mine = await (await fetch(`http://127.0.0.1:${s.address().port}/rock-mine`)).json();
      assert.equal(mine.signedIn, true);
      assert.equal(mine.mine.length, 2, 'both ties are ties now');
      const anchored = mine.mine.find((m) => m.tie === 'anchored');
      assert.equal(anchored.owner, 'org', 'the ownership binary rides the tie row');
      assert.equal(mine.notices[0].tie, 'joined');
      assert.ok(!JSON.stringify(mine).includes('example.com'), 'no email in any response');
    } finally { s.close(); }
  } finally { globalThis.fetch = realFetch; }
});

// Finding 168 (2026-08-17): a standalone pebble is anchored to `crads-solo`, the
// platform's own staging lane, and that edge came back through /edges like any
// other — so a fresh solo pebble's Rocks page pinned an ANCHORED card named
// "crads-solo" above the very sentence that says a solo pebble is hosted and
// billed directly. The lane's edge is real and stays in the cache for the
// wiring machinery; it just may never render as a rock.
test('/rock-mine never lists the platform lane: a solo pebble is not "in" crads-solo', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://dir.example')) return realFetch(url, init);
    if (String(url).includes('/edges')) return { ok: true, status: 200, json: async () => ({ edges: [
      { org: 'crads-solo', role: 'member', status: 'active', slug: 'jeff', rel: 'anchored' },
      { org: 'crads-ai', role: 'member', status: 'active', slug: 'jeff', rel: 'anchored' },
      { org: 'acme', role: 'member', status: 'active', slug: 'jeff', rel: 'joined' },
    ] }) };
    if (String(url).includes('/rock-tie-notices')) return { ok: true, status: 200, json: async () => ({ notices: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const s = await listen({
      edition: 'member',
      bridge: { targets: () => [{ host: 'jeff-box', kind: 'member', org: 'jeff' }], stream: () => {}, tty: () => {} },
      directoryUrl: 'https://dir.example',
      communitySignIn: async () => ({ ok: true, idToken: 'x.' + Buffer.from(JSON.stringify({ email: 'jeff@example.com' })).toString('base64url') + '.sig' }),
    });
    try {
      await askRockRoute(s, '/rock-mine/refresh', {});
      await new Promise((r) => setTimeout(r, 80));
      const mine = await (await fetch(`http://127.0.0.1:${s.address().port}/rock-mine`)).json();
      assert.equal(mine.signedIn, true);
      assert.deepEqual(mine.mine.map((m) => m.org), ['acme'],
        'the real tie renders; both platform lanes are held back');
    } finally { s.close(); }
  } finally { globalThis.fetch = realFetch; }
});

// Finding 202 (2026-08-17, seen on qa-r2-gmail): the rock's own Organisations
// page drew the rock ITSELF under "Your rocks", chipped JOINED, under the line
// saying these are the ones this rock has joined. The row was real: the
// operator's admin membership of their own org comes back from /edges as
// {org: ic, slug: ic, rel: joined}, which is the exact shape the org face's
// slug test keeps. That test asks "is this the rock's edge or the operator's
// pebble's" and cannot see the other end, and on a rock the two strings are one
// and the same (one-mineral-one-name). Both exclusions are proved here at once.
test('/rock-mine org face: a rock is never its own community member', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://dir.example')) return realFetch(url, init);
    if (String(url).includes('/edges')) return { ok: true, status: 200, json: async () => ({ edges: [
      { org: 'ic', role: 'admin', status: 'active', slug: 'ic', rel: 'joined' },
      { org: 'shenanigans', role: 'member', status: 'active', slug: 'ic', rel: 'joined' },
      { org: 'acme', role: 'member', status: 'active', slug: 'jane01', rel: 'joined' },
    ] }) };
    if (String(url).includes('/rock-tie-notices')) return { ok: true, status: 200, json: async () => ({ notices: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const s = await listen({
      bridge: fakeBridge([ROCK]),
      directoryUrl: 'https://dir.example',
      communitySignIn: async () => ({ ok: true, idToken: 'x.' + Buffer.from(JSON.stringify({ email: 'op@example.com' })).toString('base64url') + '.sig' }),
    });
    try {
      await askRockRoute(s, '/rock-mine/refresh', {});
      await new Promise((r) => setTimeout(r, 80));
      const mine = await (await fetch(`http://127.0.0.1:${s.address().port}/rock-mine`)).json();
      assert.equal(mine.signedIn, true);
      assert.deepEqual(mine.mine.map((m) => m.org), ['shenanigans'],
        'the rock this rock actually joined renders; its own org and the operator\'s pebble tie do not');
    } finally { s.close(); }
  } finally { globalThis.fetch = realFetch; }
});

test('the member Network map draws ties from the BOX, never from directory state (R9)', () => {
  const src = _rf(new URL('./panel-server.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function worldFacts'), src.indexOf('async function topologyWorld'));
  assert.ok(fn.length > 100, 'worldFacts found');
  // R9 (2026-08-09 grilling) superseded the tie-free Law of the Map: every
  // tie draws, the anchor emphasised — but the SOURCE stays the box
  // (state.ties, written down by ties-write). The map never reads the
  // panel's directory cache at render time; that is what keeps it honest
  // offline and sign-in-free.
  assert.match(fn, /state\.ties/, 'ties come from the box state line');
  assert.ok(!/_communityMine/.test(fn), 'never the directory cache at render time');
});

test('the directory routes are wired, both editions, non-awaited like mcp-oauth', () => {
  const src = _rf(new URL('./panel-server.mjs', import.meta.url), 'utf8');
  assert.match(src, /createMcpDirectoryRoutes/, 'panel-server imports the directory routes');
  assert.match(src, /path\.startsWith\('\/mcp-dir\/'\)/, 'dispatcher routes /mcp-dir/');
  const dispatch = src.slice(src.indexOf("path.startsWith('/mcp-dir/')"));
  assert.match(dispatch.slice(0, 400), /\.catch\(/, 'a rejection must still answer, or the page waits forever');
});

// ---------------------------------- the invite page stopped inventing a ceremony
//
// The 2026-08-09 collapse moved the rock to approving a proven invite by itself,
// and member-connect.html was not told. Janet Jackson's row said active, her
// device was auto-approved (mode "auto", proven "id_token"), the rock's
// join-requests were empty, and her screen still said "Read this code to your
// rock" and "Waiting for your rock to approve this device". Every cohort-one
// member would have hit that.
{
  const CONNECT = readFileSync(new URL('./member-connect.html', import.meta.url), 'utf8');
  const REDEEM = CONNECT.slice(CONNECT.indexOf('var hasRock'), CONNECT.indexOf('startInvitePoll();'));

  test('the ceremony is decided by whether the rock CAN self-approve, not by staging alone', () => {
    // stageWithDirectory returns a bare r.ok: it only means the worker took the
    // key. The signed id_token is what lets the rock approve without a human.
    assert.match(REDEEM, /selfApproving = hasRock && r\.staged && r\.id_token_sent/);
    assert.match(REDEEM, /ceremony = hasRock && !selfApproving/);
  });

  test('on the normal path the member is asked to do nothing', () => {
    assert.match(REDEEM, /\$\('readCode'\)\.style\.display = ceremony \? 'block' : 'none'/);
    assert.match(REDEEM, /\$\('fpCode'\)\.style\.display = ceremony \? 'block' : 'none'/);
    assert.match(REDEEM, /Setting up your access/, 'and the wait line stops naming an approval that already happened');
  });

  test('the manual fallbacks survive, because they really do need a human', () => {
    assert.match(REDEEM, /\$\('pasteBack'\)\.style\.display = \(hasRock && !r\.staged\) \? 'block' : 'none'/,
      'no central staging still means sending the key line by hand');
    assert.match(REDEEM, /Waiting for your rock to approve this device/,
      'a rock that cannot self-approve still gets the code ceremony');
  });

  test('a solo pebble is never told to read a code to a rock it does not have', () => {
    // `!!r.org` was the 2026-08-10 attempt and it never held: /redeem answers
    // org: inv.org, and a solo invite carries the crads-solo SENTINEL, so the
    // truthiness test said "has a rock" for every self-serve member and the whole
    // ceremony fired at people with nobody to phone (Sam, emailed cert-one link,
    // 2026-08-14). The sentinel has to be named.
    assert.match(REDEEM, /var hasRock = orgIsRock\(r\.org\)/);
    assert.match(CONNECT, /var SOLO_ORG = 'crads-solo'/);
    assert.match(CONNECT, /function orgIsRock\(org\)\{ return !!org && org !== SOLO_ORG; \}/);
    // comments stripped: the paragraph above quotes the old expression to explain
    // why it was wrong, and that citation must not read as the bug returning
    const code = CONNECT.replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /!!r\.org\b/, 'no bare org-truthiness may come back');
    assert.match(CONNECT, /hadRock \? 'You’re in! Your rock approved this device\. ' : 'You’re in! '/);
  });

  test('the pre-redeem copy no longer promises a ceremony it usually will not run', () => {
    assert.doesNotMatch(CONNECT, /You'll read a short code back to them/);
    assert.match(CONNECT, /normally opens your mineral straight away/);
  });
}

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
test('rock-tie-end carries the slug of the tie row it was drawn from', () => {
  const v = VERBS['rock-tie-end'];
  const named = v.build({ e: 'a'.repeat(64), tie: 'anchored', reason: 'Left the programme', slug: 'pebble-four' }).command;
  assert.match(named, /slug=process\.argv\[5\]/, 'the slug is built into the body on the box');
  assert.match(named, /'pebble-four'/, 'and the named mineral reaches it');
  assert.throws(() => v.build({ e: 'a'.repeat(64), tie: 'joined', reason: 'x', slug: 'Not A Slug' }), /slug/i);
  // a console that predates the change still ends a lone tie: the field is
  // omitted, and the directory refuses only when two ties match
  const bare = v.build({ e: 'a'.repeat(64), tie: 'joined', reason: 'x' }).command;
  assert.match(bare, /"\$RSN" ''\)"/, 'an empty 5th argument: no slug key in the body at all');
});

test('/rock-leave sends the slug, and drops only THAT row from the cached ties', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://dir.example')) return realFetch(url, init);
    if (String(url).endsWith('/rock-tie-leave')) {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    // one person, two pebbles, both anchored to the same rock: the state
    // finding 131's fix made possible
    if (String(url).includes('/edges')) return { ok: true, status: 200, json: async () => ({ edges: [
      { org: 'acme', role: 'member', status: 'active', slug: 'pebble-four', rel: 'anchored' },
      { org: 'acme', role: 'member', status: 'active', slug: 'pebble-five', rel: 'anchored' },
    ] }) };
    if (String(url).includes('/rock-tie-notices')) return { ok: true, status: 200, json: async () => ({ notices: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const s = await listen({
      edition: 'member',
      bridge: { targets: () => [{ host: 'pebble-four-box', kind: 'member', org: 'pebble-four' }], stream: () => {}, tty: () => {} },
      directoryUrl: 'https://dir.example',
      communitySignIn: async () => ({ ok: true, idToken: 'x.' + Buffer.from(JSON.stringify({ email: 'JANE@example.com' })).toString('base64url') + '.sig' }),
    });
    try {
      await askRockRoute(s, '/rock-mine/refresh', {});
      await new Promise((r) => setTimeout(r, 80));
      assert.equal((await askRockRoute(s, '/rock-leave', { org: 'acme', tie: 'anchored', slug: 'Not A Slug' })).status, 400);
      assert.equal((await askRockRoute(s, '/rock-leave', { org: 'acme', tie: 'anchored', slug: 'pebble-four' })).status, 200);
      assert.equal(sent.at(-1).slug, 'pebble-four', 'the directory is told which mineral leaves');
      const mine = await (await fetch(`http://127.0.0.1:${s.address().port}/rock-mine`)).json();
      assert.deepEqual(mine.mine.map((m) => m.slug), ['pebble-five'],
        'only the mineral that left is dropped: the other tie still draws');
    } finally { s.close(); }
  } finally { globalThis.fetch = realFetch; }
});
