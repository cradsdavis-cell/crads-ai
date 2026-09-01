#!/usr/bin/env node
// prune-down.mjs <slug> <dest-subpath> <keep-id>... [--none]
//
// The withdrawal leg push-down never had. Removes entries under ONE
// reconcile-owned destination in a member's inbox that are not in the keep
// list, commits, pushes. Same shape as push-down (clone, mutate, commit,
// push) and the same delivery gates: a prune is delivery, so it stops
// wherever delivery stops. The credential resolver, the consent gate and the
// row reader are the exact functions push-down.mjs imports, from the same
// modules, not a second copy of that logic.
//
// WHAT THIS DOES NOT TOUCH. It removes the OFFER only, never what a member
// has already installed on their own box: .claude/skills/<id>,
// library/<pack>/<id>, dashboard/pages/<id>.html live on the member's box,
// not in the inbox. Never delete member content holds here exactly as it
// does everywhere else in this repo. It also never touches anything in the
// inbox outside dest-subpath: keys/, heartbeat/, evict/, re-anchor/, drops/,
// catalog/ and MEMBERSHIP.yaml are lifecycle machinery, not content, and the
// legacy skills/, pages/, dirs/, context/ and packs/ paths hold content an
// operator delivered by hand with install-pack. Reconcile does not own that
// content and this must never reap it.
//
// THE ALLOW-LIST IS THE POINT OF THIS FILE. push-down does no traversal
// validation on its destSub at all, which is survivable for an additive copy
// and is not survivable for a delete. dest-subpath must be exactly one of
// the four reconcile-owned roots below, checked before any git or
// filesystem call, so anything else refuses having done nothing.
import { readFile, rm, mkdir, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pushConsent } from '../registry/consent.mjs';
import { extractRow } from '../registry/normalize-row.mjs';
import { resolveOrgGitHub, refusal, plainRemote, runGit } from '../factory/org-github.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Requirement 1: the allow-list, spelled out here and nowhere else.
const ALLOWED_DEST = ['offers', 'prompts', 'offers-dirs', 'offers-pages'];
// Requirement 3: ids are regex-pinned before being compared or joined into a
// path. A traversal id such as ".." fails this and is refused before it ever
// reaches a path.join call.
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const rawArgs = process.argv.slice(2);
const NONE = rawArgs.includes('--none');
const positional = rawArgs.filter((a) => a !== '--none');
const [slug, destSub, ...keepIdsRaw] = positional;

if (!slug || !destSub) {
  console.error('usage: prune-down <slug> <dest-subpath> <keep-id>... (or --none to keep nothing)');
  process.exit(2);
}

// Requirement 1, enforced first and unconditionally. Nothing below this line
// runs, and nothing above it touched disk, so a bad dest-subpath (a legacy
// path, an off-limits inbox path, or anything else) leaves the tree exactly
// as it found it.
if (!ALLOWED_DEST.includes(destSub)) {
  console.error(`REFUSED: dest-subpath must be one of ${ALLOWED_DEST.join(', ')}. Got "${destSub}". Nothing was touched.`);
  process.exit(2);
}

// Requirement 5: an empty keep list is legal, and it means remove everything
// under dest-subpath, because un-offering the last item is a real state. It
// is reachable only through the explicit --none flag, never by a caller
// forgetting to pass ids, and never together with ids (that pairing is
// contradictory, not merely redundant).
if (NONE && keepIdsRaw.length) {
  console.error('usage: pass either --none or one or more keep-ids, never both.');
  process.exit(2);
}
if (!NONE && keepIdsRaw.length === 0) {
  console.error('usage: prune-down <slug> <dest-subpath> <keep-id>... (pass --none to keep nothing; a bare empty list is a usage error, not a request to empty the destination)');
  process.exit(2);
}

// Requirement 3, continued: refuse a bad id rather than silently skip it.
for (const id of keepIdsRaw) {
  if (!ID_RE.test(id)) {
    console.error(`REFUSED: keep-id "${id}" is not a valid id (must match ${ID_RE}). Nothing was touched.`);
    process.exit(2);
  }
}
const keepIds = new Set(keepIdsRaw);

// ---------------------------------------------------------------------------
// Requirement 6: the same delivery gates as push-down.mjs, in the same order,
// built from the same imported helpers. A prune is delivery, so it stops
// wherever delivery stops: unresolved credentials, no registry row or tie,
// a non-active member, an anchor's delivery_pause, or withheld push consent.

const { owner: OWNER, token: TOKEN } = resolveOrgGitHub({ brainRoot: repoRoot });
if (!OWNER || !TOKEN) { console.error(refusal({ what: 'withdraw content from a member box' })); process.exit(2); }

const rowPath = path.join(repoRoot, 'registry', 'members', `${slug}.yaml`);
const tiePath = path.join(repoRoot, 'registry', 'ties', `${slug}.json`);
const seatRow = await readFile(rowPath, 'utf8').catch(() => null);
if (seatRow === null && !(await readFile(tiePath, 'utf8').catch(() => null))) {
  throw new Error(`no registry row for ${slug}`);
}
const row = seatRow ?? 'status: "active"\n';
const status = (row.match(/^status:\s*"?(\w+)"?/m) || [, 'unknown'])[1];
if (status !== 'active') {
  console.error(`REFUSED: ${slug} status is '${status}', not active. prune-down is off.`);
  process.exit(1);
}

// The anchor's per-box delivery pause gates every content leg the same way it
// gates push-down (push-skill and install-pack ride push-down; a prune is
// the same kind of act on the same channel).
if ((row.match(/^delivery_pause:\s*"?(\w*)"?/m) || [, ''])[1] === 'true') {
  console.error(`REFUSED: delivery to ${slug} is paused by the anchor. Content and installs stop; seat, registry and heartbeat persist. Resume by setting delivery_pause off.`);
  process.exit(1);
}

{
  const policy = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
  const anchorSlug = (policy.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim() || '';
  const policyDefault = (policy.match(/^\s{2}infra_push_consent:\s*"?(\w+)"?/m) || [, ''])[1];
  const gate = pushConsent({ row: extractRow(row), anchorSlug, policyDefault });
  if (!gate.allowed) {
    console.error(`REFUSED: ${slug}: ${gate.why}.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Clone or fast-forward the same working copy push-down uses, prune one
// level under dest-subpath, commit, push.

const clone = path.join(repoRoot, 'state', 'inboxes', slug);
const remote = process.env.INBOX_REMOTE_URL || plainRemote(OWNER, `inbox-${slug}`);
const git = (a, cwd = clone) => runGit(a, { cwd, token: TOKEN });
let cloned = false; try { await stat(path.join(clone, '.git')); cloned = true; } catch { /* fresh */ }
if (!cloned) { await mkdir(path.dirname(clone), { recursive: true }); runGit(['clone', remote, clone], { token: TOKEN }); }
else { git(['remote', 'set-url', 'origin', remote]); git(['pull', '--ff-only', 'origin', 'main']); }

// Requirement 4: only one level down. Entries directly under dest-subpath/
// are the candidates; nothing deeper is enumerated or reasoned about. A page
// or a dir each carry a sidecar alongside their content
// (offers-pages/<id>.html + <id>.json; offers-dirs/<id>/ + <id>.yaml), so an
// entry's id is its own name with that ONE known sidecar suffix stripped,
// never anything discovered by walking further down.
function idOf(name) {
  if (destSub === 'offers-pages') return name.replace(/\.(html|json)$/, '');
  if (destSub === 'offers-dirs') return name.replace(/\.yaml$/, '');
  return name;
}

const destDir = path.join(clone, destSub);
let entries = [];
try { entries = await readdir(destDir, { withFileTypes: true }); } catch { entries = []; }

const removedIds = new Set();
for (const entry of entries) {
  const id = idOf(entry.name);
  if (keepIds.has(id)) continue;
  await rm(path.join(destDir, entry.name), { recursive: true, force: true });
  removedIds.add(id);
}

git(['add', '-A']);
const dirty = git(['status', '--porcelain']).trim();
// Requirement 7: fail soft and idempotent. Nothing to remove means no
// commit, exactly the way push-down prints "nothing to push (already
// current)" instead of committing an empty change.
if (!dirty) { console.log('nothing to prune (already current).'); process.exit(0); }
git(['-c', 'user.name=Rock Brain', '-c', 'user.email=prune-down@rock.local', 'commit', '-q', '-m', `prune-down: ${destSub}`]);
git(['push', 'origin', 'main']);
console.log(removedIds.size
  ? `pruned ${destSub} in inbox-${slug}: removed ${[...removedIds].sort().join(', ')}.`
  : `pruned ${destSub} in inbox-${slug}.`);
