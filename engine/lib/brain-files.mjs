// brain-files.mjs — which files in a mineral's brain the app shows. ONE rule,
// two readers: the panel's brain-list verb (a shell command run on the box over
// SSH) and the brain graph in engine/cockpit/box-cockpit.mjs. The graph runs
// the SAME shell text this module builds, so the Files tree and the graph cannot
// disagree about what a brain holds (finding 107: one wiki, three readers, three
// answers; the fix then was to share a list, and the fix now is to share it
// harder).
//
// WHY FROM THE BRAIN ROOT (spec 2026-10-17 adopt-existing-server, "Engine
// changes for adopted brains", last row). Until 2026-10-18 the member verbs did
// `cd /state/wiki` and the pebble graph walked `<box>/wiki`, so a brain laid out
// any other way (Sam's own: notes/, decisions/, no wiki/) answered "no brain at
// /state/wiki" and drew an empty graph. That is code drifting from the 2026-07-27
// ruling that brain structure is user-land (docs/three-layer-model.md): nothing
// in the machinery may assume a particular layout.
//
// WHY GIT DECIDES. The person's own .gitignore is the honest statement of what
// is private, so the list is `git ls-files -co --exclude-standard` (tracked plus
// untracked-but-not-ignored). A folder that is not a git repo falls back to a
// pruned find. On top of either, a fixed exclusion set that holds even for
// files a brain TRACKS: Oracle tracks 205 files under .claude/ and 278 under
// cockpit/, and neither is pages.
//
//   - any dot segment (.git, .claude, .obsidian, ...): also unopenable, since
//     the panel's path validator refuses dot segments
//   - node_modules/ at any depth
//   - cockpit/ and archives/ at the brain root, and the two credential folders
//     from engine/lib/brain-ignore.txt's required block that are not dot
//     folders (secrets/, ssh/). Those matter most on the find fallback, which
//     has no .gitignore to ask: a pebble's secrets/*.txt must never become a row
//     (brain-shape.test.mjs reads the required block and checks every entry).
//
// safe.directory: the panel's SSH user and the brain's owner can differ, and git
// then refuses the repo as "dubious ownership". A refused git must not fall
// through to find, because find ignores .gitignore and would list exactly the
// private files git exists to keep out. Passing it on the command line is
// protected configuration, so it is honoured.

export const BRAIN_LIST_TOP_EXCLUDE = ['cockpit', 'archives', 'secrets', 'ssh'];
export const BRAIN_LIST_EXCLUDE_RE = `(^|/)\\.|(^|/)node_modules/|^(${BRAIN_LIST_TOP_EXCLUDE.join('|')})/`;

const extRe = (exts) => `\\.(${exts.join('|')})$`;

// The listing, as POSIX shell text, to run with the brain root as the current
// directory. Prints one relative path per line, sorted, de-duplicated.
// `exts` is the extension allow-list (lowercase, no dots); the panel passes its
// ASSET_EXT, the graph passes ['md']. The find predicate is built from the same
// list, so the two branches answer the same question.
export function brainListSh(exts) {
  if (!Array.isArray(exts) || !exts.length || !exts.every((e) => /^[a-z0-9]+$/.test(e))) {
    throw new Error('brainListSh: exts must be a non-empty list of bare lowercase extensions');
  }
  const namePred = exts.map((e) => `-name '*.${e}'`).join(' -o ');
  const git = 'git -c safe.directory="$PWD"';
  return '{ if ' + git + ' rev-parse --is-inside-work-tree >/dev/null 2>&1; then '
    + git + ' -c core.quotepath=off ls-files -co --exclude-standard; '
    + `else find . \\( -name '.?*' -o -name node_modules ${BRAIN_LIST_TOP_EXCLUDE.map((d) => `-o -path ./${d}`).join(' ')} \\) -prune -o -type f \\( ${namePred} \\) -print | sed 's|^\\./||'; fi; } `
    + `| grep -E '${extRe(exts)}' | grep -Ev '${BRAIN_LIST_EXCLUDE_RE}' `
    // -c also lists tracked files deleted from the working tree; a row for a
    // file that is not there would only refuse to open
    + `| while IFS= read -r f; do [ -f "$f" ] && printf '%s\\n' "$f"; done | LC_ALL=C sort -u`;
}

// Refuse a read the listing would never offer: a path the brain's .gitignore
// keeps out (secrets/, a private notes folder), or one under the fixed
// exclusions. Prepended to brain-read / brain-image with the page in "$P".
export const BRAIN_READ_GUARD_SH = 'if printf \'%s\\n\' "$P" | grep -Eq \'' + BRAIN_LIST_EXCLUDE_RE + '\'; then echo "ERROR: that file is not part of your brain\'s pages: $P"; exit 1; fi; '
  + 'if git -c safe.directory="$PWD" rev-parse --is-inside-work-tree >/dev/null 2>&1 && git -c safe.directory="$PWD" check-ignore -q -- "$P" 2>/dev/null; then echo "ERROR: that file is private to your brain (its .gitignore keeps it out): $P"; exit 1; fi; ';
