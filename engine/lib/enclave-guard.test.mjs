// engine/lib/enclave-guard.test.mjs — PreToolUse hook denies enclave paths, allows the rest.
// Run: node --test engine/lib/enclave-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'enclave-guard.mjs');

function runGuard(payload, protectedPaths) {
  return new Promise((resolve) => {
    const pebble = spawn('node', [GUARD, ...protectedPaths], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    pebble.stderr.on('data', (d) => { err += d; });
    pebble.on('close', (code) => resolve({ code, err }));
    pebble.stdin.end(JSON.stringify(payload));
  });
}

test('denies Read of a protected absolute path', async () => {
  const r = await runGuard(
    { tool_name: 'Read', tool_input: { file_path: '/state/wiki/personal/salary.md' } },
    ['/state/wiki/personal', 'wiki/personal']
  );
  assert.equal(r.code, 2);
  assert.match(r.err, /enclave-guard: blocked/);
});

test('denies Grep whose path sneaks the enclave in via pattern field', async () => {
  const r = await runGuard(
    { tool_name: 'Grep', tool_input: { pattern: 'salary', path: 'wiki/personal' } },
    ['/state/wiki/personal', 'wiki/personal']
  );
  assert.equal(r.code, 2);
});

test('denies Bash command that references the enclave', async () => {
  const r = await runGuard(
    { tool_name: 'Bash', tool_input: { command: 'cat /state/wiki/personal/salary.md' } },
    ['/state/wiki/personal', 'wiki/personal']
  );
  assert.equal(r.code, 2);
});

test('allows Read of a normal wiki page', async () => {
  const r = await runGuard(
    { tool_name: 'Read', tool_input: { file_path: '/work/wiki/projects/acme.md' } },
    ['/state/wiki/personal', 'wiki/personal']
  );
  assert.equal(r.code, 0);
});

test('allows on malformed stdin (fail-open is fine: snapshot already excludes enclave)', async () => {
  const pebble = spawn('node', [GUARD, '/state/wiki/personal'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const done = new Promise((resolve) => pebble.on('close', resolve));
  pebble.stdin.end('not json');
  assert.equal(await done, 0);
});
