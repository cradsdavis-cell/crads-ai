// is-main.test.mjs: the CLI-tail guard must be FALSE inside a single
// executable (argv[1] is the binary itself) and TRUE only for the one script
// node was asked to run. Run: node --test engine/lib/is-main.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain } from './is-main.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const here = new URL('./is-main.mjs', import.meta.url).href;

test('false inside a single executable: argv[1] is the binary, and so is every bundled module', () => {
  const bin = '/Users/x/Crads-AI.app/Contents/MacOS/crads-ai';
  assert.equal(isMain(pathToFileURL(bin).href, { argv1: bin, execPath: bin }), false);
  // a relative argv[1] resolves to the same binary
  const local = join(process.cwd(), 'crads-ai');
  assert.equal(isMain(pathToFileURL(local).href, { argv1: './crads-ai', execPath: local }), false);
});

test('true only for the script node was asked to run', () => {
  const node = process.execPath;
  assert.equal(isMain(here, { argv1: new URL(here).pathname, execPath: node }), true);
  assert.equal(isMain(here, { argv1: join(process.cwd(), 'something-else.mjs'), execPath: node }), false);
  assert.equal(isMain(here, { argv1: undefined, execPath: node }), false);
  assert.equal(isMain('not a url', { argv1: '/x/y.mjs', execPath: node }), false);
});

test('the two engine CLIs still answer from a dev checkout (page-delete usage, skills-list snapshot)', () => {
  const root = new URL('../../', import.meta.url);
  const pd = spawnSync(process.execPath, [join(root.pathname, 'engine/appshell/page-delete.mjs')], { encoding: 'utf8' });
  assert.equal(pd.status, 1);
  assert.match(pd.stdout, /usage: page-delete\.mjs/);
  const state = tmpDir('is-main-state-');
  writeFileSync(join(state, 'keep'), '');
  const sl = spawnSync(process.execPath, [join(root.pathname, 'engine/appshell/skills-list.mjs'), state], { encoding: 'utf8' });
  assert.equal(sl.status, 0);
  assert.match(sl.stdout, /^SKILLS_STATE \{/m);
});

test('importing the two CLI modules does not run their tails', () => {
  // this test file is argv[1]; the modules under test are not
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(new URL('../appshell/page-delete.mjs', import.meta.url).href)});
     await import(${JSON.stringify(new URL('../appshell/skills-list.mjs', import.meta.url).href)});
     console.log('imported quietly');`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'imported quietly');
});
