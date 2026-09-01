# rock-machinery: the fleet control-plane (product module)

The generic machinery a rock box runs its fleet with: permission gate, job dispatcher,
self-healing git, headless runner, fleet heartbeat aggregation, and the operator dashboard.
Baked into `ai-os-parent`, linked to `$BRAIN_ROOT/cockpit` by `boot-rock.sh` at container
start. Versioned and rolled back with the image tag.

## Provenance rule (decided 2026-07-17, after the leak-hunt finding)

This module is **authored greenfield in this repo**. It is NEVER generated, copied, or
"scrubbed" from an operator's personal system. The prototype it re-implements (Sam's
second-brain cockpit) carries personal strategy, client names, and private paths embedded in
code; an audit proved a scrub-and-copy pipeline cannot be made safe against un-enumerated
proper nouns. So cleanliness here is by construction, not by laundering: improvements from
any operator's cockpit are ported deliberately, as generic rewrites.

## Clean-gate (enforced in CI)

Every file in this module must pass, as a hard CI check before any image bakes:

1. **No personal identity.** No person's name, email, phone, handle, or home path other
   than generic placeholders. No client or contact names, ever. The gate's marker list
   lives in `scripts/clean-gate.sh`, not here (quoting a marker is itself a hit).
2. **No business content in code.** No hardcoded strategy strings, meeting slugs, dashboard
   cards describing a real person's pipeline. Cards and jobs are config-driven, and config is
   staged per deployment (`/state/deployment.yaml` + the brain repo), never baked.
3. **No secrets.** No tokens, no `.env` (only `.env.example`), nothing the `.dockerignore`
   would have to save us from.
4. **Deployment-agnostic.** No org name in code or defaults. Anything org-specific reads from
   the staged config or the brain at `WIKI_DIR`.

## Contents (to be authored: the module contract)

| Piece | Re-implements (reference only) | Role |
|---|---|---|
| `permissions.mjs` | cockpit permission gate | default-deny outbound; secret-path deny-list |
| `run-job.mjs` | cockpit dispatcher | headless job runner, per-job grants |
| `git-sync.mjs` + `git-lock.mjs` | cockpit git self-heal | the fleet's git never wedges |
| `jobs.yaml` | cockpit job registry | declarative cadence; the brain stages the schedule |
| `heartbeat.mjs` | (new) | ingests member metadata pulses; never member content |
| `dashboard.mjs` | cockpit dashboard | fleet + registry view for operators, config-driven cards |
| `crontab` | (generated from jobs.yaml) | installed by boot-rock.sh |

Until these land, the module is this contract plus the clean-gate. `boot-rock.sh` treats an
image built without the pieces as "machinery pending" and boots the IDE regardless, so the
rock is usable while the module fills in.
