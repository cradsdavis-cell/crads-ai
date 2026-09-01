# evidence/

Phase 1 of the v2 documentation plan. What the product HAS, extracted rather
than remembered, so a coverage claim has a denominator.

| File | What |
|---|---|
| `inventory.json` | the surface inventory: nav sections by face and group, member verbs, connectors, skills, machinery jobs. Regenerate with `node docs/product/pipeline/inventory.mjs --json > docs/product/evidence/inventory.json` |
| `discrepancies.md` | claims in the v1 docs that the evidence contradicts, with the correction |

Nothing in here is hand-listed. `inventory.mjs` throws rather than reporting an
empty surface, because a silently empty inventory reports 100% coverage of
nothing.
