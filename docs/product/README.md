# docs/product/: the documentation system source

Spec: `docs/superpowers/specs/2026-08-24-documentation-system.md`. This tree
is the ONE source; the website `/docs`, the in-image tiers, and the PDF
exports all render from it. Nothing in here is operator documentation: that
stays in `docs/` proper, untouched.

## Layout

| Path | What |
|---|---|
| `pipeline/source.mjs` | the page contract: frontmatter axes, enums, the refusals that encode spec rulings |
| `pipeline/render.mjs` | markdown-subset renderer + the shared manifest every surface reads |
| `pipeline/shots.mjs` | the screenshot DECLARATION: what is captured, from which surface and world |
| `pipeline/shoot.mjs` | the capture driver (needs a browser; a release step, not a CI step) |
| `pipeline/generate.mjs` | reference pages built FROM the code, plus `--check` |
| `pipeline/claims.mjs` | what the gates refuse, as data: banned vocabulary, pinned claims, the billing caveat |
| `pipeline/legal.mjs` | the legal version lock, plus `--update` |
| `pipeline/drift.mjs` | the soft drift ledger for hand-written prose |
| `pipeline/recipes.mjs` | the installable artefacts a how-to ships, validated by the engine's own scheduler |
| `pages/` | the pages: `tutorial/`, `how-to/`, `explanation/`, `legal/`, `reference/` (generated) |
| `pipeline/legal-lock.json` | version + body hash per legal page; the lock the gate checks |

## The page contract

```
---
title: Get your inbox triaged every morning
summary: One line, powers every index.
audience: pebble        # public | pebble | rock (cumulative upward)
access: public          # the DISARMED gate: public is the only legal value
mode: how-to            # tutorial | how-to | reference | explanation | legal
installs: inbox-triage  # REQUIRED for how-to: the catalog-install artefact id
order: 10               # optional sort within its mode group
generated: false        # true = written by the reference generator; CI hard-blocks hand edits
---
```

Legal pages additionally require `version:` and `effective: YYYY-MM-DD`.

Two rulings live as validator refusals, so drift fails the build instead of
shipping: a how-to without an artefact refuses (every how-to ships one), and
a legal page without a version stamp refuses.

## Screenshots

A page references a shot by id and never by path:

```
![The assistant home, one week in](shot:member-overview)
```

A shot directive is always alone on its line (a `<figure>` cannot live inside a
`<p>`), and every referenced id must be declared in `pipeline/shots.mjs`. Both
are enforced by `pipeline/shots.test.mjs`, which needs no browser: the qa-*
browser rigs are out of the clean-checkout suite (trap 15), so a contract that
could only be checked by capturing pixels would never be checked at all.

Capture is a release step against the Driftwood fixture:

```
cd wizard/dev-harness && npm i          # once, for playwright
node docs/product/pipeline/shoot.mjs    # -> docs/product/shots/ (gitignored)
```

Readiness is a condition, not a stopwatch: the rig waits for the page's
skeletons to clear before it shoots, and `shot-report.json` records any shot
where they never did. Shot ids carry the name a PERSON sees, not the internal
section id, per `docs/naming.md`.

## Generated reference

Reference is the one Diataxis mode nobody hand-writes. Three sources, read
straight from the repo:

| Source | Page |
|---|---|
| `engine/skills/*.md` frontmatter | `pages/reference/skills.md` |
| `wizard/panel/mcp-catalogue.mjs` | `pages/reference/connections.md` |
| `engine/cron/scheduler.mjs` `DISPLAY` | `pages/reference/machinery-jobs.md` |

```
node docs/product/pipeline/generate.mjs           # write them
node docs/product/pipeline/generate.mjs --check   # fail if any is stale
```

`generate.test.mjs` regenerates in memory and compares to disk, so renaming a
skill or adding a connector turns the suite red until the generator is re-run.
That test IS the "docs change when the app changes" mechanism; without it,
generation is a one-off convenience that rots like anything else.

The generator **refuses to emit an em dash** rather than laundering one, because
the same strings render in the product: when it throws, fix the source and the
Skills page improves too. Nothing hand-written may live in `pages/reference/`,
and a test enforces that as well.

## Recipes

`mode: how-to` refuses to validate without an `installs:` id, and that id must
name a recipe in `pipeline/recipes.mjs`. Every recipe's cadence is validated by
the engine's own `scheduleProblem()`, the same function the box runs before it
will schedule anything: a recipe that would not fire on a real mineral cannot
ship inside a page that says it installs in one click.

This is also the answer to the empty-library ruling of 17 Aug. The library fills
from documented recipes, so writing the doc IS shipping the skill and the two
cannot disagree.

## The gates

Everything here runs in the clean-checkout suite on every push and pull request
(`suite.yml` collects `git ls-files '*.test.mjs'`), so none of it needs a browser.

**Hard, blocks the build:**

- **Generated reference is in sync.** Regenerated in memory and diffed.
- **Vocabulary.** `stamp`, `wire`, `mark` never reach a shipped page. `mineral`
  is brand and explicitly allowed (Sam, 2026-08-24); a test guards that too, so
  re-banning it fails with a readable reason rather than breaking three pages.
- **Pinned claims.** Sentences whose disappearance is a trust or legal problem,
  not a style regression: the privacy commitment, the continuity promise, the
  Google-BYO fact, the WhatsApp disclosure, the rock-is-not-in-the-data-chain
  line. Enforced the moment their page exists; reported until then, which makes
  `PINNED_CLAIMS` double as the writing queue.
- **The billing caveat.** A page carrying a screenshot with a price in it must
  say the price is indicative. Pricing is display-only until the 26 Sep
  read-date, and a screenshot of a number reads as a commitment.
- **Legal.** A `mode: legal` page cannot change its text without moving its
  version. `legal-lock.json` holds a body hash per page; the gate refuses
  exactly one combination, body changed and version unchanged. After a
  deliberate revision: bump `version:` and `effective:`, then
  `node docs/product/pipeline/legal.mjs --update`.

The counterparty named in every legal artefact is **Samuel Davis, trading as
Crads AI, ABN 26 929 349 775** (Coogee, NSW). Not registered for GST. The
incorporation decision sits on the 26 Sep read-date agenda.

**Soft, reports and exits 0:**

```
node docs/product/pipeline/drift.mjs
```

Hand-written prose is the only rot no test can see, so a page declares what it
describes (`pins:` plus `reviewed:`) and the ledger walks git history for pinned
paths touched since the review date. Triaged Sundays alongside `/weekly`.

The gates run on **shipped pages only**. Fixtures are unit-test material for the
source, render and shots contracts: gating test data would mean a fixture
written to exercise a refusal fails the build for exercising it. Each gate is
instead pinned on synthetic pages, so the mechanism is proven before the page it
guards is written.

## Running it

```
node --test $(git ls-files 'docs/product/pipeline/*.test.mjs')
```

Build steps 2-8 (fixture, screenshot rig, reference generation, CI gates,
seed pages, volume, website render) land against this base per the spec's
build order.
