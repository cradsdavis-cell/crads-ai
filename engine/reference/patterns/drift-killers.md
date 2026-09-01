---
title: Drift-killer skill family (standing skills whose only job is finding incoherence)
maturity: needs-engine-release
---

## What it is

A small family of skills that exist purely to find drift in the brain and in the jobs running against it (a fast coherence scan, a connector health check, a deeper periodic sync, stub cleanup) rather than expecting every other skill to police its own quality as a side effect of doing its actual job.

## Why it matters

Without dedicated drift-detection, small inconsistencies accumulate invisibly: a page nothing links to anymore, a contact who should have a page and doesn't, a cron job that silently stopped running three weeks ago. None of these are dramatic on their own. By the time anyone notices the pattern, the fix is a big cleanup project instead of something caught and closed in minutes.

## How to adopt it on this box

- This is the single largest gap against what a mature setup has: none of a lint pass, a health check, a deeper sync, or stub cleanup exist as engine skills yet, so this is a `needs-engine-release` item, not something a client-box assistant can build for itself.
- The two simplest to build first are both read-only / report-only, with no design decisions needed: a lint pass checking the five frontmatter fields + a staleness threshold + broken cross-references, and a health check pinging whichever connectors are enabled (`accounts.*`) plus confirming the job queue isn't stuck.
- Until these ship, the closest available approximation is folding a manual version of the same questions into `/weekly` (which already does a lighter version of this for projects, see `freshness-staleness.md`).

## Signals you need it

- A job silently stops running and nobody notices for days.
- A page references a person, price, or offering that no longer exists.
- The client asks "is everything still working?" and the honest answer takes real investigation rather than a single command.
