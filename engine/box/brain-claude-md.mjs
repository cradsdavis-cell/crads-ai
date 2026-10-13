#!/usr/bin/env node
// brain-claude-md.mjs <state-dir>: keep the "read your brain first" block in the
// mineral's CLAUDE.md, between its own markers, on every box start (2026-10-13).
//
// WHY. Six public docs pages promise that the assistant reads the person's layer
// pages (above all wiki/_layers/8-workflow.md: their voice, rules and boundaries)
// "at the start of every session, before you have typed a word". On a
// self-hosted pebble nothing made that true: no CLAUDE.md was written into the
// brain, so Claude Code (and opencode, which reads CLAUDE.md as its context file:
// engine/kernel/lib/harness/*.mjs `reads.contextFile`) started every Terminal
// session and every scheduled skill run knowing none of it. Only Crads for
// Teams wrote a CLAUDE.md (engine/team/team-enrol.mjs, its own markers).
//
// WHERE. <stateDir>/CLAUDE.md. Claude Code reads every CLAUDE.md from its
// working folder up to the root, and every way into a pebble works at or under
// /state:
//   * the panel Terminal tab and any SSH command: provisioning/host/enter-aios
//     execs into the container with `-w /state`;
//   * Claude Code desktop over SSH: the folder Help tells members to pick is
//     /state/<mineral-name>, a symlink to the brain root (engine/lib/open-folder.mjs;
//     on a pebble `<name> -> .`), or plain /state on old boxes;
//   * scheduled skill runs: engine/kernel/lib/runner.mjs calls runTurn() with no
//     cwd, and both harnesses default it to stateDir.
// On a pebble the brain root IS /state (resolveBrainRoot), so the file is part
// of the brain repo and rides the nightly push. It is the same file Teams writes
// its own block into; the two blocks never touch each other. Teams' Slack and
// inbox turns deliberately run in throwaway folders OUTSIDE /state
// (team-slack.mjs buildAnswerWorkdir, team-inbox.mjs buildReaderWorkdir) so they
// never pick up this file, and nothing here changes that.
//
// WHY `@` IMPORTS FOR TWO PAGES ONLY. Claude Code inlines `@path` lines into
// context at session start, resolving a relative path against the CLAUDE.md that
// contains it (not the cwd), and silently skips a file that does not exist yet.
// That is what makes "before you have typed a word" literally true for the
// voice/rules page and the who-they-are page, which apply to every reply.
// Importing all eight would load the whole brain into every turn, scheduled
// ones included, so the other six are named in code spans (which Claude Code
// never imports) and read when a question touches them. opencode does not expand
// `@` imports, so every line also says in plain words which file to read.
// Verified on Claude Code 2.1.218, 2026-10-13: an imported page was in context, a
// missing import was skipped without error, a code-span path was not imported,
// and opening the folder through the `<name> -> .` symlink loaded the file once.
//
// WHAT IT NEVER DOES. It never touches a byte outside its markers, never writes
// when the result would be byte-identical (no mtime churn, no nightly diff),
// never writes through a symlinked CLAUDE.md, and leaves a file with broken or
// doubled markers alone rather than guess where the member's text ends. The
// block is static text: no names, hosts, dates or secrets, so it is identical on
// every mineral and safe in a private repo.
//
// ROCKS. Skipped (isOrgBox). A rock boots through boot-rock.sh, its brain
// lives in /state/brain with a CLAUDE.md rendered from its own template, and
// org-brain-setup.sh owns the /state/CLAUDE.md pointer there. A member-born rock
// still runs box-up.sh, and is skipped here for the same reason. The rock chain
// is deferred release-surface work (repo CLAUDE.md), so it keeps its behaviour.
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { resolveBrainRoot, isOrgBox } from '../lib/brain-root.mjs';
import { isMain } from '../lib/is-main.mjs';

// Matched by PREFIX, so the human note inside the start marker can be reworded
// later without orphaning the blocks already written on every mineral.
export const MARK_START = '<!-- crads-ai:brain-layers start';
export const MARK_END = '<!-- crads-ai:brain-layers end -->';
const START_LINE = `${MARK_START} (your mineral keeps this block current each time it starts; write your own notes above or below it, never inside) -->`;

// The two pages imported in full. Ids and paths per engine/onboarding/layers.mjs
// and engine/skills/onboard.md (`wiki/_layers/<id>.md`).
export const IMPORTED = ['8-workflow', '3-self'];

// What each of the other six holds, in onboard.md's words (person scope).
const READ_WHEN = [
  ['1-north-star', 'the long-term vision and why, and what winning looks like'],
  ['2-philosophy', 'values and principles, how they decide, what they will not compromise'],
  ['4-network', 'the people that matter, with a page each under `{p}wiki/people/`'],
  ['5-past', 'their history, what they have built, the lessons'],
  ['6-goals', 'this quarter and this year, with success criteria, and the anti-goals'],
  ['7-tasks', 'what they are working on right now'],
];

/** The block, pure. `prefix` is the brain root relative to the CLAUDE.md folder ('' on a pebble). */
export function buildBrainSection({ prefix = '' } = {}) {
  const p = prefix ? `${prefix.replace(/\/+$/, '')}/` : '';
  const layer = (id) => `${p}wiki/_layers/${id}.md`;
  return [
    START_LINE,
    '## Before you answer: read who you work for',
    '',
    `This folder is a brain. The person you work for told it who they are in the`,
    `\`/onboard\` interview, and it lives in eight layer pages under \`${p}wiki/_layers/\`.`,
    'Read them before you answer anything substantive, and treat what they say as',
    "this person's standing instructions.",
    '',
    'Two pages apply to every reply, so read them first, every session. Where they',
    'disagree with your own defaults, they win:',
    '',
    `- How they work, write and speak, and what never to touch: @${layer('8-workflow')}`,
    `- Who they are and what they do: @${layer('3-self')}`,
    '',
    'Read the other six when a question touches them:',
    '',
    ...READ_WHEN.map(([id, what]) => `- \`${layer(id)}\`: ${what.replace('{p}', p)}`),
    '',
    `For a question about this mineral itself (its name, connections, devices,`,
    `skills or backups), read \`${p}STATE.md\` first.`,
    '',
    `If \`${p}wiki/_layers/\` has no pages yet, the interview has not happened. Say so,`,
    'offer to start it with `/onboard`, and do not guess at who they are.',
    MARK_END,
  ].join('\n');
}

const count = (s, sub) => s.split(sub).length - 1;

/**
 * Put `section` into `text` between the markers. Returns { text, malformed }.
 * Replaces the one existing block in place, or appends a new one (the same
 * blank-line join team-enrol.mjs uses). Broken or doubled markers return the
 * text unchanged with malformed: true, because the member's own words could
 * be anywhere in that region.
 */
export function upsertBrainSection(text, section) {
  const starts = count(text, MARK_START);
  const ends = count(text, MARK_END);
  if (starts === 0 && ends === 0) {
    return { text: (text.trimEnd() ? `${text.trimEnd()}\n\n` : '') + `${section}\n`, malformed: false };
  }
  const a = text.indexOf(MARK_START);
  const b = text.indexOf(MARK_END);
  if (starts !== 1 || ends !== 1 || b < a) return { text, malformed: true };
  return { text: text.slice(0, a) + section + text.slice(b + MARK_END.length), malformed: false };
}

/**
 * The one writer. Returns { action, file, reason? } where action is one of
 * created | updated | kept | skipped (with a reason).
 */
export function ensureBrainClaudeMd(stateDir = '/state', { env = process.env } = {}) {
  const file = path.join(stateDir, 'CLAUDE.md');
  if (isOrgBox(stateDir, { env })) return { action: 'skipped', file, reason: 'org box: its brain carries its own CLAUDE.md' };
  const brainRoot = resolveBrainRoot(stateDir, { env });
  const prefix = path.relative(path.resolve(stateDir), path.resolve(brainRoot)).split(path.sep).join('/');
  if (prefix.startsWith('..') || path.isAbsolute(prefix)) {
    return { action: 'skipped', file, reason: `brain root ${brainRoot} is outside ${stateDir}` };
  }
  let st = null;
  try { st = lstatSync(file); } catch { /* absent: a fresh mineral */ }
  if (st && st.isSymbolicLink()) return { action: 'skipped', file, reason: 'CLAUDE.md is a symlink; not writing through it' };
  if (st && !st.isFile()) return { action: 'skipped', file, reason: 'CLAUDE.md is not a regular file' };
  const before = st ? readFileSync(file, 'utf8') : '';
  const { text, malformed } = upsertBrainSection(before, buildBrainSection({ prefix }));
  if (malformed) return { action: 'skipped', file, reason: 'the brain-layers markers are broken or doubled; left as the member has it' };
  if (st && text === before) return { action: 'kept', file };
  writeFileSync(file, text);
  return { action: st ? 'updated' : 'created', file };
}

// CLI form, called by engine/box-up.sh on every start. Never fatal to boot.
if (isMain(import.meta.url)) {
  const stateDir = process.argv[2];
  if (!stateDir) { console.error('usage: brain-claude-md.mjs <state-dir>'); process.exit(2); }
  try {
    const r = ensureBrainClaudeMd(stateDir);
    console.log(`brain-claude-md: ${r.action}${r.reason ? ` (${r.reason})` : ''}`);
  } catch (e) {
    console.error(`brain-claude-md: ${e && e.message || e}`);
    process.exit(1);
  }
}
