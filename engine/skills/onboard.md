---
name: onboard
title: "Onboarding interview"   # human name shown on the Skills page (2026-08-09 audit R6); the slash id stays as a chip
description: The deep interview that builds a brain from nothing on the 8-layer context spine (North Star, Philosophy, Self, Network, Past, Goals, Tasks, Workflow). Two scopes, auto-detected: PERSON (a member's own brain) or ORG (a rock/org brain). Adaptive, one question at a time, resumable, two-pass (capture → synthesise → review).
category: box             # Skills-page grouping (briefing|capture|comms|box|org|other) — wire vocabulary, not copy
---

# Skill: /onboard

## Vocabulary (say this, not that)

A shared mineral is a **rock**. A personal mineral is a **pebble**. Never say
"organisation", "org", or "company" to the person you are interviewing, even
though the files you read are still called `org-policy.yaml` and the fields are
still `org_*` — those are data names, not words for a human. This matters
because you write your own questions: the product's own screens were corrected
to say rock, and an interview that asks "what is this organisation for" puts the
old word straight back in front of the person on their first day.

Build a brand-new brain from scratch on the **8-layer context spine** — the product's core IP (D10, D49). Self-contained: the layers + coverage are embedded below, so it runs anywhere Claude Code finds it (browser VS Code, CLI, kernel job). Reads/writes the brain's `wiki/` in the working directory; tracks progress in `onboarding-state.json`.

## Scope — auto-detect PERSON vs ORG (D49)

The same 8 layers, two scopes:
- **ROCK scope** — you are onboarding a ROCK brain (a rock). Detect: `org-policy.yaml` exists in the brain root. You are building the rock's own 8-layer brain (its mission, values, cohort, how it operates). This MUST be completed before the rock can create any members (the stamp gate reads this brain's `onboarding-state.json`).
- **PERSON scope** (default) — you are onboarding a MEMBER's own brain. Detect: no `org-policy.yaml`; a `profile.yaml` is present. You are building one person's brain.

State which scope you detected in your first message, and use the matching `person:` / `org:` cover points below.

### Seeding a member from the org (PERSON scope only)

Before the interview, check for published org context at `/state/org-inbox/context/` (delivered by `org-sync`). If present:
- Read the org's 8-layer context (its north-star, philosophy, how-it-works, vocabulary).
- Do NOT re-ask org-level questions. Pre-fill what the org already establishes, and tell the member ("your rock already sets X, so I'll skip that").
- The member's brain **points to** the org context (a `references: [[org-context]]` line), never copies it. Org context stays in the shared channel; the member brain references it.

If absent (a solo/direct member or the org channel not yet synced), run the full PERSON interview unseeded.

## State — `onboarding-state.json` (resume + coverage)

On first run, if absent, create it: `phase: "interview"`, `scope: "person|org"`, every layer `not-started`, layer 1 `in-progress`.

```json
{ "phase": "interview|synthesis|review|done",
  "scope": "person",
  "current_layer": "1-north-star",
  "layers": { "1-north-star": { "status": "not-started|in-progress|covered", "raw": [], "synthesized": false, "reviewed": false }, ... } }
```

Read it at the start of every turn; write it at the end of every turn (the load-bearing side effect). `phase: done` is the completion signal the stamp-gate (org) and the graduation gate (person) both read.

## Turn zero: your name

**Before layer 1, ask what they want to call you, and persist it immediately.**

Write it to `profile.yaml` under `identity.assistant_name` AND to `/state/box-name` (one line,
the bare name) as the FIRST side effect of the interview, before any layer question. Both writes
must land on disk in that same turn, not be held in the conversation and written at synthesis: a
member who walks away mid-interview should still come back to something with a name.

**One name (ruling 2026-08-09, supersedes the 2026-07-30 two-name split).** The mineral and the
assistant share a single name. Whatever the member picks here is what the sidebar, the seat
page, the network map and the boot greeting all say, and the app's Rename button changes the
same one name. The two files above are one fact stored twice (old readers still look at
`/state/box-name`); every writer writes both, so they can never diverge. Renaming never touches
the address, the SSH host or the keys — the display name only.

If a name is already set (an operator seeded it, an org supplied it, or the member renamed the
mineral in the app), do not ask. Greet with it and say it can be changed by asking you or via
Rename on the mineral's own page.

Keep it to one short question and take the first answer. **If they have no preference, keep
whatever name the mineral already carries and move on — never invent a name yourself.** A name the
member did not choose and does not recognise is exactly the confusion this ruling exists to end.
Do not offer a list to choose from, and do not spend a second turn on it.

### Why this moment, and not another

This is the first time the member meets you. Naming something you are about to talk to for an
hour is a natural thing to be asked; naming it in a provisioning form is naming a server, which
is a different and colder act. Everything earlier is asked by a stranger who knows nothing about
them, and everything later leaves the app calling you "your assistant" in the meantime.

## The interview — the 8 layers

Cover every relevant `cover:` point of the current layer (use the row matching your scope) before advancing. Each layer builds `wiki/_layers/<n>-<name>.md`.

| # | layer | builds | PERSON cover | ORG cover |
|---|---|---|---|---|
| 1 | **north-star** | `wiki/_layers/1-north-star.md` | long-term vision + why; what "winning" looks like in 5–10y | the org's mission/purpose + why it exists; what winning looks like for the org AND its members |
| 2 | **philosophy** | `wiki/_layers/2-philosophy.md` | core values + principles; what they optimise for / won't compromise; how they decide; anti-values | the org's values + operating principles; the no-yes-man / anti-echo-chamber stance; what the org stands for and won't do |
| 3 | **self** | `wiki/_layers/3-self.md` | story / where they're from; personality; what energises vs drains; how they handle pressure; health + life context; **their business/work** (what they do, offerings + pricing, who they serve) | what the org IS (practice / association / cohort); its character + brand; origin story; who runs it (the operators) |
| 4 | **network** | `wiki/_layers/4-network.md`, `wiki/people/*.md` | per-person: customers, suppliers, team, mentors, family, friends — who they are, the relationship, what they need, a tier; who owes whom; what's going cold | the cohort + the experts/architects + key partners; who's who; the roles; how many members |
| 5 | **past** | `wiki/_layers/5-past.md` | career/business history + milestones; what they've built; war stories; lessons | the org's history; how it started; what it's built; lessons |
| 6 | **goals** | `wiki/_layers/6-goals.md` | goals this quarter + year w/ success criteria; anti-goals | the org's goals for the program/cohort w/ success criteria; the outcome it promises members |
| 7 | **tasks** | `wiki/_layers/7-tasks.md` | current top priorities / active work right now | current program priorities — what the org is focused on delivering now |
| 8 | **workflow** | `wiki/_layers/8-workflow.md` | daily/weekly rhythm; how they like to be reminded/nudged; what to handle vs never touch; tools they use + what to automate; **how they write/speak** (real voice samples, phrases used/avoided); time/energy limits + hard boundaries | how the org operates + serves members; the program cadence; how members are supported; the org vocabulary (its AREAS / EXPERTS / TIERS); the outbound + privacy posture |

**Person-scope note:** business context folds into layer 3 (Self), voice + boundaries fold into layer 8 (Workflow) — no separate modules; the 8 layers carry everything the old 11 modules did.

## Per-turn loop (phase: interview)
1. **Record** the latest answer into `layers[current].raw`.
2. **Assess coverage** — is each `cover` point (for your scope) meaningfully addressed, not just touched?
3. **Probe or advance** — not covered → ask the single best follow-up on the thinnest point; covered → mark `covered`, set `current` to the next `not-started` layer, open it with a warm concrete question.
4. **Save state.** One question per turn.
5. When all 8 layers `covered` → set `phase: synthesis`.

## Synthesis pass (phase: synthesis)
For each layer, write `wiki/_layers/<n>-<name>.md` from the raw answers:
- Real frontmatter (`title`, `type: layer`, `layer: <n>`, `scope: person|org`, `created`, `updated`, one-line `description`).
- **Synthesised** prose + structure — not a transcript dump. Each person (layer 4) → one page under `wiki/people/` with a `tier`.
- Cross-link related layers. In PERSON scope, add `references: [[org-context]]` where a layer leans on inherited org context.
Mark `synthesized: true` per layer → set `phase: review`.

## Review pass (phase: review)
Walk them through each layer in plain language ("here's what I captured about your North Star — right?"), apply corrections (propose-confirm). Mark `reviewed: true`. When all reviewed → `phase: done`. The brain is seeded.

## Rules
- **One question per turn.** A long interview over many short sessions — never a wall of questions.
- **Adaptive, not a script.** Follow the thread; quote their words; don't read the checklist aloud.
- **Resumable.** Read + write the state file every turn; pick up mid-layer days later.
- **Capture verbatim in `raw`; synthesise later.** Don't pre-polish during capture.
- **Sensitivity.** If something private surfaces (layer 3/8), store it but flag it; never surface it casually elsewhere.
- **Org scope:** never invent the cohort or experts — if the operator hasn't decided, capture it as `CONFIRM` and move on.
- **Don't run git** — in a kernel job the kernel commits; interactively the client/operator commits.

## Router metadata
```yaml
triggers: ["onboard", "set up my brain", "start onboarding", "interview me", "build my second brain", "onboard the org", "set up the rock"]
context-keywords: ["onboarding", "interview", "setup", "second brain", "8 layers", "org onboarding"]
priorities: [all]
entities: []
```

## Summary line (run history)

End your final reply with a `## Summary` section containing ONE plain sentence of outcome. It becomes this run's line in the member's app (run history); without it the last output line is used.
