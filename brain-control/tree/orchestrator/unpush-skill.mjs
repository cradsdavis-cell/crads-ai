#!/usr/bin/env node
// unpush-skill.mjs <member-slug> <skill-id> — stop distributing ONE skill to
// ONE member. The inverse of push-skill, built to the boundary the content
// channel already sets rather than against it.
//
// Where the boundary actually falls, checked on a live box rather than assumed:
// org content lives in the box's /state/org-inbox, which org-sync maintains as a
// GIT MIRROR of inbox-<slug> and keeps gitignored, deliberately outside the
// member's own committed brain (org-sync.sh: "Keep org content out of the
// member's own committed brain (the IP boundary)"). So withdrawing a skill here
// DOES remove it from that mirror on the box's next sync. What the channel's
// "nothing is ever deleted" invariant protects is the member's OWN brain: any
// note, page or copy they made is theirs and is never touched by this.
//
// So un-pushing means exactly two things, both on the ORG's own side:
//   1. remove skills/<id>/ from inbox-<slug>, so no further version lands;
//   2. drop the skills_installed entry, so the org's own record stops claiming
//      it is distributing something it no longer distributes.
import { readFile, writeFile, rm, mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOrgGitHub, refusal, plainRemote, runGit } from '../factory/org-github.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [slug, skillId] = process.argv.slice(2);
if (!slug || !skillId) { console.error('usage: unpush-skill <member-slug> <skill-id>'); process.exit(2); }
if (!/^[a-z0-9][a-z0-9-]*$/.test(skillId)) { console.error('skill-id must be kebab-case'); process.exit(2); }

const { owner: OWNER, token: TOKEN } = resolveOrgGitHub({ brainRoot: repoRoot });
if (!OWNER || !TOKEN) { console.error(refusal({ what: 'withdraw a skill from a member box' })); process.exit(2); }

const rowPath = path.join(repoRoot, 'registry', 'members', `${slug}.yaml`);
const row = await readFile(rowPath, 'utf8').catch(() => '');
if (!row) { console.error(`REFUSED: no registry row for ${slug}`); process.exit(1); }

// 1. take it off the member's inbox so no further version is delivered
const clone = path.join(repoRoot, 'state', 'inboxes', slug);
const remote = process.env.INBOX_REMOTE_URL || plainRemote(OWNER, `inbox-${slug}`);
const git = (a, cwd = clone) => runGit(a, { cwd, token: TOKEN });
let cloned = false; try { await stat(path.join(clone, '.git')); cloned = true; } catch { /* fresh */ }
if (!cloned) { await mkdir(path.dirname(clone), { recursive: true }); runGit(['clone', remote, clone], { token: TOKEN }); }
else { git(['remote', 'set-url', 'origin', remote]); git(['pull', '--ff-only', 'origin', 'main']); }

await rm(path.join(clone, 'skills', skillId), { recursive: true, force: true });
git(['add', '-A']);
const dirty = git(['status', '--porcelain']).trim();
if (dirty) {
  git(['-c', 'user.name=Rock Brain', '-c', 'user.email=unpush@rock.local', 'commit', '-q', '-m', `unpush-skill: ${skillId} for ${slug}`]);
  git(['push', 'origin', 'main']);
}

// 2. stop the org's own record claiming it distributes this
const before = row;
const after = row.replace(/^\s*-\s*\{\s*skill_id:\s*"?([a-z0-9-]+)"?[^}]*\}\s*$/gm,
  (line, id) => (id === skillId ? '' : line)).replace(/\n{3,}/g, '\n\n');
if (after !== before) await writeFile(rowPath, after);
try { execFileSync('node', [path.join(repoRoot, 'registry', 'build-index.mjs')], { cwd: repoRoot, stdio: 'pipe' }); } catch { /* index rebuild is best-effort */ }

console.log(dirty || after !== before
  ? `OK: ${skillId} is no longer distributed to ${slug}. It disappears from the org content on their box at their next sync; anything they wrote or copied into their OWN brain is theirs and is untouched.`
  : `nothing to do: ${skillId} was not being distributed to ${slug}.`);
