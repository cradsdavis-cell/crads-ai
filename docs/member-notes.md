# Member notes for commits already pushed

The normal route to plain, member-facing words is a `notes:` trailer in the commit
body (see `scripts/build-changelog.mjs`). Write it there whenever you can: it
lives with the change, needs no second file, and cannot go stale.

This file is the seam for when you cannot. A commit that is already pushed cannot
have its body amended, and until it has a line somewhere the app's version chip
shows the raw commit subject, which is written for whoever is building this repo.

**Format.** One bullet per commit: the sha first, then one sentence in a member's
words. No scope prefix, no repo nouns, present tense, their screen not ours.
Anything that is not a bullet starting with a sha is prose and is ignored, so this
paragraph is safe.

**A line here WINS** over that commit's `notes:` trailer, because it is the later,
deliberate correction. Abbreviated and full shas both match.

**Add it the day you notice.** Only the last 25 commits are published, and merge
commits burn that window fast, so a line added a week late reaches nobody. Entries
matching no commit are counted and reported by the build rather than silently
dropped. Leave old entries in place: they are the record of what a release said.

*(This file starts empty in the fresh extraction; the private repo's entries
named commits that do not exist in this history.)*
