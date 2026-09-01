# Pattern reference library (v1)

**Canonical home:** `engine/reference/` in the ai-os engine repo, shipped to client boxes via the engine image. Mirrored to the private `aios-patterns` GitHub repo so a live box can pull library updates without waiting for an image rebuild.

## What this is

A catalogue of structural patterns that make an AI-assisted "second brain" reliable over months of real use, not just at demo time. It was written by auditing a mature, heavily-used second-brain system against this engine's own architecture and pulling out the patterns worth generalising: not what one specific person did, but the shape of the problem and the shape of the fix.

Every pattern here is abstract. Examples use invented placeholder businesses (a florist, a bookkeeper, a gym owner) so the library reads the same on any client box. Nothing in this library is a client's actual data, decision, or business fact.

## Who reads this

1. **The client's own assistant, at runtime.** The primary audience. The assistant reads this library to understand what a well-run brain looks like structurally, notice where its own box falls short, and propose closing one gap at a time. `skills/self-improve.md` is the skill that does this on a cadence.
2. **The client, secondarily.** A non-technical business owner might read a pattern file to understand *why* the assistant is proposing a change. Every file is written so that reading works without engineering background. If a pattern file only makes sense to an engineer, it's not finished.

## Structure

```
README.md               (this file)
patterns/<slug>.md       (one file per pattern, 15 in v1, see below)
skills/self-improve.md   (draft engine skill: proposes one upgrade per week)
```

Each pattern file has:
- **Frontmatter**: `title` + `maturity`.
- **What it is**: 2-3 plain sentences.
- **Why it matters**: the failure mode it prevents, stated generically (never "this happened to a specific client").
- **How to adopt it on this box**: concrete steps, referencing `profile.yaml` fields or wiki conventions where the engine already has a hook for it.
- **Signals you need it**: observable symptoms an assistant (or a client) can actually notice, so this isn't just a checklist to apply blindly.

### Maturity tags

| Tag | Meaning | Who can act on it |
|---|---|---|
| `shipped-in-engine` | The engine already does this, on every box, today. Nothing to propose: if the assistant thinks this is missing, it's misreading its own box, not finding a real gap. | Nobody needs to do anything. Worth confirming the box is actually using what it has. |
| `assistant-can-adopt-now` | A convention or a light-touch change any client's assistant can propose and apply today, inside the existing engine (usually a wiki-conventions change, a rule the assistant follows, or a use of a `profile.yaml` field that already exists). No new engine code required. | The assistant, via `skills/self-improve.md` or in conversation. |
| `needs-engine-release` | Requires new engine capability that doesn't exist yet on any box (a hook, a new generic skill, a new staging surface). The assistant can *name* the gap but cannot close it itself. | An engine developer. The assistant should say so plainly rather than pretend it can build the fix. |

## How the assistant should use this library

- **Consult during weekly review**, via `skills/self-improve.md` (chained off `/weekly` or run standalone). Not every session: this is a slow-cadence check, not a running commentary on the client's setup.
- **Propose at most ONE upgrade at a time.** Never present the whole gap list. Pick the single highest-value, currently-adoptable pattern and make the case for it. A list of ten "you're missing X" items is overwhelming and reads as criticism, not help.
- **Never self-apply a change without confirmation.** Every proposal is propose-confirm, no exceptions, even for changes that feel obviously good. This mirrors the engine's own default (`comms.outbound_policy: propose-confirm`) applied to the box's own configuration, not just outbound messages.
- **Don't re-raise a declined suggestion inside 90 days.** If the client said no (or "not now"), that's a real answer. Log it and respect the cooldown. See the guardrails in `skills/self-improve.md`.
- **Don't propose a `needs-engine-release` pattern as an action.** If the highest-value gap needs new engine capability, say so honestly ("this would help, but it needs a feature that doesn't exist on any box yet") rather than promising something the assistant can't deliver.

## Provenance

v1 drafted 2026-07-10 from a structural pattern audit (30 patterns catalogued, gapped against the engine plus a staging client box). Operator-reviewed and shipped 2026-07-10. No real names, businesses, or incidents cross into this library: every example is invented. See the summary returned alongside this draft for what was deliberately deferred to a later version and why.
