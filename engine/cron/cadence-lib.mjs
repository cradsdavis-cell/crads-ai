// cadence-lib.mjs — pure schedule logic for the box scheduler (cadence v2,
// spec docs/superpowers/specs/2026-08-04-skills-cadence-library-design.md § 4).
// No filesystem, no clock: scheduler.mjs owns IO and time, this owns meaning,
// so every rule here is unit-testable without a box.
//
// cockpit/cadence.json v2:
//   { "version": 2,
//     "migrated_profile_cadence": true,        // set once by the fold-in
//     "jobs": {
//       "<skill-id>": {
//         "enabled": true,
//         "deliver": false,                    // route output to the member's Telegram
//         "schedule":
//             { "kind": "times", "days": ["mon","wed"], "times": ["07:00","16:30"] }
//           | { "kind": "every", "minutes": 120, "quiet": true }
//           | { "kind": "every-days", "n": 3, "time": "09:00", "anchor": "2026-08-04" }
//       } } }
//
// v1 ({ "<id>": { enabled, when: daily|weekly|off, time } }) is read-compatible:
// daily -> times/every day, weekly -> times/Monday (the old hardcode, preserved
// so nothing silently moves). Writers always write v2.

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];   // index = Date dow
export const EVERY_FLOOR_MIN = 30;   // a claude -p every few minutes exhausts the member's own plan

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseTime(t) {
  const [h, m] = String(t).split(':').map(Number);
  return { h, m };
}

// ---- v1 -> v2 ---------------------------------------------------------------

export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.schedule && typeof raw.schedule === 'object') {
    return { enabled: raw.enabled === true, deliver: raw.deliver === true, schedule: raw.schedule };
  }
  // v1 shape
  const time = TIME_RE.test(String(raw.time || '')) ? raw.time : '07:00';
  if (raw.when === 'daily') return { enabled: raw.enabled === true, deliver: raw.deliver === true, schedule: { kind: 'times', days: [], times: [time] } };
  if (raw.when === 'weekly') return { enabled: raw.enabled === true, deliver: raw.deliver === true, schedule: { kind: 'times', days: ['mon'], times: [time] } };
  return { enabled: false, deliver: false, schedule: { kind: 'times', days: [], times: [time] } };
}

export function normalizeCadence(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: 2, jobs: {} };
  const src = (raw.version === 2 && raw.jobs && typeof raw.jobs === 'object') ? raw.jobs : raw;
  const jobs = {};
  for (const [id, entry] of Object.entries(src)) {
    if (!ID_RE.test(id)) continue;
    const n = normalizeEntry(entry);
    if (n) jobs[id] = n;
  }
  const out = { version: 2, jobs };
  if (raw.migrated_profile_cadence === true) out.migrated_profile_cadence = true;
  return out;
}

// ---- schedule validity + matching -------------------------------------------

// Returns null when valid, else a one-line reason. Invalid schedules never fire.
export function scheduleProblem(s) {
  if (!s || typeof s !== 'object') return 'no schedule';
  if (s.kind === 'times') {
    const days = Array.isArray(s.days) ? s.days : [];
    if (days.some((d) => !DAY_KEYS.includes(d))) return 'unknown day name';
    const times = Array.isArray(s.times) ? s.times : [];
    if (!times.length) return 'no times set';
    if (times.some((t) => !TIME_RE.test(String(t)))) return 'malformed time';
    return null;
  }
  if (s.kind === 'every') {
    const m = Number(s.minutes);
    if (!Number.isInteger(m) || m < EVERY_FLOOR_MIN) return `minutes must be an integer >= ${EVERY_FLOOR_MIN}`;
    return null;
  }
  if (s.kind === 'every-days') {
    if (!Number.isInteger(Number(s.n)) || Number(s.n) < 1) return 'n must be a positive integer';
    if (!TIME_RE.test(String(s.time || ''))) return 'malformed time';
    if (!YMD_RE.test(String(s.anchor || ''))) return 'anchor must be YYYY-MM-DD';
    return null;
  }
  return 'unknown schedule kind';
}

// now: { hour, minute, dow (0=Sun..6=Sat), ymd "YYYY-MM-DD", quiet "22:00-07:00"|"" }
export function scheduleMatches(s, now) {
  if (scheduleProblem(s)) return false;
  if (s.kind === 'times') {
    const days = Array.isArray(s.days) && s.days.length ? s.days : DAY_KEYS;
    if (!days.includes(DAY_KEYS[now.dow])) return false;
    return s.times.some((t) => { const { h, m } = parseTime(t); return h === now.hour && m === now.minute; });
  }
  if (s.kind === 'every') {
    if ((now.hour * 60 + now.minute) % Number(s.minutes) !== 0) return false;
    if (s.quiet !== false && inQuiet(now.quiet || '', now.hour, now.minute)) return false;
    return true;
  }
  if (s.kind === 'every-days') {
    const { h, m } = parseTime(s.time);
    if (h !== now.hour || m !== now.minute) return false;
    const diff = Math.round((Date.parse(now.ymd + 'T00:00:00Z') - Date.parse(s.anchor + 'T00:00:00Z')) / 86400000);
    return diff >= 0 && diff % Number(s.n) === 0;
  }
  return false;
}

export function inQuiet(quiet, hour, minute) {
  const m = String(quiet || '').match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const cur = hour * 60 + minute, a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
  return a <= b ? (cur >= a && cur < b) : (cur >= a || cur < b);   // handles overnight windows
}

// Human one-liner for --plan and logs (the app renders its own labels).
export function describeSchedule(s) {
  const p = scheduleProblem(s);
  if (p) return `invalid (${p})`;
  if (s.kind === 'times') {
    const days = Array.isArray(s.days) && s.days.length ? s.days.join('+') : 'daily';
    return `${days} ${s.times.join(',')}`;
  }
  if (s.kind === 'every') return `every ${s.minutes}m${s.quiet !== false ? ' (quiet-aware)' : ''}`;
  return `every ${s.n}d ${s.time} (from ${s.anchor})`;
}

// ---- profile fold-in (§ 4.2) -------------------------------------------------
// The four profile-cadence jobs become ordinary cadence.json entries, seeded
// once from profile.yaml and member-owned after that. profile: the parsed
// object scheduler.loadCadence() already builds ({enabled, mh, mm, eh, em,
// watch, wdow, wh, wmin}). todayYmd anchors the inbox interval entry.
// Existing entries are never overwritten; the flag makes this run exactly once.
export function migrateProfileCadence(cad, profile, { anchorYmd }) {
  const next = normalizeCadence(cad);
  if (next.migrated_profile_cadence === true) return { changed: false, cadence: next };
  const two = (n) => String(n).padStart(2, '0');
  const seeds = {
    daily:   { deliver: true,  schedule: { kind: 'times', days: [], times: [`${two(profile.mh)}:${two(profile.mm)}`] } },
    capture: { deliver: false, schedule: { kind: 'times', days: [], times: [`${two(profile.eh)}:${two(profile.em)}`] } },
    weekly:  { deliver: true,  schedule: { kind: 'times', days: [DAY_KEYS[profile.wdow] || 'sun'], times: [`${two(profile.wh)}:${two(profile.wmin)}`] } },
    inbox:   { deliver: false, schedule: { kind: 'every', minutes: Math.max(EVERY_FLOOR_MIN, profile.watch || 60), quiet: true } },
  };
  for (const [id, seed] of Object.entries(seeds)) {
    if (next.jobs[id]) continue;   // the member already owns this entry
    const on = profile.enabled === true && (id !== 'inbox' || (profile.watch || 0) > 0);
    next.jobs[id] = { enabled: on, deliver: seed.deliver, schedule: seed.schedule };
  }
  void anchorYmd;   // reserved: every-days seeds would anchor here
  next.migrated_profile_cadence = true;
  return { changed: true, cadence: next };
}

// ---- job building ------------------------------------------------------------
// From a raw cadence.json value to fireable jobs. Every job is a skill job
// (kernel enqueue+drain); machinery never comes from this file.
export function buildJobsFromCadence(raw, { quiet = '' } = {}) {
  const cad = normalizeCadence(raw);
  const jobs = [];
  for (const [id, entry] of Object.entries(cad.jobs)) {
    if (!entry.enabled) continue;
    if (scheduleProblem(entry.schedule)) continue;
    jobs.push({
      name: `skill /${id} (${describeSchedule(entry.schedule)})`,
      skill: id,
      isSkill: true,
      deliver: entry.deliver === true,
      match: (hour, minute, dow, ymd) => scheduleMatches(entry.schedule, { hour, minute, dow, ymd, quiet }),
    });
  }
  return jobs;
}
