// injection.test.mjs — operator and member TEXT must never be re-parsed as shell.
//
// The file's own contract (top of panel-server.mjs) is that the browser never
// sends shell: every command is built server-side from validated args. Three
// places broke it, all the same way. shq() produces a safe standalone shell WORD
// (single-quoted, inner quotes escaped), and each of these took that word and
// pasted it INSIDE another quoted context, where the quoting no longer holds:
//
//   * box-rename  -> inside a double-quoted echo, so $(...) ran
//   * member-set-status pause reason -> inside a single-quoted sed script, where
//     an apostrophe closes the quote and the rest concatenates
//   * console-answer note -> inside a double-quoted curl body
//
// All three verified by running the built fragment before the fix. The pause one
// was the nastiest: the injected command ran AND sed still got a valid script, so
// the pause succeeded and nothing looked wrong.
//
// These tests EXECUTE the built commands against a temp file rather than pattern
// matching them, because the whole class is about what a shell does with a string,
// not what the string looks like.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MEMBER_VERBS } from './panel-server.mjs';
import { tmpDir } from '../../tests/tmp-dir.mjs';

// A payload that writes a marker file if the shell ever evaluates it.
const withMarker = (dir) => {
  const marker = join(dir, 'INJECTED');
  return { marker, payload: `ok$(touch ${marker})` };
};

test('box-rename: a name containing $(...) is stored, never executed', () => {
  const dir = tmpDir('inj-rename-');
  const { marker, payload } = withMarker(dir);
  // The verb routes through the one-name dual-writer (2026-08-09); point its
  // box-image paths at this repo + a temp box so the built command still RUNS.
  const cmd = MEMBER_VERBS['box-rename'].build({ name: payload }).command
    .replaceAll('/app/engine/box/name-set.mjs', join(import.meta.dirname, '..', '..', 'engine', 'box', 'name-set.mjs'))
    .replaceAll(' /state ', ` ${dir} `);
  const out = execFileSync('bash', ['-c', cmd], { encoding: 'utf8' });

  assert.ok(!existsSync(marker), 'the command substitution must NOT run');
  assert.equal(readFileSync(join(dir, 'box-name'), 'utf8'), payload, 'the literal name is what gets stored');
  assert.ok(readFileSync(join(dir, 'profile.yaml'), 'utf8').includes(payload), 'the assistant name matches (one-name ruling)');
  assert.match(out, /OK: renamed to/, 'and the confirmation still prints');
  assert.ok(out.includes(payload), 'echoing the name back is fine, executing it is not');
});

// The pause-reason injection test died with pause itself (ruling 2026-08-10:
// member-set-status is resume-only). The surviving injection surface is the
// legacy-reason CLEAR on release, proven below: same argv-not-sed shape, same
// reason it exists (an apostrophe used to close the sed quote and execute).


test('console-answer is RETIRED (2026-09-01): the verb, and its injection surface, stay gone', () => {
  // Its two tests ran the node-built request-body fragment and proved a note
  // could never reach the shell. The face collapse deleted the verb with the
  // rest of the directory machinery (invite-member, rock-state, rock-answer,
  // rock-tie-end, console-request, console-withdraw, org-topology-state), so
  // there is no body to build and no curl for a note to ride. The lesson
  // survives in the structural lexer test below, which walks every verb that
  // still exists; this pin holds that none of the deleted ones come back
  // quietly, because each was a fresh chance to nest a shq word in "...".
  for (const verb of ['console-answer', 'invite-member', 'rock-state', 'rock-answer',
    'rock-tie-end', 'console-request', 'console-withdraw', 'org-topology-state']) {
    assert.ok(!(verb in MEMBER_VERBS), `${verb} stays out of the one verb table`);
  }
});


// A small POSIX-quoting lexer: is index `target` inside a double-quoted region?
//
// Two corrections went into this, both caught by the negative control below,
// which is the whole reason it exists. First attempt counted unescaped double
// quotes and flagged two safe verbs, because a `"` inside a SINGLE-quoted region
// is a literal. Second attempt only honoured backslash escapes INSIDE double
// quotes, so it mis-parsed the `\'` that shq itself emits outside them. A guard
// that cries wolf gets deleted, and one that misses the bug is decoration.
function stateAt(str, target) {
  let sq = false, dq = false;
  for (let i = 0; i < str.length; i += 1) {
    if (i === target) return { sq, dq };
    const c = str[i];
    if (!sq && c === '\\') { i += 1; continue; }   // backslash escapes everywhere except in ''
    if (c === "'" && !dq) { sq = !sq; continue; }
    if (c === '"' && !sq) { dq = !dq; continue; }
  }
  return { sq, dq };
}

test('the nesting lexer actually detects the bug it is looking for', () => {
  // Negative control, using the REAL pre-fix box-rename shape.
  const buggy = `printf '%s' 'x'\\''y' > /state/box-name && echo "OK: renamed to 'x'\\''y'"`;
  const first = buggy.indexOf("'\\''");
  const second = buggy.indexOf("'\\''", first + 1);
  assert.ok(first !== -1 && second !== -1, 'both shq escapes located');
  assert.equal(stateAt(buggy, first).dq, false, 'the printf argument is a bare word');
  assert.equal(stateAt(buggy, second).dq, true, 'the echo copy is nested, and that was the hole');
});

test('no verb pastes a shq-quoted value inside a double-quoted string', () => {
  // The structural version of the three bugs above: shq's guarantee is "safe as a
  // standalone word", and it evaporates the moment the word is nested in "...".
  const ARGS = {
    slug: 'jane01', confirm: 'jane01', name: "x'y", label: "x'y", note: "x'y", reason: "x'y",
    id: 'a'.repeat(32), answer: 'declined', kind: 'ask-read', status: 'paused',
    skill_id: 'sk', org: 'other-org', page: 'a.md', role: 'admin', email: 'a@b.c',
    pubkey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForTheTestOnly0 t',
  };
  const offenders = [];
  for (const [table, V] of [['member', MEMBER_VERBS]]) {
    for (const [name, spec] of Object.entries(V)) {
      let cmd;
      try { cmd = spec.build({ ...ARGS })?.command || ''; } catch { continue; }
      // Every place shq had to escape a quote: the exact spot the old bugs lived.
      for (let i = cmd.indexOf("'\\''"); i !== -1; i = cmd.indexOf("'\\''", i + 1)) {
        if (stateAt(cmd, i).dq) { offenders.push(`${table}:${name}`); break; }
      }
    }
  }
  assert.deepEqual(offenders, [], `shq value nested in a double-quoted string: ${offenders.join(', ')}`);
});
