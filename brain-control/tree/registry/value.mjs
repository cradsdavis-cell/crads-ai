// value.mjs · T5.1: the value model, MODEL-ONLY, over ONE org's registry plane.
// Ported from the console's ledger()/fleetTotals() (the sandbox is the
// reference implementation; divergence here is a bug HERE). Nothing charges:
// the registry just knows every box's payer, seat and model line truthfully,
// so Stripe (its own later epic) lands on true numbers.
//
// Registry mapping of the sandbox's dials: runs:self|owner|crads-ai ->
// managed_by member|org|crads-ai · owner:'self'|rockId -> 'member'|<org-slug>
// · home -> anchor. This plane sees the org's OWN rows only (anchored here);
// community members anchored elsewhere are the directory's to count (T5.2).
export const PER_BRAIN = 100;   // the model bill: brains x $100/mo to Anthropic

const live = (r) => r.status !== 'left';

// The per-box SEAT line: who carries this box's machinery seat.
export function boxSeatLine(row = {}, { anchorSlug = '' } = {}) {
  if (!live(row)) {
    return row.owner !== 'member'
      ? `seat: none, decommissioned, brain absorbed into ${row.owner}`
      : 'seat: none, left (their brain went with them)';
  }
  if (row.managed_by === 'member') return 'seat: their own licence (self-run, by approved request)';
  if (row.managed_by === 'org') return `seat: ${anchorSlug}'s metal`;
  return `seat: hosted, ${anchorSlug} pays`;
}

// The org's own ledger rows ({k, t}, the console's shape).
export function orgLedger(rows = [], { anchorSlug = '', orgOwnBrain = 1 } = {}) {
  const out = [];
  const alive = rows.filter(live);
  const ownedRows = alive.filter((r) => r.owner === anchorSlug || r.owner === 'org');
  const brains = orgOwnBrain + ownedRows.length;
  if (brains) out.push({ k: 'model', t: `pays Anthropic ~$${brains * PER_BRAIN}/mo, ${brains} brain${brains > 1 ? 's' : ''}` });
  const runSeats = alive.filter((r) => r.managed_by === 'org').length;
  if (runSeats) out.push({ k: 'licence', t: `pays Crads AI machinery, ${runSeats} seat${runSeats > 1 ? 's' : ''} it runs` });
  const hostedSeats = alive.filter((r) => r.managed_by === 'crads-ai').length;
  if (hostedSeats) out.push({ k: 'hosted', t: `pays Crads AI ${hostedSeats} hosted seat${hostedSeats > 1 ? 's' : ''}` });
  if (alive.length) out.push({ k: 'plat', t: `pays Crads AI platform: ${alive.length} home` });
  // members IN: live boxes whose fees are their own (member-owned or owned by
  // ANOTHER org; keystone 4 makes an owned box's fees the owner's, so boxes
  // this org owns pay it nothing).
  const paying = alive.filter((r) => r.owner !== anchorSlug && r.owner !== 'org').length;
  if (paying) out.push({ k: 'in', t: `gets ${paying} home member${paying > 1 ? 's' : ''}` });
  return out;
}

// Fleet totals for this plane (the platform seat sums planes + directory).
export function fleetTotals(rows = [], { anchorSlug = '', orgOwnBrain = 1 } = {}) {
  const alive = rows.filter(live);
  const brains = orgOwnBrain + alive.length; // every live anchored box is a brain someone pays for
  return {
    boxes: rows.length,
    anthropic: brains * PER_BRAIN,
    hostedSeats: alive.filter((r) => r.managed_by === 'crads-ai').length,
    runSeats: alive.filter((r) => r.managed_by === 'org').length,
  };
}
