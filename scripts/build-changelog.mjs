// build-changelog.mjs: publish the app's what's-new list beside the exe.
//
// Run by CI: `node scripts/build-changelog.mjs dist/changelog.json`.
//
// Why this is a script and not four lines of inline PowerShell (2026-08-13): the
// inline version could only be tested by cutting a release, and this box has no
// pwsh, so a parsing mistake would have been found by the app showing nothing.
// Same list, same shape, plus one field, and now it has tests.
//
// The one field is `notes`, and it is the whole point. The commit subjects in this
// repo are written for whoever is building it: "baseline: leg E COMPLETE, and
// finding 82 is why it nearly was not" is a good commit message and useless to a
// member of somebody's community. updater.mjs filters the worst of it, but no
// filter can turn "a rock adopted another box's repo" into "your backup was going
// to the wrong place". Only the person who made the change can write that line, at
// the moment they make it:
//
//     the rock adopted another box's repo, then had one button that could only fail
//
//     notes: your rock now backs up to its own GitHub repository, not another one's
//
// When a `notes:` trailer is there, the app shows it INSTEAD of the subject, and it
// is never filtered as internal. When it is not, nothing breaks and the tidied
// subject is what shows. One line per commit, only when it is worth writing.
//
// The trailer is the whole seam only while the commit is still amendable. Once it
// is pushed to the shared branch the body is frozen, and 2026-08-14 showed what
// that costs: `124: "8 of 8 pebbles unlocked" on a rock that could not build one`
// went out with no trailer, and it is NOT filtered as internal (nothing in the
// subject says "internal"; the change is real and member-facing), so the version
// chip would have shown a member that sentence. `docs/member-notes.md` is the
// after-the-fact half: sha, then the words. See parseMemberNotes below.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Unit + record separators, so a subject or body containing tabs, quotes or
// newlines cannot break the parse. The old tab-split format would have.
const US = '\x1f';
const RS = '\x1e';
export const FORMAT = `%h${US}%ad${US}%s${US}%b${RS}`;
export const COUNT = 25;

// First `notes:` (or `note:`) line in the commit body wins. One commit gets one
// member-facing line: a change that needs two of them is two changes.
export function noteFrom(body) {
  const m = /^[ \t]*notes?:[ \t]*(\S.*?)[ \t]*$/im.exec(String(body || ''));
  return m ? m[1].trim() : '';
}

export function parseLog(raw) {
  return String(raw || '')
    .split(RS)
    .map((rec) => rec.replace(/^[\r\n]+/, ''))
    .filter((rec) => rec.trim())
    .map((rec) => {
      const [sha = '', date = '', subject = '', body = ''] = rec.split(US);
      const entry = { sha: sha.trim(), date: date.trim(), subject: subject.trim() };
      const notes = noteFrom(body);
      if (notes) entry.notes = notes;
      return entry;
    })
    .filter((e) => e.sha && e.subject);
}

// ---- the after-the-fact seam ------------------------------------------------
// Resolved from this file, not from cwd: CI runs the script from the repo root
// but nothing guarantees that, and a silently-missing notes file reads exactly
// like a repo with no curated lines.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MEMBER_NOTES_PATH = join(ROOT, 'docs', 'member-notes.md');

// A data line is a bullet whose first word is a sha. Anchoring to the bullet is
// what lets that file explain itself in prose above the list without a paragraph
// beginning with a hex-looking word turning into a release note.
export function parseMemberNotes(text) {
  const line = /^[ \t]*[-*][ \t]+`?([0-9a-f]{7,40})`?[ \t]+(\S.*?)[ \t]*$/gim;
  const out = new Map();
  for (const [, sha, words] of String(text || '').matchAll(line)) {
    const key = sha.toLowerCase();
    if (!out.has(key)) out.set(key, words.trim());   // first wins, as in noteFrom
  }
  return out;
}

// Prefix match in either direction: the log hands us `%h`, which git widens as
// the repo grows, while the file may carry whatever length was pasted in. git
// guarantees `%h` is unambiguous, so a 7+ char prefix is not a real collision risk.
function noteFor(sha, notes) {
  const s = String(sha || '').toLowerCase();
  if (!s || !(notes instanceof Map)) return '';
  if (notes.has(s)) return notes.get(s);
  for (const [key, words] of notes) {
    if (key.length >= 7 && (key.startsWith(s) || s.startsWith(key))) return words;
  }
  return '';
}

// A file line WINS over the commit's own trailer: it is the later, deliberate
// correction, and the only reason to write one is that the trailer is wrong or
// absent. `applied` is returned so the build can report what matched nothing.
export function applyMemberNotes(entries, notes) {
  let applied = 0;
  const out = (Array.isArray(entries) ? entries : []).map((e) => {
    const words = noteFor(e && e.sha, notes);
    if (!words) return e;
    applied++;
    return { ...e, notes: words };
  });
  return { entries: out, applied };
}

// No file is not an error: the seam is optional and a checkout without it must
// still build a changelog.
export function readMemberNotes(path = MEMBER_NOTES_PATH, read = readFileSync) {
  try { return parseMemberNotes(read(path, 'utf8')); } catch { return new Map(); }
}

export function readLog(count = COUNT, run = execFileSync) {
  return run('git', ['log', '-n', String(count), '--date=short', `--pretty=format:${FORMAT}`],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

export function buildChangelog(count = COUNT, run = execFileSync, notes = readMemberNotes()) {
  return applyMemberNotes(parseLog(readLog(count, run)), notes).entries;
}

// CLI: written only when the parse produced something. A release that publishes an
// empty changelog.json is worse than one that publishes none, because the app
// cannot tell an empty list from a quiet week and would say "no release notes".
if (process.argv[1] && process.argv[1].endsWith('build-changelog.mjs')) {
  const out = process.argv[2] || 'dist/changelog.json';
  const notes = readMemberNotes();
  const { entries, applied } = applyMemberNotes(parseLog(readLog()), notes);
  if (!entries.length) {
    console.error('build-changelog: git log produced no entries; refusing to write an empty changelog');
    process.exit(1);
  }
  writeFileSync(out, JSON.stringify(entries, null, 0), 'utf8');
  const curated = entries.filter((e) => e.notes).length;
  console.log(`build-changelog: wrote ${entries.length} entries to ${out} (${curated} in member words, ${applied} of those from docs/member-notes.md)`);
  // Reported, never swallowed: a sha that has aged past COUNT and a mistyped sha
  // are indistinguishable from here, and only the second one is a mistake.
  if (notes.size > applied) {
    console.log(`build-changelog: ${notes.size - applied} member-notes line(s) matched no commit in the last ${COUNT} (aged out, or a bad sha)`);
  }
}
