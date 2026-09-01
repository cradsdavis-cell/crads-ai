---
title: Frontmatter + validation (a small structured header on every page, checked)
maturity: needs-engine-release
---

## What it is

Every brain page carries a small structured header: a title, a type (is this a business fact, a person, a project, a past decision?), a created date, an updated date, and a one-line description. A stronger version adds a machine-checkable rule set (which types are allowed, which fields each type requires) enforced by a lint pass, with a harder gate that blocks only the handful of edits that would silently corrupt the brain (a broken cross-reference, an invalid date, a type that doesn't exist).

## Why it matters

Without structure, there's no way to answer "show me everything active" or "what hasn't been touched in a month" without reading every single page. Free-text pages also drift quietly: a status gets changed in the prose ("we're not doing this anymore") but nowhere a skill can actually check it, so two different skills end up disagreeing about the same fact because they read different parts of the same unstructured page.

## How to adopt it on this box

- The **light version is already available today**: every generic engine skill already expects title / type / created / updated / description on brain pages. Keep using it consistently: this alone makes "what's current" answerable by a machine, not just by re-reading prose.
- The **stronger version (a real schema file, a lint skill, a hard-gate hook)** is not yet built anywhere in the engine (`engine/hooks/` is currently empty and there's no generic `/lint` skill). This is a `needs-engine-release` item; the assistant on a client box cannot build the hook or the lint skill itself.
- Until it ships, approximate the value manually: when writing or reading a page, check the five light-convention fields exist and are internally consistent, and mention it if they're missing rather than silently proceeding.

## Signals you need it

- The assistant genuinely isn't sure whether a page is still current.
- Two pages contradict each other with no way to tell which one is newer.
- A page that should be marked done or archived is still being treated as active because nothing ever flips a status field.
- Onboarding review turns up pages with missing or malformed headers that nobody noticed until asked to look.
