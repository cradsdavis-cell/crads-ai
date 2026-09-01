// One-name ruling (2026-08-09): one name per box, stored twice (box-name +
// profile.yaml identity.assistant_name), every writer going through
// name-set.mjs. These pins keep the dual write, the migration gate and the
// verb wiring from drifting back into the six-source naming mess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'name-set.mjs');
const run = (box, name) => execFileSync(process.execPath, [SCRIPT, box, name], { encoding: 'utf8' });

test('a fresh box gets both files from one call', () => {
  const box = tmpDir('name-');
  const out = run(box, 'Keith');
  assert.equal(readFileSync(join(box, 'box-name'), 'utf8'), 'Keith');
  assert.match(readFileSync(join(box, 'profile.yaml'), 'utf8'), /^identity:\n  assistant_name: "Keith"$/m);
  assert.match(out, /OK: renamed to Keith/);
});

test('an existing assistant_name is replaced in place, never duplicated; idempotent', () => {
  const box = tmpDir('name-');
  writeFileSync(join(box, 'profile.yaml'), 'identity:\n  assistant_name: "Kai"\n  user_short: "Sam"\nbusiness:\n  customers: "coaches"\n');
  run(box, 'Keith');
  run(box, 'Keith');   // second run must change nothing further
  const t = readFileSync(join(box, 'profile.yaml'), 'utf8');
  assert.equal((t.match(/assistant_name:/g) || []).length, 1, 'one assistant_name line');
  assert.match(t, /assistant_name: "Keith"/);
  assert.match(t, /user_short: "Sam"/, 'neighbouring identity fields survive');
  assert.match(t, /customers: "coaches"/, 'the rest of the profile survives');
});

test('double quotes are stripped so a name cannot break its own YAML line', () => {
  const box = tmpDir('name-');
  run(box, 'Kei"th');
  assert.match(readFileSync(join(box, 'profile.yaml'), 'utf8'), /assistant_name: "Keith"/);
  assert.equal(readFileSync(join(box, 'box-name'), 'utf8'), 'Keith');
});

test('a profile with an identity block but no assistant_name gains the line inside it', () => {
  const box = tmpDir('name-');
  writeFileSync(join(box, 'profile.yaml'), 'identity:\n  user_short: "Sam"\n');
  run(box, 'Janet');
  const t = readFileSync(join(box, 'profile.yaml'), 'utf8');
  assert.match(t, /^identity:\n  assistant_name: "Janet"\n  user_short: "Sam"$/m);
});

test('box-up.sh runs the migration through the same script, marker-gated, box-name winning', () => {
  const sh = readFileSync(join(HERE, '..', 'box-up.sh'), 'utf8');
  assert.match(sh, /name-migrated/, 'one-shot marker present');
  assert.match(sh, /name-set\.mjs/, 'migration shares the dual-write script');
  const block = sh.split('one-name migration')[1] || '';
  assert.match(block, /\[ -f "\$BOX\/box-name" \]/, 'migration only fires when a box-name exists to win');
  assert.ok(block.indexOf('touch "$BOX/.kernel/name-migrated"') > -1, 'marker written even when names already agree');
});

test('the box-rename verb routes through name-set.mjs with the name as a shell word', async () => {
  const { MEMBER_VERBS } = await import('../../wizard/panel/panel-server.mjs');
  const cmd = MEMBER_VERBS['box-rename'].build({ name: 'Keith' }).command;
  assert.match(cmd, /node \/app\/engine\/box\/name-set\.mjs \/state/, 'verb shares the dual-write script');
  assert.ok(!cmd.includes('printf'), 'no second hand-rolled writer left behind');
});

test('console-state names a never-renamed box from its profile, and box-cockpit reads box-name first', async () => {
  const { MEMBER_VERBS } = await import('../../wizard/panel/panel-server.mjs');
  const cmd = MEMBER_VERBS['member-console-state'].build().command;
  assert.ok(cmd.includes('assistant_name'), 'console-state falls back to the assistant name');
  const cc = readFileSync(join(HERE, '..', 'cockpit', 'box-cockpit.mjs'), 'utf8');
  assert.match(cc, /box-name.*\|\|.*assistant_name|rd\(path\.join\(box, 'box-name'\)\)/, 'box-cockpit reads the box-name mirror first');
});
