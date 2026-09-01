// lineage.mjs · T4.1: the frozen birth record + the reframe history, pure.
// C2 (system-logic pass, ruled): stampedBy/origin are FROZEN at creation and
// never touched by edge edits, transfers, or re-anchors; "born: seeded by X"
// survives leaving X. Reframes (framework adoption by consent, /reframe with
// intensity overlay|integrate|rebuild) are the ONLY legal append, and declined
// offers are recorded too: re-anchoring re-offers declined reframes (ruled
// 2026-07-27), which needs the history to exist.
const INTENSITIES = new Set(['overlay', 'integrate', 'rebuild']);
const OUTCOMES = new Set(['accepted', 'declined']);

export function buildLineage({ stampedBy = '', framework = '', date = '' } = {}) {
  return {
    origin: stampedBy ? 'stamped' : 'self',
    stamped_by: stampedBy,
    born: date,
    framework_imprint: stampedBy ? framework : '',
    reframes: [],
  };
}

export function appendReframe(lineage, { from = '', framework = '', intensity = '', date = '', outcome = '' } = {}) {
  if (!INTENSITIES.has(intensity)) throw new Error(`intensity must be overlay|integrate|rebuild (got "${intensity}")`);
  if (!OUTCOMES.has(outcome)) throw new Error(`outcome must be accepted|declined (got "${outcome}")`);
  return { ...lineage, reframes: [...(lineage.reframes || []), { from, framework, intensity, date, outcome }] };
}

// Consumers call this before any lineage write: the new record must be the old
// one plus (possibly) appended reframes. Anything else is a frozen-field edit.
export function assertLineageFrozen(oldL = {}, newL = {}) {
  for (const k of ['origin', 'stamped_by', 'born', 'framework_imprint']) {
    if (oldL[k] !== newL[k]) throw new Error(`lineage is frozen: '${k}' cannot change (was "${oldL[k]}", attempted "${newL[k]}")`);
  }
  const oldR = oldL.reframes || [], newR = newL.reframes;
  if (!Array.isArray(newR) || newR.length < oldR.length) throw new Error('lineage is frozen: reframes only append');
  for (let i = 0; i < oldR.length; i++) {
    if (JSON.stringify(newR[i]) !== JSON.stringify(oldR[i])) throw new Error('lineage is frozen: existing reframes cannot be rewritten');
  }
}
