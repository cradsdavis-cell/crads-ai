// cloud-init-size.test.mjs — the member user-data must fit Hetzner's 32 KiB cap.
// A real stamp on a real org blew this at 37923 B (2026-08-03), after the
// member's tunnel and DNS had already been created and had to be rolled back.
// These tests render the template the way provision-pebble.sh does and assert
// the arithmetic, so the payload cannot silently regrow past the budget again.
//
// 2026-08-14: the guard started blocking merges rather than regressions. Two
// sessions each added ONE line to the /etc/ai-os/env block (AIOS_ANCHOR_ORG,
// TZ=Australia/Sydney); each parent passed with 19 B and 2 B of headroom, and
// the merge was 35 B over. It was bought back by deleting a stale comment,
// which works exactly once. The structural fix is that the template's ~5 KiB of
// `#` prose stops riding to the box at all: provision-pebble.sh strips
// comment-only lines at render time (strip-cloud-init-comments.awk) and this
// file measures the STRIPPED render, so the number under the ceiling is the
// number that actually goes on the wire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TPL = path.join(HERE, 'cloud-init.template.yaml');
const STRIPPER = path.join(HERE, 'strip-cloud-init-comments.awk');
const PROVISION = path.join(HERE, 'provision-pebble.sh');
const HOST = path.join(HERE, '..', 'host');
const HOST_SCRIPTS = ['aios-host-update', 'enter-aios'];

const hostBlock = () => HOST_SCRIPTS.map((n) => {
  const gz = execFileSync('gzip', ['-9nc', path.join(HOST, n)]).toString('base64');
  return `  - path: /usr/local/bin/${n}\n    permissions: '0755'\n    encoding: gz+b64\n    content: ${gz}\n`;
}).join('');

// The real strip: the same awk program provision-pebble.sh pipes through, so a
// change to one is a change to both and this file can never be measuring a
// payload different from the one that ships.
const strip = (yaml) => execFileSync('awk', ['-f', STRIPPER], { input: yaml }).toString();

const splice = (yaml) => yaml.replace(/^ *#__HOST_SCRIPTS__ *$/m, hostBlock().replace(/\n$/, ''));
const rendered = () => splice(strip(readFileSync(TPL, 'utf8')));
// What the payload looked like before the strip, kept so the tests below can
// state what the strip bought and prove it changed nothing else.
const unstripped = () => splice(readFileSync(TPL, 'utf8'));

test('the host scripts exist as reviewable files, not inline blobs', () => {
  for (const n of HOST_SCRIPTS) {
    const p = path.join(HOST, n);
    assert.ok(existsSync(p), `${n} ships as a file under provisioning/host/`);
    assert.match(readFileSync(p, 'utf8'), /^#!/, `${n} is a real script`);
  }
  const tpl = readFileSync(TPL, 'utf8');
  assert.match(tpl, /#__HOST_SCRIPTS__/, 'the template splices them in');
  assert.doesNotMatch(tpl, /aios-host-update\n\s+permissions/, 'and no longer inlines them');
});

test('what we splice decodes back to the exact scripts (gz+b64 is cloud-init native)', () => {
  const ci = rendered();
  for (const n of HOST_SCRIPTS) {
    const m = ci.match(new RegExp(`  - path: /usr/local/bin/${n}\\n    permissions: '0755'\\n    encoding: gz\\+b64\\n    content: (\\S+)`));
    assert.ok(m, `${n} is spliced with an encoding cloud-init understands`);
    const back = gunzipSync(Buffer.from(m[1], 'base64')).toString();
    assert.equal(back, readFileSync(path.join(HOST, n), 'utf8'), `${n} round-trips byte for byte`);
  }
});

test('compressing the host scripts actually buys room', () => {
  const inline = HOST_SCRIPTS.reduce((n, s) => n + readFileSync(path.join(HOST, s), 'utf8').length, 0);
  assert.ok(hostBlock().length < inline, `spliced ${hostBlock().length} B < inline ${inline} B`);
});

// --- the strip is what provisioning does, not a thing this file invented -----
test('provision-pebble.sh renders THROUGH the stripper, and before substitution', () => {
  assert.ok(existsSync(STRIPPER), 'strip-cloud-init-comments.awk ships beside the template');
  const sh = readFileSync(PROVISION, 'utf8');
  assert.match(sh, /awk -f "\$STRIPPER" "\$HERE\/cloud-init\.template\.yaml"/,
    'the render pipeline starts at the stripper reading the committed template');
  assert.match(sh, /STRIPPER="\$HERE\/strip-cloud-init-comments\.awk"\n\[ -f "\$STRIPPER" \] \|\| die /,
    'and refuses to stamp from a checkout that is missing it');
  // Order matters: strip first means the awk only ever sees committed bytes, so
  // a password or tunnel token can never reach a line the stripper reasons about.
  assert.ok(sh.indexOf('awk -f "$STRIPPER"') < sh.indexOf('s|__PEBBLE_PASSWORD__|'),
    'the strip runs before the secrets are substituted in');
});

// --- what the strip must NOT take ---------------------------------------------
// Each of these is a live-boot failure, not a cosmetic one.
test('the strip keeps the format line, the splice markers, and in-file comments', () => {
  const out = strip(readFileSync(TPL, 'utf8'));

  // Lose this and Hetzner hands the VM a file cloud-init will not parse at all.
  assert.equal(out.split('\n')[0], '#cloud-config', 'the format declaration is still line 1');

  // Lose these and the box boots with no enter-aios, no aios-host-update, and
  // (on a seeded stamp) an empty brain: provision-pebble.sh splices onto them.
  for (const m of ['#__HOST_SCRIPTS__', '#__SEED_WRITE_FILES__', '#__SEED_RUNCMD__']) {
    assert.ok(out.includes(m), `${m} survives for the splice to find`);
  }

  // Comments inside a block scalar are FILE CONTENT on the box, not prose about
  // it. The allowed_signers file is the sharpest case: those four lines are the
  // only instructions an operator gets for arming the host-update channel, and
  // ssh-keygen -Y reads the file they live in.
  assert.match(out, /# allowed_signers for aios-host-update \(ssh-keygen -Y verify\)/,
    'the allowed_signers instructions still ship as the file body');
  assert.match(out, /#   updates@ai-os namespaces="aios-host-update" ssh-ed25519 AAAA\.\.\./,
    'including the example signer line an operator copies');
  assert.match(out, /# -> secrets\/box_reg_host/, '/etc/ai-os/env keeps its own comments');
  assert.match(out, /`\$\$` escapes the `\$`/, 'the ai-os.service unit keeps its inline explanation');
  assert.match(out, /# the sentinel's blob carries hyphens and fails base64/,
    "the runcmd shell blocks keep theirs (that one guards a member's SSH lockout)");
});

test('the strip removes comment lines and nothing else', () => {
  const before = unstripped().split('\n');
  const after = rendered().split('\n');
  // Every surviving line is present, in order, and byte-identical.
  let i = 0;
  const dropped = [];
  for (const line of before) {
    if (i < after.length && after[i] === line) { i += 1; continue; }
    dropped.push(line);
  }
  assert.equal(i, after.length, 'the stripped render is a subsequence of the unstripped one');
  assert.ok(dropped.length > 0, 'the strip actually did something');
  for (const line of dropped) {
    assert.match(line, /^[ \t]*#/, `only comment-only lines are dropped, got: ${JSON.stringify(line)}`);
  }
});

// The budget itself: base template + host scripts must leave real room for a
// seed. Measured on 2026-08-03: seeds run ~12.5 KiB (member) to ~14 KiB (org).
test('the rendered base leaves room for a real seed inside the 31000-byte budget', () => {
  const base = rendered().length;
  assert.ok(base < 17000, `base+scripts is ${base} B; over 17000 and a normal seed stops fitting`);
  assert.ok(base + 14100 <= 31000, `base ${base} B + a 14.1 KiB org-owned seed must stay inside 31000`);
});

// Headroom, stated as a number so the next reader does not have to rerun this to
// find out whether they can afford a line. This is the check that turned red on
// 2026-08-14 with 35 B to find; the strip is what put four figures back.
test('the strip is worth kilobytes, so a one-line addition is never the problem again', () => {
  const saved = unstripped().length - rendered().length;
  assert.ok(saved > 4000, `stripping comments must buy real room; it bought ${saved} B`);
  const headroom = 16900 - rendered().length;
  assert.ok(headroom > 3000,
    `only ${headroom} B under the ceiling: the template has regrown past what the strip bought, ` +
    'so trim the payload (write_files content, runcmd) rather than the comments, which no longer ship');
});
