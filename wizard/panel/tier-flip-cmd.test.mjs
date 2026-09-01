// tier-flip-cmd.test.mjs: the demote box-side flip must SURVIVE the shell.
// Run: node --test wizard/panel/tier-flip-cmd.test.mjs
//
// Why this file exists. The flip is a node one-liner built as a JS template
// literal and shipped to the box inside `node -e '...'`. Writing `+"\n"` in
// the template puts a REAL newline in the emitted command, inside a
// single-quoted JS string literal, which node refuses to parse:
//
//   fs.writeFileSync(f,JSON.stringify(j,null,2)+"
//   ");                                          <- SyntaxError
//
// So "Retire this rock" answered 500 with a raw node stack trace, because the
// route tests stub the bridge and assert on the ROUTE: nothing ever handed
// the built string to a shell. That is the gap this file closes: it EXECUTES
// the command the box would run.
//
// PROMOTE IS RETIRED (face collapse, 2026-09-01). promoteFlipCmd and
// PROMOTE_UNANCHOR_CMD are deleted with the whole brokered-promotion path:
// there is no directory to park a request with and no anchor to detach from.
// The executed-command coverage they had here becomes the retirement pin
// below. DEMOTE survives as the mineral-local "stop hosting" flip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMOTE_CMD } from './panel-server.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('the promote flip commands are RETIRED (2026-09-01): the exports stay gone', async () => {
  // A promoted rock was the hosted era's upgrade path; a self-hosted mineral
  // that wants to host initialises a commons instead. If either export comes
  // back, this file has to grow its executed-shell coverage back with it,
  // because the route tests still stub the bridge.
  const mod = await import('./panel-server.mjs');
  for (const gone of ['promoteFlipCmd', 'PROMOTE_UNANCHOR_CMD', 'PROMOTE_MINT_CMD',
    'promotePendingWriteCmd', 'PROMOTE_PENDING_CLEAR_CMD', 'PROMOTE_CONSENT']) {
    assert.equal(mod[gone], undefined, `${gone} must stay deleted`);
  }
});

// Run the flip command the way the box does: sh -c, with /state/ownership.json
// redirected at a temp file. The command hardcodes the real path, so the test
// rewrites just that literal; everything else, including the quoting under
// test, is byte-identical to what ships.
function runFlip(cmd, ownership) {
  const dir = tmpDir('flip-');
  const f = join(dir, 'ownership.json');
  writeFileSync(f, JSON.stringify(ownership, null, 2));
  const out = execFileSync('sh', ['-c', cmd.split('/state/ownership.json').join(f)], { encoding: 'utf8' });
  return { out: out.trim(), json: JSON.parse(readFileSync(f, 'utf8')) };
}

test('the emitted command carries no raw newline (the SyntaxError shape)', () => {
  assert.equal(DEMOTE_CMD.includes('\n'), false, 'the demote flip embeds a real newline in a quoted JS string');
});

test('demote flips a rock to a pebble and hands ownership back to the member', () => {
  // Since the face collapse the flip also clears the hosting-era ownership:
  // owner returns to "member" and the org handle is dropped, because a mineral
  // that stopped hosting is nobody's org asset. Everything else is untouched.
  const before = { owner: 'org', owner_slug: 'acme', managed_by: 'org', machinery_by: 'crads-ai', tier: 'rock', anchor: 'acme' };
  const { out, json } = runFlip(DEMOTE_CMD, before);
  assert.match(out, /demoted: this mineral is a pebble again, and yours/);
  assert.equal(json.tier, 'pebble');
  assert.equal(json.owner, 'member', 'ownership comes home with the flip');
  assert.equal('owner_slug' in json, false, 'no org handle survives on a personal mineral');
  assert.equal(json.managed_by, before.managed_by, 'the machinery fields are untouched');
  assert.equal(json.machinery_by, before.machinery_by);
  assert.equal(json.anchor, before.anchor);
});

test('demote is idempotent: an already-pebble exits 0 and says so', () => {
  const { out, json } = runFlip(DEMOTE_CMD, { owner: 'member', tier: 'pebble' });
  assert.match(out, /already a pebble/);
  assert.equal(json.tier, 'pebble');
});

test('the written file ends with a trailing newline (why the escape exists)', () => {
  const dir = tmpDir('flip-');
  const f = join(dir, 'ownership.json');
  writeFileSync(f, JSON.stringify({ tier: 'rock' }, null, 2));
  execFileSync('sh', ['-c', DEMOTE_CMD.split('/state/ownership.json').join(f)]);
  assert.equal(readFileSync(f, 'utf8').endsWith('}\n'), true);
});

// ---------------------------------------------------------------------------
// The arming phrase must match what the USER IS SHOWN. The seat renders
// "Type exactly: stop hosting" (the face collapse's rework of "retire this
// rock"), and a confirmation gate whose pass condition is invisible is not a
// gate, it is a dead end. The original bug was a CSS text-transform
// uppercasing the instruction while the check compared case-sensitively.
// Both ends must fold case, and both ends must agree on the phrase.

test('the stop-hosting gate accepts the phrase as the user sees it, both ends folding case', () => {
  const html = readFileSync(join(HERE, 'member.html'), 'utf8');
  assert.match(html, /Type exactly: <span[^>]*>stop hosting<\/span>/, 'the seat shows the phrase');
  const arm = html.match(/rtIn\.addEventListener\('input',[\s\S]{0,300}?\}\);/);
  assert.ok(arm, 'the arming handler must still exist');
  assert.match(arm[0], /toLowerCase\(\)/, 'client arming must fold case');
  assert.match(arm[0], /'stop hosting'/, 'against the phrase on screen');
  const srv = readFileSync(join(HERE, 'panel-server.mjs'), 'utf8');
  const check = srv.match(/form\.confirm[\s\S]{0,160}?stop hosting/);
  assert.ok(check, 'the server check must still exist');
  assert.match(check[0], /toLowerCase\(\)/, 'server check must fold case');
});
