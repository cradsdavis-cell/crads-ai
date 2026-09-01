// joined-rock-heartbeat.test.mjs: panel iteration 2 R9 (2026-08-23), the box
// side of "one heartbeat repo per joined rock". heartbeat-push.sh pushes to the
// legacy anchor conf PLUS every /state/heartbeat.d/<rock>.conf; org-sync.sh
// installs and removes a joined rock's conf + key from its inbox.
//   node --test engine/box/joined-rock-heartbeat.test.mjs
//
// Both scripts run in real bash against a temp state dir with a fake `git` on
// PATH (a shell stub that logs its argv and fakes the clone), so what is pinned
// is which remotes get pushed with which keys, not a regex over the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PUSH = path.join(HERE, 'heartbeat-push.sh');
const SYNC = path.join(HERE, 'org-sync.sh');

// The git stub. Every invocation appends one line of argv to $GIT_LOG plus the
// GIT_SSH_COMMAND it ran under (that is where the key shows). `clone` makes a
// fake working tree (a .git dir, so the next run takes the pull branch);
// `status --porcelain` reports a change whenever heartbeat.json exists; any
// remote whose URL contains "refuse" fails clone and push, like a revoked key.
const GIT_STUB = `#!/usr/bin/env bash
printf '%s\\t%s\\n' "\${GIT_SSH_COMMAND:-}" "$*" >> "$GIT_LOG"
args=("$@"); dir=""
if [ "\${args[0]}" = -C ]; then dir="\${args[1]}"; args=("\${args[@]:2}"); fi
while [ "\${args[0]}" = -c ]; do args=("\${args[@]:2}"); done
case "\${args[0]}" in
  clone) url="\${args[@]: -2:1}"; dest="\${args[@]: -1}"; case "$url" in *refuse*) exit 128;; esac; mkdir -p "$dest/.git"; echo "$url" > "$dest/.git/url"; exit 0;;
  push) case "$(cat "$dir/.git/url" 2>/dev/null)" in *refuse*) exit 1;; esac; exit 0;;
  status) [ -f "$dir/heartbeat.json" ] && echo " M heartbeat.json"; exit 0;;
  *) exit 0;;
esac
`;

function rig() {
  const root = tmpDir('r9hb-');
  const state = path.join(root, 'state');
  const bin = path.join(root, 'bin');
  mkdirSync(path.join(state, 'cockpit'), { recursive: true });
  mkdirSync(path.join(state, 'secrets'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'git'), GIT_STUB, { mode: 0o755 });
  const gitLog = path.join(root, 'git.log');
  const run = (script, args = []) => {
    let out = '', code = 0;
    try {
      out = execFileSync('bash', [script, ...args], {
        encoding: 'utf8', cwd: root,
        // AIOS_DIR: 2026-08-25 task 3 moved seed_pages()'s page-copy logic out
        // to engine/appshell/seed-org-pages.mjs, which org-sync.sh locates via
        // ${AIOS_DIR:-/app}/engine/... (it cannot use a path relative to
        // itself, because in production it runs from a boot-time COPY at
        // $BOX/org-sync.sh, not from its engine/box/ source location). A real
        // box has the full engine tree at /app; here, the repo checkout
        // stands in for it.
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STATE_DIR: state, GIT_LOG: gitLog, AIOS_DIR: path.join(HERE, '..', '..') },
      });
    } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); code = e.status; }
    return { out, code };
  };
  const log = () => (existsSync(gitLog) ? readFileSync(gitLog, 'utf8').trim().split('\n').filter(Boolean) : []);
  const pushes = () => log().filter((l) => /\spush /.test(l));
  const clones = () => log().filter((l) => /\tclone /.test(l));
  const w = (rel, body, mode) => { const p = path.join(state, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, body, mode ? { mode } : undefined); };
  return { root, state, run, log, pushes, clones, w, done: () => rmSync(root, { recursive: true, force: true }) };
}

const PRIV = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAfake\n-----END OPENSSH PRIVATE KEY-----\n';

// ---- heartbeat-push.sh ---------------------------------------------------------

test('heartbeat-push: no conf at all is a clean exit 0 with no git call', () => {
  const r = rig();
  try {
    r.w('cockpit/heartbeat.json', '{}\n');
    const { code, out } = r.run(PUSH);
    assert.equal(code, 0, out);
    assert.deepEqual(r.log(), []);
  } finally { r.done(); }
});

test('heartbeat-push: the anchor conf plus two joined-rock confs push three times, each with its own key and URL', () => {
  const r = rig();
  try {
    r.w('cockpit/heartbeat.json', '{"ok":true}\n');
    r.w('heartbeat.conf', 'ORG_GH_OWNER=anchor-org\nSLUG=alice\n');
    r.w('secrets/heartbeat_deploy_key', PRIV, 0o600);
    r.w('heartbeat.d/rock-one.conf', 'ORG_GH_OWNER=rock-one\nSLUG=alice\n');
    r.w('secrets/heartbeat_deploy_key.rock-one', PRIV, 0o600);
    // a conf may name its key and its remote explicitly
    r.w('heartbeat.d/rock-two.conf', `ORG_GH_OWNER=rock-two\nSLUG=alice\nKEY=${r.state}/secrets/custom.key\nHEARTBEAT_REMOTE_URL=ssh://git@github.com/rock-two/hb-custom.git\n`);
    r.w('secrets/custom.key', PRIV, 0o600);
    const { code, out } = r.run(PUSH);
    assert.equal(code, 0, out);
    assert.match(out, /anchor: pushed\./);
    assert.match(out, /rock-one: pushed\./);
    assert.match(out, /rock-two: pushed\./);
    const clones = r.clones();
    assert.equal(clones.length, 3, clones.join('\n'));
    const byUrl = Object.fromEntries(clones.map((l) => { const [ssh, argv] = l.split('\t'); const url = argv.split(' ').at(-2); return [url, { ssh, dest: argv.split(' ').at(-1) }]; }));
    assert.equal(byUrl['ssh://git@github.com/anchor-org/heartbeat-alice.git'].ssh, `ssh -i ${r.state}/secrets/heartbeat_deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`);
    assert.equal(byUrl['ssh://git@github.com/anchor-org/heartbeat-alice.git'].dest, `${r.state}/.heartbeat-out/anchor`);
    assert.equal(byUrl['ssh://git@github.com/rock-one/heartbeat-alice.git'].ssh, `ssh -i ${r.state}/secrets/heartbeat_deploy_key.rock-one -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`);
    assert.equal(byUrl['ssh://git@github.com/rock-one/heartbeat-alice.git'].dest, `${r.state}/.heartbeat-out/rock-one`);
    assert.equal(byUrl['ssh://git@github.com/rock-two/hb-custom.git'].ssh, `ssh -i ${r.state}/secrets/custom.key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`);
    assert.equal(r.pushes().length, 3);
    // the same filtered file landed in every working clone
    for (const d of ['anchor', 'rock-one', 'rock-two']) assert.equal(readFileSync(path.join(r.state, '.heartbeat-out', d, 'heartbeat.json'), 'utf8'), '{"ok":true}\n');
    assert.match(readFileSync(path.join(r.state, '.gitignore'), 'utf8'), /^\.heartbeat-out\/$/m);
  } finally { r.done(); }
});

test('heartbeat-push: a rock that refuses the clone does not stop the others, and the run still exits 0', () => {
  const r = rig();
  try {
    r.w('cockpit/heartbeat.json', '{}\n');
    r.w('heartbeat.d/aaa-refuse.conf', 'ORG_GH_OWNER=aaa-refuse\nSLUG=alice\n');   // sorts first, fails first
    r.w('secrets/heartbeat_deploy_key.aaa-refuse', PRIV, 0o600);
    r.w('heartbeat.d/zzz-good.conf', 'ORG_GH_OWNER=zzz-good\nSLUG=alice\n');
    r.w('secrets/heartbeat_deploy_key.zzz-good', PRIV, 0o600);
    const { code, out } = r.run(PUSH);
    assert.equal(code, 0, out);
    assert.match(out, /aaa-refuse: clone denied/);
    assert.match(out, /zzz-good: pushed\./);
    assert.match(out, /1 rock\(s\) fine, 1 refused\./);
    assert.equal(r.pushes().length, 1);
    assert.match(r.pushes()[0], /heartbeat_deploy_key\.zzz-good/);
  } finally { r.done(); }
});

test('heartbeat-push: a joined conf with no key yet is skipped quietly; a second run reuses the clone', () => {
  const r = rig();
  try {
    r.w('cockpit/heartbeat.json', '{}\n');
    r.w('heartbeat.d/rock-one.conf', 'ORG_GH_OWNER=rock-one\nSLUG=alice\n');
    let res = r.run(PUSH);
    assert.equal(res.code, 0);
    assert.match(res.out, /rock-one: no write key/);
    assert.deepEqual(r.log(), []);
    r.w('secrets/heartbeat_deploy_key.rock-one', PRIV, 0o600);
    res = r.run(PUSH); assert.match(res.out, /rock-one: pushed/);
    res = r.run(PUSH); assert.match(res.out, /rock-one: pushed/);
    assert.equal(r.clones().length, 1, 'cloned once, pulled after');
    assert.equal(r.log().filter((l) => /\spull /.test(l)).length, 1);
  } finally { r.done(); }
});

test('heartbeat-push: a pre-R9 box with its clone AT .heartbeat-out is migrated under .heartbeat-out/anchor', () => {
  const r = rig();
  try {
    r.w('cockpit/heartbeat.json', '{}\n');
    r.w('heartbeat.conf', 'ORG_GH_OWNER=anchor-org\nSLUG=alice\n');
    r.w('secrets/heartbeat_deploy_key', PRIV, 0o600);
    r.w('.heartbeat-out/.git/HEAD', 'ref: refs/heads/main\n');
    r.w('.heartbeat-out/heartbeat.json', 'old\n');
    const { code, out } = r.run(PUSH);
    assert.equal(code, 0, out);
    assert.equal(r.clones().length, 0, 'no re-clone');
    assert.ok(existsSync(path.join(r.state, '.heartbeat-out', 'anchor', '.git', 'HEAD')));
    assert.ok(!existsSync(path.join(r.state, '.heartbeat-out', '.git')));
    assert.match(out, /anchor: pushed/);
  } finally { r.done(); }
});

test('heartbeat-push: a joined conf that resolves to the anchor repo pushes once, not twice', () => {
  const r = rig();
  try {
    r.w('cockpit/heartbeat.json', '{}\n');
    r.w('heartbeat.conf', 'ORG_GH_OWNER=same-org\nSLUG=alice\n');
    r.w('secrets/heartbeat_deploy_key', PRIV, 0o600);
    r.w('heartbeat.d/same-org.conf', 'ORG_GH_OWNER=same-org\nSLUG=alice\n');
    r.w('secrets/heartbeat_deploy_key.same-org', PRIV, 0o600);
    const { out } = r.run(PUSH);
    assert.match(out, /same-org: same repo as an earlier conf; skipping/);
    assert.equal(r.pushes().length, 1);
  } finally { r.done(); }
});

// ---- org-sync.sh delivery leg ----------------------------------------------------

// A box joined to rock-one: org-inbox.conf names it, and the inbox is a fixture
// directory that already looks like a clone (a .git dir makes org-sync take
// the pull branch, which the stub accepts).
function joined(r, inboxFiles, status = 'active') {
  r.w('org-inbox.conf', 'ORG_GH_OWNER=rock-one\nSLUG=alice\n');
  r.w('secrets/org_inbox_deploy_key', PRIV, 0o600);
  r.w('org-inbox/.git/HEAD', 'ref: refs/heads/main\n');
  r.w('org-inbox/MEMBERSHIP.yaml', `status: ${status}\n`);
  for (const [f, body] of Object.entries(inboxFiles)) r.w(path.join('org-inbox', f), body);
}
const CONF = 'ORG_GH_OWNER=rock-one\nSLUG=alice\n';

test('org-sync: heartbeat/conf + heartbeat/deploy_key in the inbox install heartbeat.d/<rock>.conf and a 0600 key, idempotently', () => {
  const r = rig();
  try {
    joined(r, { 'heartbeat/conf': CONF, 'heartbeat/deploy_key': PRIV });
    let res = r.run(SYNC);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /status pipe to rock-one: conf installed/);
    assert.match(res.out, /status pipe to rock-one: key installed/);
    const conf = path.join(r.state, 'heartbeat.d', 'rock-one.conf');
    const key = path.join(r.state, 'secrets', 'heartbeat_deploy_key.rock-one');
    assert.equal(readFileSync(conf, 'utf8'), 'ORG_GH_OWNER=rock-one\nSLUG=alice\n');
    assert.equal(readFileSync(key, 'utf8'), PRIV);
    assert.equal(statSync(key).mode & 0o777, 0o600);
    const m1 = statSync(key).mtimeMs;
    res = r.run(SYNC);
    assert.doesNotMatch(res.out, /installed/, 'second run writes nothing');
    assert.equal(statSync(key).mtimeMs, m1);
    // a rotated key is picked up
    r.w('org-inbox/heartbeat/deploy_key', PRIV.replace('fake', 'rotated'));
    res = r.run(SYNC);
    assert.match(res.out, /key installed/);
    assert.match(readFileSync(key, 'utf8'), /rotated/);
    // and the push leg now reaches the joined rock with that conf
    r.w('cockpit/heartbeat.json', '{}\n');
    res = r.run(PUSH);
    assert.match(res.out, /rock-one: pushed/);
    assert.match(r.clones()[0], /heartbeat_deploy_key\.rock-one.*ssh:\/\/git@github\.com\/rock-one\/heartbeat-alice\.git/);
  } finally { r.done(); }
});

test('org-sync: the delivered conf is never sourced; only the three known vars survive, and HEARTBEAT_REMOTE_URL is kept', () => {
  const r = rig();
  try {
    joined(r, {
      'heartbeat/conf': 'ORG_GH_OWNER="rock-one"\nSLUG=alice\nHEARTBEAT_REMOTE_URL=ssh://git@github.com/rock-one/hb-alt.git\nKEY=/etc/passwd\nrm -rf /\n$(touch /tmp/pwned)\n',
      'heartbeat/deploy_key': PRIV,
    });
    const res = r.run(SYNC);
    assert.equal(res.code, 0, res.out);
    const conf = readFileSync(path.join(r.state, 'heartbeat.d', 'rock-one.conf'), 'utf8');
    assert.equal(conf, 'ORG_GH_OWNER=rock-one\nSLUG=alice\nHEARTBEAT_REMOTE_URL=ssh://git@github.com/rock-one/hb-alt.git\n');
  } finally { r.done(); }
});

test('org-sync: a conf naming another owner than the inbox, or a non-key, is refused and nothing is written', () => {
  const r = rig();
  try {
    joined(r, { 'heartbeat/conf': 'ORG_GH_OWNER=someone-else\nSLUG=alice\n', 'heartbeat/deploy_key': PRIV });
    let res = r.run(SYNC);
    assert.match(res.out, /refused \(a rock can only open a pipe to itself\)/);
    assert.ok(!existsSync(path.join(r.state, 'heartbeat.d')));
    assert.ok(!existsSync(path.join(r.state, 'secrets', 'heartbeat_deploy_key.someone-else')));
    r.w('org-inbox/heartbeat/conf', CONF);
    r.w('org-inbox/heartbeat/deploy_key', 'not a key\n');
    res = r.run(SYNC);
    assert.match(res.out, /is not a private key; refused/);
    assert.ok(!existsSync(path.join(r.state, 'secrets', 'heartbeat_deploy_key.rock-one')));
  } finally { r.done(); }
});

test('org-sync: a membership that is no longer active removes the conf, the key and the working clone; content stays', () => {
  const r = rig();
  try {
    joined(r, { 'heartbeat/conf': CONF, 'heartbeat/deploy_key': PRIV });
    r.run(SYNC);
    r.w('.heartbeat-out/rock-one/.git/HEAD', 'x\n');
    r.w('.claude/skills/from-rock/SKILL.md', '# kept\n');
    r.w('org-inbox/MEMBERSHIP.yaml', 'status: paused\n');
    const res = r.run(SYNC);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /status pipe to rock-one removed \(membership is 'paused'\)/);
    assert.ok(!existsSync(path.join(r.state, 'heartbeat.d', 'rock-one.conf')));
    assert.ok(!existsSync(path.join(r.state, 'secrets', 'heartbeat_deploy_key.rock-one')));
    assert.ok(!existsSync(path.join(r.state, '.heartbeat-out', 'rock-one')));
    assert.ok(existsSync(path.join(r.state, '.claude', 'skills', 'from-rock', 'SKILL.md')), 'never delete content');
    assert.ok(existsSync(path.join(r.state, 'org-inbox', 'heartbeat', 'conf')), 'the inbox mirror is untouched');
    // the push leg now has nothing for that rock
    r.w('cockpit/heartbeat.json', '{}\n');
    assert.equal(r.run(PUSH).code, 0);
    assert.equal(r.pushes().length, 0);
  } finally { r.done(); }
});

test('org-sync: an inbox with no heartbeat/ directory changes nothing on an active box', () => {
  const r = rig();
  try {
    joined(r, {});
    const res = r.run(SYNC);
    assert.equal(res.code, 0, res.out);
    assert.doesNotMatch(res.out, /status pipe/);
    assert.ok(!existsSync(path.join(r.state, 'heartbeat.d')));
  } finally { r.done(); }
});

// ---- the anchor detach leaves joined confs alone ----------------------------------

test('unanchorCmd is RETIRED (2026-09-01): the app-side detach died with the tie routes', async () => {
  // The face collapse deleted /rock-tie-downgrade and the promote flow, and
  // unanchorCmd with them: nothing app-side detaches an anchor any more,
  // because nothing central can hold one. The box-side leave/evict scripts
  // below are the only detach paths left, and they carry the file-scoping
  // rules this test used to pin on the app copy too.
  const panel = await import('../../wizard/panel/panel-server.mjs');
  assert.equal(panel.unanchorCmd, undefined, 'the export stays gone');
});

// ---- 2026-08-23: the box CLAIMS its joined ties (multi-tie channel) ---------------
// tie-claim.mjs writes /state/org-inbox.d/<owner>.conf + the per-rock read key.
// org-sync.sh pulls that inbox into /state/org-inbox.d/<owner>/ under the same
// membership gate and never-delete rule as the anchor's, and the heartbeat
// delivery leg applies per inbox.

/** What tie-claim leaves for a joined rock (the box minted its own keys). */
function claimed(r, owner, org, slug = 'alice', { status = 'active', inbox = {} } = {}) {
  r.w(`org-inbox.d/${owner}.conf`, `ORG_GH_OWNER=${owner}\nSLUG=${slug}\nORG=${org}\n`);
  r.w(`secrets/org_inbox_deploy_key.${owner}`, PRIV, 0o600);
  r.w(`secrets/org_inbox_deploy_key.${owner}.pub`, 'ssh-ed25519 AAAA inbox\n');
  r.w(`heartbeat.d/${owner}.conf`, `ORG_GH_OWNER=${owner}\nSLUG=${slug}\nKEY=${path.join(r.state, 'secrets', `heartbeat_deploy_key.${owner}`)}\n`);
  r.w(`secrets/heartbeat_deploy_key.${owner}`, PRIV, 0o600);
  r.w(`secrets/heartbeat_deploy_key.${owner}.pub`, 'ssh-ed25519 AAAA heartbeat\n');
  if (status !== 'clone') {
    r.w(`org-inbox.d/${owner}/.git/HEAD`, 'ref: refs/heads/main\n');
    r.w(`org-inbox.d/${owner}/MEMBERSHIP.yaml`, `status: ${status}\n`);
  }
  for (const [f, body] of Object.entries(inbox)) r.w(path.join('org-inbox.d', owner, f), body);
}

test('org-sync: a box with NO anchor still pulls every joined inbox with its own key, and gitignores them', () => {
  const r = rig();
  try {
    claimed(r, 'guild-gh', 'guild', 'alice', { status: 'clone' });
    claimed(r, 'tides-gh', 'tides', 'alice', { status: 'clone' });
    const { code, out } = r.run(SYNC);
    assert.equal(code, 0, out);
    assert.match(out, /guild-gh: synced/);
    assert.match(out, /tides-gh: synced/);
    assert.match(out, /no org-inbox.conf; not an org-managed box/, 'the anchor leg still reports as before');
    const cl = r.clones();
    assert.equal(cl.length, 2);
    assert.match(cl[0], /org_inbox_deploy_key\.guild-gh.*ssh:\/\/git@github\.com\/guild-gh\/inbox-alice\.git/);
    assert.match(cl[1], /org_inbox_deploy_key\.tides-gh.*ssh:\/\/git@github\.com\/tides-gh\/inbox-alice\.git/);
    assert.ok(existsSync(path.join(r.state, 'org-inbox.d', 'guild-gh', '.git')));
    const gi = readFileSync(path.join(r.state, '.gitignore'), 'utf8').split('\n');
    assert.ok(gi.includes('org-inbox.d/'), 'joined inboxes stay out of the member brain');
  } finally { r.done(); }
});

test('org-sync: the anchor AND a joined rock both sync; a refused joined clone never stops the anchor', () => {
  const r = rig();
  try {
    joined(r, {});
    claimed(r, 'refuse-gh', 'refuse', 'alice', { status: 'clone' });
    claimed(r, 'guild-gh', 'guild', 'alice', { status: 'clone' });
    const { code, out } = r.run(SYNC);
    assert.equal(code, 0, out);
    assert.match(out, /refuse-gh: clone denied/);
    assert.match(out, /guild-gh: synced/);
    assert.match(out, /\[org-sync\] synced\./, 'the anchor leg still ran');
    assert.ok(!existsSync(path.join(r.state, 'org-inbox.d', 'refuse-gh', '.git')));
  } finally { r.done(); }
});

test('org-sync: a joined inbox with a claimed (box-minted) heartbeat key is not overwritten by a delivered one; a non-active membership removes the pipe but keeps the inbox and content', () => {
  const r = rig();
  try {
    claimed(r, 'guild-gh', 'guild', 'alice', { inbox: { 'heartbeat/conf': 'ORG_GH_OWNER=guild-gh\nSLUG=alice\n', 'heartbeat/deploy_key': PRIV.replace('fake', 'delivered') } });
    const hbConf = path.join(r.state, 'heartbeat.d', 'guild-gh.conf');
    const hbKey = path.join(r.state, 'secrets', 'heartbeat_deploy_key.guild-gh');
    const confBefore = readFileSync(hbConf, 'utf8');
    let res = r.run(SYNC);
    assert.equal(res.code, 0, res.out);
    assert.doesNotMatch(res.out, /status pipe to guild-gh: (conf|key) installed/, 'the claimed pipe is already live; nothing to deliver');
    assert.equal(readFileSync(hbConf, 'utf8'), confBefore, 'the KEY= conf tie-claim wrote survives');
    assert.equal(readFileSync(hbKey, 'utf8'), PRIV, 'the box-minted key survives');
    // the push leg reaches the joined rock with the claimed key
    r.w('cockpit/heartbeat.json', '{}\n');
    res = r.run(PUSH);
    assert.match(res.out, /guild-gh: pushed/);
    // the rock ends the tie
    r.w('org-inbox.d/guild-gh/MEMBERSHIP.yaml', 'status: left\n');
    r.w('.heartbeat-out/guild-gh/.git/HEAD', 'x\n');
    r.w('.claude/skills/from-guild/SKILL.md', '# kept\n');
    res = r.run(SYNC);
    assert.match(res.out, /status pipe to guild-gh removed \(membership is 'left'\)/);
    assert.match(res.out, /guild-gh: membership is 'left'\. no new content installed\. existing content kept\./);
    assert.ok(!existsSync(hbConf));
    assert.ok(!existsSync(hbKey));
    assert.ok(!existsSync(path.join(r.state, '.heartbeat-out', 'guild-gh')));
    assert.ok(existsSync(path.join(r.state, 'org-inbox.d', 'guild-gh.conf')), 'the inbox conf is the rock-side membership gate, not ours to drop here');
    assert.ok(existsSync(path.join(r.state, 'org-inbox.d', 'guild-gh', 'MEMBERSHIP.yaml')), 'the mirror stays');
    assert.ok(existsSync(path.join(r.state, '.claude', 'skills', 'from-guild', 'SKILL.md')), 'never delete content');
  } finally { r.done(); }
});

test('org-sync: a joined inbox with NO claimed key still takes the delivered heartbeat pipe (the optional leg keeps working)', () => {
  const r = rig();
  try {
    claimed(r, 'guild-gh', 'guild', 'alice', { inbox: { 'heartbeat/conf': 'ORG_GH_OWNER=guild-gh\nSLUG=alice\n', 'heartbeat/deploy_key': PRIV } });
    rmSync(path.join(r.state, 'heartbeat.d', 'guild-gh.conf'));
    rmSync(path.join(r.state, 'secrets', 'heartbeat_deploy_key.guild-gh'));
    rmSync(path.join(r.state, 'secrets', 'heartbeat_deploy_key.guild-gh.pub'));
    const res = r.run(SYNC);
    assert.match(res.out, /status pipe to guild-gh: conf installed/);
    assert.match(res.out, /status pipe to guild-gh: key installed/);
    assert.equal(readFileSync(path.join(r.state, 'heartbeat.d', 'guild-gh.conf'), 'utf8'), 'ORG_GH_OWNER=guild-gh\nSLUG=alice\n');
    // and a conf naming a third party is refused per inbox, exactly as on the anchor
    r.w('org-inbox.d/guild-gh/heartbeat/conf', 'ORG_GH_OWNER=someone-else\nSLUG=alice\n');
    rmSync(path.join(r.state, 'heartbeat.d', 'guild-gh.conf'));
    rmSync(path.join(r.state, 'secrets', 'heartbeat_deploy_key.guild-gh'));
    const r2 = r.run(SYNC);
    assert.match(r2.out, /names 'someone-else' but this inbox belongs to 'guild-gh'; refused/);
    assert.ok(!existsSync(path.join(r.state, 'heartbeat.d', 'someone-else.conf')));
  } finally { r.done(); }
});

// Was: 'org-sync: a joined rock's pages seed with from: <its handle>, never
// the anchor's name', asserting a brand-new manifest entry with from: 'guild'.
// Retired by delivery-model step 7c, Part B: reconcile now stages every kind
// automatically to offers-pages/ (pickup-only), so seed-org-pages.mjs no
// longer creates a manifest entry for an id it has never seen before,
// regardless of which inbox (anchor or joined) the page arrived from. A
// joined rock's brand-new page is left for the member to pick up
// deliberately via page-install.mjs instead.
test('org-sync: a joined rock’s brand-new page is left for pickup, not auto-seeded with a manifest entry', () => {
  const r = rig();
  try {
    r.w('ownership.json', JSON.stringify({ owner: 'member', anchor: 'acme' }));
    r.w('dashboard/pages.json', JSON.stringify({ pages: [] }));
    claimed(r, 'guild-gh', 'guild', 'alice', { inbox: { 'pages/welcome-pack/house-rules.html': '<h2>rules</h2>' } });
    const res = r.run(SYNC);
    assert.equal(res.code, 0, res.out);
    const manifest = JSON.parse(readFileSync(path.join(r.state, 'dashboard', 'pages.json'), 'utf8'));
    assert.deepEqual(manifest.pages, [], 'no entry is created for an id this box has never heard of');
    assert.ok(!existsSync(path.join(r.state, 'dashboard', 'pages', 'house-rules.html')));
  } finally { r.done(); }
});

// The still-live half of the old test's intent: an id that DOES already
// carry a manifest entry is repaired from a joined rock's inbox too, and its
// existing from (whatever it is) is left exactly as it was, since repair
// never touches the manifest.
test('org-sync: a joined rock repairs a page that already has a manifest entry, without touching that entry’s from', () => {
  const r = rig();
  try {
    r.w('ownership.json', JSON.stringify({ owner: 'member', anchor: 'acme' }));
    r.w('dashboard/pages.json', JSON.stringify({ pages: [{ id: 'house-rules', title: 'House rules', from: 'guild' }] }));
    claimed(r, 'guild-gh', 'guild', 'alice', { inbox: { 'pages/welcome-pack/house-rules.html': '<h2>rules</h2>' } });
    const res = r.run(SYNC);
    assert.equal(res.code, 0, res.out);
    const manifest = JSON.parse(readFileSync(path.join(r.state, 'dashboard', 'pages.json'), 'utf8'));
    assert.deepEqual(manifest.pages, [{ id: 'house-rules', title: 'House rules', from: 'guild' }], 'the entry is untouched');
    assert.equal(readFileSync(path.join(r.state, 'dashboard', 'pages', 'house-rules.html'), 'utf8'), '<h2>rules</h2>', 'the missing file is recreated');
  } finally { r.done(); }
});

test('org-sync: a bad owner name or a conf with no SLUG is skipped, not sourced', () => {
  const r = rig();
  try {
    r.w('org-inbox.d/bad_owner.conf', 'ORG_GH_OWNER=x\nSLUG=a\n');
    r.w('org-inbox.d/no-slug.conf', 'ORG_GH_OWNER=no-slug\nrm -rf /\n');
    r.w('secrets/org_inbox_deploy_key.no-slug', PRIV, 0o600);
    const res = r.run(SYNC);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /ignoring org-inbox.d\/bad_owner\.conf \(bad owner name\)/);
    assert.match(res.out, /org-inbox.d\/no-slug\.conf has no usable SLUG; skipping/);
    assert.equal(r.clones().length, 0);
  } finally { r.done(); }
});

// ---- the detach paths and the joined leave ----------------------------------------

test('evict-apply names the anchor’s files only: org-inbox.d/ and heartbeat.d/ survive an eviction', async () => {
  // unanchorCmd used to be checked here too; it is retired with the tie routes
  // (see the retirement pin above), so evict-apply is the one detach script
  // left to hold to the file-scoping rule.
  for (const cmd of [readFileSync(path.join(HERE, 'evict-apply.sh'), 'utf8')]) {
    assert.doesNotMatch(cmd, /org-inbox\.d/);
    assert.doesNotMatch(cmd, /heartbeat\.d/);
    assert.doesNotMatch(cmd, /deploy_key\./);
    assert.doesNotMatch(cmd, /rm -rf? [^;]*org-inbox\b[^.]/);
  }
  // evict-apply for real: the joined rock's files are still there afterwards
  const r = rig();
  try {
    joined(r, {});
    r.w('heartbeat.conf', CONF);
    r.w('secrets/heartbeat_deploy_key', PRIV, 0o600);
    r.w('ownership.json', JSON.stringify({ owner: 'member', anchor: 'rock-one' }));
    r.w('org-inbox/evict/notice.json', JSON.stringify({ org: 'rock-one', reason: 'x', at: '2026-08-23' }));
    claimed(r, 'guild-gh', 'guild');
    const { code, out } = r.run(path.join(HERE, 'evict-apply.sh'), [r.state]);
    assert.equal(code, 0, out);
    assert.ok(!existsSync(path.join(r.state, 'heartbeat.conf')), 'the anchor pipe went');
    assert.ok(existsSync(path.join(r.state, 'org-inbox.d', 'guild-gh.conf')));
    assert.ok(existsSync(path.join(r.state, 'heartbeat.d', 'guild-gh.conf')));
    assert.ok(existsSync(path.join(r.state, 'secrets', 'heartbeat_deploy_key.guild-gh')));
    assert.ok(existsSync(path.join(r.state, 'secrets', 'org_inbox_deploy_key.guild-gh')));
  } finally { r.done(); }
});
