#!/usr/bin/env node
// push-member-key.mjs <slug>
// Derive the member's SSH door key from the rock's APPROVED public-key registry
// (registry/members/keys/<slug>.yaml) and push it into inbox-<slug>/keys/member.authorized_keys.
// The box's org-sync installs it into /state/ssh/member (D46 AuthorizedKeysCommand path).
//
// D51 (admin-first invites). Two properties make this safe AND make it the off-switch:
//   1. The ONLY thing it can ever push is a DERIVED authorized_keys file — approved public
//      keys when the member is active, or an EMPTY file otherwise. It can never push content,
//      a private key, or anything read back from the box. Public keys only.
//   2. Unlike push-down.mjs (which refuses any non-active push to protect CONTENT), this
//      MUST be able to push while non-active, because pushing the empty file is exactly how
//      a revoke locks the member out. Revoking = flip status + rerun this = empty key drops
//      on the next box sync. Nothing in the member's own brain is ever deleted.
//
// Keys are only ever appended to keys/<slug>.yaml AFTER a two-party fingerprint approval in
// the panel. This script is the transport; the panel is the gate.
//
// Auth: ORG_GH_OWNER + ORG_GH_TOKEN (env or repo .env); legacy IC_ORG / IC_ORG_TOKEN honoured.
import { readFile, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOrgGitHub, refusal, plainRemote, runGit } from '../factory/org-github.mjs';

const PUBKEY_RE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9@._ -]{1,64})?$/;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = process.argv[2];
if (!slug || !/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(slug)) {
  console.error('usage: push-member-key <slug>  (dns-safe slug)'); process.exit(2);
}

// Fallback chain matches factory/stamp-pebble.sh: explicit ORG_GH_* > legacy IC_* > the
// rock's staged factory env (provisioning.env.local ships GH_OWNER + GITHUB_TOKEN).
const { owner: OWNER, token: TOKEN } = resolveOrgGitHub({ brainRoot: repoRoot });
if (!OWNER || !TOKEN) { console.error(refusal({ what: 'deliver a device key to a member box' })); process.exit(2); }

// Membership row must exist (metadata-only). Status drives active-vs-revoke; ANY known status
// is allowed to proceed (a non-active status pushes the empty file = the off-switch).
const rowPath = path.join(repoRoot, 'registry', 'members', `${slug}.yaml`);
const row = await readFile(rowPath, 'utf8').catch(() => { console.error(`REFUSED: no registry row for ${slug}`); process.exit(1); });
const status = (row.match(/^status:\s*"?(\w+)"?/m) || [, 'unknown'])[1];

// Derive the door key from the APPROVED public keys, but ONLY while active.
let keys = [];
if (status === 'active') {
  const keyPath = path.join(repoRoot, 'registry', 'members', 'keys', `${slug}.yaml`);
  const y = await readFile(keyPath, 'utf8').catch(() => '');
  const block = y.split(/^pubkeys:\s*$/m)[1] || '';
  for (const line of block.split('\n')) {
    const m = line.match(/^\s+-\s+"?(ssh-ed25519 [^"\n]+?)"?\s*$/);
    if (!m) { if (/^\S/.test(line)) break; continue; }        // next top-level field ends the list
    if (!PUBKEY_RE.test(m[1])) { console.error(`SKIP: malformed key line in ${slug}.yaml`); continue; }
    keys.push(m[1]);
  }
}
const authorized = keys.length ? keys.join('\n') + '\n' : '';   // EMPTY = revoke (truncates the door)

// Stage the single file and push it into inbox-<slug>/keys/. Own git (no active-gate: the
// empty-file push IS the revoke). We only ever write this one derived path.
const clone = path.join(repoRoot, 'state', 'inboxes', slug);
const remote = plainRemote(OWNER, `inbox-${slug}`);
const git = (args, cwd = clone) => runGit(args, { cwd, token: TOKEN });
// THE REPO MAY NOT EXIST. A stamped member got inbox-<slug> from the factory; an
// ADOPTED one never went through it, so this clone 404s and (before 2026-08-10)
// took the whole verb down with a raw Node stack trace that printed the token.
// Create it the same idempotent way the factory does, then carry on.
try { runGit(['ls-remote', remote, 'HEAD'], { token: TOKEN }); }
catch {
  try {
    execFileSync('gh', ['repo', 'create', `${OWNER}/inbox-${slug}`, '--private', '-y'], { stdio: 'pipe' });
    console.log(`created ${OWNER}/inbox-${slug} (adopted mineral, never stamped)`);
  } catch (e) {
    console.error(`REFUSED: ${OWNER}/inbox-${slug} does not exist and could not be created (${String(e.stderr || e.message || e).split('\n')[0]}).`);
    process.exit(2);
  }
}
let cloned = false; try { await stat(path.join(clone, '.git')); cloned = true; } catch {}
if (!cloned) { await mkdir(path.dirname(clone), { recursive: true }); runGit(['clone', remote, clone], { token: TOKEN }); }
else { git(['remote', 'set-url', 'origin', remote]); git(['pull', '--ff-only', 'origin', 'main']); }

await mkdir(path.join(clone, 'keys'), { recursive: true });
await writeFile(path.join(clone, 'keys', 'member.authorized_keys'), authorized);

// WHO THIS MINERAL BELONGS TO (finding 100, 2026-08-13). Driven as a member, a
// claim worked completely and then went nowhere: the device key was minted, the
// ssh door opened, the rock committed "device enrolled via id_token, box
// active" — and the pebble was left never knowing WHOSE it was. engine/box/
// mineral-arm.mjs gates the whole directory leg on an account address and
// answered, on the claimed box, "holderless: no account address on this mineral
// yet". So no box_reg_host, no box_directory_token, no owner_e, therefore no
// mineral record, therefore the member's own /app/minerals read "Nothing to
// show for this account yet". Permanently, not until a cron.
//
// mineral-arm's own comment says "Claiming it in the app arms it". Nothing ever
// told the box. This is the telling.
//
// It rides HERE rather than in stamp-pebble.sh because this script runs on every
// approval, so it also heals every pebble already stamped, whereas the stamp
// writes the inbox once at creation and never again.
//
// A SEPARATE FILE, deliberately, not a new field in MEMBERSHIP.yaml: that file's
// `status` drives the box's membership gate (pebble-template/box/org-sync.sh),
// and there is no reason to put a live off-switch at risk to carry an address.
// The pebble clones the whole inbox, so any file here lands on the box.
const holderEmail = (row.match(/^email:\s*"?([^"\s#]+)"?/m) || [, ''])[1].trim().toLowerCase();
if (holderEmail) {
  await mkdir(path.join(clone, 'identity'), { recursive: true });
  await writeFile(path.join(clone, 'identity', 'holder_email'), `${holderEmail}\n`);
}

// THE DEVICE NAMES THAT GO WITH THOSE KEYS (finding 116, 2026-08-13). Same
// rules as the keys above and for the same reason: derived, public, and pushed
// only while active, so a revoke truncates the names with the door. Without it
// device-sync has nothing but a fingerprint to label an adopted row with, and
// labels every one of them "Approved by your rock".
//
// A SEPARATE FILE from member.authorized_keys, because that file is consumed by
// sshd. A comment line would be ignored by ssh but this is not a place to find
// out; the box reads names from its own path.
const namesPath = path.join(repoRoot, 'registry', 'members', 'keys', `${slug}.names.yaml`);
const namesSrc = status === 'active' ? await readFile(namesPath, 'utf8').catch(() => '') : '';
await mkdir(path.join(clone, 'keys'), { recursive: true });
await writeFile(path.join(clone, 'keys', 'member.device_names'), (() => {
  // FINGERPRINT<TAB>NAME, one per line: the flattest thing the box can parse
  // without a YAML reader, and unambiguous because a fingerprint has no tab.
  const out = [];
  for (const line of String(namesSrc).split('\n')) {
    const m = line.match(/^\s{2}([A-Z2-7]{6}):\s*"([^"\n]{1,60})"\s*$/);
    if (m) out.push(`${m[1]}\t${m[2]}`);
  }
  return out.length ? out.join('\n') + '\n' : '';
})());

git(['add', '-A']);
const dirty = git(['status', '--porcelain']).trim();
if (!dirty) { console.log(`member key already current for ${slug} (${keys.length} key(s), status=${status}).`); process.exit(0); }
git(['-c', 'user.name=Rock Brain', '-c', 'user.email=push-member-key@rock.local', 'commit', '-q', '-m', `member-key: ${slug} (${keys.length} key(s), status=${status})`]);
git(['push', 'origin', 'main']);
console.log(keys.length
  ? `pushed ${keys.length} approved device key(s) for ${slug} -> inbox-${slug}/keys.`
  : `pushed EMPTY key file for ${slug} (status=${status}) -> the member door is now closed on next sync.`);
