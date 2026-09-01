---
name: self-improve
description: During weekly review, diff this box's setup against the pattern reference library, pick the single highest-value adoptable gap, and propose it to the client as one propose-confirm upgrade with rationale and effort estimate. Never more than one proposal a week; never auto-applies.
category: box             # Skills-page grouping (briefing|capture|comms|box|org|other)
generic: true        # config-driven; no client-specific values in this file
reads_profile:
  - identity.user_short
  - skills.enabled
  - skills.bespoke
reads:
  - reference/patterns/*.md      # the pattern library (this directory's sibling)
  - state/self-improve-log.md    # history of what's been proposed, accepted, declined
  - profile.yaml                 # what's actually configured on this box today
  - wiki/*                       # what conventions the wiki actually follows today
writes:
  - state/self-improve-log.md
  - "profile.yaml / wiki pages / skill config: only on confirm, only the exact change proposed"
---

# Skill: /self-improve  (generic)

The box looking at its own wiring once a week and asking one honest question: what's the single biggest gap between how this box is actually set up and how a well-run box is set up, that this box's assistant can actually close today? **Everything client-specific comes from `/state/profile.yaml` and this client's wiki. This skill hard-codes nothing about any pattern's content, it only reads `reference/patterns/*.md`.**

## Trigger
Chained off `/weekly` (runs after the review, before "next week's focus" is set) or invocable standalone as `/self-improve`. Weekly cadence only: this is not a running commentary, it's a once-a-week check.

## 0. Read the log first
Read `state/self-improve-log.md`. For each past entry, note: which pattern, when proposed, outcome (`adopted` / `declined` / `deferred`), and if declined, the date the 90-day cooldown clears. Anything still adopted stays out of consideration entirely (already done). Anything declined within the last 90 days is excluded from this run's candidate list.

## 1. Build the candidate list
Read every file in `reference/patterns/`. For each:
- If `maturity: shipped-in-engine` → skip. Nothing to propose; if the box seems to be missing it, that's a misconfiguration to note separately, not a self-improve proposal.
- If `maturity: needs-engine-release` → not actionable by this box. Keep a short "waiting on the engine" note for the output, but do not propose it as an action.
- If `maturity: assistant-can-adopt-now` and not already adopted and not in cooldown → candidate.

## 2. Score each candidate against this client's actual signals
For each candidate, check its "Signals you need it" section against this box's own state. Don't score on the pattern's general appeal, score on evidence this specific client actually has the symptom:
- Grep `wiki/log.md`, `logs/cron/*.md`, and recent session notes for anything matching the pattern's listed signals.
- Weight a candidate higher the more of its own signals show up in this client's actual logs, not the pattern's theoretical value.
- Tie-break by effort: prefer the cheaper, more mechanical adoption over the more involved one when signal strength is close.

## 3. Pick exactly one
Take the highest-scoring candidate. If nothing scores above a minimal bar (no real signal of the gap actually biting this client), say so plainly. **"nothing worth proposing this week"** is a valid, honest output. Don't manufacture a marginal proposal just to have something to say.

## 4. Present the proposal
```
Self-improve, week of {date} ({user_short})

Gap: {pattern title}
What's missing on this box: {one or two sentences, specific to this client's actual setup}
Evidence: {the specific signal(s) observed in this client's own logs/wiki, not a hypothetical}
What closing it looks like: {concrete steps from the pattern's "How to adopt" section}
Effort: {mechanical / half-day / multi-day, from the pattern file}

Apply? (y / edit / not now)
```
If a `needs-engine-release` item is the most relevant thing surfaced this week (even though it can't be proposed as an action), say so honestly in a short footer instead of silently omitting it: *"Also worth knowing: {pattern} would help here too, but needs an engine feature that doesn't exist on any box yet."*

## 5. Apply only on explicit confirm
- `y`: apply exactly the change described, nothing broader. Write to `profile.yaml` and/or the relevant wiki page(s) per the pattern's adoption steps.
- `edit`: take the client's adjustment, re-confirm the edited version before writing.
- `not now`: do not apply. Still log the outcome (see Step 6) with a 90-day cooldown.
**Never apply without one of these responses.** No exceptions for proposals that feel obviously good.

## 6. Log the outcome
Append to `state/self-improve-log.md` regardless of outcome:
```
## [{date}] {pattern-slug}
Outcome: adopted | declined | deferred
Evidence shown: {one-line}
{if declined/deferred:} Cooldown until: {date + 90d}
```
This is what makes the cooldown enforceable next run: Step 0 reads this file first.

## 7. One-line summary
```
Self-improve: proposed {pattern title} ({outcome}). {N} patterns waiting on engine release. {N} in cooldown.
```

## Rules
- **Never more than one proposal per run, and runs are weekly at most.** If the client asks for more, that's their call to make explicitly, the default is one.
- **Never auto-apply.** Every single change, however small, needs an explicit `y`/`edit` from the client this run. A past `y` on a similar-sounding change doesn't carry over.
- **Never re-propose a declined pattern before its 90-day cooldown clears.** A "not now" is a real answer, not a rejection to route around.
- **Never propose a `needs-engine-release` pattern as an action.** Name it as context if relevant, but don't imply the box can build it.
- **Evidence, not enthusiasm.** A proposal without an observed signal in this client's own logs is a guess, not a diagnosis. Don't present it as one.
- **Read-only until Step 5.** Steps 0-4 never write anything.
- If a source (log, wiki path) is missing, say so. Never fabricate evidence.

---

### Genericisation notes
Built generic from the start (no coupled original to lift from: this skill is new to the engine, drafted alongside the pattern library it reads). Design choices worth flagging for review:
| Concern | Decision | Why |
|---|---|---|
| Cadence | Weekly only, chained off `/weekly` | Matches the pattern library's own "consult during weekly review" instruction in `README.md`; a faster cadence risks nagging |
| Proposal cap | Exactly one per run | Mirrors the audit's own finding that a long gap list reads as criticism, not help |
| Cooldown | 90 days on decline | Long enough that "not now" is respected as a real answer, short enough that a client's situation can change and get re-offered |
| Scoring | Signal-evidence-weighted, not popularity-weighted | A pattern is only worth proposing if this specific client shows the symptom. Otherwise it's the assistant's opinion, not a diagnosis |
| `needs-engine-release` handling | Named but never proposed as an action | Keeps the skill honest about what a client-box assistant can and can't actually deliver |
