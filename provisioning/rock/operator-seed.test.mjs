// operator-seed.test.mjs: a rock boots with its FOUNDER on the people roster.
//   node --test provisioning/rock/operator-seed.test.mjs
//
// The operator half of roster-seed.test.mjs, and it broke the same way. sshd on a
// rock reads TWO key sources: the host's /home/aios-op/.ssh/authorized_keys
// (AuthorizedKeysFile, where the stamped operator key lands) and
// /state/ssh/aios-op/authorized_keys (AuthorizedKeysCommand, derived by
// people-sync from the people registry the console shows). The container cannot
// see the first, and sshd does not expose which key authenticated.
//
// Proven live on certrock (2026-08-04): people/ held only _TEMPLATE.yaml and
// /state/ssh/aios-op/ was an EMPTY DIRECTORY, while I was logged in as aios-op at
// that moment. So People listed nobody on a box whose operator was using it, and
// people-revoke could not revoke that key, because people-sync owns the roster
// file and has no reach into the host one. "Who can administer this rock" read as
// nobody while a full-admin key with docker-group (host root) access worked.
//
// The managed template fixed exactly this for the member on 2026-08-03 and the
// rock was never given the same treatment: AuthorizedKeysFile none appeared
// twice there and zero times here.
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, 'cloud-init.rock.template.yaml');
const tpl = () => readFileSync(TEMPLATE, 'utf8');

test('the rock cloud-init seeds the founder key into the people registry', () => {
  const t = tpl();
  assert.match(t, /\/home\/aios-op\/\.ssh\/authorized_keys/, 'reads the stamped host key');
  assert.match(t, /people\/founder\.yaml/, 'writes a people row');
  assert.match(t, /\/state\/ssh\/aios-op\/authorized_keys/, 'and derives the roster file directly');
  // people-sync.mjs parses role/status/pubkeys; a row missing any of them
  // contributes no keys and the page stays empty anyway.
  for (const field of ['role:', 'status:', 'pubkeys:', 'name:']) {
    assert.ok(t.includes(field), `the seeded row carries ${field}`);
  }
});

test('the seed happens BEFORE the roster becomes the only door', () => {
  // Written the wrong way round this is a total lockout: these boxes have no root
  // SSH at all, so the only way back would be Hetzner rescue mode.
  const t = tpl();
  const seedAt = t.indexOf('/state/ssh/aios-op/authorized_keys');
  const onlyDoorAt = t.indexOf('AuthorizedKeysFile none');
  assert.ok(seedAt !== -1 && onlyDoorAt !== -1, 'both halves present');
  assert.ok(seedAt < onlyDoorAt, 'seed must precede making the roster the only door');
});

test('the only-door switch is conditional, validated, and rolled back on a bad config', () => {
  const t = tpl();
  const block = t.slice(t.indexOf('if [ -s /state/ssh/aios-op/authorized_keys ]'));
  assert.match(block, /^if \[ -s /, 'applies ONLY when the roster demonstrably holds a key');
  assert.match(block, /sshd -t/, 'validates the config before trusting it');
  assert.match(block, /rm -f \/etc\/ssh\/sshd_config\.d\/61-aios-roster-only\.conf/,
    'and removes it again if sshd refuses to parse it');
  assert.match(block, /Match User aios-op(?!,)/, 'the one operator login (Support was deleted 2026-08-05)');
});

// --- the seed block, actually executed -------------------------------------
// The assertions above are string checks; this one RUNS the shell cloud-init
// will run, against a fake host tree, because a seed that reads right and
// writes nothing is exactly the failure being fixed.
function runSeed({ hostKey }) {
  const root = tmpDir('op-seed-');
  const brain = join(root, 'brain');
  mkdirSync(join(root, 'home', 'aios-op', '.ssh'), { recursive: true });
  mkdirSync(join(root, 'state', 'ssh', 'aios-op'), { recursive: true });
  if (hostKey !== null) writeFileSync(join(root, 'home', 'aios-op', '.ssh', 'authorized_keys'), `${hostKey}\n`);

  // Lift the block out of the template so the test cannot drift from what ships,
  // and repoint its absolute paths at the fake tree.
  const t = tpl();
  const start = t.indexOf('    KEY="$(head -n1 /home/aios-op');
  const end = t.indexOf('esac', start) + 'esac'.length;
  assert.ok(start > 0 && end > start, 'found the seed block in the template');
  const script = t.slice(start, end)
    .replace(/__BRAIN_ROOT__/g, brain)
    .replace(/\/home\/aios-op/g, join(root, 'home', 'aios-op'))
    .replace(/\/state\/ssh/g, join(root, 'state', 'ssh'))
    .replace(/^\s*chown .*$/gm, ':');   // no chown in a test tree

  execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  const rowPath = join(brain, 'people', 'founder.yaml');
  const derivedPath = join(root, 'state', 'ssh', 'aios-op', 'authorized_keys');
  return {
    row: existsSync(rowPath) ? readFileSync(rowPath, 'utf8') : null,
    derived: existsSync(derivedPath) ? readFileSync(derivedPath, 'utf8') : null,
  };
}

const REAL_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIdCgb5L27nNGtdmBbg+6xHvgB1o8gHHzslDSQlPqypI operator-certrock';

test('running the seed produces a row people-sync will actually accept', () => {
  const { row, derived } = runSeed({ hostKey: REAL_KEY });
  assert.ok(row, 'a founder row was written');
  assert.match(row, /^role: "admin"$/m);
  assert.match(row, /^status: "active"$/m);
  assert.match(row, /^pubkeys:\n {2}- "ssh-ed25519 /m, 'the pubkeys block-list shape people-sync parses');
  assert.match(row, /^added: "\d{4}-\d{2}-\d{2}"$/m);
  assert.equal(derived?.trim(), REAL_KEY, 'the derived roster carries the key verbatim');

  // The real parser, not my reading of it: people-sync must bucket this key to
  // aios-op. Its PUBKEY_RE rejects anything but a plain ssh-ed25519 line, which
  // is how a subtly wrong seed shape would silently produce an empty roster.
  const KEY_RE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9@._ -]{1,64})?$/;
  const block = row.split(/^pubkeys:\s*$/m)[1] || '';
  const keys = [...block.matchAll(/^\s+-\s+"?(ssh-ed25519 [^"\n]+?)"?\s*$/gm)].map((m) => m[1]);
  assert.equal(keys.length, 1, 'exactly one key parsed out of the block-list');
  assert.ok(KEY_RE.test(keys[0]), 'and it passes people-sync PUBKEY_RE');
});

test('a box with no stamped operator key seeds NOTHING (and so never locks its door)', () => {
  // The case that makes the conditional switch safe: no key to seed means no
  // roster, which means the only-door switch must not fire.
  const { row, derived } = runSeed({ hostKey: null });
  assert.equal(row, null, 'no key, no row');
  assert.ok(!derived, 'and no derived roster, so `[ -s ... ]` stays false');
});

test('a non-ed25519 or sentinel host key is not seeded', () => {
  // The phantom-device lockout (2026-08-03) came from a glob matching a sentinel
  // placeholder and creating a roster entry that could never authenticate.
  for (const junk of ['__OPERATOR_PUBKEY__', 'ssh-rsa AAAAB3NzaC1yc2EAAAA', '']) {
    const { row } = runSeed({ hostKey: junk });
    assert.equal(row, null, `"${junk.slice(0, 20)}" must not become a founder row`);
  }
});

// --- Support must not get a free shell -------------------------------------
// A terminal lands in the org container, where provisioning.env.local holds the
// org's Hetzner/Cloudflare/GitHub tokens, deprovision scripts run, and
// people/<self>.yaml can be edited to self-promote to Admin. The panel gates
// /term/open, but that check reads a role the operator's own machine declares.
// This gate reads the login sshd actually authenticated, so it holds against a
// patched pebble. Support's real work arrives as $SSH_ORIGINAL_COMMAND, which
// must keep working, or Support is broken instead of contained.

function enterAios() {
  // Since R18 (2026-08-23) the rock template embeds provisioning/host/enter-aios
  // gz+b64 (one script for both faces; enter-aios-parity.test.mjs pins the
  // match), so lift it by decoding the blob rather than dedenting a text block.
  const t = tpl();
  const m = t.match(/  - path: \/usr\/local\/bin\/enter-aios\n    permissions: '0755'\n    encoding: gz\+b64\n    content: (\S+)\n/);
  assert.ok(m, 'found the enter-aios wrapper');
  const script = gunzipSync(Buffer.from(m[1], 'base64')).toString('utf8');
  // Neuter the exec so the test observes the DECISION, not docker, and answer
  // the break-glass probe with "running" so the test never waits on a
  // container this machine does not have.
  return script
    .replace(/^T=""/m, 'docker(){ [ "$1" = inspect ] && { echo true; return 0; }; echo "WOULD-RUN docker $*"; }\nT=""')
    .replace(/exec docker/g, 'echo WOULD-RUN docker');
}

const runAs = (user, cmd) => {
  const script = enterAios();
  const dir = tmpDir('enter-');
  const p = join(dir, 'enter-aios');
  writeFileSync(p, script);
  const r = execFileSync('bash', [p], {
    encoding: 'utf8', env: { ...process.env, USER: user, SSH_ORIGINAL_COMMAND: cmd },
  }).trim();
  return r;
};

test('there is no Support login on the rock at all (role deleted 2026-08-05)', () => {
  // Stronger than the guard this replaces. The old shape refused Support an
  // interactive shell while the command branch ran ANYTHING it was handed, gated
  // only by a string the app prepended on the operator's own machine, so a plain
  // ssh pebble walked straight past it to /state/secrets/provisioning.env.local.
  // The role had never been granted to anyone, so it was deleted rather than
  // patched: no user, no sshd match, no key directory, nothing to bypass.
  const t = tpl();
  assert.doesNotMatch(t, /name: aios-support/, 'the unix user is gone');
  assert.doesNotMatch(t, /Match User aios-op,aios-support/, 'sshd no longer matches it');
  assert.doesNotMatch(t, /\/state\/ssh\/aios-support/, 'no key directory is created for it');
});

test('an Admin login keeps its interactive shell', () => {
  const out = runAs('aios-op', '');
  assert.match(out, /WOULD-RUN docker exec -it/, 'Admin still gets a terminal');
  assert.match(out, /AIOS_LOGIN=aios-op/);
});

// --- finding 98: the platform key rides along, and must not steal the founder row
//
// A rock created by the platform owner's own email was keyed to that laptop and
// nothing else, because mintDeviceKey mints ON the laptop and the private half
// never reaches the VPS. The brokered stamp runs FROM the VPS and is the only way
// a rock can create a member (finding 69), so such a rock could not stamp anyone:
// every broker key was refused and it retried forever against the same refusal.
//
// The fix puts the platform's enrol key on every rock alongside the owner's. This
// test guards the part that could go silently wrong: ORDER. The seed below takes
// `head -n1` of authorized_keys to decide who to write into people/founder.yaml,
// so the human's key has to stay first. Get it backwards and every rock's console
// would name Crads-AI as its founder while the human appeared nowhere, which is
// the exact class of bug this file was written for.
const PLATFORM_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePlatformEnrolKeyForTestsOnly000000 crads-enrolment';

test('98: with two authorized keys, the FOUNDER row still names the human', () => {
  const { row, derived } = runSeed({ hostKey: `${REAL_KEY}\n${PLATFORM_KEY}` });
  assert.ok(row, 'a founder row was written');
  assert.match(row, /operator-certrock/, 'the human key is the one seeded');
  assert.doesNotMatch(row, /crads-enrolment/,
    'the platform key must never be written into the people registry as a person');
  assert.equal(derived?.trim(), REAL_KEY, 'and the derived roster carries the human key only');
});

test('98: the cloud-init renders a LIST, so a second key is possible at all', () => {
  // Guards the template side: if this collapses back to a single hardcoded item,
  // provision-rock.sh can pass two keys and only one will ever be authorized.
  const t = tpl();
  assert.match(t, /ssh_authorized_keys:\n\s+- __OPERATOR_PUBKEY__/,
    'the operator block is a YAML list whose single item is the substitution point');
});

// --- the RENDER, actually executed -----------------------------------------
// The string checks above prove the template can take two keys. This runs the
// real python out of provision-rock.sh against the real template, because the
// substitution is the fragile half: mutation-checked, the OLD single-value
// replace given two keys emitted INVALID YAML (the second key landed as a bare
// line), which would not have failed the stamp, it would have stopped the box
// booting at all. Naively passing two keys without this change was worse than
// the bug it fixes.
function renderCloudInit(operatorPubkey) {
  const sh = readFileSync(join(HERE, 'provision-rock.sh'), 'utf8');
  const py = sh.slice(sh.indexOf("python3 - <<'PY'") + "python3 - <<'PY'".length, sh.indexOf('\nPY\n'));
  const d = tmpDir('oprender-');
  writeFileSync(join(d, 'key'), 'DEPLOYLINE1\nDEPLOYLINE2\n');
  writeFileSync(join(d, 'dep'), 'brain_root: "/state/brain"\n');
  const out = join(d, 'ci.yaml');
  execFileSync('python3', ['-c', py], {
    encoding: 'utf8',
    env: { ...process.env,
      TPL: TEMPLATE, DEPLOY_SRC: join(d, 'dep'), KEY_FILE: join(d, 'key'), CI_OUT: out,
      IDE_PASSWORD: 'p', TUNNEL_TOKEN: 't', IMAGE: 'img', BRAIN_REPO: 'r',
      BRAIN_ROOT: '/state/brain', GHCR_PULL_TOKEN: 'g', FACTORY_ENV_B64: 'Zg==',
      OPERATOR_PUBKEY: operatorPubkey, SSH_RULE: '/bin/true',
      BRAIN_SEED_MODE: 'template', ORG_DISPLAY: 'Org', ORG_HANDLE: 'org' },
  });
  return readFileSync(out, 'utf8');
}

/** aios-op's authorized keys, read back through a real YAML parser. */
function renderedOpKeys(text) {
  const script = 'import sys,yaml,re;d=yaml.safe_load(re.sub(r"^#cloud-config\\s*","",sys.stdin.read()));'
    + 'u=[x for x in d["users"] if isinstance(x,dict) and x.get("name")=="aios-op"][0];'
    + 'print("\\n".join(u["ssh_authorized_keys"]))';
  return execFileSync('python3', ['-c', script], { input: text, encoding: 'utf8' }).trim().split('\n');
}

test('98 RENDER: two keys become two entries, owner first, and the YAML still parses', () => {
  const owner = 'ssh-ed25519 AAAAOWNERKEY owner-laptop';
  const platform = 'ssh-ed25519 AAAAPLATFORMKEY crads-enrolment';
  assert.deepEqual(renderedOpKeys(renderCloudInit(`${owner}\n${platform}`)), [owner, platform]);
});

test('98 RENDER: one key is still exactly one entry, and none is the sentinel', () => {
  const owner = 'ssh-ed25519 AAAAOWNERKEY owner-laptop';
  assert.deepEqual(renderedOpKeys(renderCloudInit(owner)), [owner]);
  const none = renderedOpKeys(renderCloudInit(''));
  assert.equal(none.length, 1);
  assert.match(none[0], /no-operator-key-staged disabled/,
    'an empty list would authorize nobody AND boot a rock no one can reach');
});
