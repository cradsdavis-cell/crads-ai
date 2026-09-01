// pebble-seed.test.mjs — trap 53: a Mountain-built pebble is born with its brain.
//
// Until 2026-08-17 only the retired rock-side factory ever set SEED_DIR, so
// every pebble built on the one build path booted with an empty scaffold: no
// CLAUDE.md contract, no wiki/system/membership.md, no first-conversation
// script, no starter skills, no lineage.json. These tests pin the assembler
// (pebble-seed.sh) against a fixture template, and — when a real brain-template
// checkout is present beside this repo — against the real template, including
// the Hetzner 32 KiB user-data arithmetic.
//
// No provisioning is touched: the assembler is pure file work, and the only
// provision-pebble.sh assertions are structural (the hook exists), never a run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEEDER = path.join(HERE, 'pebble-seed.sh');
const REAL_TPL = process.env.PEBBLE_TEMPLATE_DIR || path.join(homedir(), 'brain-template', 'pebble-template');

// A fixture with the real template's shape: every variant, every token family.
function fixtureTemplate() {
  const t = tmpDir('pebble-tpl-');
  mkdirSync(path.join(t, 'wiki', 'system'), { recursive: true });
  mkdirSync(path.join(t, 'skills'), { recursive: true });
  mkdirSync(path.join(t, 'box'), { recursive: true });
  writeFileSync(path.join(t, 'CLAUDE.md'),
    '# Your AI OS ({{ORG_NAME}} member box)\nno-yes-man. Name ({{ASSISTANT_NAME}}). {{AI_DISCLOSURE_LINE}}\n');
  writeFileSync(path.join(t, 'CLAUDE-solo.md'),
    '# Your AI OS\nsolo contract. Name ({{ASSISTANT_NAME}}). {{OUTBOUND_POLICY}}. {{AI_DISCLOSURE_LINE}}\n');
  writeFileSync(path.join(t, 'CLAUDE-org-owned.md'), '# org-owned variant, never shipped by the Mountain\n');
  writeFileSync(path.join(t, 'profile.yaml'),
    'identity:\n  user_name: "{{USER_NAME}}"\n  user_short: "{{USER_SHORT}}"\n'
    + '  assistant_name: "{{ASSISTANT_NAME}}"\n  timezone: "{{TIMEZONE}}"\n'
    + 'accounts:\n  email:\n    provider: "{{PROVIDER}}"\n    send_as: "{{SEND_AS}}"\n'
    + '  inbox_triage:\n    mode: "{{INBOX_MODE}}"\n'
    + 'comms:\n  outbound_policy: "{{OUTBOUND_POLICY}}"\n  ai_disclosure: {{AI_DISCLOSURE}}\n'
    + 'cadence:\n  quiet_hours: "{{QUIET_HOURS}}"\n'
    + 'classifications:\n  - match: ["{{ORG_NAME}}"]\n    badge: "{{EXPERTS_LABEL}}"\n');
  writeFileSync(path.join(t, 'wiki', 'system', 'membership.md'),
    '# {{ORG_NAME}} membership and your box\n{{EXPERTS_LABEL}} packs, {{PULSE_NAME}}, {{AREAS_LABEL}}.\n');
  writeFileSync(path.join(t, 'wiki', 'system', 'membership-solo.md'),
    '# Your box and Crads-AI\nsolo ownership page.\n');
  writeFileSync(path.join(t, 'wiki', 'system', 'membership-org-owned.md'), '# org-owned page, never shipped\n');
  writeFileSync(path.join(t, 'skills', 'eod.md'), 'eod for {{ORG_NAME}}\n');
  writeFileSync(path.join(t, 'skills', 'pulse.md'), 'pulse ({{PULSE_NAME}})\n');
  writeFileSync(path.join(t, 'box', 'org-sync.sh'), '#!/bin/sh\n# ships in the image, never the seed\n');
  return t;
}

function assemble(tpl, env = {}) {
  const out = tmpDir('pebble-seed-');
  const r = spawnSync('bash', [SEEDER, out], {
    env: { ...process.env, PEBBLE_TEMPLATE_DIR: tpl, AIOS_ANCHOR_ORG: '', CLIENT_NAME: '', AIOS_BOX_NAME: '', ...env },
    encoding: 'utf8',
  });
  return { out, r };
}

const rd = (base, f) => readFileSync(path.join(base, f), 'utf8');

test('anchored build: member contract + membership page land, org handle rendered, no tokens left', () => {
  const tpl = fixtureTemplate();
  const { out, r } = assemble(tpl, { AIOS_ANCHOR_ORG: 'acme', CLIENT_NAME: 'Jane Doe' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(rd(out, 'CLAUDE.md'), /acme member box/, 'ORG_NAME renders as the anchor handle');
  assert.match(rd(out, 'wiki/system/membership.md'), /acme membership/, 'membership page is the member variant, rendered');
  const prof = rd(out, 'profile.yaml');
  assert.match(prof, /user_name: "Jane Doe"/);
  assert.match(prof, /user_short: "Jane"/);
  assert.match(prof, /assistant_name: ""/, 'anchored pebbles are born nameless (ruling 2026-08-16)');
  const lineage = JSON.parse(rd(out, 'lineage.json'));
  assert.equal(lineage.origin, 'stamped');
  assert.equal(lineage.stamped_by, 'acme');
  assert.deepEqual(lineage.reframes, []);
  assert.equal(lineage.framework_imprint, '', 'the imprint arrives down the inbox, never in the seed');
  rmSync(tpl, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
});

test('solo build: solo variants become the shipped pages, box name becomes the assistant name', () => {
  const tpl = fixtureTemplate();
  const { out, r } = assemble(tpl, { CLIENT_NAME: 'Jane Doe', AIOS_BOX_NAME: 'Fern' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(rd(out, 'CLAUDE.md'), /solo contract/, 'CLAUDE-solo.md ships as CLAUDE.md');
  assert.match(rd(out, 'CLAUDE.md'), /Name \(Fern\)/, 'the box name IS the assistant name (docs/naming.md)');
  assert.match(rd(out, 'wiki/system/membership.md'), /solo ownership page/, 'membership-solo.md ships as membership.md');
  assert.match(rd(out, 'profile.yaml'), /assistant_name: "Fern"/);
  const lineage = JSON.parse(rd(out, 'lineage.json'));
  assert.equal(lineage.origin, 'self');
  assert.equal(lineage.stamped_by, '');
  rmSync(tpl, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
});

test('what must never ship: org-owned variants, box/, root skills/, ownership.json, unrendered tokens', () => {
  const tpl = fixtureTemplate();
  for (const env of [{ AIOS_ANCHOR_ORG: 'acme' }, {}]) {
    const { out, r } = assemble(tpl, env);
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['CLAUDE-org-owned.md', 'CLAUDE-solo.md',
      'wiki/system/membership-org-owned.md', 'wiki/system/membership-solo.md',
      'box', 'skills', 'ownership.json']) {
      assert.ok(!existsSync(path.join(out, f)), `${f} must not be in the seed`);
    }
    assert.ok(existsSync(path.join(out, '.claude/skills/eod/SKILL.md')), 'skills land where Claude Code reads them');
    assert.ok(existsSync(path.join(out, '.claude/skills/pulse/SKILL.md')));
    const g = spawnSync('grep', ['-rlE', String.raw`\{\{[A-Z_]+\}\}`, out], { encoding: 'utf8' });
    assert.notEqual(g.status, 0, `unrendered tokens survived in: ${g.stdout}`);
    rmSync(out, { recursive: true, force: true });
  }
  rmSync(tpl, { recursive: true, force: true });
});

test('a nameless solo box gets an instruction, not an empty parenthesis', () => {
  const tpl = fixtureTemplate();
  const { out, r } = assemble(tpl, { CLIENT_NAME: 'Jane' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(rd(out, 'CLAUDE.md'), /Name \(no name yet: invite them to choose one\)/);
  assert.match(rd(out, 'profile.yaml'), /assistant_name: ""/);
  rmSync(tpl, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
});

test('refusals are loud: missing template, and a solo build against a pre-solo-variant template', () => {
  const gone = path.join(tmpdir(), 'no-such-template-anywhere');
  const { r } = assemble(gone, {});
  assert.notEqual(r.status, 0, 'a missing template must refuse, not seed nothing');
  assert.match(r.stderr, /pebble template not found/);

  const tpl = fixtureTemplate();
  rmSync(path.join(tpl, 'CLAUDE-solo.md'));
  const solo = assemble(tpl, {});
  assert.notEqual(solo.r.status, 0, 'a template without solo variants cannot serve a solo build');
  assert.match(solo.r.stderr, /no solo variants/);
  const anchored = assemble(tpl, { AIOS_ANCHOR_ORG: 'acme' });
  assert.equal(anchored.r.status, 0, 'the same old template still serves an anchored build');
  rmSync(tpl, { recursive: true, force: true });
});

test('provision-pebble.sh assembles the default seed when the caller brings none (structural)', () => {
  const sh = readFileSync(path.join(HERE, 'provision-pebble.sh'), 'utf8');
  assert.match(sh, /if \[ -z "\$\{SEED_DIR:-\}" \] && \[ "\$\{PEBBLE_SEED:-\}" != "none" \]/,
    'the hook fires exactly when no seed was brought and no opt-out was given');
  assert.match(sh, /"\$HERE\/pebble-seed\.sh" "\$SEED_TMP" \|\| die/,
    'assembly failure refuses the build rather than shipping an empty brain');
  const hook = sh.indexOf('pebble-seed.sh');
  const cf = sh.indexOf('cf_resolve_ids');
  assert.ok(hook > 0 && hook < cf, 'the seed is assembled before anything is created, so a refusal costs nothing');
});

// --- the real template, when this box has one (operator box; skipped on clean checkouts) ---
test('real template: both modes land CLAUDE.md + membership.md and fit the user-data budget', (t) => {
  if (!existsSync(REAL_TPL)) return t.skip(`no template checkout at ${REAL_TPL}`);
  const TPLF = path.join(HERE, 'cloud-init.template.yaml');
  const STRIPPER = path.join(HERE, 'strip-cloud-init-comments.awk');
  const HOST = path.join(HERE, '..', 'host');
  const hostBlock = ['aios-host-update', 'enter-aios'].map((n) => {
    const gz = execFileSync('gzip', ['-9nc', path.join(HOST, n)]).toString('base64');
    return `  - path: /usr/local/bin/${n}\n    permissions: '0755'\n    encoding: gz+b64\n    content: ${gz}\n`;
  }).join('');
  const stripped = execFileSync('awk', ['-f', STRIPPER], { input: readFileSync(TPLF, 'utf8') }).toString();
  const base = stripped.replace(/^ *#__HOST_SCRIPTS__ *$/m, hostBlock.replace(/\n$/, '')).length;

  for (const env of [{ AIOS_ANCHOR_ORG: 'acme', CLIENT_NAME: 'Cohort Member' },
                     { CLIENT_NAME: 'Door Person', AIOS_BOX_NAME: 'Fern' }]) {
    const { out, r } = assemble(REAL_TPL, env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(path.join(out, 'CLAUDE.md')), 'CLAUDE.md lands');
    assert.match(rd(out, 'CLAUDE.md'), /no-yes-man contract/, 'and it is the real contract');
    assert.ok(existsSync(path.join(out, 'wiki/system/membership.md')), 'membership.md lands');
    assert.match(rd(out, 'CLAUDE.md'), /First conversation/, 'the first-conversation script rides in CLAUDE.md');
    assert.ok(existsSync(path.join(out, 'lineage.json')));
    // the same arithmetic provision-pebble.sh enforces at stamp time
    const b64 = execFileSync('bash', ['-c',
      `tar cf - -C ${JSON.stringify(out)} . | gzip -9n | base64 -w 512 | wc -c`], { encoding: 'utf8' });
    const seedBytes = Number(b64.trim());
    assert.ok(base + seedBytes <= 31000,
      `base ${base} B + real seed ${seedBytes} B must fit the 31000 B budget (Hetzner cap 32768)`);
    rmSync(out, { recursive: true, force: true });
  }
});
