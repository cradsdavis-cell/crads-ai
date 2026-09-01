#!/usr/bin/env node
// anchor-adopt.mjs — adopt a tie-anchored mineral into this rock's machinery
// (T6, 2026-08-10). Before this, approving an anchor ask wrote ONE directory
// edge and nothing else: no registry seat, no channel repos, no entitled
// catalogue, no billing hook — a tie-anchored pebble was invisible on the
// rock's fleet and starved on the member's Library. This script makes the
// app-made anchor end at the SAME place a rock-created member ends:
//
//   1. metal-ceiling precheck (an adopted mineral joins this rock's bill)
//   2. slug reconciliation — the asked slug is the member's local alias; a
//      collision renames the REGISTRY slug (-2..-9), never the mineral
//   3. registry row born from _TEMPLATE: owner "member", `attached:` today,
//      `wired:` empty until the keys land (anchor-reconcile.mjs sets it)
//   4. the two channel repos (factory/org-channel-repos.sh — NO deploy keys;
//      the mineral mints its own and sends up the public halves)
//   5. the non-secret wire bundle staged at the directory (/anchor-wire); the
//      member's app claims it once and wires the mineral
//
// Run from the brain root:
//   node orchestrator/anchor-adopt.mjs --result /tmp/rock-answer.out
//   node orchestrator/anchor-adopt.mjs --slug jane01 --email jane@example.com [--name 'Jane Doe']
// Idempotent: a re-run against an existing row for the SAME email re-stages
// the bundle and touches nothing else (error recovery, like stamp re-runs).
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveOrgGitHub, refusal, plainRemote, runGit } from '../factory/org-github.mjs';
import { setScalar } from '../registry/set-field.mjs';

const die = (m) => { console.error(`ERROR: ${m}`); process.exit(1); };
const args = process.argv.slice(2);
const argOf = (flag) => { const i = args.indexOf(flag); return i === -1 ? '' : String(args[i + 1] || ''); };

let asked = argOf('--slug');
let email = argOf('--email');
let typedName = argOf('--name');
const resultPath = argOf('--result');
if (resultPath) {
  let r;
  try { r = JSON.parse(readFileSync(resultPath, 'utf8')); } catch { die(`could not read the answer at ${resultPath}`); }
  if (r.decision && r.decision !== 'accept') die('that answer was not an accept; nothing to adopt');
  if (r.tie && r.tie !== 'anchored') die('that tie is joined, not anchored; a joined member needs no adoption');
  asked = asked || String(r.slug || '');
  email = email || String(r.email || '');
  // The anchor-LATER answer carries no name today: /rock-tie-result hands back
  // decision, tie, slug and (on an anchored accept) the email, and the
  // rocktiereq record it reads never stored one. Read it anyway so the day the
  // directory carries it this path stops being the odd one out.
  typedName = typedName || String(r.name || '');
}
if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(asked)) die(`that slug does not look right: "${asked}"`);
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) die('a member email is required (the directory hands it back on an anchored accept)');
email = email.toLowerCase();
// THE NAME THE OPERATOR TYPED, CARRIED (finding 155, 2026-08-16). This script
// took only --slug and --email, so display_name was written from the email's
// local part and the name actually typed on the rock ("QA Member Five") lived
// nowhere but the sent invite: every anchor-adopted row on the live rock read
// as a local part, and the directory holds label:"" on both the mineral and the
// box registration, so it was not recoverable anywhere else either. The
// rock-initiated path knows it (pebble-request.mjs has it from the form) and
// now hands it over. The local part stays the FALLBACK, never a refusal: the
// anchor-later path still has no name to give.
const localPart = email.split('@')[0];
// Quotes, backslashes and control characters would break out of the YAML scalar
// this is written into; length capped like brain_name is on the ask. Accents and
// non-Latin scripts are NOT stripped: this is a person's name, and the sibling
// sanitiser next door (auto-approve.mjs, finding 116) can flatten to printable
// ASCII only because what it holds is a machine name.
const cleanName = typedName.replace(/[\u0000-\u001f\u007f"\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
const displayName = cleanName || localPart;

const root = process.cwd();
const rd = (p) => { try { return readFileSync(path.join(root, p), 'utf8'); } catch { return ''; } };

const pol = rd('org-policy.yaml');
const ORG = ((pol.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m) || [])[1] || '').trim();
const DISPLAY = ((pol.match(/^org:\s*$[\s\S]*?^\s+display(?:_name)?:\s*"?([^"\n#]*)"?/m) || [])[1] || '').trim() || ORG;
if (!ORG) die('this brain has no org name in org-policy.yaml; is it a rock?');
const env = rd('.env');
const envOf = (k) => ((env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || '').trim();
// the ONE resolver (org-github.mjs): explicit env, brain .env, legacy names,
// staged provisioning, then the box's own connected GitHub — never a
// hand-rolled chain here
const ghId = resolveOrgGitHub({ brainRoot: root });
if (!ghId.ok) die(refusal({ what: 'adopt this mineral (its channel repos must live on an account the organisation owns)' }));
const GH_OWNER = ghId.owner;
const GH_TOKEN = ghId.token;
// (ORG_PULL_TOKEN / CRADS_DIRECTORY_URL are no longer read here: the wire was
// staged at the central directory, which is deleted — self-host strip,
// 2026-09-01. The registry seat and the channel repos below are the whole
// adoption now; wiring the mineral is a local act.)

const membersDir = path.join(root, 'registry', 'members');
const rowEmail = (text) => ((text.match(/^email:\s*"?([^"\n#]*)"?/m) || [])[1] || '').trim().toLowerCase();

// ---- slug reconciliation: same email = same member (idempotent re-run) -----
let slug = '';
let existingRow = '';
for (let i = 1; i <= 9; i += 1) {
  const cand = i === 1 ? asked : `${asked}-${i}`;
  const p = path.join(membersDir, `${cand}.yaml`);
  if (!existsSync(p)) { slug = cand; break; }
  if (rowEmail(readFileSync(p, 'utf8')) === email) { slug = cand; existingRow = p; break; }
}
if (!slug) die(`every slug from ${asked} to ${asked}-9 is taken by someone else; pick a different alias with the member`);
if (slug !== asked) console.log(`slug: "${asked}" is taken here; this member's registry seat is "${slug}" (their mineral keeps its own name)`);

// ---- metal ceiling: only a genuinely NEW row faces it ----------------------
if (!existingRow) {
  try {
    execFileSync(process.execPath, [path.join(root, 'factory', 'metal-ceiling.mjs'),
      '--dir', membersDir, '--ceiling', process.env.AIOS_METAL_CEILING || '5'], { stdio: 'pipe' });
  } catch (e) {
    if (existsSync(path.join(root, 'factory', 'metal-ceiling.mjs'))) {
      die('metal ceiling reached: adopting this mineral would put the rock past its ceiling; no adoption until a member leaves or the ceiling is raised deliberately');
    } // an older brain without the guard adopts without it
  }
}

// ---- the registry row: born from _TEMPLATE once, never regenerated ---------
const today = new Date().toISOString().slice(0, 10);
if (!existingRow) {
  const tplPath = path.join(membersDir, '_TEMPLATE.yaml');
  if (!existsSync(tplPath)) die('registry/members/_TEMPLATE.yaml is missing; this brain predates the registry');
  let row = readFileSync(tplPath, 'utf8');
  // A FUNCTION REPLACEMENT, NEVER A STRING (2026-08-16, found reviewing the
  // finding-155 fix before it shipped). String.replace re-reads $&, $', $` and
  // $1 out of the REPLACEMENT text, so a value containing them is not inserted,
  // it is re-expanded from the match. The name fix below strips quotes from what
  // the operator typed, and "Tom $& Jerry" then put the quotes straight back:
  //   display_name: ""  ->  display_name: "Tom display_name: "" Jerry"
  // and "$'" spliced the whole rest of the template into the scalar. Escaping
  // the input cannot fix this, because the injected text comes from the file
  // being edited. Every value written through here (name, email, slug, owner)
  // is now a literal.
  const set = (re, to) => { row = row.replace(re, () => to); };
  set(/^slug: ""/m, `slug: "${slug}"`);
  set(/^member_id: ""/m, `member_id: "m-${slug}"`);
  set(/^display_name: ""/m, `display_name: "${displayName}"`);
  set(/^email: ""/m, `email: "${email}"`);
  set(/^anchor: org/m, `anchor: ${ORG}`);
  set(/^  - org$/m, `  - ${ORG}`);
  set(/^managed_by: "org"/m, 'managed_by: "member"');
  set(/^inbox_repo: ""/m, `inbox_repo: "${GH_OWNER}/inbox-${slug}"`);
  set(/^  repo: ""/m, `  repo: "inbox-${slug}"`);
  set(/^  created: ""/m, `  created: "${today}"`);
  set(/^  joined: ""/m, `  joined: "${today}"`);
  // the adoption pair (T6): attached = the seat exists; wired = the channel
  // keys landed (anchor-reconcile.mjs flips it). A row attached-but-not-wired
  // for long is the reconcile cron's cue to re-stage the wire bundle.
  row += `\n# anchor adoption (T6): this member arrived by anchoring their own mineral\nattached: "${today}"\nwired: ""\n`;
  writeFileSync(path.join(membersDir, `${slug}.yaml`), row);
  console.log(`registry: ${slug} adopted (attached ${today}, owner member; their mineral, this rock's anchor)`);
} else {
  // Re-adoption revives a departed row (same email = same member). Without
  // this, a member who left properly and anchors again later keeps status
  // "left" forever: anchor-reconcile skips left rows, so the wire never
  // lands. Arrival supersedes departure here exactly as in the marker scrub.
  let row = readFileSync(existingRow, 'utf8');
  let changed = false;
  // A row written before this script carried a name holds the email's local
  // part, and every anchor-adopted row on the live rock was in that state
  // (finding 155). Upgrading it is safe precisely because the placeholder is
  // OUR OWN output: a name an operator set by hand is not the local part of
  // their address, and in the one case where it happens to be, the typed name
  // is the same string anyway. Nothing else on the row is touched: a re-run has
  // never regenerated it and must not start now.
  const currentName = ((row.match(/^display_name:\s*"?([^"\n#]*)"?/m) || [])[1] || '').trim();
  if (cleanName && cleanName !== currentName && (!currentName || currentName === localPart)) {
    // setScalar, not a hand-rolled replace: it is this brain's ONE row writer
    // ("touch the one line you mean, leave every other byte alone"), it carries
    // the literal-insert rule, and it APPENDS a key that is missing rather than
    // silently matching nothing, which a bare replace on a row with no
    // display_name line would have done while still reporting the change.
    row = setScalar(row, 'display_name', cleanName);
    changed = true;
    console.log(`registry: ${slug} is "${cleanName}" (the row carried the email's local part)`);
  }
  if (/^status: "left"/m.test(row)) {
    row = row.replace(/^status: "left"/m, 'status: "active"')
      .replace(/^( {2}left:) ".*"/m, '$1 ""')
      .replace(/^attached: ".*"/m, `attached: "${today}"`)
      .replace(/^wired: ".*"/m, 'wired: ""');
    changed = true;
    console.log(`registry: ${slug} REVIVED (they left once; they are anchoring again, attached ${today})`);
  } else {
    // (this used to say "re-staging the wire only"; there is no wire to
    // re-stage since the self-host strip, so a same-email re-run is a no-op)
    console.log(`registry: ${slug} already adopted; nothing to change`);
  }
  if (changed) writeFileSync(existingRow, row);
}

// ---- channel repos (no deploy keys on this path) ---------------------------
try {
  const out = execFileSync('sh', [path.join(root, 'factory', 'org-channel-repos.sh'), slug],
    { env: { ...process.env, ORG_GH_OWNER: GH_OWNER, ORG_GH_TOKEN: GH_TOKEN }, encoding: 'utf8' });
  process.stdout.write(out);
} catch (e) {
  const err = String(e.stderr || e.message || e).trim();
  // a dead credential names its SOURCE, not a misleading downstream symptom
  // (found live on keith: a revoked connected-account token surfaced as
  // "repository not found" three layers later)
  if (/Bad credentials|HTTP 401/i.test(err)) {
    die(`the GitHub credential is stale or revoked (it came from ${ghId.from}). `
      + `Run connect-github on this rock to re-authorize, then run this again. Nothing was created.`);
  }
  die(`could not create the channel repos: ${err.slice(0, 300)}`);
}

// ---- scrub stale departure markers (found live on keith, 2026-08-10) -------
// The channel repos are created idempotently, so an adoption can REUSE repos
// from this member's earlier life here — and an old heartbeat repo can still
// carry the leave.json from how that life ENDED. leave-reconcile then reads
// the ghost on its next pass and flips the fresh seat to "left", so the wire
// stalls on a departure that predates the arrival. A member arriving by
// definition supersedes any old departure: scrub the markers at adoption,
// best-effort (a scrub failure only means the ghost may bite until the next
// adopt re-run; adoption itself must not die over history).
try {
  const W = path.join('/tmp', `hb-scrub-${slug}`);
  execFileSync('rm', ['-rf', W]);
  // runGit, never a raw execFileSync: it carries the credential helper AND
  // GIT_TERMINAL_PROMPT=0. A raw clone of a tokenless URL makes git ASK for a
  // username on stdin, and with stdio piped that blocks forever — adoption
  // hung exactly here on the live cert, with the reconcile behind it never
  // getting its turn (2026-08-10).
  runGit(['clone', '-q', '--depth', '1', plainRemote(GH_OWNER, `heartbeat-${slug}`), W], { token: GH_TOKEN });
  let scrubbed = false;
  for (const marker of [['rm', '-q', 'leave.json'], ['rm', '-q', '-r', 're-anchor']]) {
    try { runGit(['-C', W, ...marker], { token: GH_TOKEN }); scrubbed = true; } catch { /* not present */ }
  }
  if (scrubbed) {
    runGit(['-C', W, '-c', 'user.name=Adopt', '-c', 'user.email=adopt@rock.local',
      'commit', '-q', '-m', `adopt: ${slug} arrived; stale departure markers superseded`], { token: GH_TOKEN });
    runGit(['-C', W, 'push', '-q'], { token: GH_TOKEN });
    console.log(`heartbeat: stale departure markers scrubbed (this member's earlier leave is history, not state)`);
  }
  execFileSync('rm', ['-rf', W]);
} catch { console.log('WARN: could not check the heartbeat repo for stale leave markers; if the seat flips to left, scrub leave.json from it by hand'); }

// ---- the wire bundle is NOT staged anywhere (self-host strip, 2026-09-01) --
// This used to POST { inbox_repo, heartbeat_repo, pull_token, org_contact } to
// the central directory's /anchor-wire for the member's box to claim. The
// directory is deleted and the box-side claimer (anchor-claim.mjs) went with
// it, so the channel repos above ARE the adoption artefact: hand the member
// their repo names and deploy-key instructions directly, or let the commons
// model's local wiring take over when it lands.

// ---- index + commit (fail-soft: the row on disk is already the truth) ------
try { execFileSync(process.execPath, [path.join(root, 'registry', 'build-index.mjs')], { cwd: root, stdio: 'pipe' }); }
catch { console.log('WARN: registry/build-index.mjs did not run; the index catches up on the next reconcile'); }
try {
  execFileSync('git', ['add', 'registry/'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=Panel', '-c', 'user.email=panel@rock.local',
    'commit', '-q', '-m', `adopt: ${slug} anchored their own mineral (attached ${today})`], { cwd: root, stdio: 'pipe' });
  try { runGit(['push', '-q', 'origin', 'HEAD'], { cwd: root, token: GH_TOKEN }); }
  catch { console.log('WARN: the adoption commit is local only (push failed); the next authed push carries it'); }
} catch { /* nothing to commit: idempotent re-run */ }

console.log(`OK: ${slug} is adopted: registry seat + channel repos exist. There is no central wire staging any more; connect their mineral to ${GH_OWNER}/inbox-${slug} and ${GH_OWNER}/heartbeat-${slug} locally.`);
