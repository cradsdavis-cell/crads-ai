// layers.mjs: the 8-layer onboarding seed, in the shape /onboard itself writes.
//
// Until 2026-09-18 a new brain (box-up.sh via init-state.mjs, and the local
// face via local-scaffold.mjs) was seeded from interview-spec.yaml, the
// pre-rewrite 11-module map, while engine/skills/onboard.md reads and writes
// the 8 layers under `layers` + `current_layer`. A fresh brain therefore said
// "0 of 11 steps, current: self" beside a ladder that said "The 8 layers", and
// /onboard's first turn met a file in a shape it does not document. This is
// the one list both seeders use; its ids are the ones onboard.md's table
// names (`wiki/_layers/<id>.md`).

export const LAYERS = [
  '1-north-star',
  '2-philosophy',
  '3-self',
  '4-network',
  '5-past',
  '6-goals',
  '7-tasks',
  '8-workflow',
];

/**
 * The state /onboard expects on its first turn: interview phase, every layer
 * not-started, layer 1 in progress. `scope` is "org" for a rock brain (it has
 * org-policy.yaml), "person" otherwise, exactly as onboard.md detects it.
 */
export function initialLayersState({ scope = 'person' } = {}) {
  const layers = Object.fromEntries(LAYERS.map((id) => [id, { status: 'not-started', raw: [], synthesized: false, reviewed: false }]));
  layers[LAYERS[0]].status = 'in-progress';
  return { phase: 'interview', scope: scope === 'org' ? 'org' : 'person', current_layer: LAYERS[0], layers };
}

/**
 * True for a state file still in the legacy seed shape that nobody has
 * answered into: `modules`, no `layers`, and not one raw answer recorded.
 * Safe to replace with initialLayersState(); anything with answers is kept.
 */
export function isUntouchedLegacySeed(st) {
  if (!st || typeof st !== 'object' || st.layers || !st.modules || typeof st.modules !== 'object') return false;
  if (st.phase && st.phase !== 'interview') return false;
  return Object.values(st.modules).every((m) => !m || !Array.isArray(m.raw) || m.raw.length === 0);
}
