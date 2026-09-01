#!/usr/bin/env node
// anchor-reconcile.mjs — finish wiring adopted minerals (T6, 2026-08-10).
// The second half of anchor adoption. anchor-adopt.mjs left a registry row
// `attached:` with `wired:` empty and staged a wire bundle at the directory;
// the member's mineral claimed the bundle, minted BOTH deploy keypairs on its
// own disk, and posted the PUBLIC halves to /anchor-pubkeys. This applier:
//
//   1. polls /anchor-pubkeys for this org (org token)
//   2. registers each pair on the member's two channel repos
//      (inbox = read-only, heartbeat = read-write — the stamp-pebble split)
//   3. flips the row's `wired:` to today (+ fills box.host if empty),
//      consumes the directory record, and lets catalog-reconcile (which runs
//      after this in reconcile-all) deliver the first entitled catalogue
//   4. re-stages the wire for any row attached > 1h and still unwired with no
//      keys arrived — the one-time claim was lost (a failed apply, a wiped
//      app); the bundle is non-secret and re-staging is free
//
// Fail-soft and unattended like every applier: one bad row never stops the
// rest. Runs from reconcile-all on the rock's scheduler cadence.
// SELF-HOST STRIP (2026-09-01): the central directory this script spoke to
// (directory.crads-ai.com) is deleted, along with the account system. It exits
// here — silently, 0 — so a rock that syncs this machinery on boot stops
// phoning a dead service on its reconcile cadence. The body below is kept for
// reference until the commons model replaces this leg. Authored upstream in
// brain-template; keep the two copies identical.
process.exit(0);

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveOrgGitHub, runGit } from '../factory/org-github.mjs';

const root = process.cwd();
const rd = (p) => { try { return readFileSync(path.join(root, p), 'utf8'); } catch { return ''; } };
const pol = rd('org-policy.yaml');
const ORG = ((pol.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m) || [])[1] || '').trim();
const env = rd('.env');
const envOf = (k) => ((env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || '').trim();
const PULL = envOf('ORG_PULL_TOKEN');
const DIR = envOf('CRADS_DIRECTORY_URL') || process.env.CRADS_DIRECTORY_URL || 'https://directory.crads-ai.com';
if (!ORG || !PULL) { console.log('anchor-reconcile: not a rock with a directory token; nothing to do'); process.exit(0); }
// the ONE resolver: an applier with no resolvable identity waits quietly —
// the owner connects GitHub once and the next round wires everything
const ghId = resolveOrgGitHub({ brainRoot: root });
if (!ghId.ok) { console.log('anchor-reconcile: no org GitHub identity resolves yet (run connect-github); waiting'); process.exit(0); }
const GH_OWNER = ghId.owner;
const GH_TOKEN = ghId.token;

const membersDir = path.join(root, 'registry', 'members');
const field = (text, name) => ((text.match(new RegExp(`^${name}:\\s*"?([^"\\n#]*)"?`, 'm')) || [])[1] || '').trim();

// every adopted-but-unwired row, keyed by slug
const unwired = new Map();
for (const f of (existsSync(membersDir) ? readdirSync(membersDir) : [])) {
  if (!f.endsWith('.yaml') || f.startsWith('_')) continue;
  const text = readFileSync(path.join(membersDir, f), 'utf8');
  if (field(text, 'attached') && !field(text, 'wired') && field(text, 'status') !== 'left') {
    unwired.set(field(text, 'slug') || f.replace(/\.yaml$/, ''), { file: path.join(membersDir, f), text });
  }
}
// ONE INBOX (spec 2026-08-17 § 3): a JOINED tie is wired by this same applier,
// and it has no seat row. Without this loop its posted keys hit the
// `if (!seat) continue` below and are skipped every round forever, with the
// log line saying they belong to another org: a joined member would sit
// unwired permanently and nothing on any screen would say why. Ties are read
// from registry/ties/, written by tie-reconcile.mjs.
//
// A SEAT WINS on a slug collision, the same rule tie-reconcile applies from the
// other side: if the person is hosted here, the seat is the record that carries
// their billing and status, and a tie record beside it must not be the thing
// this marks wired.
const tiesDir = path.join(root, 'registry', 'ties');
for (const f of (existsSync(tiesDir) ? readdirSync(tiesDir) : [])) {
  if (!f.endsWith('.json') || f.startsWith('_')) continue;
  let rec;
  try { rec = JSON.parse(readFileSync(path.join(tiesDir, f), 'utf8')); } catch { continue; }
  const slug = String(rec.slug || f.replace(/\.json$/, ''));
  if (rec.wired || unwired.has(slug)) continue;
  unwired.set(slug, { file: path.join(tiesDir, f), tie: true, rec });
}

if (!unwired.size) { console.log('anchor-reconcile: no adopted minerals waiting'); process.exit(0); }

const auth = { authorization: `Bearer ${PULL}`, 'content-type': 'application/json' };
let rows = [];
try {
  const r = await fetch(`${DIR}/anchor-pubkeys?org=${encodeURIComponent(ORG)}`, { headers: auth });
  const b = await r.json();
  if (r.ok && Array.isArray(b.pubkeys)) rows = b.pubkeys;
  else console.log(`anchor-reconcile: the directory said ${r.status}; retrying next round`);
} catch (e) { console.log(`anchor-reconcile: directory unreachable (${String(e.message || e).slice(0, 80)}); retrying next round`); }

const today = new Date().toISOString().slice(0, 10);
const gh = (argsArr) => execFileSync('gh', argsArr, {
  env: { ...process.env, GH_TOKEN: GH_TOKEN || process.env.GH_TOKEN || '' }, stdio: 'pipe', encoding: 'utf8' });

let wiredCount = 0;
// A STAMPED member got its two channel repos from stamp-pebble.sh. An ADOPTED
// one never went through the factory, so nobody has created them, and
// registering a deploy key on a repository that does not exist 404s every round
// forever: the mineral stays unwired, never checks in, and the rock's card says
// "never checked in (no heartbeat yet)" with no explanation anywhere. Found on
// keith (2026-08-10) before the first adopted mineral posted its keys.
//
// Same idempotent shape stamp-pebble uses: view, else create. Private, and only
// ever under the org's OWN owner.
function ensureChannelRepos(slug) {
  for (const name of [`inbox-${slug}`, `heartbeat-${slug}`]) {
    try { gh(['repo', 'view', `${GH_OWNER}/${name}`]); continue; } catch { /* not there yet */ }
    gh(['repo', 'create', `${GH_OWNER}/${name}`, '--private', '-y']);
    console.log(`anchor-reconcile: created ${GH_OWNER}/${name} (adopted mineral, never stamped)`);
  }
}

for (const row of rows) {
  const seat = unwired.get(String(row.slug || ''));
  if (!seat) continue;   // keys for a row this brain does not hold; leave for the org that does
  try { ensureChannelRepos(row.slug); }
  catch (e) {
    const err = String(e.stderr || e).split('\n')[0];
    if (/Bad credentials|HTTP 401/i.test(String(e.stderr || e))) {
      console.log(`anchor-reconcile: the GitHub credential is stale or revoked (from ${ghId.from}); run connect-github on this rock. Waiting.`);
      break;   // one dead credential blocks every row the same way; say it once
    }
    console.log(`anchor-reconcile: could not create the channels for ${row.slug} (${err}); next round`); continue;
  }
  try {
    gh(['api', '-X', 'POST', `repos/${GH_OWNER}/inbox-${row.slug}/keys`,
      '-f', 'title=mineral-ro', '-F', 'read_only=true', '-f', `key=${row.inbox_pub}`]);
  } catch (e) { if (!/already in use/i.test(String(e.stderr || e))) { console.log(`anchor-reconcile: inbox key for ${row.slug} failed; next round`); continue; } }
  try {
    gh(['api', '-X', 'POST', `repos/${GH_OWNER}/heartbeat-${row.slug}/keys`,
      '-f', 'title=mineral-rw', '-F', 'read_only=false', '-f', `key=${row.heartbeat_pub}`]);
  } catch (e) { if (!/already in use/i.test(String(e.stderr || e))) { console.log(`anchor-reconcile: heartbeat key for ${row.slug} failed; next round`); continue; } }
  // A tie is a JSON record, not a YAML seat: same meaning of wired, different
  // file shape. Everything above this point (repos, both keys, the consume ack)
  // is identical for the two, which is the whole point of one-inbox.
  if (seat.tie) {
    const rec = { ...seat.rec, wired: today };
    const host = String(row.box_host || '').replace(/[\u0000-\u001f\u007f"\\]/g, '').trim().slice(0, 80);
    if (host && !rec.box_host) rec.box_host = host;
    writeFileSync(seat.file, JSON.stringify(rec, null, 2) + '\n');
    unwired.delete(String(row.slug));
    try { await fetch(`${DIR}/anchor-pubkeys-consume`, { method: 'POST', headers: auth, body: JSON.stringify({ org: ORG, e: row.e, slug: String(row.slug) }) }); }
    catch { /* consumed next round */ }
    wiredCount += 1;
    console.log(`anchor-reconcile: ${row.slug} WIRED (joined tie; both keys registered)`);
    continue;
  }
  let text = seat.text.replace(/^wired: ""/m, `wired: "${today}"`);
  if (row.box_host && /^ {2}host: ""/m.test(text)) {
    // Same two rules as the display-name write in anchor-adopt.mjs, and for the
    // same reason (2026-08-16). box_host is whatever the app relayed to
    // /anchor-pubkeys, bounded to 80 characters there and nothing else, so it is
    // sanitised HERE for the YAML scalar; and the insert is a FUNCTION, because
    // a string replacement re-reads $& out of the replacement text and would put
    // back the very quote this line strips.
    const host = String(row.box_host).replace(/[\u0000-\u001f\u007f"\\]/g, '').trim().slice(0, 80);
    if (host) text = text.replace(/^ {2}host: ""/m, () => `  host: "${host}"`);
  }
  writeFileSync(seat.file, text);
  unwired.delete(String(row.slug));
  // ACK THE MINERAL, NOT THE PERSON (finding 153, 2026-08-16). Without a slug
  // the directory reads this as "I have registered everything you gave me for
  // this address" and deletes every anchorpub row under that email hash. A
  // member with two pebbles on this rock therefore had the SECOND pebble's
  // freshly posted keys thrown away the moment the first was wired. The GET
  // hands the slug back on every row; name it.
  //
  // How bad that was depends on the box, and the answer changed the same day:
  // an engine before ai-os a5fa22e treated its keys-sent marker as "never ask
  // again", so a pebble whose row was destroyed stayed unwired FOREVER. From
  // a5fa22e (shipped in :v2 sha-110d91c) a wired box rechecks, a re-staged
  // bundle retires the marker and the keys go up again, so the cost is one
  // re-stage cycle instead. Destroying the row is still wrong: it turns a wire
  // that had already happened into an hour of silence, and it only self-heals
  // for seats the re-stage loop below can still see.
  //
  // String(), not row.slug: JSON.stringify DROPS an undefined value, so a row
  // that ever arrived without one would quietly rebuild the destructive
  // slug-less body rather than fail. It cannot today (the seat lookup above
  // matched on this very slug, and registry keys are never empty), and that is
  // exactly the kind of "cannot happen" that this route has already been bitten
  // by once.
  try { await fetch(`${DIR}/anchor-pubkeys-consume`, { method: 'POST', headers: auth, body: JSON.stringify({ org: ORG, e: row.e, slug: String(row.slug) }) }); }
  catch { /* consumed next round */ }
  wiredCount += 1;
  console.log(`anchor-reconcile: ${row.slug} WIRED (both keys registered; catalogue follows on this same pass)`);
}

// re-stage lost claims: attached > 1h, still unwired, no keys arrived
let restaged = 0;
for (const [slug, seat] of unwired) {
  // tie-reconcile owns re-staging for ties (it has the hour grace and the
  // record), and seat.text does not exist on one: reading it here would throw
  // and take the rest of the loop with it.
  if (seat.tie) continue;
  const attached = field(seat.text, 'attached');
  if (!attached || Date.now() - new Date(attached).getTime() < 60 * 60 * 1000) continue;
  const emailAddr = field(seat.text, 'email').toLowerCase();
  if (!emailAddr) continue;
  const e = createHash('sha256').update(emailAddr).digest('hex');
  const bundle = { inbox_repo: `${GH_OWNER}/inbox-${slug}`, heartbeat_repo: `${GH_OWNER}/heartbeat-${slug}`,
    pull_token: PULL, org_contact: { org: ORG, gh_owner: GH_OWNER } };
  try {
    const r = await fetch(`${DIR}/anchor-wire`, { method: 'POST', headers: auth, body: JSON.stringify({ org: ORG, e, slug, bundle }) });
    if (r.ok) { restaged += 1; console.log(`anchor-reconcile: re-staged the wire for ${slug} (claim never landed)`); }
  } catch { /* next round */ }
}

if (wiredCount) {
  try { execFileSync(process.execPath, [path.join(root, 'registry', 'build-index.mjs')], { cwd: root, stdio: 'pipe' }); } catch { /* next round */ }
  try {
    execFileSync('git', ['add', 'registry/'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['-c', 'user.name=Reconcile', '-c', 'user.email=reconcile@rock.local',
      'commit', '-q', '-m', `anchor-reconcile: ${wiredCount} mineral(s) wired`], { cwd: root, stdio: 'pipe' });
    try { runGit(['push', '-q', 'origin', 'HEAD'], { cwd: root, token: GH_TOKEN }); } catch { /* carried later */ }
  } catch { /* nothing to commit */ }
}
console.log(`anchor-reconcile: ${wiredCount} wired, ${restaged} re-staged, ${unwired.size} still waiting`);
