// template-seed.test.mjs — run: node --test provisioning/rock/template-seed.test.mjs
//
// The ownership ruling (Sam, 2026-08-09): "The github repo should be their own
// off the bat. Crads AI should not own anyone's backups." In brain_seed:
// template mode the box clones the PRODUCT TEMPLATE, strips its history, and
// the org brain is reborn locally with no remote. These tests render the rock
// cloud-init exactly as provision-rock.sh does and prove: the render is valid
// YAML, the seed block's shell parses, the identity substitutes, and the
// heredoc's terminator survives YAML de-indentation (the one place a rendered
// template can silently swallow the rest of the script).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, 'cloud-init.rock.template.yaml');

// the same replacement set provision-rock.sh's python stage applies
function render(mode, over = {}) {
  const dir = tmpDir('tplseed-');
  let t = readFileSync(TEMPLATE, 'utf8');
  t = t.replace('      __BRAIN_DEPLOY_KEY__', '      FAKEKEY');
  t = t.replace('__DEPLOYMENT_YAML_B64__', Buffer.from('deployment_name: acme\n').toString('base64'));
  for (const [k, v] of Object.entries({
    IDE_PASSWORD: 'pw', TUNNEL_TOKEN: 'tt', IMAGE: 'ghcr.io/x/ai-os-parent:v2',
    BRAIN_REPO: mode === 'template' ? 'https://x-access-token:tok@github.com/owner/brain-template.git' : 'git@github.com:owner/acme-brain.git',
    BRAIN_ROOT: '/state/brain', GHCR_PULL_TOKEN: 'tok', FACTORY_ENV_B64: 'ZW1wdHkK',
    SSH_FIREWALL_RULE: '/bin/true', OPERATOR_PUBKEY: 'ssh-ed25519 AAAA op',
    BRAIN_SEED_MODE: mode, ORG_DISPLAY: 'Acme Collective', ORG_HANDLE: 'acme',
    ...over,
  })) t = t.replaceAll(`__${k}__`, v);
  const out = join(dir, 'ci.yaml');
  writeFileSync(out, t);
  return { out, text: t };
}

test('template-mode render is valid YAML and the seed script parses as shell', () => {
  const { out } = render('template');
  // YAML parse via python (the render stage is python; same parser class)
  const script = execFileSync('python3', ['-c', `
import yaml, json, sys
d = yaml.safe_load(open('${out}'))
cmds = [c for c in d['runcmd'] if isinstance(c, str) and 'ORGMD' in c]
print(json.dumps(cmds))
`], { encoding: 'utf8' });
  const cmds = JSON.parse(script);
  assert.equal(cmds.length, 1, 'exactly one template-seed block in runcmd');
  const seed = cmds[0];
  // the block must have survived de-indentation intact: terminator at column 0
  assert.match(seed, /\nORGMD\n/, 'the heredoc terminator must sit at column 0 after YAML de-indent, or the rest of the script is swallowed');
  // and the shell must parse
  const dir = tmpDir('tplseed-sh-');
  writeFileSync(join(dir, 's.sh'), seed);
  execFileSync('bash', ['-n', join(dir, 's.sh')]);
});

test('the reborn brain gets the org identity and sheds the template clone credential', () => {
  const { text } = render('template');
  assert.ok(text.includes('# Acme Collective Brain (rock)'), 'CLAUDE.md heading names the organisation');
  assert.ok(text.includes('`acme`'), 'the handle lands in the provenance line');
  assert.ok(text.includes('rm -rf /state/brain/.git'), 'the template history (and the tokened clone URL in .git/config) must be stripped');
  assert.ok(text.includes('rm -f /root/.ssh/brain_deploy'), 'the unused key file must not linger');
  assert.ok(text.includes('never holds a copy'), 'the rendered CLAUDE.md states the ownership rule');
});

// The identity fill, RUN rather than grepped. Everything else in this file
// asserts the rendered text; nothing executed the one step whose absence made
// every door-born rock nameless (no directory route, no ORG_PULL_TOKEN, and
// stamp-pebble dying "org-policy org.name is empty"). The template's own helper
// does the work, so the fixture is the real template checkout, a sibling of
// this repo exactly as engine/box/install.test.mjs already assumes.
const TPL = join(HERE, '..', '..', '..', 'brain-template');

// WHAT THE HOST ACTUALLY HAS. cloud-init's `packages:` installs exactly these,
// plus docker from its own apt repo; nothing else is on a fresh box. Every
// runcmd line is shell on THAT machine, not on a developer's laptop, and the
// gap between those two environments is not theoretical: the first cut of the
// identity fill called `node` directly, died "command not found" on the first
// real rock, and every test here stayed green because they all ran where node
// exists. Anything the seed block invokes must be in this list or run in the
// container image.
const HOST_BINARIES = ['curl', 'ca-certificates', 'ufw', 'git', 'fail2ban', 'docker',
  // coreutils/shell builtins a base Ubuntu image carries
  'sh', 'bash', 'cat', 'echo', 'grep', 'sed', 'awk', 'mkdir', 'rm', 'mv', 'cp',
  'touch', 'chown', 'chmod', 'printf', 'test', 'ssh-keyscan', 'ssh-keygen', 'tee'];

function runFill(brainRoot) {
  const { out } = render('template', { BRAIN_ROOT: brainRoot });
  const cmd = JSON.parse(execFileSync('python3', ['-c', `
import yaml, json
d = yaml.safe_load(open('${out}'))
print(json.dumps([c for c in d['runcmd'] if isinstance(c, str) and 'ORGMD' in c][0]))
`], { encoding: 'utf8' }));
  // just the fill: the surrounding block does git + heredoc + key cleanup,
  // none of which belongs in a unit test's blast radius.
  let script = cmd.slice(cmd.indexOf('docker run'), cmd.indexOf('if [ ! -f'));
  assert.ok(script.includes('org-identity.mjs'), 'the fill must ride the shared helper');
  // Run the container's job locally: the box has node inside the image, this
  // process has node on PATH. Same argv, same helper, same policy on disk.
  script = script.replace(/docker run[\s\S]*?--entrypoint node \S+ *\\?\n?/, 'node ')
    .replace(/"\/brain\//g, `"${brainRoot}/`)
    .replace(/\("\/brain\/registry/g, `("${brainRoot}/registry`);
  return spawnSync('bash', ['-c', script], { cwd: brainRoot, encoding: 'utf8' });
}

test('the seed fills the org identity into org-policy.yaml, verified as the consumers read it', { skip: !existsSync(join(TPL, 'registry', 'org-identity.mjs')) && 'brain-template checkout not present' }, async () => {
  const brain = tmpDir('tplseed-brain-');
  mkdirSync(join(brain, 'registry'), { recursive: true });
  copyFileSync(join(TPL, 'org-policy.yaml'), join(brain, 'org-policy.yaml'));
  copyFileSync(join(TPL, 'registry', 'org-identity.mjs'), join(brain, 'registry', 'org-identity.mjs'));

  const { readOrgIdentity } = await import(join(brain, 'registry', 'org-identity.mjs'));
  assert.equal(readOrgIdentity(readFileSync(join(brain, 'org-policy.yaml'), 'utf8')).name, '',
    'the template must still ship an EMPTY name, or this test proves nothing');

  const r = runFill(brain);
  assert.equal(r.status, 0, `the fill failed: ${r.stdout}${r.stderr}`);
  const got = readOrgIdentity(readFileSync(join(brain, 'org-policy.yaml'), 'utf8'));
  assert.equal(got.name, 'acme', 'the handle must land where broker-register and stamp-pebble read it');
  assert.equal(got.display_name, 'Acme Collective');
});

test('a brain with no policy to fill logs the warning instead of dying silently', () => {
  const brain = tmpDir('tplseed-empty-');
  const r = runFill(brain);
  assert.notEqual(r.status, 0, 'a rock born nameless must not look like a success');
});

// The regression that shipped a nameless rock: a runcmd line calling a binary
// the host does not have. It failed soft into a log file, so the box booted
// looking fine and the defect only surfaced when an owner pressed a button
// days later.
//
// Narrow on purpose. A general "does every command exist" walk drowns in
// heredoc prose and JS one-liner internals; what actually bit is a short list
// of interpreters that live in the IMAGE and not on the host. Heredoc bodies
// are stripped first (they are file contents, not commands), then any
// command-position use of one of these outside a `docker run` is an error.
const NOT_ON_HOST = ['node', 'npm', 'npx', 'jq', 'yq'];

function stripHeredocs(text) {
  return text.replace(/<<-?'?([A-Za-z_][A-Za-z0-9_]*)'?[\s\S]*?^\1$/gm, '<<HEREDOC-STRIPPED');
}

test('runcmd never calls an image-only interpreter on the host', () => {
  const { out } = render('template');
  const cmds = JSON.parse(execFileSync('python3', ['-c', `
import yaml, json
d = yaml.safe_load(open('${out}'))
print(json.dumps([c for c in d['runcmd'] if isinstance(c, str)]))
`], { encoding: 'utf8' }));

  const offenders = [];
  for (const raw of cmds) {
    for (const line of stripHeredocs(raw).split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      for (const bin of NOT_ON_HOST) {
        // command position: start of line or after a shell separator
        const re = new RegExp(`(^|[;&|]|\\bthen\\b|\\bdo\\b|\\belse\\b|\\{)\\s*(${bin})\\s`, 'g');
        if (!re.test(t)) continue;
        if (/docker\s+run/.test(t)) continue;   // running it in the image is the correct form
        offenders.push(`${bin}: ${t.slice(0, 100)}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'cloud-init packages: installs curl, ca-certificates, ufw, git, fail2ban (plus docker). '
    + 'These interpreters are only in the container image, so a bare call dies "command not found" '
    + 'on a real box while every test here passes. Wrap it in docker run --entrypoint.');
});

test('the identity fill specifically runs in the image, mounting the brain', () => {
  const { text } = render('template');
  const seed = text.slice(text.indexOf('if [ "template" = "template" ]'), text.indexOf('ORGMD'));
  assert.match(seed, /docker run --rm -v \/state\/brain:\/brain/, 'the brain must be mounted into the image');
  assert.match(seed, /--entrypoint node/, 'and node must come from the image, never the host');
  assert.doesNotMatch(seed.replace(/docker run[^\n]*/g, ''), /(^|[;&|])\s*node\s/m, 'no bare host node');
});

test('repo mode renders the seed block inert', () => {
  const { out } = render('repo');
  const seeds = execFileSync('python3', ['-c', `
import yaml
d = yaml.safe_load(open('${out}'))
print(sum(1 for c in d['runcmd'] if isinstance(c, str) and c.strip().startswith('if [ "repo" = "template" ]')))
`], { encoding: 'utf8' }).trim();
  assert.equal(seeds, '1', 'the block renders with a false guard, so a classic brain_repo deployment is untouched');
});
