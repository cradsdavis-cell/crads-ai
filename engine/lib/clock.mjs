// clock.mjs — the injectable clock (spec §0.5). The box NEVER reads the OS wall
// clock for any artifact it stamps; it reads virtual time so the harness can drive
// the whole engagement in deterministic virtual time and detect wall-clock leaks.
//
// Resolution order for now():
//   1. env AIOS_FAKE_NOW            (an ISO instant — highest precedence, per-invocation)
//   2. state/clock.json            (AIOS_CLOCK_FILE, else <stateDir>/state/clock.json) → {now, tz, speedup}
//   3. real Date()                 (production — ONLY when neither override is set)
//
// In production, no AIOS_FAKE_NOW + no clock.json ⇒ now() === real time, so this is
// transparent to a live client box. In test mode the harness sets one of the two.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function clockSource(stateDir) {
  if (process.env.AIOS_FAKE_NOW) return { now: process.env.AIOS_FAKE_NOW, src: 'env:AIOS_FAKE_NOW', tz: null };
  const cf = process.env.AIOS_CLOCK_FILE || (stateDir ? path.join(stateDir, 'state', 'clock.json') : null);
  if (cf) {
    try { const c = JSON.parse(readFileSync(cf, 'utf8')); if (c && c.now) return { now: c.now, src: `file:${cf}`, tz: c.tz || null }; } catch {}
  }
  return { now: null, src: 'real', tz: null };
}

export function now(stateDir) {
  const s = clockSource(stateDir);
  return s.now ? new Date(s.now) : new Date();
}
export const nowISO = (stateDir) => now(stateDir).toISOString();

// Is the box running on virtual time? (true ⇒ artifacts must NOT contain wall-clock ts)
export const isVirtual = (stateDir) => clockSource(stateDir).src !== 'real';

// Client-LOCAL calendar date (YYYY-MM-DD) for the given IANA tz — spec §0.5 requires
// all windows in client-tz calendar terms, so the brief stamps the LOCAL date.
export function localDate(stateDir, tz) {
  const d = now(stateDir);
  if (!tz) return d.toISOString().slice(0, 10);
  // en-CA gives YYYY-MM-DD; timeZone does the tz-aware calendar conversion.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
// Client-local "HH:MM" too (used by future cadence-trigger evaluation).
export function localTime(stateDir, tz) {
  const d = now(stateDir);
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

// Write/advance the virtual clock file (harness control).
export function setClock(stateDir, iso, tz = null, speedup = 0) {
  const dir = path.join(stateDir, 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'clock.json'), JSON.stringify({ now: iso, tz, speedup }, null, 2) + '\n');
  return path.join(dir, 'clock.json');
}

// CLI: node clock.mjs --now <stateDir> | --set <stateDir> <iso> [tz] | --local <stateDir> <tz>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, stateDir, a, b] = process.argv.slice(2);
  if (cmd === '--now') console.log(nowISO(stateDir));
  else if (cmd === '--set') console.log('wrote ' + setClock(stateDir, a, b || null));
  else if (cmd === '--local') console.log(localDate(stateDir, a));
  else { console.error('usage: clock.mjs --now <stateDir> | --set <stateDir> <iso> [tz] | --local <stateDir> <tz>'); process.exit(1); }
}
