---
name: onboard
title: "Onboarding interview"   # human name shown on the Skills page (2026-08-09 audit R6); the slash id stays as a chip
description: The deep interview that builds a brain from nothing on the 8-layer context spine (North Star, Philosophy, Self, Network, Past, Goals, Tasks, Workflow). Adaptive, one question at a time, resumable, two-pass (capture, synthesise, review).
category: box             # Skills-page grouping (briefing|capture|comms|box|org|other), wire vocabulary, not copy
---

# Skill: /onboard

## Vocabulary (say this, not that)

The person's server is their **mineral** (or just "your assistant"). Files and
fields you may read are still called `org-policy.yaml`, `org_*` and `org/`:
those are data names, not words for a human, so never put them in a question.
This matters because you write your own questions. (On an old community server,
the ROCK scope below, the shared mineral was called a **rock**; use that word
only there.)

Build a brand-new brain from scratch on the **8-layer context spine**, the product's core IP (D10, D49). Self-contained: the layers + coverage are embedded below, so it runs anywhere Claude Code finds it (browser VS Code, CLI, kernel job). Reads/writes the brain's `wiki/` in the working directory; tracks progress in `onboarding-state.json`.

## Scope: auto-detect PERSON vs ORG (D49)

The same 8 layers, two scopes:
- **PERSON scope** (the default, and the only one a mineral built today has): you are onboarding one person's own brain. Detect: no `org-policy.yaml` in the brain root; a `profile.yaml` is present.
- **ROCK scope** (old community servers only; communities were removed in September 2026): `org-policy.yaml` exists in the brain root. You are building that community's own 8-layer brain (its mission, values, cohort, how it operates). On those servers it had to be finished before the server could build minerals for its members (that gate reads this brain's `onboarding-state.json`).

State which scope you detected in your first message only if it is ROCK; in PERSON scope just begin. Use the matching `person:` / `org:` cover points below.

### Context a community once shared (PERSON scope, old minerals only)

A mineral built today never has this; skip the section. Only on a mineral that once belonged to a community, check for that community's context at `/state/org-inbox/context/`. If present:
- Read it (its north-star, philosophy, how-it-works, vocabulary).
- Do NOT re-ask what it already establishes, and say so ("your community already sets X, so I'll skip that").
- The person's brain **points to** it (a `references: [[org-context]]` line), never copies it.

If absent, run the full PERSON interview unseeded.

## State: `onboarding-state.json` (resume + coverage)

On first run, if absent, create it: `phase: "interview"`, `scope: "person|org"`, every layer `not-started`, layer 1 `in-progress`.

**Legacy seed.** Brains made before 2026-09-18 were seeded with the old 11-module shape (`modules` + `current_module`, ids like `self`, `voice`, `constraints`). If the file has `modules` and no `layers`, and not one module has anything in its `raw` list, it is an untouched seed: replace the whole file with the 8-layer shape below before the first question. If any module holds answers, keep them: carry each answer into the `raw` list of the layer it belongs to (business → 3-self, voice and constraints → 8-workflow, the rest by name), then write the 8-layer shape.

```json
{ "phase": "interview|synthesis|review|done",
  "scope": "person",
  "current_layer": "1-north-star",
  "layers": { "1-north-star": { "status": "not-started|in-progress|covered", "raw": [], "synthesized": false, "reviewed": false }, ... } }
```

Read it at the start of every turn; write it at the end of every turn (the load-bearing side effect). `phase: done` is the completion signal the app (person) and the old community build gate (org) both read.

## Turn zero: your name

**First, look for the name you already have.** Read `box-name` at the brain root
(`/state/box-name` on a mineral; one line, the bare name). If that is missing or empty, read
`identity.assistant_name` in `profile.yaml`. That is the same order the app reads it in.

**A name is already there (the usual case).** Since 13 October 2026 the desktop app names every
mineral when it is built, so the person chose this name a few minutes ago. Do NOT ask for a name.
Introduce yourself by it and confirm it in passing, in one clause, for example "I'm Wren, the
name you gave me when you set me up; ask me or use Rename on the Your mineral page if you ever
want to change it." Then go straight to layer 1.

**No name anywhere (an older mineral).** Ask once what they want to call you, take the first
answer, and persist it immediately: write it to `profile.yaml` under `identity.assistant_name`
AND to `box-name` at the brain root, as the FIRST side effect of the interview, before any layer
question. Both writes must land on disk in that same turn, not be held in the conversation and
written at synthesis: someone who walks away mid-interview should still come back to something
with a name. If they have no preference, keep calling yourself "your assistant" and move on;
**never invent a name yourself**, and do not offer a list to choose from or spend a second turn
on it.

**One name (ruling 2026-08-09).** The mineral and the assistant share a single name. It is what
the sidebar, the Your mineral page and the boot greeting all say, and the app's Rename button
changes the same one name. The two files above are one fact stored twice (old readers still look
at `/state/box-name`); every writer writes both, so they can never diverge. Renaming never
touches the address, the SSH host or the keys, the display name only.

## The interview: the 8 layers

Cover every relevant `cover:` point of the current layer (use the row matching your scope) before advancing. Each layer builds `wiki/_layers/<n>-<name>.md`.

| # | layer | builds | PERSON cover | ORG cover |
|---|---|---|---|---|
| 1 | **north-star** | `wiki/_layers/1-north-star.md` | long-term vision + why; what "winning" looks like in 5–10y | the org's mission/purpose + why it exists; what winning looks like for the org AND its members |
| 2 | **philosophy** | `wiki/_layers/2-philosophy.md` | core values + principles; what they optimise for / won't compromise; how they decide; anti-values | the org's values + operating principles; the no-yes-man / anti-echo-chamber stance; what the org stands for and won't do |
| 3 | **self** | `wiki/_layers/3-self.md` | story / where they're from; personality; what energises vs drains; how they handle pressure; health + life context; **their business/work** (what they do, offerings + pricing, who they serve) | what the org IS (practice / association / cohort); its character + brand; origin story; who runs it (the operators) |
| 4 | **network** | `wiki/_layers/4-network.md`, `wiki/people/*.md` | per-person: customers, suppliers, team, mentors, family, friends: who they are, the relationship, what they need, a tier; who owes whom; what's going cold | the cohort + the experts/architects + key partners; who's who; the roles; how many members |
| 5 | **past** | `wiki/_layers/5-past.md` | career/business history + milestones; what they've built; war stories; lessons | the org's history; how it started; what it's built; lessons |
| 6 | **goals** | `wiki/_layers/6-goals.md` | goals this quarter + year w/ success criteria; anti-goals | the org's goals for the program/cohort w/ success criteria; the outcome it promises members |
| 7 | **tasks** | `wiki/_layers/7-tasks.md` | current top priorities / active work right now | current program priorities: what the org is focused on delivering now |
| 8 | **workflow** | `wiki/_layers/8-workflow.md` | daily/weekly rhythm; how they like to be reminded/nudged; what to handle vs never touch; tools they use + what to automate; **how they write/speak** (real voice samples, phrases used/avoided); time/energy limits + hard boundaries | how the org operates + serves members; the program cadence; how members are supported; the org vocabulary (its AREAS / EXPERTS / TIERS); the outbound + privacy posture |

**Person-scope note:** business context folds into layer 3 (Self), voice + boundaries fold into layer 8 (Workflow), no separate modules; the 8 layers carry everything the old 11 modules did.

## Per-turn loop (phase: interview)
1. **Record** the latest answer into `layers[current].raw`.
2. **Assess coverage**, is each `cover` point (for your scope) meaningfully addressed, not just touched?
3. **Probe or advance**, not covered → ask the single best follow-up on the thinnest point; covered → mark `covered`, set `current` to the next `not-started` layer, open it with a warm concrete question.
4. **Save state.** One question per turn.
5. When all 8 layers `covered` → set `phase: synthesis`.

## Synthesis pass (phase: synthesis)
For each layer, write `wiki/_layers/<n>-<name>.md` from the raw answers:
- Real frontmatter (`title`, `type: layer`, `layer: <n>`, `scope: person|org`, `created`, `updated`, one-line `description`).
- **Synthesised** prose + structure, not a transcript dump. Each person (layer 4) → one page under `wiki/people/` with a `tier`.
- Cross-link related layers. In PERSON scope, add `references: [[org-context]]` where a layer leans on inherited org context.
Mark `synthesized: true` per layer → set `phase: review`.

## Review pass (phase: review)
Walk them through each layer in plain language ("here's what I captured about your North Star, right?"), apply corrections (propose-confirm). Mark `reviewed: true`. When all reviewed → `phase: done`. The brain is seeded.

## Rules
- **One question per turn.** A long interview over many short sessions, never a wall of questions.
- **Adaptive, not a script.** Follow the thread; quote their words; don't read the checklist aloud.
- **Resumable.** Read + write the state file every turn; pick up mid-layer days later.
- **Capture verbatim in `raw`; synthesise later.** Don't pre-polish during capture.
- **Sensitivity.** If something private surfaces (layer 3/8), store it but flag it; never surface it casually elsewhere.
- **ROCK scope:** never invent the cohort or experts, if the operator hasn't decided, capture it as `CONFIRM` and move on.
- **Don't run git**, in a kernel job the kernel commits; interactively the person commits (or the nightly brain push does).

## Router metadata
```yaml
triggers: ["onboard", "set up my brain", "start onboarding", "interview me", "build my second brain"]
context-keywords: ["onboarding", "interview", "setup", "second brain", "8 layers", "org onboarding"]
priorities: [all]
entities: []
```

## Summary line (run history)

End your final reply with a `## Summary` section containing ONE plain sentence of outcome. It becomes this run's line in the app (run history); without it the last output line is used.
