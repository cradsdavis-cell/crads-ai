// shots.mjs - the docs screenshot contract, per the documentation-system spec
// (docs/superpowers/specs/2026-08-24-documentation-system.md, build step 3).
//
// Screenshots are BUILD ARTEFACTS, not manual assets: a page references a shot
// by id, the rig captures it from the Driftwood fixture, and nobody ever pastes
// a PNG into this tree by hand. That is the whole reason a doc screenshot can
// stay true across a release.
//
// This file is the DECLARATION. `shoot.mjs` is the driver that needs a browser;
// `shots.test.mjs` is the gate that does not. The split matters: the qa-* rigs
// are excluded from the clean-checkout suite (trap 15), so if the docs/shots
// contract could only be checked by running a browser, CI would never check it.
// Declaring the plan as data lets a zero-dep test pin the contract while the
// expensive capture stays a release step.
//
// Every shot names the surface and world it is taken from, so a reader can
// always answer "what was I looking at" and a maintainer can re-take one shot
// without re-reading the rig.

// The harness's three surfaces (wizard/dev-harness/README.md); connect, wizard
// and join left on 2026-09-01, the rock face with the simple-assistant strip
// on 2026-09-09.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SURFACES = ['panel', 'member', 'door'];
// The harness's three worlds. `rich` is the populated Driftwood world.
export const WORLDS = ['rich', 'empty', 'error'];

// A shot: { id, surface, world, sec, waitMs, waitUntil, note }
//  id        - stable, kebab-case; what a page writes in ![alt](shot:<id>)
//  surface   - which harness surface to open
//  world     - which fixture world
//  sec       - optional nav section to activate first (via dev-harness/nav.mjs)
//  waitUntil - playwright goto condition; 'commit' for pages that never settle
//  marks     - ANNOTATIONS, declared by SELECTOR and never by coordinate. Each
//              is { sel, say }. The rig resolves the element's box at capture
//              time and records it as PERCENTAGES of the image, so a callout
//              follows its control when the UI moves instead of drifting onto
//              empty space. A selector that matches nothing FAILS the shot
//              rather than silently producing an unannotated screenshot: a
//              missing callout is invisible, and invisible is how a doc lies.
//  full      - capture the whole scrollable page instead of the viewport.
//              DEFAULTS TO FALSE, and that default was chosen by looking at the
//              output: a full-page capture of a dense UI, shown inside a 46rem
//              reading column, is a grey smear nobody can read. Viewport shots
//              are legible at the width they are actually displayed. Opt in only
//              where the point of the shot IS the length of the page.
//  note      - why this shot exists, for whoever re-takes it
export const WAITS = ['load', 'domcontentloaded', 'commit', 'networkidle'];
const S = [];
const add = (id, surface, world, opts = {}) => {
  S.push({ id, surface, world, sec: opts.sec || null, waitMs: opts.waitMs || 1200,
    waitUntil: opts.waitUntil || 'load', full: opts.full === true,
    marks: Array.isArray(opts.marks) ? opts.marks : [],
    // clicks: selectors pressed AFTER readiness, before capture, for pages
    // whose settled state needs the reader's own gesture (the Brain graph's
    // Fit button: the audit-round-two shot photographed 11 of 12 nodes
    // off-canvas because the fit raced the capture). A selector that matches
    // nothing fails the shot, same rule as marks.
    clicks: Array.isArray(opts.clicks) ? opts.clicks : [],
    note: opts.note || '' });
};

// Section ids below were read from the shipping nav with a browser
// (2026-08-24), not guessed: the first pass at this file invented `overview`,
// `members`, `organisations` and `billing`, and seven of fourteen shots failed
// on locators that have never existed. The real set is
//   dashboard decisions yourrock seat network rocks pebbles brain skills
//   connections publish secrets sharing terminal
// and the default landing is `dashboard`, so a dashboard shot clicks nothing.
// Re-read it the same way when the nav is regrouped; do not trust this comment
// over the DOM.

// --- the door and the birth path (public tier, tutorial) ---
add('door-identity-chooser', 'door', 'rich', { note: 'the door with minerals on it: what a returning owner sees' });
add('door-empty', 'door', 'empty', { note: 'a machine with no minerals yet: the first-run door' });

// --- the member surfaces (public tier, tutorial + reference) ---
// Shot ids carry the name a PERSON sees, never the internal sec id: the page
// whose sec is `dashboard` is titled "Overview" in the sidebar and the hero.
// naming.md's name-vs-handle law, applied to documentation.
// Selectors are the app's own stable handles: `#heroStrip` and the overview
// grid's `[data-card="<id>"]`, which member.html sets from the card registry.
// Nothing here is a coordinate, an nth-child, or a text match.
add('member-overview', 'member', 'rich', {
  full: true, waitMs: 3500,
  note: 'the assistant home (sec `dashboard`, titled Overview): the page a member lands on; the longer wait lets the cadence fetch land so the Skills card agrees with the Skills page',
  marks: [
    { sel: '#heroStrip', say: 'Your assistant, by the name you gave it. "Talk to it" opens a conversation.' },
    { sel: '[data-card="onboarding"]', say: 'How much of the interview is done. Until this completes, every answer your assistant gives is generic.' },
    { sel: '[data-card="brain"]', say: 'How many pages your brain holds. This is what your assistant reads before it answers anything.' },
    { sel: '[data-card="ladder"]', say: 'What your pebble can do, and what is still switched off. Each row links to the way in.' },
    { sel: '[data-card="health"]', say: 'The jobs your mineral runs by itself. Expand it to see each one and when it last ran.' },
  ],
});
add('member-brain', 'member', 'rich', { sec: 'brain', full: true, waitMs: 2500, clicks: ['#gFit'],
  note: 'the brain graph: the member owns a folder of files, drawn live at render time; Fit pressed so the layout is framed, not racing' });
add('member-skills', 'member', 'rich', { sec: 'skills', note: 'installed skills; the library ships empty, so this is the engine set' });
add('member-connections', 'member', 'rich', { sec: 'connections', note: 'wired MCPs and their auth state: an expired token is SEEN here, not discovered weeks later' });
// member-seat was out of the roster 2026-08-24 to 2026-08-25 (audit finding
// A5): the seat page's one data source is the `member-console-state` verb and
// the harness did not stub it, so every capture showed "Checking..." cards.
// The stub landed with the granular-walkthrough round; if this shot ever shows
// a could-not-reach banner again, pull it rather than publish an error state.
add('member-seat', 'member', 'rich', { sec: 'seat', waitMs: 2200, note: 'Your pebble: ownership, the backup card, and anything waiting on the member' });
add('member-telegram-setup', 'member', 'rich', { sec: 'connections', waitMs: 2200, clicks: ['#tgToggle'],
  note: 'the Telegram card expanded: step 1 (BotFather + token) as a fresh mineral shows it' });
add('member-empty', 'member', 'empty', { full: true, note: 'a box before onboarding: the state a new seat actually opens on' });

// --- the remaining member surfaces, one per nav section (coverage pass) ---
add('member-secrets', 'member', 'rich', { sec: 'secrets', note: 'Secrets: every password, token and key the mineral holds, and what each is for' });
add('member-terminal', 'member', 'rich', { sec: 'terminal', waitMs: 2200, note: 'Terminal: talking to the assistant directly' });


export const SHOTS = S;

// Where a rendered page points its <img>. One place, so the website and the
// in-image surface cannot disagree about the path.
export const shotSrc = (id) => `/docs/shots/${id}.png`;

// Every shot a page body references. The renderer and the gate read the SAME
// function, so a directive the renderer understands can never be invisible to
// the gate (and the reverse).
export function extractShotRefs(body) {
  const ids = [];
  const re = /!\[[^\]]*\]\(shot:([a-z0-9-]+)\)/g;
  let m;
  while ((m = re.exec(body))) ids.push(m[1]);
  return ids;
}

export const shotIds = () => SHOTS.map((s) => s.id);

// The marks a shot actually captured, read from the sidecar the rig wrote. Empty
// when the shot has none or has not been taken: the renderer degrades to a plain
// figure rather than failing, because a missing screenshot is already caught by
// the publish step, and failing twice for one cause helps nobody.
export const SHOTS_DIR = new URL('../shots/', import.meta.url);

export function marksFor(id, dir = SHOTS_DIR) {
  try {
    // `dir` is the capture output directory, and it is a PARAMETER because
    // `docs/product/shots/` is a build artefact nobody commits (.gitignore).
    // A test that read only the real directory asserted on whatever the last
    // local rig run happened to leave behind: green here, red on a clean
    // checkout and in CI, for the whole suite (trap 62). Production still
    // passes nothing and reads the real sidecar.
    const p = typeof dir === 'string' ? join(dir, `${id}.marks.json`)
      : new URL(`${id}.marks.json`, dir);
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch { return []; }
}
