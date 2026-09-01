// recipes.mjs - the installable artefacts a how-to ships.
//
// The spec's ruling (2026-08-24): every how-to page teaches a pattern AND
// installs it, through the panel's `catalog-install` verb. A how-to that only
// tells you what to type is prose pretending to be a recipe, so `mode: how-to`
// refuses to validate without an `installs:` id and that id must appear here.
//
// This also answers the 17 Aug empty-library ruling with a mechanism rather
// than a backlog: the library fills from documented recipes, so writing the
// doc IS shipping the skill, and the two can never disagree.
//
// Every cadence below is validated by the ENGINE's own `scheduleProblem()`, the
// same function the box runs before it will schedule anything. A recipe that
// would not fire on a real mineral cannot ship in a doc that says it will.
import { scheduleProblem } from '../../../engine/cron/cadence-lib.mjs';

// A recipe: { id, title, what, skill, cadence, why }
//   id      - what a how-to page writes in `installs:`
//   skill   - the engine skill it schedules (must exist in engine/skills/)
//   cadence - a real cadence entry: { enabled, deliver, schedule }
//   what    - one line, member-facing, what installing it does
//   why     - why this cadence and not another
export const RECIPES = [
  {
    id: 'morning-inbox-triage',
    title: 'Morning inbox triage',
    skill: 'inbox',
    what: 'Your assistant sorts every unread email into reply, read later, or archive before you sit down.',
    why: '07:00 local, every day. Before the working day rather than during it: the point is to '
       + 'walk up to a sorted inbox, not to be interrupted by one being sorted.',
    cadence: { enabled: true, deliver: true, schedule: { kind: 'times', days: [], times: ['07:00'] } },
  },
  {
    id: 'daily-brief',
    title: 'The daily brief',
    skill: 'daily',
    what: 'A short brief each weekday: what is on, what matters most, what is at risk.',
    why: 'Weekdays only at 07:15, just after triage, so the brief can already account for what '
       + 'landed overnight. Weekends stay quiet on purpose.',
    cadence: { enabled: true, deliver: true, schedule: { kind: 'times', days: ['mon', 'tue', 'wed', 'thu', 'fri'], times: ['07:15'] } },
  },
  {
    id: 'chase-replies-owed',
    title: 'Chase what people owe you',
    skill: 'followup',
    what: 'Surfaces the threads where someone owes you a reply, before they go cold.',
    why: 'Twice a week (Tuesday and Thursday, 16:00) rather than daily. A follow-up list that '
       + 'appears every morning gets ignored; one that appears twice a week gets read.',
    cadence: { enabled: true, deliver: true, schedule: { kind: 'times', days: ['tue', 'thu'], times: ['16:00'] } },
  },
  {
    id: 'plan-the-week',
    title: 'Plan the week',
    skill: 'plan-week',
    what: 'Monday morning: sets three to five concrete outcomes for the week and writes them where the daily brief will read them.',
    why: 'Monday 08:00, before the week has opinions about itself. It is the planning half of a pair: '
       + 'plan-week sets the outcomes, weekly reviews against them on Sunday.',
    cadence: { enabled: true, deliver: true, schedule: { kind: 'times', days: ['mon'], times: ['08:00'] } },
  },
  {
    id: 'weekly-review',
    title: 'The weekly review',
    skill: 'weekly',
    what: 'Sunday evening: what moved this week, what stalled, what next week needs.',
    why: 'Sunday 17:00, so the week is closed before it starts. Pairs with plan-week, which sets '
       + 'the outcomes on Monday morning.',
    cadence: { enabled: true, deliver: true, schedule: { kind: 'times', days: ['sun'], times: ['17:00'] } },
  },
];

export const recipeIds = () => RECIPES.map((r) => r.id);
export const recipe = (id) => RECIPES.find((r) => r.id === id) || null;

// Validated against the engine's own rules, not ours.
export function auditRecipes(skillNames) {
  const problems = [];
  const seen = new Set();
  for (const r of RECIPES) {
    if (seen.has(r.id)) problems.push(`duplicate recipe id ${r.id}`);
    seen.add(r.id);
    if (!/^[a-z0-9-]+$/.test(r.id)) problems.push(`${r.id}: id must be kebab-case`);
    const bad = scheduleProblem(r.cadence.schedule);
    if (bad) problems.push(`${r.id}: the engine refuses this schedule: ${bad}`);
    if (r.cadence.enabled !== true) problems.push(`${r.id}: a recipe installs ENABLED or it does nothing`);
    if (skillNames && !skillNames.includes(r.skill)) problems.push(`${r.id}: no engine skill named ${r.skill}`);
    for (const f of ['title', 'what', 'why']) if (!r[f]) problems.push(`${r.id}: missing ${f}`);
    if (String(r.what).includes('—') || String(r.why).includes('—')) problems.push(`${r.id}: em dash`);
  }
  return problems;
}
