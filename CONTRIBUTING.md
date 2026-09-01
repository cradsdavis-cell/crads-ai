# Contributing

Thanks for looking. This project is small and opinionated; contributions are
welcome, and the bar is the one the codebase already sets for itself.

## Ground rules

- **Zero runtime dependencies.** The engine, the wizard and the shipped app run
  on Node's standard library. Build-time tools (esbuild, postject) live only in
  CI. A PR that adds a runtime dependency needs a very good story.
- **Tests ride with the change.** Every behaviour fix pins the behaviour. Run
  the suite before pushing: `node --test $(git ls-files '*.test.mjs')`. It must
  be green on a clean checkout with nothing installed.
- **No personal or deployment-specific content in product code.**
  `scripts/clean-gate.sh` is the wall for what bakes into images; the same
  spirit applies everywhere. Fixtures use fictional names.
- **Comments explain why, not what.** The codebase carries its history in its
  comments; keep that habit.

## Practicalities

- Open an issue first for anything non-trivial, so the design conversation
  happens before the code does.
- One change per PR. A `notes:` trailer in the commit body, written in plain
  words a member could read, feeds the app's changelog (see
  `scripts/build-changelog.mjs`).
- Security issues: never as public issues — see `SECURITY.md`.
