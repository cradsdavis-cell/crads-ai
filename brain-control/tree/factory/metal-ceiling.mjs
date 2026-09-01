#!/usr/bin/env node
// metal-ceiling.mjs · the HARD per-rock box ceiling (Mountain model, 2026-08-04).
// The band is soft — a stamp past the tier band is allowed, flagged, and
// reconciled on the next invoice — but the METAL is hard: provisioning refuses
// past the ceiling, because every stamp is a real VM on the platform's card and
// a runaway loop or a hostile rock must hit a wall before the bill does.
// Default 5 boxes per rock until real tier numbers are priced; raise per-org
// with AIOS_METAL_CEILING, deliberately, never silently.
//
// Pure + testable, same shape as ownership-resolve.mjs: stamp-pebble.sh shells
// out to the CLI, tests import ceilingVerdict. A row counts against the ceiling
// unless its status is explicitly 'left' — same fail-safe reading as the
// teardown and demote guards (a malformed row is a live row, never a free slot).

import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

export const DEFAULT_CEILING = 5;

export function ceilingVerdict({ statuses = [], ceiling = DEFAULT_CEILING } = {}) {
  // 0 and negatives deliberately fall back rather than refusing everything
  // forever: see tests/metal-ceiling.test.mjs, "zero... not a real ceiling".
  // The fallback is no longer SILENT though — an operator who sets a value this
  // rejects was trying to say something, and a hard guard quietly running at a
  // number nobody chose is how a guard stops meaning anything.
  const asked = Number(ceiling);
  const usable = Number.isFinite(asked) && asked > 0;
  if (ceiling !== undefined && ceiling !== null && ceiling !== '' && !usable) {
    process.emitWarning(`metal ceiling: "${ceiling}" is not a usable ceiling; running at the default of ${DEFAULT_CEILING}.`);
  }
  const cap = usable ? asked : DEFAULT_CEILING;
  const live = statuses.filter((s) => String(s || '').trim().replace(/^"|"$/g, '') !== 'left').length;
  return { live, ceiling: cap, full: live >= cap };
}

// regex-reader (house style: no YAML dependency): the top-level status line.
export function rowStatus(text) {
  const m = String(text || '').match(/^status:\s*("?[a-z]*"?)\s*$/m);
  return m ? m[1] : ''; // '' = unreadable = counts as live (fail-safe)
}

export function readRegistryStatuses(dir) {
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.yaml') && !basename(f).startsWith('_')); } catch { return []; }
  return files.map((f) => { try { return rowStatus(readFileSync(join(dir, f), 'utf8')); } catch { return ''; } });
}

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}

if (process.argv[1] && process.argv[1].endsWith('metal-ceiling.mjs')) {
  const dir = argOf('--dir');
  const v = ceilingVerdict({ statuses: readRegistryStatuses(dir), ceiling: argOf('--ceiling') || DEFAULT_CEILING });
  if (v.full) {
    process.stderr.write(
      `METAL CEILING: this rock already has ${v.live} live box${v.live === 1 ? '' : 'es'} `
      + `(ceiling ${v.ceiling}). The stamp is refused at provisioning time — the tier band is soft `
      + `and reconciles on the invoice, but the metal guard is hard. Raise AIOS_METAL_CEILING `
      + `deliberately, or contact Crads AI.\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(v) + '\n');
}
