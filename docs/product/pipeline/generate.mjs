#!/usr/bin/env node
// generate.mjs - reference pages, built FROM the code, per the
// documentation-system spec (2026-08-24, build step 4).
//
//   node docs/product/pipeline/generate.mjs [--check]
//
// Reference is the one Diataxis mode nobody hand-writes. A skill list, a
// connections catalogue and a machinery-jobs table are all facts the repo
// already holds, and a hand-kept copy of a fact is a copy that goes wrong
// quietly. So they are generated, marked `generated: true`, and pinned by
// generate.test.mjs: regenerate in memory, compare to disk, fail the build on
// any difference. `--check` does the same from the CLI and prints the diff.
//
// Three sources, three techniques, chosen by what is safe to touch:
//   engine/skills/*.md            frontmatter, read with a targeted extract
//                                 (their frontmatter carries nested lists and
//                                  inline comments; the strict page parser
//                                  would rightly refuse it)
//   wizard/panel/mcp-catalogue.mjs a pure module: imported
//   engine/cron/scheduler.mjs     a box script with side effects on import, so
//                                 its DISPLAY table is source-sliced. That is
//                                 the repo's standard technique, not a
//                                 shortcut (docs/code-map.md).
//
// NO EM DASHES, enforced: this output is customer-facing product copy and the
// house rule is zero. The generator refuses rather than laundering, because a
// laundered string diverges from the product surface the same string renders
// on. When this throws, fix the source; the Skills page gets better too.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOGUE, CATEGORIES } from '../../../wizard/panel/mcp-catalogue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const OUT = path.join(HERE, '..', 'pages', 'reference');

const EM = '—';
function noEmDash(s, where) {
  if (String(s).includes(EM)) {
    throw new Error(`em dash in generated copy from ${where}: ${JSON.stringify(s)}\n`
      + '  Fix the SOURCE string, not this generator: the same text renders in the product.');
  }
  return s;
}

// --- source 1: the engine skills ------------------------------------------
// A targeted extract, not a parse: we want four scalars out of a frontmatter
// block that also holds nested lists and trailing `# comments`.
function skillMeta(file) {
  const text = readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) throw new Error(`${file}: no frontmatter`);
  const fm = m[1];
  const grab = (key) => {
    const line = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(fm);
    if (!line) return null;
    const v = line[1].trim();
    // A quoted value ends at its closing quote: everything after it is an
    // inline comment. Getting this backwards (skipping comment-stripping for
    // quoted values) put `# human name shown on the Skills page (2026-08-09
    // audit R6)` into all ten generated skill titles on the first run.
    const q = /^"([^"]*)"|^'([^']*)'/.exec(v);
    if (q) return (q[1] !== undefined ? q[1] : q[2]).trim();
    return v.replace(/\s+#.*$/, '').trim();
  };
  const name = grab('name');
  if (!name) throw new Error(`${file}: frontmatter has no name:`);
  return {
    name,
    title: grab('title') || name,
    description: grab('description') || '',
    category: grab('category') || 'other',
  };
}

// Category slugs are wire vocabulary ('box', 'briefing'); a heading is copy and
// gets sentence case. Exported (2026-09-10) so the docs index's "What it can
// do" strip groups skills exactly as the generated Skills page does.
export const CATEGORY_LABEL = {
  box: 'Your mineral', briefing: 'Briefings', capture: 'Capture',
  comms: 'Email and messages', org: 'Your community', other: 'Everything else',
};

export function skills() {
  const dir = path.join(REPO, 'engine', 'skills');
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    .map((f) => skillMeta(path.join(dir, f)));
}

// --- source 3: the machinery jobs -----------------------------------------
// scheduler.mjs reads state and builds paths at import time, so it is sliced
// rather than imported. The slice is anchored on the const declaration and
// fails loudly if the table is renamed or restructured.
// The "when" column comes from the scheduler ITSELF: --plan-json runs the real
// match functions through describeWhen(), so the times can never drift from the
// code. It runs against a scratch state dir, which means guard-dependent jobs
// (anchor wiring, member-health pulls) honestly read "never" there; those render
// as "when it applies" since the guard, not the clock, decides them.
function machineryWhen() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'docs-machinery-'));
  try {
    const out = execFileSync('node', [path.join(REPO, 'engine', 'cron', 'scheduler.mjs'), scratch, '--plan-json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const plan = JSON.parse(out);
    return new Map((plan.machinery || []).map((r) => [r.id, r.when]));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function machinery() {
  const src = readFileSync(path.join(REPO, 'engine', 'cron', 'scheduler.mjs'), 'utf8');
  const m = /^const DISPLAY = \{\n([\s\S]*?)^\};$/m.exec(src);
  if (!m) throw new Error('scheduler.mjs: the DISPLAY table moved or changed shape; re-anchor this slice');

  // WHICH JOBS A ROCK ACTUALLY RUNS (2026-08-24). A rock's scheduler starts with
  // AIOS_SCHEDULER_ROLE=rock (boot-rock.sh:506) and filters every job through
  // ROCK_JOBS, so a rock runs EIGHT of these, not all of them. The v1 page said
  // "your mineral runs these jobs on its own" and listed all seventeen, which is
  // true for a pebble and false for a rock: no nightly backup, no brain push, no
  // auto-update. Derived from the regex rather than listed, so it cannot drift.
  const rockRe = /const ROCK_JOBS = (\/.*\/);/.exec(src);
  if (!rockRe) throw new Error('scheduler.mjs: ROCK_JOBS not found; the rock filter changed shape');
  // eslint-disable-next-line no-eval
  const onRock = eval(rockRe[1]);
  const names = [...src.matchAll(/name: '([^']+)', lid: '([a-z0-9-]+)'/g)];
  const lidToName = new Map(names.map((n) => [n[2], n[1]]));
  const nameFor = (id) => lidToName.get(id)
    || (src.match(new RegExp(`name: '(${id}[^']*)'`)) || [])[1] || id;

  const rows = [];
  for (const line of m[1].split('\n')) {
    const r = /^\s*'?([a-z0-9-]+)'?:\s*\{\s*note:\s*'((?:[^'\\]|\\.)*)'(?:,\s*pebble:\s*(false|true))?\s*\}/.exec(line);
    if (r) {
      rows.push({
        id: r[1],
        note: r[2].replace(/\\'/g, "'"),
        rock: onRock.test(nameFor(r[1])),
        // pebble: false in DISPLAY marks the control-plane jobs whose match or
        // guard can never fire on a member box. Everything else runs on a
        // pebble (some behind guards that no-op until the job applies).
        pebble: r[3] !== 'false',
      });
    }
  }
  if (!rows.length) throw new Error('scheduler.mjs: DISPLAY parsed to zero rows');
  const whenById = machineryWhen();
  for (const r of rows) {
    const w = whenById.get(r.id);
    // "never" from the scratch run means the job's clock is gated on something
    // existing for it to do (a wire to claim, members to pull for), so the
    // honest column value is applicability, not a time.
    r.when = (!w || w === 'never') ? 'when it applies' : w;
    // auto-update is jittered per box (scheduler.mjs ~489: 04:10 base + a
    // stable 0-29 min offset); the scratch run's minute is real but not YOURS,
    // and it changes with the scratch path, so pin the honest general form.
    if (r.id === 'auto-update') r.when = '04:10 + a per-box offset';
  }
  // The five-invisible-jobs failure (depth plan 2026-08-25): DISPLAY carried 17
  // rows while buildJobs defined 22, and the missing five never reached the
  // page. Refuse the mismatch instead of silently under-documenting again.
  const lids = [...new Set(names.map((n) => n[2]))];
  const missing = lids.filter((l) => !rows.some((r) => r.id === l));
  if (missing.length) throw new Error(`scheduler.mjs DISPLAY has no row for: ${missing.join(', ')} - add notes so the reference and the Health card can name them`);
  return rows;
}

// --- page builders ---------------------------------------------------------
const STAMP = 'Generated from the code by docs/product/pipeline/generate.mjs. Do not edit by hand: run the generator.';

const fm = (o) => ['---', ...Object.entries(o).map(([k, v]) => `${k}: ${v}`), '---'].join('\n');

function skillsPage() {
  const rows = skills();
  const byCat = new Map();
  for (const s of rows) {
    noEmDash(s.title, `skill ${s.name} title`);
    noEmDash(s.description, `skill ${s.name} description`);
    if (!byCat.has(s.category)) byCat.set(s.category, []);
    byCat.get(s.category).push(s);
  }
  const body = [`> ${STAMP}`, '',
    `Every mineral ships with these ${rows.length} skills. They are the engine set: the`,
    'skill library itself ships empty, so anything beyond this list is something you',
    'added.', '',
    // Verified against config/profile.schema.yaml (cadence.enabled: false) and
    // engine/cron/cadence-lib.mjs seeds: schedules ship attached but OFF.
    'Four of them arrive with a schedule already attached: the daily brief in the',
    'morning, the session capture in the evening, the weekly review on Sunday',
    'afternoon, and inbox triage on a repeating interval. Like everything else the',
    'schedules ship switched off; flipping the switch on your Skills page is what',
    'starts one, and the times are yours to change there. The rest run when you ask,',
    'or on any schedule you give them.', ''];
  // Category slugs are wire vocabulary ('box', 'briefing'); a heading is copy and
  // gets sentence case. The skills page shipped four lowercase headings until
  // the case gate caught them.
  for (const cat of [...byCat.keys()].sort()) {
    body.push(`## ${CATEGORY_LABEL[cat] || (cat.charAt(0).toUpperCase() + cat.slice(1))}`, '');
    body.push('| Skill | What it does |', '|---|---|');
    for (const s of byCat.get(cat)) body.push(`| **${s.title}** (\`/${s.name}\`) | ${s.description} |`);
    body.push('');
  }
  return {
    file: 'skills.md',
    content: [fm({
      title: 'Every skill your mineral ships with',
      summary: `The ${rows.length} engine skills present on every mineral, with what each one does.`,
      audience: 'public', access: 'public', mode: 'reference', generated: 'true', order: '10',
    }), '', body.join('\n').trimEnd(), ''].join('\n'),
  };
}

function connectionsPage() {
  const rows = [...CATALOGUE];
  const byCat = new Map();
  for (const c of rows) {
    noEmDash(c.blurb, `catalogue ${c.key} blurb`);
    if (!byCat.has(c.category)) byCat.set(c.category, []);
    byCat.get(c.category).push(c);
  }
  const featured = rows.filter((c) => c.boxKey).length;
  const body = [`> ${STAMP}`, '',
    `${rows.length} services your mineral can connect to without you finding an endpoint`,
    `yourself. ${featured} of them ship inside the box as featured connectors; the rest`,
    'connect by URL from the same page.', '',
    'The sign-in column says how you authorise it. **One click** means the service supports',
    'dynamic registration, so you sign in and it is done. **Token** means you paste an API',
    'token instead, because that endpoint advertises no one-click flow.', '',
    '**Google is not in this table, and that is not an omission of the product.** Gmail,',
    'Google Calendar and Google Drive connect through their own wizard on the Connections',
    'page, with your own key, and [connecting Google](/docs/connect-google) walks the whole',
    'thing. Everything below connects from the same page in one or two clicks.', '',
    'Absences are deliberate rather than oversights: every endpoint here was probed live',
    'before it was listed, and a service that advertises a connection flow which does not',
    'actually work is left out until it does. If something you use is missing, ask, and it',
    'gets probed.', ''];
  for (const cat of CATEGORIES.filter((c) => byCat.has(c))) {
    body.push(`## ${cat}`, '');
    body.push('| Service | What you get | Sign-in | In the box |', '|---|---|---|---|');
    for (const c of byCat.get(cat)) {
      body.push(`| **${c.label}** | ${c.blurb} | ${c.auth === 'oauth' ? 'One click' : 'Token'} | ${c.boxKey ? 'Featured' : 'By URL'} |`);
    }
    body.push('');
  }
  return {
    file: 'connections.md',
    content: [fm({
      title: 'What you can connect',
      summary: `The ${rows.length} services in the curated connections catalogue, and how each one signs in.`,
      audience: 'public', access: 'public', mode: 'reference', generated: 'true', order: '20',
    }), '', body.join('\n').trimEnd(), ''].join('\n'),
  };
}

function machineryPage() {
  const rows = machinery();
  for (const r of rows) noEmDash(r.note, `machinery ${r.id} note`);
  const onPebble = rows.filter((r) => r.pebble).length;
  const body = [`> ${STAMP}`, '',
    'Your mineral runs some of these jobs on its own. They are machinery: Crads AI',
    'maintains them, they are shown to you read-only, and they are not the same thing as',
    'the schedules you set for your own skills, which live on **Skills** under',
    '**Your assistant**.', '',
    'You can see the ones your mineral runs, and their last outcome, on the **Health**',
    'card on your **Overview** page. It summarises them in a line ("3 jobs, all fine") and',
    'expands to the individual rows.', '',
    `**Your mineral runs ${onPebble} of these ${rows.length}.** The jobs marked no in the`,
    'Runs column are control-plane work the scheduler still knows how to do but that',
    'never fires on a mineral of your own (a member roster to pull health for, a',
    'shared organisation brain to refresh); they are listed so the table is the whole',
    'scheduler, not a flattering subset of it.', '',
    'A yes does not mean the job fires on every box every day: several jobs guard',
    'themselves to nothing until they apply (no connected services means nothing to',
    'refresh; no managing organisation means nothing to sync). The column says where',
    'a job *can* run, and the Health card on your Overview says what yours actually',
    'did. The When column is read from the scheduler itself; "when it applies" means',
    'the job has a rhythm only once there is something for it to do.', '',
    '| Job | What it does | When | Runs |', '|---|---|---|---|',
    ...rows.map((r) => `| \`${r.id}\` | ${r.note} | ${r.when} | ${r.pebble ? 'yes' : 'no'} |`), ''];
  return {
    file: 'machinery-jobs.md',
    content: [fm({
      title: 'The jobs your mineral runs by itself',
      summary: `The ${rows.length} machinery jobs Crads AI maintains on every mineral, and what each one is for.`,
      audience: 'public', access: 'public', mode: 'reference', generated: 'true', order: '30',
    }), '', body.join('\n').trimEnd(), ''].join('\n'),
  };
}

export function generate() {
  return [skillsPage(), connectionsPage(), machineryPage()];
}

// --- CLI -------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('generate.mjs')) {
  const pages = generate();
  const check = process.argv.includes('--check');
  let drift = 0;
  mkdirSync(OUT, { recursive: true });
  for (const p of pages) {
    const dest = path.join(OUT, p.file);
    const on = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
    if (on === p.content) { console.log(`  ok    ${p.file}`); continue; }
    drift += 1;
    if (check) { console.log(`  DRIFT ${p.file}${on === null ? ' (missing)' : ''}`); continue; }
    writeFileSync(dest, p.content);
    console.log(`  write ${p.file}`);
  }
  if (check && drift) {
    console.error(`\n${drift} generated page(s) out of date. Run: node docs/product/pipeline/generate.mjs`);
    process.exit(1);
  }
  console.log(`${pages.length} reference page(s) ${check ? 'checked' : 'generated'} -> ${path.relative(REPO, OUT)}`);
}
