import { catalogue as provisionCatalogue, BUILD_STEPS, publicProviders } from './provision-fixture.mjs';
// fixtures.mjs: realistic demo data for the UI-overhaul dev harness.
//
// One fictional org ("driftwood-surf") with a fleet of members, operators,
// skills, governance, an org brain, and one member face ("Mel Harper") with
// a populated brain graph + dashboard. No real client names, no real emails.
//
// Every /run verb the six surfaces call is dispatched through runVerb() below.
// The RENDER CODE in panel.html / member.html is the contract these shapes
// mirror (markers like __INDEX__ / __DATA__ / __MANIFEST__, `=== path` blocks,
// yamlScalar-parsable yaml, JSON arrays embedded in text).
//
// Three states: 'rich' (default) · 'empty' (new org/member, nothing yet) ·
// 'error' (every box unreachable: /run verbs fail).

const now = () => Date.now();
const iso = (msAgo) => new Date(now() - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z');
const H = 3600e3, D = 24 * H, MIN = 60e3;

export const ORG = 'driftwood-surf';
export const ORG_DISPLAY = 'Driftwood Surf School';
export const ROCK_HOST = 'driftwood-rock';
export const MEMBER_HOST = 'mel-box';
// The LOCAL face (2026-09-11): a brain folder on this computer, no server.
// Reached with ?face=local on a surface URL; the harness passes `face` down.
export const LOCAL_HOST = 'sam-local';
export const LOCAL_PATH = '/home/mel/Crads-AI/mel';

const FAKE_KEY = (label) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF4k3m0eXAMPLEexampleEXAMPLEexampleEXAMPLEexample ${label}`;

// ---------------------------------------------------------------------------
// targets / identities
// ---------------------------------------------------------------------------
export function targets(surface, state, face) {
  const base = { role: 'admin', roleAssumed: false, wizardUrl: '/wizard', doorUrl: '/door' };
  if (face === 'local') {
    return { targets: [{ host: LOCAL_HOST, org: 'sam', kind: 'local', path: LOCAL_PATH, name: 'Sam' }], edition: 'member', ...base };
  }
  if (surface === 'member') {
    return { targets: state === 'empty' ? [{ host: MEMBER_HOST, org: ORG, kind: 'member' }]
      : [{ host: MEMBER_HOST, org: ORG, kind: 'member' }], edition: 'member', ...base };
  }
  return { targets: [{ host: ROCK_HOST, org: ORG, kind: 'rock' }], edition: 'org', ...base };
}

export function identities(state, face) {
  if (state === 'empty') return { identities: [], open: {} };
  if (face === 'local') {
    return { identities: [{ host: LOCAL_HOST, org: 'sam', kind: 'local', path: LOCAL_PATH, name: 'Sam' }], open: { member: '/member' } };
  }
  return {
    // `org` IS THE ALIAS PREFIX, not the org's display slug. listPanelTargets
    // derives it by regex from the alias (`driftwood-rock` -> `driftwood`,
    // `mel-box` -> `mel`), so it can never be the same string on a rock and
    // a member box the way this fixture asserted until 2026-08-13. That was not
    // cosmetic: it is why the certified door shot showed "driftwood-surf ·
    // rock" and "driftwood-surf · your assistant", two rows whose only
    // distinguishing word was the quiet one at the end, and it hid the fact
    // that nothing on the screen joined these to the account's minerals.
    identities: [
      { host: ROCK_HOST, org: 'driftwood', kind: 'rock' },
      { host: MEMBER_HOST, org: 'mel', kind: 'member' },
      // a mineral this machine's key opens that the ACCOUNT holds no grant on
      // (ruling 5). Sam's own 2026-08-10 case: signed in as one account, keys
      // on disk for another. Kept in the default fixture so the flag is drawn
      // in the baseline shots rather than living in a state nobody captures.
      { host: 'legacy-box', org: 'legacy', kind: 'member' },
    ],
    open: { panel: '/panel', member: '/member', wizard: '/wizard', connect: '/connect' },
  };
}

export function probe(host, state) {
  if (host === LOCAL_HOST) return { ok: true, login: 'local' };
  if (state === 'error') return { ok: false, login: '' };
  return { ok: true, login: host === ROCK_HOST ? 'aios-op' : 'member' };
}

// ---------------------------------------------------------------------------
// the mineral inventory (spec 2026-08-13)
// ---------------------------------------------------------------------------
// FINDING 10: the old /account/minerals fixture predated `tier`, `yours`,
// `held_by` and `role`, and there was no /account/devices fixture AT ALL. So
// every certified door shot was drawn against a shape production does not
// serve, and the connect row never appeared in a single screenshot. That is
// how findings 8 and 9 survived a UI certification pass. These fixtures carry
// the real shape, including the three cases the old ones could not express:
// a mineral held by an ORG, a mineral NOT on this machine, and a mineral this
// machine's key opens that the account holds no grant on.
const ACCOUNT_EMAIL = 'mel@driftwoodsurf.school';

// what /my-minerals returns, verbatim shape (worker.js:1928)
export function myMinerals(state) {
  if (state === 'empty') return [];
  return [
    { mineral_id: 'min_' + '0'.repeat(24), label: ORG_DISPLAY, host: 'driftwood.crads-ai.com',
      tier: 'rock', anchor: '', role: 'owner', held_by: 'you' },
    // ORG-HELD (ruling 6): a member's own working assistant that the rock owns,
    // which is exactly the anchored shape cohort one ships in. It must read
    // "held by Driftwood Surf School", never "shared with you".
    { mineral_id: 'min_' + '1'.repeat(24), label: 'Mel', host: 'mel.crads-ai.com',
      tier: 'pebble', anchor: 'driftwood', role: 'user', held_by: ORG_DISPLAY },
    // on the account, NOT on this machine: the row that carries the Connect
    // button, and the whole question Sam asked
    { mineral_id: 'min_' + '2'.repeat(24), label: 'Harbour Guild', host: 'harbour.crads-ai.com',
      tier: 'rock', anchor: '', role: 'user', held_by: 'someone else' },
    // on the account with no registered box: listed so you know it exists,
    // never offered a button that has nothing to ask (finding 9's mirror)
    { mineral_id: 'min_' + '3'.repeat(24), label: 'Tidepool', host: 'tidepool.crads-ai.com',
      tier: 'pebble', anchor: '', role: 'owner', held_by: 'you' },
  ];
}

// what /my-boxes returns: only minerals whose box has registered SSH facts, so
// only these can be ASKED to admit this machine
export function myBoxes(state) {
  if (state === 'empty') return [];
  return [
    { host: 'driftwood.crads-ai.com', label: ORG_DISPLAY, tier: 'rock', ssh: { hostname: 'driftwood.crads-ai.com', user: 'aios-op' } },
    { host: 'mel.crads-ai.com', label: 'Mel', tier: 'pebble', ssh: { hostname: 'mel.crads-ai.com', user: 'member' } },
    { host: 'harbour.crads-ai.com', label: 'Harbour Guild', tier: 'rock', ssh: { hostname: 'harbour.crads-ai.com', user: 'aios-op' } },
  ];
}

export const accountEmail = (state) => (state === 'empty' ? '' : ACCOUNT_EMAIL);

// ---------------------------------------------------------------------------
// org fleet
// ---------------------------------------------------------------------------
// Panel iteration 2 (R5, 2026-08-23): one member in each of the five
// lifecycle states, so the Members page can be driven end to end here:
//   mel · diego  active        mei  active, but Claude signed out (risk)
//   tom            quiet         a heartbeat 4 days old
//   sofia          legacy paused renders as active with a Bring back fold
//   noor           setting up    stamped, never checked in (no heartbeat)
//   lena           invited       never enrolled
//   ravi · kai     ended         left (their own call) · torn down from here
const MEMBERS = [
  { slug: 'mel', name: 'Mel Harper', status: 'active', tier: 'standard', region: 'hel1', provider: 'google', packs: 4, skills: ['daily-brief', 'weekly-review'] },
  { slug: 'tom', name: 'Tom Okafor', status: 'active', tier: 'standard', region: 'hel1', provider: 'google', packs: 3, skills: ['daily-brief'] },
  { slug: 'mei', name: 'Mei-Ling Chen', status: 'active', tier: 'core', region: 'sin', provider: 'microsoft', packs: 2, skills: ['daily-brief', 'inbox-triage'] },
  { slug: 'diego', name: 'Diego Alvarez', status: 'active', tier: 'standard', region: 'hel1', provider: 'google', packs: 4, skills: ['daily-brief', 'weekly-review', 'inbox-triage'] },
  { slug: 'sofia', name: 'Sofia Lindqvist', status: 'paused', tier: 'core', region: 'hel1', provider: 'google', packs: 1, skills: [] },
  { slug: 'noor', name: 'Noor Haddad', status: 'active', tier: 'standard', region: 'hel1', provider: 'google', packs: 0, skills: [] },
  { slug: 'lena', name: 'Lena Petrova', status: 'invited', tier: 'standard', region: 'hel1', provider: 'google', packs: 0, skills: [] },
  { slug: 'ravi', name: 'Ravi Nair', status: 'left', tier: 'standard', region: 'sin', provider: 'google', packs: 2, skills: [],
    left_how: 'left', left_mineral: 'kept, re-anchored to Crads AI' },
  { slug: 'kai', name: 'Kai Tanaka', status: 'left', tier: 'standard', region: 'sin', provider: 'google', packs: 1, skills: [],
    left_how: 'torn-down', decommissioned: '2026-08-19' },
];

// the install receipts (R2): what each member's own box says it installed
// from a rock, regardless of the engagement toggle
const ROCK_OF = 'driftwood-surf';
const receipts = (ids) => ids.map((id, i) => ({ id, rock: ROCK_OF, version: id === 'daily-brief' ? 3 : 1 + i }));

// heartbeats keyed by slug; ages picked so the fleet board shows the full
// range: ok · quiet · risk (signed out) · no-heartbeat
const HEARTBEATS = () => ({
  mel: { app_commit: 'a1b2c3d', built_at: iso(2 * D), generated_at: iso(2 * H), auth_ok: true, onboarded: true, disk_pct: 41, last_activity: iso(3 * H),
    shared: { skill_engagement: true, activity: true },
    skills_installed: 3, skills_enabled: ['daily-brief', 'weekly-review'],
    skill_runs: { 'daily-brief': iso(5 * H), 'weekly-review': iso(2 * D) },
    skills_from_rocks: receipts(['daily-brief', 'weekly-review']) },
  tom: { app_commit: '9f8e7d6', built_at: iso(21 * D), generated_at: iso(4 * D + 3 * H), auth_ok: true, onboarded: true, disk_pct: 62, last_activity: iso(4 * D),
    shared: { skill_engagement: true, activity: true },
    skills_installed: 2, skills_enabled: ['daily-brief'], skill_runs: { 'daily-brief': iso(4 * D) },
    skills_from_rocks: receipts(['daily-brief']) },
  mei: { app_commit: 'a1b2c3d', built_at: iso(2 * D), generated_at: iso(1 * H), auth_ok: false, onboarded: true, disk_pct: 38, last_activity: iso(9 * H),
    shared: { skill_engagement: true, activity: true },
    skills_installed: 2, skills_enabled: ['daily-brief', 'inbox-triage'],
    skill_runs: { 'daily-brief': iso(26 * H), 'inbox-triage': iso(26 * H) },
    skills_from_rocks: receipts(['daily-brief', 'inbox-triage']) },
  diego: { app_commit: 'a1b2c3d', built_at: iso(2 * D), generated_at: iso(40 * MIN), auth_ok: true, onboarded: true, disk_pct: 55, last_activity: iso(1 * H),
    shared: { skill_engagement: true, activity: true },
    skills_installed: 3, skills_enabled: ['daily-brief', 'weekly-review', 'inbox-triage'],
    skill_runs: { 'daily-brief': iso(6 * H), 'weekly-review': iso(1 * D), 'inbox-triage': iso(2 * H) },
    skills_from_rocks: receipts(['daily-brief', 'weekly-review']) },
  sofia: { generated_at: iso(1 * D), auth_ok: true, onboarded: true, disk_pct: 30, last_activity: iso(1 * D),
    shared: { skill_engagement: false, activity: true },
    skills_from_rocks: [] },
});

function stallBoardLines(state) {
  if (state === 'empty') return ['▸ reading the registry…', '__INDEX__', '[]', '__HEARTBEATS__', '__SELFBUILD__', '{}'];
  const index = MEMBERS.map((m) => ({
    slug: m.slug, status: m.status, tier: m.tier, region: m.region,
    host: `${m.slug}.${ORG}.example.com`, display_name: m.name, packs: m.packs,
    ...(m.left_how ? { left_how: m.left_how } : {}),
    ...(m.left_mineral ? { left_mineral: m.left_mineral } : {}),
    ...(m.decommissioned ? { decommissioned: m.decommissioned } : {}),
  }));
  const out = ['▸ reading the registry…', '__INDEX__', JSON.stringify(index, null, 1), '__HEARTBEATS__'];
  const hbs = HEARTBEATS();
  for (const [slug, hb] of Object.entries(hbs)) {
    out.push(`=== ${slug}`);
    out.push(JSON.stringify(hb, null, 1));
  }
  // The rock's own build stamp (2026-08-23), the baseline every member version
  // is read against. a1b2c3d is "current" here, so tom renders behind and sofia
  // (no app_commit at all) renders unknown: all three states on one screen.
  out.push('__SELFBUILD__');
  out.push(JSON.stringify({ sha: 'a1b2c3d', tag: 'v2', built_at: iso(2 * D) }));
  return out;
}

function memberYaml(m) {
  const lines = [
    `slug: "${m.slug}"`,
    `display_name: "${m.name}"`,
    `status: "${m.status}"`,
    `tier: "${m.tier}"`,
    `region: "${m.region}"`,
    `provider: "${m.provider}"`,
    `host: "${m.slug}.${ORG}.example.com"`,
  ];
  if (m.left_how) lines.push(`left_how: "${m.left_how}"`);
  if (m.left_mineral) lines.push(`left_mineral: "${m.left_mineral}"`);
  if (m.decommissioned) lines.push(`decommissioned: "${m.decommissioned}"`);
  lines.push('skills:');
  for (const s of m.skills) lines.push(`  - skill_id: "${s}"`);
  if (!m.skills.length) lines.pop();
  return lines;
}

function memberListLines(state) {
  if (state === 'empty') return ['▸ no members registered yet'];
  const out = ['▸ listing members…'];
  for (const m of MEMBERS) { out.push(`=== members/${m.slug}.yaml`); out.push(...memberYaml(m)); }
  return out;
}

// operators (People tab)
const PEOPLE = [
  { slug: 'maya', name: 'Maya Castellanos', email: 'maya@driftwood-surf.example.com', role: 'admin', status: 'active', keys: 2 },
  { slug: 'ben', name: 'Ben Whitfield', email: 'ben@driftwood-surf.example.com', role: 'support', status: 'active', keys: 1 },
  { slug: 'nadia', name: 'Nadia Karim', email: 'nadia@driftwood-surf.example.com', role: 'support', status: 'revoked', keys: 1 },
];

function peopleListLines(state) {
  if (state === 'empty') return ['▸ no people beyond the founding key'];
  const out = [];
  for (const p of PEOPLE) {
    out.push(`=== people/${p.slug}.yaml`);
    out.push(`name: "${p.name}"`, `email: "${p.email}"`, `role: "${p.role}"`, `status: "${p.status}"`, 'keys:');
    for (let i = 0; i < p.keys; i++) out.push(`  - "${FAKE_KEY(p.slug + '-key' + (i + 1))}"`);
  }
  return out;
}

// skills library
const SKILLS = [
  // The ten ENGINE skills every mineral ships (docs audit round two, 2026-08-24:
  // the published Skills shot showed 2 built-ins beside prose citing the engine
  // ten, trap-49 class). Ids, titles and categories mirror engine/skills/*.md as
  // the generated reference renders them; cadences mirror the recipe library
  // where a recipe schedules the skill, 'off' where it is on demand.
  { id: 'connect', version: '0', description: 'Connect an outside service so this mineral can use it, including in scheduled jobs.', cadence: 'off', time: '09:00', outbound: false },
  { id: 'dashboard', version: '0', description: 'Build or change the member\'s own app pages and dashboard cards.', cadence: 'off', time: '09:00', outbound: false },
  { id: 'explain', version: '0', description: 'Explains this system and answers questions about how it works. Read-only.', cadence: 'off', time: '09:00', outbound: false },
  { id: 'onboard', version: '0', description: 'The deep interview that builds a brain from nothing on the 8-layer spine.', cadence: 'off', time: '09:00', outbound: false },
  { id: 'daily', version: '0', description: 'Morning prioritisation brief: today\'s tasks and calendar, the top 3, what is at risk.', cadence: 'daily', time: '07:15', outbound: false },
  { id: 'plan-week', version: '0', description: 'Monday goal-setter: sets this week\'s 3 to 5 outcomes where every brief reads them.', cadence: 'weekly', time: '08:00', outbound: false },
  { id: 'weekly', version: '0', description: 'Weekly review: the week\'s log, project health, stale actions, next week\'s focus.', cadence: 'weekly', time: '17:00', outbound: false },
  { id: 'capture', version: '0', description: 'End-of-session sweep that proposes the updates that should have been written.', cadence: 'off', time: '09:00', outbound: false },
  { id: 'followup', version: '0', description: 'Scans for open loops and surfaces what is slipping before it becomes a problem. Read-only.', cadence: 'off', time: '09:00', outbound: false },
  { id: 'inbox', version: '0', description: 'Triage unread inbox into open-loop / mark-read / archive. Confirms before any label writes.', cadence: 'daily', time: '07:00', outbound: false },
  // Community- and self-authored EXTRAS, titled so none duplicates an engine
  // skill (a rock publishing an engine duplicate is the curate page's named
  // mistake, and a fixture that photographed one would teach it).
  { id: 'daily-brief', version: '3', description: 'Morning summary of the day\'s lessons, conditions and bookings, for the coaching day.', cadence: 'daily', time: '06:45', outbound: false },
  { id: 'weekly-review', version: '2', description: 'Sunday wrap of the week\'s sessions and the week ahead, written into the member\'s brain.', cadence: 'weekly', time: '17:30', outbound: false },
  { id: 'inbox-triage', version: '1', description: 'Sorts booking and enquiry email into act / read / ignore and drafts replies for approval.', cadence: 'off', time: '08:00', outbound: true },
  // self-authored (panel iteration 2, R11): the one card whose x warns "this
  // is the only copy". No rock, no version.
  { id: 'trip-planner', version: '0', description: 'Turns a few lines about a trip into a packing list and a day plan, in the member\'s brain.', cadence: 'off', time: '09:00', outbound: false },
];

// The DISTRIBUTION LIBRARY (<brain>/skills-library/<id>/skill.yaml), which is a
// different store from the skills INSTALLED on the mineral (SKILLS above, read by
// skills-list). Modelled as its own list on purpose: they overlap without being
// equal on any real rock, and a fixture that made them identical is what let the
// two-store confusion hide. Here:
//   daily-brief / weekly-review  in both (authored, and the rock runs them too)
//   client-onboarding            library only (given away, never run here)
//   draft-outreach               library only AND declares no category, so the
//                                refuse-to-publish row is reachable in the harness
//   inbox-triage                 installed only (came from Harbour Guild, a rock
//                                above; not this rock's to distribute)
// `category` and `title` live in the manifest, NOT in SKILL.md frontmatter, which
// is why community-catalog-push refused every correctly-authored skill until
// 2026-08-10: it read the markdown only.
const LIBRARY = [
  { id: 'daily-brief', version: '3', title: 'Lesson-day brief', category: 'briefing', cadence: 'daily', time: '06:45', outbound: false,
    description: "Morning summary of the day's lessons, conditions and bookings, for the coaching day." },
  { id: 'weekly-review', version: '2', title: 'Season week wrap', category: 'briefing', cadence: 'weekly', time: '17:30', outbound: false,
    description: "Sunday wrap of the week's sessions and the week ahead, written into the member's brain." },
  { id: 'client-onboarding', version: '1', title: 'Client onboarding', category: 'org', cadence: 'off', time: '09:00', outbound: false,
    description: 'Walks a new client through week one and writes the notes into their brain.' },
  { id: 'draft-outreach', version: '1', title: 'Draft outreach', category: '', cadence: 'off', time: '09:00', outbound: true,
    description: 'Drafts a first-touch message from the member’s own notes. Never sends.' },
];
function skillListLines(state) {
  if (state === 'empty') return ['▸ no skills authored yet'];
  const out = ['▸ reading the skill library…'];
  for (const s of LIBRARY) {
    out.push(`=== ${s.id}`);
    out.push(`version: "${s.version}"`, `description: "${s.description}"`, `title: "${s.title}"`);
    out.push(`category: "${s.category}"`);
    out.push('cadence:', `  default: "${s.cadence}"`, `  time: "${s.time}"`, `outbound: ${s.outbound}`);
  }
  return out;
}

// onboarding-state.json, the 8-layer spine from engine/skills/onboard.md.
// 'empty' = a rock still mid-interview (the state that gates member creation);
// anything else = finished.
const OB_LAYERS = ['1-north-star', '2-philosophy', '3-self', '4-network',
  '5-past', '6-goals', '7-tasks', '8-workflow'];
function onboardState(state) {
  const covered = state === 'empty' ? 3 : OB_LAYERS.length;
  const layers = {};
  OB_LAYERS.forEach(function (k, i) {
    layers[k] = { status: i < covered ? 'covered' : (i === covered ? 'in-progress' : 'not-started'), raw: [], synthesized: i < covered, reviewed: state !== 'empty' };
  });
  return { phase: state === 'empty' ? 'interview' : 'done', scope: 'org',
    current_layer: OB_LAYERS[Math.min(covered, OB_LAYERS.length - 1)], layers };
}

// governance (org-policy.yaml, same 2-level shape the wizard composes)
function governanceLines(state) {
  const name = state === 'empty' ? 'driftwood' : ORG;
  return `schema_version: 1

org:
  name: "${name}"
  display_name: "${ORG_DISPLAY}"
  domain: "driftwood-surf.example.com"
  persona: "Aster"

vocabulary:
  areas_label: "Areas"
  areas:
    - visibility
    - systems
    - wellbeing
  experts_label: "Coaches"
  experts:
    - Maya Castellanos
    - Ben Whitfield
  tiers:
    - standard|Full access to all content and the weekly group call
    - core|Online content only, no live calls

pulse:
  enabled: true
  name: "Pulse"
  landing_page: "notes/pulse/"

heartbeats: minimal
region: hel1

drops:
  direct_to_member: true

access:
  ssh: true
  browser_fallback: true

roles:
  admins:
    - maya@driftwood-surf.example.com
  support:
    - ben@driftwood-surf.example.com

lifecycle:
  content_updates: auto
  images: pinned
  leaver_timeline_days: 30
  leaver_portability: true

member_defaults:
  outbound: "propose-confirm"
  ai_disclosure: true
  challenge_before_comply: true
  quiet_hours: "21:00-06:30"
  timezone: "Europe/Helsinki"

invariants:
  outbound_propose_confirm: true
  privacy_no_member_readback: true
  member_data_portability: true`.split('\n');
}

// pending devices / join requests / device activity / invites waiting
function pendingDevices(state) {
  if (state !== 'rich') return [];
  return [{ slug: 'lena', pubkey: FAKE_KEY('lena-laptop'), fingerprint: 'K7PMQZ' }];
}
function joinRequests(state) {
  if (state !== 'rich') return [];
  return [
    { id: 'jr-2041', email: 'hana.mori@example.com', name: 'Hana Mori' },
    { id: 'jr-2042', email: 'liam.oconnor@example.com', name: "Liam O'Connor" },
  ];
}
function deviceActivity(state) {
  if (state !== 'rich') return [];
  return [
    { slug: 'diego', fingerprint: 'KX9DLM', at: iso(40 * MIN), mode: 'auto' },
    { slug: 'tom', fingerprint: 'ZP2WQN', at: iso(5 * H), mode: 'manual' },
  ];
}
function invitePendingLines(state) {
  if (state !== 'rich') return ['▸ nobody waiting on an invite'];
  return [
    '=== members/lena.yaml',
    'display_name: "Lena Petrova"',
    'invite:',
    `  expires: "${new Date(now() + 9 * D).toISOString().slice(0, 10)}"`,
  ];
}

// ---------------------------------------------------------------------------
// org brain (panel · Org brain tab)
// ---------------------------------------------------------------------------
const ORG_PAGES = {
  'index.md': `# ${ORG_DISPLAY}\n\nThe operating brain for the collective. Start here.\n\n## Live areas\n\n- [[notes/vision]]: where this is going\n- [[notes/vocabulary]]: what we call things\n- [[programs/visibility-sprint]]: the current flagship program\n\n> Content flows down to members through packs; nothing flows back up without consent.`,
  'log.md': `# Log\n\n- ${iso(2 * H).slice(0, 10)} pushed **daily-brief v3** to 4 members\n- ${iso(2 * D).slice(0, 10)} onboarded Diego Alvarez\n- ${iso(6 * D).slice(0, 10)} paused Sofia Lindqvist (sabbatical, back in Sep)`,
  'notes/vision.md': `# Vision\n\nA collective where every member runs on their **own** assistant, on their own box.\n\nWe supply the rhythm (packs, skills, cadence); the member owns the data.\n\n- part-of :: [[index]]\n- references :: [[notes/vocabulary]]`,
  'notes/vocabulary.md': `# Vocabulary\n\n| word | meaning |\n\n- **Areas**: visibility, systems, wellbeing\n- **Coaches**: the people who author program content\n- **Pulse**: the weekly opt-in member rollup`,
  'programs/visibility-sprint.md': `# Visibility sprint\n\nA 6-week program. Weeks 1-2 audit, 3-4 build, 5-6 ship.\n\nDelivered as packs: [[packs/pack-1-starter]] then [[packs/pack-2-make-it-you]].`,
  'packs/pack-1-starter.md': `# Pack 1 · Starter\n\nThe first drop every member gets: brain scaffold + daily-brief skill.\n\n\`\`\`\npacks/pack-1/\n  brain/\n  skills/daily-brief/\n\`\`\``,
  'packs/pack-2-make-it-you.md': `# Pack 2 · Make it you\n\nPersonalisation pass: vocabulary, tone, the member's own areas.`,
  'people/maya-castellanos.md': `# Maya Castellanos\n\nFounder + lead coach. Owns the visibility area.\n\n- part-of :: [[index]]`,
  'people/ben-whitfield.md': `# Ben Whitfield\n\nSupport. First responder on member questions; runs the Tuesday clinic.`,
  'notes/pulse.md': `# Pulse\n\nWeekly rollup of what members chose to share. 4 of 5 active members opted in this week.`,
};

// ---------------------------------------------------------------------------
// member face (Mel)
// ---------------------------------------------------------------------------
const MEMBER_PAGES = {
  'index.md': `# Mel's brain\n\nHome page. Everything links from here.\n\n- [[areas/visibility]] · [[areas/systems]] · [[areas/wellbeing]]\n- Current push: [[projects/q3-launch]]`,
  'log.md': `# Log\n\n- ${iso(3 * H).slice(0, 10)} daily brief ran, 2 actions carried over\n- ${iso(1 * D).slice(0, 10)} website copy draft v2 reviewed with Dana`,
  'onboarding.md': `# Onboarding\n\nAll 11 steps complete. Assistant name: **Aster**.`,
  'areas/visibility.md': `# Visibility\n\nGetting the studio seen. Current bet: the Q3 launch.\n\n- part-of :: [[index]]\n- depends-on :: [[projects/q3-launch]]`,
  'areas/systems.md': `# Systems\n\nThe studio's operating rhythm: invoicing, pipeline, weekly review.\n\n- uses :: [[notes/weekly-review]]`,
  'areas/wellbeing.md': `# Wellbeing\n\nProtected mornings. No calls before 11. Surf Wednesdays.`,
  'projects/q3-launch.md': `# Q3 launch\n\nNew service line: brand sprints for founders.\n\n![[moodboard.png]]\n\n- Landing page: [[projects/website-refresh]]\n- First three prospects: [[people/dana-whitfield]], [[people/marcus-hale]]\n\n> Target: 3 paid sprints by end of September.\n\n| prospect | stage |\n| --- | --- |\n| Dana | warm |\n| Marcus | discovery |`,
  'projects/website-refresh.md': `# Website refresh\n\nShip the new studio site. Copy v2 in review; photography booked for Friday.\n\n- part-of :: [[projects/q3-launch]]`,
  'people/dana-whitfield.md': `# Dana Whitfield\n\nFounder, Fernway Goods. Warm lead, replied same day, wants the sprint in August.\n\n- references :: [[projects/q3-launch]]`,
  'people/marcus-hale.md': `# Marcus Hale\n\nCOO at Brightside Labs. Intro via Tom. Discovery call Thursday.\n\n- references :: [[projects/q3-launch]]`,
  'notes/weekly-review.md': `# Weekly review\n\nSunday 17:00, written by the weekly-review skill, edited by me.\n\nLast week: shipped copy v2, 2 discovery calls, said no to a rush job.`,
  'notes/ideas.md': `# Ideas\n\n- productise the brand-audit checklist\n- monthly "office hours" for past clients\n- a tiny newsletter, 5 lines, every Friday`,
  // 2026-08-17: the brain lists assets too. One of each family the allow-list
  // admits, so the tree, the reader routing and the image path all render in
  // the harness instead of only on a live box. moodboard.png is referenced from
  // q3-launch below via ![[...]] so hydration is exercised end to end.
  'notes/prospects.csv': `name,company,stage,"next step"\nDana Whitfield,Fernway Goods,warm,"sprint scope call"\nMarcus Hale,Brightside Labs,discovery,"call Thursday"`,
  'notes/scratch.txt': `raw capture from the Tuesday walk:\n\npitch the sprint as "a fortnight, a finished thing"\nask Dana about the retail angle`,
  'projects/moodboard.png': '__FIXTURE_PNG__',
};

const MEMBER_GRAPH = () => {
  const type = (p) => p.startsWith('people/') ? 'person' : p.startsWith('projects/') ? 'project'
    : (p === 'index.md' || p === 'log.md' || p === 'onboarding.md') ? 'scaffold' : 'note';
  // pages only: assets never grow graph nodes (the graph is built from wikilinks)
  const nodes = Object.keys(MEMBER_PAGES).filter((p) => p.endsWith('.md')).map((p) => ({
    id: p.replace(/\.md$/, ''), title: p.split('/').pop().replace(/\.md$/, '').replace(/-/g, ' '),
    type: type(p), path: p,
  }));
  const L = (a, b, rel) => ({ source: a, target: b, w: 1, ...(rel ? { rel } : {}) });
  const links = [
    L('index', 'areas/visibility'), L('index', 'areas/systems'), L('index', 'areas/wellbeing'),
    L('index', 'projects/q3-launch'), L('index', 'log'),
    L('areas/visibility', 'projects/q3-launch', 'depends-on'),
    L('areas/systems', 'notes/weekly-review', 'uses'),
    L('projects/q3-launch', 'projects/website-refresh', 'part-of'),
    L('projects/q3-launch', 'people/dana-whitfield'), L('projects/q3-launch', 'people/marcus-hale'),
    L('people/dana-whitfield', 'projects/q3-launch', 'references'),
    L('onboarding', 'index'),
  ];
  return { nodes, links };
};

// `pebble` is the field engine/cockpit/box-cockpit.mjs actually writes (the
// person on a pebble, the rock's name on a rock). These fixtures said `client`,
// which no live box has ever emitted, and the panel read `client` too — so the
// hero subtitle was blank on every real mineral and correct in every screenshot
// for months. A fixture emits what the box emits (docs/naming.md, 2026-08-14).
function dashboardDataLines(state, signedOut, surface) {
  if (state === 'empty') {
    const data = {
      ...(surface === 'member'
        ? { assistant: 'Aster', pebble: 'Mel Harper', business: '', stage: 'brand new' }
        : { assistant: ORG_DISPLAY, pebble: ORG_DISPLAY, business: null, stage: 'brand new' }),
      onboarding: { phase: 'interview', covered: 1, total: 8, current: '1-north-star' },
      brain: { pages: 0, people: 0, skeleton: 0 },
      skills: { installed: 0 },
      health: 'OK', generated_at: iso(10 * MIN),
      connections: [],
      graph: { nodes: [], links: [] },
    };
    return ['▸ reading the box…', '__DATA__', JSON.stringify(data, null, 1), '__LAYOUT__', '{}'];
  }
  const data = {
    ...(surface === 'member'
      // anchor: the ONE fact that keeps the world coherent across surfaces.
      // Mel is Driftwood's anchored member everywhere else (the door, the seat,
      // the promote card, the heartbeats), but this payload never said so, so
      // the Billing card photographed "Pebble · direct" while five other shots
      // said anchored (audit round three, 2026-08-25).
      ? { assistant: 'Aster', pebble: 'Mel Harper', business: 'Driftwood Surf School', stage: 'Growth · month 4', anchor: ORG_DISPLAY }
      : { assistant: ORG_DISPLAY, pebble: ORG_DISPLAY, business: null, stage: null }),
    onboarding: { phase: 'done', covered: 8, total: 8, current: '' },
    brain: { pages: Object.keys(MEMBER_PAGES).filter((p) => p.endsWith('.md')).length, people: 2, skeleton: 3 },
    skills: { installed: 6 },
    health: 'OK', generated_at: iso(25 * MIN),
    connections: [
      // The mineral's OWN Claude sign-in, first because it gates everything
      // unattended. The healthy fixture is a month-4 box with cadence running,
      // so it MUST be signed in: omitting it modelled a box that could not have
      // done any of the other things this fixture claims it has done. The gate's
      // own QA rewrites this row to pending in-flight (qa-cadence-gate).
      signedOut
        ? { name: 'Claude sign-in on this mineral', status: 'not signed in yet · sign in from the Terminal tab', state: 'pending' }
        : { name: 'Claude sign-in on this mineral', status: 'signed in as mel@driftwoodsurf.school', state: 'ok' },
      { name: 'Email (Gmail)', status: 'connected', state: 'ok' },
      { name: 'Calendar', status: 'connected', state: 'ok' },
      { name: 'Telegram', status: 'set up, not linked', state: 'configured' },
      { name: 'Todoist', status: 'not connected', state: '' },
    ],
    graph: MEMBER_GRAPH(),
  };
  // __LAYOUT__ is vestigial: customise mode died 2026-08-09 and nothing reads the
  // saved order any more. Kept so old boxes' emitted shape stays exercised.
  const layout = { order: ['assistant', 'onboarding', 'brain', 'health'], hidden: [] };
  return ['▸ reading the box…', '__DATA__', JSON.stringify(data, null, 1), '__LAYOUT__', JSON.stringify(layout)];
}

function pagesListLines(state) {
  if (state === 'empty') return ['__MANIFEST__', '{}', '__CARDS__', '{}', '__OWNERSHIP__', '{}'];
  const manifest = { pages: [{ id: 'wins', title: 'My wins' }] };
  const cards = { cards: [{ id: 'momentum', title: 'This week', big: '3 wins', sub: 'captured on your My wins page' }] };
  const ownership = { owner: 'member' };
  return ['__MANIFEST__', JSON.stringify(manifest), '__CARDS__', JSON.stringify(cards), '__OWNERSHIP__', JSON.stringify(ownership)];
}

const WINS_PAGE_HTML = `<h2>My wins</h2>
<p class="hint" style="color:var(--soft);font-size:13px;line-height:1.5">A page your rock drops onto your box. Rendered from /state/dashboard/pages.</p>
<ul style="line-height:1.9;font-size:14.5px">
  <li>Copy v2 shipped and approved by Dana</li>
  <li>Two discovery calls booked off one referral</li>
  <li>Said no to a rush job (protected the week)</li>
</ul>`;

// The merged Skills page (audit R6) reads every section the real box emits;
// the old two-marker fixture made every row an orphan ("scheduled but no
// longer installed") because ALLSKILLS was absent — seen on camera 2026-08-09.
const SKILL_META = {
  // engine ten (source defaults to 'engine' below)
  'connect': { title: 'Connect a service', category: 'box' },
  'dashboard': { title: 'Build pages & cards', category: 'box' },
  'explain': { title: 'Explain this system', category: 'box' },
  'onboard': { title: 'Onboarding interview', category: 'box' },
  'daily': { title: 'Daily brief', category: 'briefing' },
  'plan-week': { title: 'Plan your week', category: 'briefing' },
  'weekly': { title: 'Weekly review', category: 'briefing' },
  'capture': { title: 'Capture the session', category: 'capture' },
  'followup': { title: 'Follow-ups', category: 'comms' },
  'inbox': { title: 'Inbox triage', category: 'comms' },
  // extras, engine-distinct titles
  'daily-brief': { title: 'Lesson-day brief', category: 'briefing', source: 'org', rock: 'Driftwood Surf School' },
  'weekly-review': { title: 'Season week wrap', category: 'briefing', source: 'org', rock: 'Driftwood Surf School' },
  'inbox-triage': { title: 'Booking inbox triage', category: 'comms', source: 'org', rock: 'Harbour Guild' },
  'trip-planner': { title: 'Trip planner', category: 'other', source: 'member' },
};
function allSkillsState() {
  return {
    skills: SKILLS.map((s) => ({
      id: s.id,
      title: (SKILL_META[s.id] || {}).title || s.id,
      description: s.description,
      category: (SKILL_META[s.id] || {}).category || 'other',
      source: (SKILL_META[s.id] || {}).source || 'engine',
      rock: (SKILL_META[s.id] || {}).rock || '',
      // .origin.json's version for rock-published skills (R12 update chip);
      // 0 for anything without one, exactly as skills-list emits it
      version: parseInt(s.version, 10) || 0, gate: '', outbound: s.outbound === true, cadence_default: s.cadence,
    })),
    cadence: {}, runs: {},
    last_runs: {
      'daily-brief': { ts: iso(4 * 60 * MIN), status: 'ok', summary: 'brief written to your brain' },
      'inbox-triage': { ts: iso(26 * 60 * MIN), status: 'fail', error: 'gmail sign-in expired' },
    },
    machinery_runs: {
      backup: { ts: iso(7 * 60 * MIN), status: 'ok' },
      'auto-update': { ts: iso(9 * 60 * MIN), status: 'ok' },
    },
    generated: iso(0),
  };
}
function cadenceListLines(state) {
  if (state === 'empty') {
    return ['__SKILLS__', '__CADENCE__', '{}', '__RUNS__', '{}', '__AUTOUPDATE__', '{}',
      '__HEARTBEAT__', '{}', '__ALLSKILLS__', 'SKILLS_STATE {"skills":[],"cadence":{},"runs":{}}', '__PLANJSON__', '{}'];
  }
  const out = ['__SKILLS__'];
  for (const s of SKILLS) {
    out.push(`=== ${s.id}`);
    out.push(`description: "${s.description}"`, 'cadence:', `  default: "${s.cadence}"`, `  time: "${s.time}"`);
  }
  out.push('__CADENCE__');
  out.push(JSON.stringify({
    // engine recipes armed as the recipe library ships them
    'inbox': { enabled: true, when: 'daily', time: '07:00' },
    'daily': { enabled: true, when: 'daily', time: '07:15' },
    'plan-week': { enabled: true, when: 'weekly', time: '08:00' },
    'weekly': { enabled: true, when: 'weekly', time: '17:00' },
    'daily-brief': { enabled: true, when: 'daily', time: '06:45' },
    'weekly-review': { enabled: true, when: 'weekly', time: '17:30' },
    'inbox-triage': { enabled: false, when: 'off', time: '08:00' },
  }, null, 1));
  out.push('__RUNS__', '{}');
  out.push('__AUTOUPDATE__', JSON.stringify({ enabled: true }));
  out.push('__HEARTBEAT__', JSON.stringify({ generated_at: iso(22 * MIN) }));
  out.push('__ALLSKILLS__', 'SKILLS_STATE ' + JSON.stringify(allSkillsState()));
  out.push('__PLANJSON__', JSON.stringify({ machinery: [
    { id: 'auto-update', when: 'around 04:00, local', note: 'nightly software update' },
    { id: 'heartbeat', when: 'hourly', note: 'tells your rock this box is alive' },
    { id: 'backup', when: '02:30 nightly', note: 'encrypted snapshot of your settings and credentials' },
  ] }));
  return out;
}

function sharingListLines(state) {
  const sharing = state === 'empty' ? {} : { activity: true, skill_engagement: true };
  const full = state === 'empty'
    ? { generated_at: iso(5 * MIN), auth_ok: true }
    : HEARTBEATS().mel;
  return ['__SHARING__', JSON.stringify(sharing, null, 1), '__FULL__', JSON.stringify(full, null, 1), '__SHARED__'];
}

function supportStatus(state) {
  if (state === 'empty') return { configured: true, active: null, events: [] };
  return {
    configured: true, active: null,
    events: [
      { at: iso(12 * D), event: 'granted', hours: 24 },
      { at: iso(11 * D), event: 'expired' },
    ],
  };
}

// The secret store (2026-07-28). Shape must match engine/vault/vault-cli.mjs
// `list` exactly. Note what is NOT here: values. The listing never carries them.
function secretsList(state) {
  if (state === 'empty') return { secrets: [] };
  return {
    secrets: [
      { name: 'gmail-token', tier: 'hot', label: 'Gmail', used_by: ['morning-brief'],
        created: iso(40 * D), updated: iso(6 * D) },
      { name: 'telegram-bot', tier: 'hot', label: 'Telegram bot', used_by: ['daily digest'],
        created: iso(38 * D), updated: iso(38 * D) },
      { name: 'client-portal-login', tier: 'cold', label: 'Client portal login', used_by: [],
        created: iso(9 * D), updated: iso(9 * D), sealed_to: ['work-laptop', 'home-mac'] },
    ],
  };
}

// The secrets LEDGER (R7, panel iteration 2). Shape must match
// engine/vault/discover.mjs's row contract exactly: name · label · what · where
// · set · kind · revoke{via,key?} · updated. Never a value.
function secretsDiscover(state) {
  if (state === 'empty') return [];
  return [
    { name: 'claude-signin', label: 'Claude sign-in', what: 'Lets your mineral run skills with nobody at the keyboard. Used by every scheduled job.', where: '.claude-auth/.credentials.json', set: true, kind: 'sign-in', revoke: { via: 'seat' }, updated: iso(3 * D), readable_by_box: true },
    { name: 'github-login', label: 'GitHub login', what: 'Backs your brain up to your own private repository. Used by the nightly backup.', where: '.kernel/gh', set: true, kind: 'sign-in', revoke: { via: 'seat' }, updated: iso(20 * D), readable_by_box: true },
    { name: 'mcp-notion', label: 'Notion', what: 'Your Notion sign-in, so jobs can read and write your pages. Used by any skill that uses Notion.', where: '.kernel/mcp-oauth.json', set: true, kind: 'connection', revoke: { via: 'connections', key: 'notion' }, updated: iso(2 * D), readable_by_box: true },
    { name: 'mcp-linear', label: 'Linear', what: 'Your Linear sign-in. Added, not signed in yet.', where: '.kernel/mcp-oauth.json', set: false, kind: 'connection', revoke: { via: 'connections', key: 'linear' }, updated: null, readable_by_box: true },
    { name: 'google-key', label: 'Google Workspace key', what: 'Your own Google key, so jobs can read mail and calendar. Used by the morning brief.', where: '.kernel/google-creds/mel@gmail.com.json', set: true, kind: 'connection', revoke: { via: 'connections', key: 'google' }, updated: iso(5 * D), readable_by_box: true },
    { name: 'telegram_bot_token', label: 'Telegram bot token', what: 'Lets your box talk to you on Telegram. Used by the Telegram bridge and your scheduled jobs.', where: 'secrets/telegram_bot_token', set: true, kind: 'channel', revoke: { via: 'telegram' }, updated: iso(38 * D), readable_by_box: true },
    { name: 'backup_passphrase', label: 'Backup passphrase', what: 'Encrypts your nightly backup before it leaves the box. Used by the backup job; you need it to restore.', where: 'secrets/backup_passphrase', set: true, kind: 'backup', revoke: { via: 'none' }, updated: iso(60 * D), readable_by_box: true },
    { name: 'backup_passphrase.escrowed', label: 'Backup passphrase, escrow marker', what: 'A note that your backup passphrase has been saved off this mineral. Until it exists, your backup reports as not recoverable.', where: 'secrets/backup_passphrase.escrowed', set: true, kind: 'backup', revoke: { via: 'none' }, updated: iso(58 * D), readable_by_box: true },
    { name: 'box_directory_token', label: 'Directory token', what: 'Proves to the Crads-AI directory that this box is yours. Used by the device enrolment and status jobs.', where: 'secrets/box_directory_token', set: true, kind: 'platform', revoke: { via: 'none' }, updated: iso(60 * D), readable_by_box: true },
    { name: 'client-portal-login', label: 'Client portal login', what: 'Sealed to your own computers. Your mineral cannot open it, and neither can Crads AI.', where: 'secrets/vault/client-portal-login', set: true, kind: 'vault', revoke: { via: 'none' }, updated: iso(9 * D), readable_by_box: false },
  ];
}

// The device roster (2026-07-28): which computers can open this box. Shape must
// match engine/devices/roster-cli.mjs `list` exactly, since member.html parses it.
function devicesList(state) {
  if (state === 'empty') return { devices: [], support: null };
  return {
    devices: [
      { slug: 'work-laptop', label: 'Work laptop', pubkey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBEqBeSfd/bTMrQlFHEMSnBr work-laptop',
        fingerprint: 'SHA256:tjP/Y1TvRpPbcIxrV1aIsFpJO+Z0C4szRuUTE09fmt0',
        added: '2026-06-14', revoked: '', status: 'active', last_seen: iso(0.5 * MIN) },
      { slug: 'home-mac', label: 'Home mac', pubkey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH9pQ0kEjKlXsGGvJ2WbNS0a home-mac',
        fingerprint: 'SHA256:9pQ0kEjKlXsGGvJ2WbNS0aBcDeFgHiJkLmNoPqRsTuA',
        added: '2026-07-02', revoked: '', status: 'active', last_seen: iso(3 * D) },
      { slug: 'old-laptop', label: 'Old laptop (sold)', pubkey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKkKkKkKkKkKkKkKkKkK old-laptop',
        fingerprint: 'SHA256:kKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKk',
        added: '2026-04-01', revoked: '2026-06-14', status: 'revoked', last_seen: iso(45 * D) },
    ],
    support: null,
  };
}

// ---------------------------------------------------------------------------
// own-brain (the seat's Backup card; the other member-connect endpoint
// fixtures were deleted with the invite surface, 2026-09-01)
// ---------------------------------------------------------------------------
export function ownBrainStatus() { return { stage: 'idle', steps: [] }; }

// The brokered build's progress, walked on a clock: the same percentages
// fulfil-arrivals posts from the remote stamp's own output.
const BUILD_WALK = [
  { pct: 4, msg: 'asking your rock to build it' },
  { pct: 8, msg: 'reserving your address' },
  { pct: 35, msg: 'creating the machine' },
  { pct: 55, msg: 'machine booting' },
  { pct: 75, msg: 'installing your assistant (the longest step)' },
  { pct: 90, msg: 'sending their invite' },
  { pct: 100, msg: 'ready', done: true },
];
let BUILD_AT = -1;
export function buildProgress() {
  if (process.env.AIOS_FX_BUILD_FAILS && BUILD_AT >= 2) {
    return { stage: 'failed', pct: 100, msg: 'the machine could not be created', failed: true };
  }
  BUILD_AT = Math.min(BUILD_AT + 1, BUILD_WALK.length - 1);
  const s = BUILD_WALK[BUILD_AT];
  return { stage: s.done ? 'ready' : 'building', pct: s.pct, msg: s.msg, done: !!s.done, failed: false };
}

// The rock's GitHub connect, walked on a clock so the card can be driven end to
// end: waiting -> installing -> done. ORG_GH_ARMED flips the factory-status
// fixture with it, which is what proves the notice disappears on success.
let ORG_GH_AT = 0;
export let ORG_GH_ARMED = false;
export function orgGitHubBegin() { ORG_GH_AT = 1; }
export function orgGitHubStatus() {
  if (!ORG_GH_AT) return { stage: 'idle', steps: [], reason: '', login: '' };
  ORG_GH_AT += 1;
  if (ORG_GH_AT === 2) return { stage: 'waiting', steps: ['Waiting for you to approve the code on github.com'], reason: '', login: '' };
  if (ORG_GH_AT === 3) return { stage: 'installing', steps: ['Waiting for you to approve the code on github.com', 'Approved. Handing the account to your rock'], reason: '', login: '' };
  ORG_GH_ARMED = true;
  // AIOS_FX_BACKUP_FAILS drives the armed-but-unbacked outcome: the sign-in
  // worked, pebbles are unblocked, and the repo did not take.
  if (process.env.AIOS_FX_BACKUP_FAILS) {
    return { stage: 'done', reason: '', login: 'driftwood-surf', repo: '',
      backupError: 'GraphQL: Name already exists on this account (createRepository)',
      steps: ['Waiting for you to approve the code on github.com', 'Approved. Handing the account to your rock', 'Connected as driftwood-surf', 'The backup repository did not finish'] };
  }
  return { stage: 'done', steps: ['Waiting for you to approve the code on github.com', 'Approved. Handing the account to your rock', 'Connected as driftwood-surf'], reason: '', login: 'driftwood-surf', repo: 'driftwood-surf/driftwood-brain' };
}

// ---------------------------------------------------------------------------
// invite fragment (valid-looking v1 invite; payload = host|sip|user|token).
// The /join page died 2026-09-01; this survives only because the legacy
// invite-verb fixtures below still print link-shaped strings.
// ---------------------------------------------------------------------------
export function joinFragment() {
  const payload = Buffer.from('mel.driftwood-surf.example.com|203.0.113.44|member|tok_demo_9f3a1c77', 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `#v1.${ORG}.mel.${payload}`;
}

// ---------------------------------------------------------------------------
// terminal transcript (base64 SSE chunks)
// ---------------------------------------------------------------------------
export function termTranscript(host) {
  const esc = '';
  const c = (n, s) => `${esc}[${n}m${s}${esc}[0m`;
  return [
    `${c('1;32', host)}:${c('1;34', '/state')}$ `,
    'claude\r\n',
    `\r\n${c('38;5;208', ' ▐▛███▜▌')}   ${c('1', 'Claude Code')} ${c('2', 'v2.1.0')}\r\n`,
    `${c('38;5;208', '▝▜█████▛▘')}  ${c('2', 'Sonnet · /state/brain')}\r\n`,
    `${c('38;5;208', '  ▘▘ ▝▝')}\r\n\r\n`,
    `${c('2', 'Tips for getting started: run /onboard, or just ask anything about your org.')}\r\n\r\n`,
    `${c('1;32', '>')} introduce yourself\r\n\r\n`,
    `I'm ${c('1', 'Aster')}, the assistant for ${c('1', 'Driftwood Surf School')}. I keep the org brain,\r\n`,
    'draft what needs drafting, and never send anything without a human yes.\r\n\r\n',
    `${c('1;32', host)}:${c('1;34', '/state')}$ `,
  ].map((s) => Buffer.from(s, 'utf8').toString('base64'));
}

// Two more transcripts, picked with `?term=onboard|signin` on the member URL
// (2026-09-10, for the product demo films). Same shape as termTranscript; the
// words follow engine/skills/onboard.md (turn zero asks the name, then one
// question per turn, quoting the member's own words) and the real `claude`
// sign-in prompt. Fiction, like every other fixture here.
export function termTranscriptFor(host, kind) {
  if (kind === 'onboard') return termTranscriptOnboard(host);
  if (kind === 'signin') return termTranscriptSignin(host);
  return termTranscript(host);
}
function banner(host, c) {
  return [
    `${c('1;32', host)}:${c('1;34', '/state')}$ `,
    'claude\r\n',
    `\r\n${c('38;5;208', ' ▐▛███▜▌')}   ${c('1', 'Claude Code')} ${c('2', 'v2.1.0')}\r\n`,
    `${c('38;5;208', '▝▜█████▛▘')}  ${c('2', 'Sonnet · /state/brain')}\r\n`,
    `${c('38;5;208', '  ▘▘ ▝▝')}\r\n\r\n`,
  ];
}
export function termTranscriptOnboard(host) {
  const esc = '\x1b';
  const c = (n, s) => `${esc}[${n}m${s}${esc}[0m`;
  return [
    ...banner(host, c),
    `${c('2', 'Tips for getting started: run /onboard, or just ask anything.')}\r\n\r\n`,
    `${c('1;32', '>')} /onboard\r\n\r\n`,
    'Before anything else: what would you like to call me? One word is fine.\r\n\r\n',
    `${c('1;32', '>')} Aster\r\n\r\n`,
    'Aster it is. Written down already, so every screen will say so.\r\n\r\n',
    "Let's start with the big picture. Five years from now, what does winning look\r\n",
    `like for ${c('1', 'Driftwood Surf School')}?\r\n\r\n`,
    `${c('1;32', '>')} Two sites, a coaching programme that runs without me on the beach every\r\n`,
    '  day, and winters off.\r\n\r\n',
    '"Winters off" is doing a lot of work in that sentence. Is that about money,\r\n',
    'or about the school running without you?\r\n\r\n',
    `${c('1;32', '>')} Both. Mostly the second.\r\n\r\n`,
    'Noted, in your words. That is layer one of eight: what you are for. Next is\r\n',
    'how you believe a surf school should be run. Take a break whenever you like;\r\n',
    'I pick up where we stopped.\r\n\r\n',
    `${c('2', 'Layer 1 of 8 · covered · saved to wiki/_layers/1-north-star.md')}\r\n\r\n`,
    `${c('1;32', '>')} `,
  ].map((s) => Buffer.from(s, 'utf8').toString('base64'));
}
export function termTranscriptSignin(host) {
  const esc = '\x1b';
  const c = (n, s) => `${esc}[${n}m${s}${esc}[0m`;
  return [
    ...banner(host, c),
    `${c('1', 'Sign in to Claude.')} Opening your browser…\r\n\r\n`,
    "Browser didn't open? Use the url below to sign in:\r\n",
    `${c('4', 'https://claude.ai/oauth/authorize?code=true&client_id=…')}\r\n\r\n`,
    'Paste code here if prompted > ',
    `${c('2', '••••••••-••••')}\r\n\r\n`,
    `${c('1;32', '✓')} Login successful. Signed in with your own Claude account.\r\n`,
    `${c('2', 'This mineral can now run scheduled jobs and answer on Telegram.')}\r\n\r\n`,
    `${c('1;32', host)}:${c('1;34', '/state')}$ `,
  ].map((s) => Buffer.from(s, 'utf8').toString('base64'));
}

// ---------------------------------------------------------------------------
// /run dispatcher
// ---------------------------------------------------------------------------
function ok(lines, code) { return { code: code || 0, lines }; }

// Telegram link state for the fixture box (see the telegram-* cases below).
let TG_STATE = { ok: true, token: false, chat: false, username: null };
// MCP connection fixture, 2026-08-09 shape: featured DCR servers + honest Google
// rows + connect-anything. notion starts working, linear needs-auth, so the page
// renders one of each state without any clicking.
const MCP_FEATURED = {
  notion: { label: 'Notion', blurb: 'read and update your pages and databases' },
  linear: { label: 'Linear', blurb: 'see and file issues' },
  sentry: { label: 'Sentry', blurb: 'read errors from your apps' },
  canva: { label: 'Canva', blurb: 'work with your designs' },
  vercel: { label: 'Vercel', blurb: 'see your deployments' },
  apify: { label: 'Apify', blurb: 'run scrapers and read results' },
};
const MCP_ON = {
  notion: { authorised: true, auth: 'oauth', renews: true },
  linear: { authorised: false, auth: 'oauth', renews: null },
  // canva, 2026-08-09: a FEATURED key that is ALSO a catalogue entry, connected
  // and fully authorised. The connections-directory shot state needs one such
  // row to prove ruling 3 (hidden from browse once connected) against a real
  // catalogue key, not just the pre-existing notion/linear rows.
  canva: { authorised: true, auth: 'oauth', renews: true },
};
const MCP_CHAT = { stripe: true };   // a connection made inside Claude Code (chats-only)
const MCP_CONTRACT = 3;   // must stay <= engine/comms/mcp-connect.mjs's real CONTRACT
                          // (2 = the byo google row, 2026-08-17; 3 = several
                          // google rows, one per account, 2026-09-14. Bumped
                          // in lockstep with the engine. rekey_due_at left the
                          // row on 2026-08-24: a published key has no clock)

// Google, with the member's own key (design-google-byo-connect.md). The box rows
// and the app's /google-connect/* routes share one state so the wizard is
// drivable end to end: off -> key dropped -> sign-in walked on a clock -> on.
// Several accounts (2026-09-14): one entry per account row, keyed like the
// box keys them (google, google-<slug>). AIOS_FX_GOOGLE seeds the primary
// (needs-auth | on | expired) for shots and tests — "expired" mirrors a box
// whose live probe wrote the dead marker; "on" also seeds a second, working
// account so the several-accounts shape is photographed. An email containing
// "denied" drives the failure path without env plumbing, so one harness
// process can walk both outcomes.
const GW_KEY_RE = /^google(-[a-z0-9][a-z0-9-]{0,19})?$/;   // mirrors engine/lib/google-byo.mjs
const gwFresh = () => ({ added: false, on: false, expired: false, email: '', client: false, flowAt: 0 });
let GW;   // key -> account state
function gwReset() {
  const seed = process.env.AIOS_FX_GOOGLE || '';
  GW = { google: {
    ...gwFresh(),
    added: seed === 'needs-auth' || seed === 'on' || seed === 'expired',
    on: seed === 'on', expired: seed === 'expired',
    email: seed ? 'mel@gmail.com' : '',
  } };
  if (seed === 'on') GW['google-work'] = { ...gwFresh(), added: true, on: true, email: 'mel@harperandco.example' };
}
gwReset();
const gwKeyOf = (v) => { const k = String(v || 'google').trim().toLowerCase(); return GW_KEY_RE.test(k) ? k : ''; };
const gwAcct = (key) => GW[key] || (GW[key] = gwFresh());
const gwLabel = (key) => key === 'google' ? 'Google Workspace' : 'Google Workspace (' + key.slice('google-'.length) + ')';
// same four shapes engine/comms/mcp-connect.mjs googleRow() emits: auth 'byo',
// byo 'google', NO url (the page must never route this row into a DCR sign-in)
function gwFixtureRow(key, a) {
  const base = { key, label: gwLabel(key), blurb: 'gmail, calendar, drive and docs, with your own key', auth: 'byo', byo: 'google', mine: true };
  if (!a.added) return { ...base, state: 'off', status: 'not connected', configured: false, authorised: false, renews: null };
  if (a.on) return { ...base, state: 'on', status: 'working, including in scheduled jobs', configured: true, authorised: true, renews: true, email: a.email };
  if (a.expired) return { ...base, state: 'needs-auth', status: 'sign-in expired, needs you once more', configured: true, authorised: false, renews: false, email: a.email };
  return { ...base, state: 'needs-auth', status: 'added, waiting for you to sign in once', configured: true, authorised: false, renews: null, email: a.email || null };
}
// primary first (always present, off when absent), then every further
// account that has been added, by key: the order engine googleRows() emits
function gwFixtureRows() {
  const extra = Object.keys(GW).filter((k) => k !== 'google' && GW[k].added).sort();
  return [gwFixtureRow('google', gwAcct('google')), ...extra.map((k) => gwFixtureRow(k, GW[k]))];
}
// the /google-connect/* route fixtures (harness.mjs forwards straight here);
// refusal strings mirror wizard/panel/google-connect-routes.mjs verbatim.
// Every route names its account row (`key`, default google), as the real ones do.
const GW_BAD_KEY = 'that account name does not look right: up to 20 letters, digits or hyphens';
export function googleConnectClient(body) {
  const key = gwKeyOf(body.key);
  if (!key) return { ok: false, reason: GW_BAD_KEY };
  let parsed = null;
  try { parsed = JSON.parse(Buffer.from(String(body.client_json_b64 || ''), 'base64').toString('utf8')); } catch { /* not JSON */ }
  if (parsed && parsed.web) {
    return { ok: false, reason: 'that is a Web application client: go back to the console and create a Desktop app client' };
  }
  if (!parsed) {
    return { ok: false, reason: 'that file is not the JSON Google gave you: download it again from the console' };
  }
  if (!parsed.installed) {
    return { ok: false, reason: 'that JSON holds no Google OAuth client (expected an id ending .apps.googleusercontent.com): download the file again from the console' };
  }
  const a = gwAcct(key);
  a.email = String(body.email || '');
  a.client = true;
  // the real route runs add-google here: the row exists on the box from this point
  a.added = true;
  return { ok: true, key, client: { client_id: parsed.installed.client_id || 'fixture.apps.googleusercontent.com' } };
}
export function googleConnectStart(body = {}) {
  const key = gwKeyOf(body.key);
  if (!key) return { ok: false, reason: GW_BAD_KEY };
  const a = gwAcct(key);
  // no client stash (fresh harness, or the "app restarted" re-key case): the
  // page matches this exact reason and re-opens the file-drop step
  if (!a.client) return { ok: false, reason: 'drop your key file first' };
  a.flowAt = 1;
  return { ok: true, key };
}
export function googleConnectStatus(keyArg) {
  const key = gwKeyOf(keyArg) || 'google';
  const a = gwAcct(key);
  if (!a.flowAt) return { ok: true, key, stage: 'idle', steps: [] };
  a.flowAt += 1;
  const s1 = 'Waiting for you to approve access in your Google window';
  const s2 = 'Approved. Google handed back a key for ' + (a.email || 'your account');
  const s3 = 'Proving it works against one of the services you allowed';
  if (a.flowAt === 2) return { ok: true, key, stage: 'waiting', steps: [s1] };
  if (a.email.includes('denied')) {
    a.flowAt = 0;   // the client stash survives a refusal, so a retry can start clean
    return { ok: true, key, stage: 'failed', reason: 'Google refused the sign-in (access denied)', steps: [s1] };
  }
  if (a.flowAt === 3) return { ok: true, key, stage: 'working', steps: [s1, s2] };
  if (a.flowAt === 4) return { ok: true, key, stage: 'working', steps: [s1, s2, s3] };
  a.flowAt = 0;
  a.added = true; a.on = true; a.expired = false;
  return { ok: true, key, stage: 'done', steps: [s1, s2, s3, 'Working, including in scheduled jobs'], email: a.email };
}
export function googleConnectCancel(body = {}) { gwAcct(gwKeyOf(body.key) || 'google').flowAt = 0; return { ok: true }; }
function mcpRows() {
  const rows = Object.entries(MCP_FEATURED).map(([key, def]) => {
    const s = MCP_ON[key];
    if (!s) return { key, ...def, url: 'https://mcp.' + key + '.example/mcp', auth: 'oauth', state: 'off', status: 'not connected', configured: false, authorised: false, renews: null, mine: true };
    const url = 'https://mcp.' + key + '.example/mcp';
    if (s.auth === 'token' || s.authorised) return { key, ...def, ...s, url, state: 'on', status: 'working, including in scheduled jobs', configured: true, mine: true };
    return { key, ...def, ...s, url, state: 'needs-auth', status: 'added, waiting for you to sign in once', configured: true, mine: true };
  });
  for (const [key, st] of Object.entries(MCP_ON)) {
    if (MCP_FEATURED[key]) continue;
    rows.push({ key, label: key, blurb: 'connected by you', auth: st.auth, state: st.authorised ? 'on' : 'needs-auth',
      status: st.authorised ? 'working, including in scheduled jobs' : 'added, waiting for you to sign in once',
      configured: true, authorised: st.authorised, renews: st.renews, mine: true });
  }
  // label capitalised like the real producer (connectionLabel, audit R1): the
  // shot rig must not show a raw key the product itself would never render
  rows.push({ key: 'stripe', label: 'Stripe', blurb: 'connected in Claude Code', auth: 'oauth', state: MCP_CHAT.stripe ? 'chat-only' : undefined, adoptable: true, mine: false, configured: true, authorised: true, renews: true, status: 'in your chats only, not in scheduled jobs' });
  if (!MCP_CHAT.stripe) rows.pop();
  // contract 2 (2026-08-17): the three "unavailable" Google rows are gone from
  // the box's report; the connectable byo rows below are the offer now
  // (contract 3, 2026-09-14: one per account).
  rows.push(...gwFixtureRows());
  // R21 (panel iteration 2): a connector on the member's CLAUDE ACCOUNT, the
  // exact shape engine/comms/mcp-connect.mjs emits for one. Never adoptable,
  // never able to serve a job; the page folds it under "Connected to your
  // Claude account".
  rows.push({ key: 'account-slack', label: 'Slack', blurb: 'connected to your Claude account in the app', auth: 'oauth',
    state: 'account', adoptable: false, mine: false, configured: false, authorised: true, renews: null,
    status: 'in your chats only' });
  return rows;
}
let TG_POLLS = 0;

// ---- the door's self-host wizard (/provision/*, /setup-steps) ---------------
// The real routes live in wizard/panel/provision-routes.mjs and setup-steps.mjs
// and drive a real Hetzner account; the harness stubs Hetzner out of existence
// (tests never touch provisioning: harness/lib/live-guard.sh). Same idiom as
// the Google connect flow above: sticky state that walks on a clock, reset by
// /state/<world>, so a driven test or a docs shot can photograph every screen
// of the wizard without a server ever being made.
//
// Two ways in. Drive the page (check the token, Build it) and the run walks
// starting -> provisioning -> booting -> ready across status polls with
// append-only steps, the way the real run reads. Or ask for a screen directly
// with `?provision=booting|ready|failed` on the door URL (read from the referer
// like `?state=`): the page's own "re-enter the flow" read then lands on that
// screen, which is how the docs photograph the build and finish screens.
// `?setup=done` flips the finish checklist's two chips to Done.
const PROV_FIXTURE = { slug: 'mel', alias: 'mel-box', ip: '203.0.113.9', server_id: 42 };
let PROV = { phase: 'idle', at: 0, failReads: 0, name: '', location: '', server_type: '' };
function provReset() { PROV = { phase: 'idle', at: 0, failReads: 0, name: '', location: '', server_type: '' }; }
// refusal strings mirror wizard/panel/provision-routes.mjs verbatim
export function provisionProviders() { return publicProviders(); }
export function provisionValidate(body) {
  const token = String((body && body.token) || '');
  if (!token || token.includes('bad')) return { status: 401, body: { ok: false, reason: 'unauthorized' } };
  const provider = String((body && body.provider) || 'hetzner');
  if (!publicProviders().some((p) => p.id === provider)) return { status: 400, body: { error: 'unknown provider' } };
  return { status: 200, body: provisionCatalogue(provider) };
}
export function provisionStart(body) {
  const slug = String((body && body.name) || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/.test(slug)) return { status: 400, body: { error: 'name must be 2-32 lowercase letters, digits or hyphens' } };
  if (!String((body && body.token) || '')) return { status: 400, body: { error: 'a Hetzner API token is required' } };
  if (PROV.phase === 'provisioning' || PROV.phase === 'booting') return { status: 409, body: { error: 'a build is already running', alias: `${PROV.name}-box` } };
  PROV = { phase: 'starting', at: 0, failReads: 0, name: slug, location: String(body.location || ''), server_type: String(body.server_type || '') };
  return { status: 200, body: { ok: true, alias: `${slug}-box` } };
}
const provView = (phase, steps, extra = {}) => ({
  slug: PROV.name || PROV_FIXTURE.slug, alias: `${PROV.name || PROV_FIXTURE.slug}-box`,
  phase, steps, ip: phase === 'starting' || phase === 'provisioning' ? null : PROV_FIXTURE.ip,
  error: null, server_id: phase === 'starting' ? null : PROV_FIXTURE.server_id, ...extra,
});
export function provisionStatus(override) {
  if (override === 'booting') return provView('booting', BUILD_STEPS.slice(0, 4));
  if (override === 'ready') return provView('ready', BUILD_STEPS);
  if (override === 'failed') {
    // first read: the page attaches to a run in flight; every read after: the
    // boot never answered, which is the one failure a person can act on
    PROV.failReads += 1;
    if (PROV.failReads === 1) return provView('booting', BUILD_STEPS.slice(0, 4));
    return provView('failed', BUILD_STEPS.slice(0, 4), { error: 'the server was created but its workspace never answered; Retry checks again, or Start over rebuilds it' });
  }
  if (PROV.phase === 'idle') return { phase: 'idle' };
  if (PROV.phase === 'ready') return provView('ready', BUILD_STEPS);
  PROV.at += 1;
  if (PROV.at <= 3) { PROV.phase = 'provisioning'; return provView('provisioning', BUILD_STEPS.slice(0, PROV.at)); }
  if (PROV.at <= 5) { PROV.phase = 'booting'; return provView('booting', BUILD_STEPS.slice(0, 4)); }
  PROV.phase = 'ready';
  return provView('ready', BUILD_STEPS);
}
export function provisionDestroy() {
  const had = PROV.phase !== 'idle';
  provReset();
  return { status: 200, body: { ok: true, destroyed: had ? { server: PROV_FIXTURE.server_id } : {} } };
}
export function setupSteps(done) {
  return {
    reachable: true,
    github: done ? { connected: true, repo: 'github.com/mel-harper/mel-brain' } : { connected: false, repo: '' },
    claude: { signedIn: !!done },
  };
}

// Sticky flow state, reset when a test asks for a world (2026-08-12).
// Five module-level variables walk their flows on a clock, and NOTHING put them
// back: once one test drove the rock's GitHub connect to `done`, ORG_GH_ARMED
// stayed true for the life of the harness process, so `org-backup-status`
// answered driftwood-surf's repo in EVERY later test, including ones asking
// for the `rich` world. That surfaced as a red assertion about repo names in a
// test that had not changed and was not wrong. A per-test world has to be a
// fresh one, so `/state/<world>` calls this; it is the only route any test uses
// to pick a world, so every test gets the reset without asking.
export function resetFlows() {
  BUILD_AT = -1;
  ORG_GH_AT = 0;
  ORG_GH_ARMED = false;
  TG_STATE = { ok: true, token: false, chat: false, username: null };
  TG_POLLS = 0;
  gwReset();
  provReset();
}

const SSH_FAIL = [
  'ssh: connect to host box port 22: Connection timed out',
  'Connection to box closed.',
];

// `?signedout=1` on the PAGE url flips the mineral's own Claude sign-in to
// pending, which is the state the cadence gate exists for. Same idiom as
// `?world=org` on the topology verb: read from the referer, so a shot or a QA
// run can ask for it without a fourth harness state.
export function runVerb(surface, verb, args, state, opts) {
  const signedOut = !!(opts && opts.signedOut);
  const face = opts && opts.face;
  // the local face: the folder's own console state, and the honest refusal
  // for anything that needs a server (the real server answers 400 unknown
  // verb; the page never asks, because those surfaces are hidden)
  if (face === 'local') {
    if (verb === 'member-console-state') {
      return ok(['CONSOLE_STATE ' + JSON.stringify({
        ownership: { owner: 'member', owner_slug: '', managed_by: 'you', tier: 'pebble', machinery_by: 'crads-ai', hosting: 'local' },
        org: { name: '', display: '', admin_email: '' }, anchored: false, anchor: '', name: 'Sam',
        backup: state === 'empty' ? { connected: false, last: '' } : { connected: true, repo: 'github.com/sam/sam-brain', last: iso(2 * H) },
        custody: [], waiting: { transfer_invitation: null, ownership_grant: null, asks: [] }, lineage: null, local: true, path: LOCAL_PATH, generated: iso(0),
      })]);
    }
    if (verb === 'open-folder') return ok(['sam']);
    if (verb === 'whoami') return ok(['sam']);
    if (/^(cadence-write|skill-run|skill-remove|telegram-|mcp-|secrets-|devices-|support-|layout-write|box-refresh)/.test(verb)) {
      return { code: 1, lines: ['harness: ' + verb + ' is not a local verb (the real server answers 400 unknown verb)'] };
    }
  }
  if (state === 'error') {
    // every verb fails the way a dead box fails: ssh timeout + non-zero exit
    return { code: 255, lines: SSH_FAIL.map((l) => l.replace('box', surface === 'member' ? MEMBER_HOST : ROCK_HOST)) };
  }

  const A = args || {};
  switch (verb) {
    // ---- shared -----------------------------------------------------------
    case 'whoami':
      return ok(surface === 'member'
        ? ['login=member user=member']
        : ['▸ connecting…', 'login=aios-op user=op']);
    case 'brain-list': {
      if (state === 'empty') return ok(['▸ listing pages…']);
      const pages = surface === 'member' ? MEMBER_PAGES : ORG_PAGES;
      return ok(['▸ listing pages…', ...Object.keys(pages).sort()]);
    }
    case 'brain-read': {
      const pages = surface === 'member' ? MEMBER_PAGES : ORG_PAGES;
      const body = pages[String(A.page || '')];
      if (state === 'empty' || body == null || body === '__FIXTURE_PNG__') return { code: 1, lines: [`no such page: ${A.page}`] };
      return ok(body.split('\n'));
    }
    // images answer on their own verb, marker + one base64 line, like the box
    case 'brain-image': {
      const pages = surface === 'member' ? MEMBER_PAGES : ORG_PAGES;
      if (state === 'empty' || pages[String(A.page || '')] !== '__FIXTURE_PNG__') {
        return { code: 1, lines: [`ERROR: no such image: ${A.page}`] };
      }
      // a real 8x8 png, so the reader decodes and shows an actual image
      const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8L8HwnwEPYMInOWQUAADAxQIBHmm4mgAAAABJRU5ErkJggg==';
      return ok([`__IMAGE__ png ${Math.round(PNG_B64.length * 3 / 4)}`, PNG_B64]);
    }
    case 'box-refresh':
      return ok(['▸ scheduling the restart…', 'OK: restart scheduled']);

    // ---- panel ------------------------------------------------------------
    // the real shape engine/skills/onboard.md writes (phase · current_layer ·
    // the 8-layer coverage map), so the Overview's Onboarding card and its
    // progress bar are exercised here rather than only on a live rock
    case 'onboard-state':
      return ok([JSON.stringify(onboardState(state))]);
    // the public brain, rock side (S9): the reader's per-page control + pushes
    case 'brain-public-list':
      return ok(['PUBLIC_BRAIN ' + JSON.stringify({ pages: [
        { page: 'index.md', title: 'Driftwood Surf School', public: false, guarded: false },
        { page: 'notes/vision.md', title: 'Vision', public: true, guarded: false },
        { page: 'people/ben-whitfield.md', title: 'Ben Whitfield', public: false, guarded: false },
      ], public: 1 })]);
    case 'brain-public-set':
      return ok([`OK: ${A.page || '?'} is now ${A.public ? 'PUBLIC to tied pebbles (after push)' : 'private'}`, 'OK: 1 public page published']);
    case 'brain-public-toggle':
      return ok([A.on ? 'OK: the public brain is ON — tied pebbles can read the marked pages' : 'OK: the public brain is OFF — reads stop now']);
    // the rock strength card's backup truth (S4): wired + pushed in the rich
    // world, wired-but-never-pushed in the empty one. ORG_REG rides the same
    // verb since 2026-08-17 (the ladder's rung 1): registered in both worlds,
    // because broker-register self-heals it on the first admin poll.
    case 'org-backup-status':
      if (ORG_GH_ARMED && process.env.AIOS_FX_BACKUP_FAILS) return ok(['ORG_BACKUP {"connected":false,"repo":"","last":""}', 'ORG_REG {"registered":true}']);
      if (ORG_GH_ARMED) return ok(['ORG_BACKUP {"connected":true,"repo":"github.com/driftwood-surf/driftwood-brain","last":"2026-08-10T01:20:00Z"}', 'ORG_REG {"registered":true}']);
      return state === 'empty'
        ? ok(['ORG_BACKUP {"connected":false,"repo":"","last":""}', 'ORG_REG {"registered":true}'])
        : ok(['ORG_BACKUP {"connected":true,"repo":"github.com/driftwood-surf/driftwood-brain","last":"2026-08-09T03:50:12Z"}', 'ORG_REG {"registered":true}']);
    // Can this rock build a pebble? The EMPTY world is a rock born through the
    // door: no GitHub connected yet, which is the state the Fleet page has to
    // explain before someone tries and fails (2026-08-10, test-org-4).
    case 'factory-status':
      // AIOS_FX_NO_GH: a FULLY ONBOARDED rock with no GitHub connected. This is
      // the state Sam was looking at on 2026-08-14 while the Overview said
      // "8 of 8 · pebbles unlocked" and the Pebbles page refused. The healthy
      // world is armed and the empty world is un-onboarded, so until this knob
      // existed nothing exercised the one combination that could lie.
      if (process.env.AIOS_FX_NO_GH) {
        return ok([JSON.stringify({ armed: false, checks: [
          { id: 'github', ok: false, title: 'GitHub account', detail: 'No GitHub account is connected, so the private repositories a new mineral needs cannot be created.', fix: 'press Connect GitHub on this page' },
          { id: 'server', ok: true, title: 'Server provider', detail: 'This rock can create machines.', fix: '' },
          { id: 'address', ok: true, title: 'Secure address', detail: 'New minerals get an address under example.com.', fix: '' },
          { id: 'image', ok: true, title: 'Mineral software', detail: 'New minerals run crads-pebble:v2.', fix: '' },
          { id: 'provisioning', ok: true, title: 'Provisioning', detail: 'Present on this box.', fix: '' },
        ] })]);
      }
      // AIOS_FX_NO_METAL: GitHub connected, hosting not staged. This is
      // test-org-4 on 2026-08-10, and the state whose copy was wrong.
      if (process.env.AIOS_FX_NO_METAL) {
        return ok([JSON.stringify({ armed: false, checks: [
          { id: 'github', ok: true, title: 'GitHub account', detail: 'New minerals get their private repositories under driftwood-surf.', fix: '' },
          { id: 'server', ok: false, title: 'Server provider', detail: 'No server-provider token, so this rock cannot create the machine a mineral runs on.', fix: 'ask whoever set up this rock to stage its provisioning tokens' },
          { id: 'address', ok: false, title: 'Secure address', detail: 'No secure-address credentials, so a new mineral cannot be reached.', fix: 'ask whoever set up this rock to stage its provisioning tokens' },
          { id: 'image', ok: true, title: 'Mineral software', detail: 'New minerals run crads-pebble:v2.', fix: '' },
          { id: 'provisioning', ok: true, title: 'Provisioning', detail: 'Present on this box.', fix: '' },
        ] })]);
      }
      return ok([(state === 'empty' && !ORG_GH_ARMED)
        ? JSON.stringify({
          armed: false,
          checks: [
            { id: 'github', ok: false, title: 'GitHub account', detail: 'No GitHub account is connected, so the private repositories a new mineral needs cannot be created.', fix: 'open the Terminal on this rock and run  connect-github' },
            { id: 'server', ok: true, title: 'Server provider', detail: 'This rock can create machines.', fix: '' },
            { id: 'address', ok: true, title: 'Secure address', detail: 'New minerals get an address under example.com.', fix: '' },
            { id: 'image', ok: true, title: 'Mineral software', detail: 'New minerals run crads-pebble:v2.', fix: '' },
            { id: 'provisioning', ok: true, title: 'Provisioning', detail: 'Present on this box.', fix: '' },
          ],
        })
        : JSON.stringify({ armed: true, checks: [] })]);
    case 'stall-board':
      return ok(stallBoardLines(state));
    case 'member-list':
      return ok(memberListLines(state));
    case 'people-list':
      return ok(peopleListLines(state));
    case 'skill-list':
      return ok(skillListLines(state));
    case 'governance-read':
      return ok(governanceLines(state));
    case 'governance-write':
      return ok(['▸ validating the policy…', 'render OK', 'committed + pushed']);
    case 'invite-pending-list':
      return ok(invitePendingLines(state));
    case 'pending-devices':
      return ok(['▸ reading staged devices…', JSON.stringify(pendingDevices(state), null, 1)]);
    case 'join-requests':
      return ok(['▸ reading join requests…', JSON.stringify(joinRequests(state), null, 1)]);
    case 'rock-state':
      return ok(['▸ reading tie state…', 'ROCK_STATE ' + JSON.stringify(rockState(state))]);
    // The org console state. `pebbleNames` is what each pebble calls ITSELF,
    // fetched live from the directory on the same round (docs/naming.md): the
    // registry row only ever holds the name the ADMIN typed at stamp time, so
    // this is the field that lets the Pebbles page follow a member's rename.
    // Mel has renamed her mineral to Fern; Tom has not renamed his, which is
    // the case where the row must NOT print the same name twice.
    case 'console-state':
      return ok(['▸ reading the console state…', 'CONSOLE_STATE ' + JSON.stringify({
        org: ORG, display: ORG_DISPLAY, minerals: [], requests: [], handover: [],
        rockRequests: [], rockTies: [],
        pebbleNames: state === 'empty' ? [] : [
          { host: 'mel.driftwood-surf.example.com', label: 'Fern' },
          { host: 'tom.driftwood-surf.example.com', label: 'Tom Okafor' },
        ],
        value: null, platform: null, generated: iso(0),
      })]);
    // The member seat's one data source (docs audit A5, 2026-08-24: unstubbed,
    // so the published shot rendered every card "Checking..." and was pulled).
    // Mirrors panel-server's member-console-state emission for the mel-box
    // world: anchored to Driftwood, GitHub-backed, nothing waiting.
    case 'member-console-state':
      return ok(['▸ reading this mineral…', 'CONSOLE_STATE ' + JSON.stringify({
        ownership: { owner: 'member', owner_slug: 'mel', managed_by: 'org', tier: 'pebble', machinery_by: 'crads-ai' },
        org: { name: ORG, display: ORG_DISPLAY, admin_email: 'maya@driftwood-surf.example.com' },
        anchored: state !== 'empty', anchor: state !== 'empty' ? ORG : '',
        name: 'Aster', backup: state === 'empty' ? { connected: false, last: '' } : { connected: true, last: iso(9 * H) },
        ties: state === 'empty' ? [] : [{ slug: ORG, tie: 'anchored' }, { slug: 'harbour-guild', tie: 'joined' }],
        custody: state === 'empty' ? [] : [
          { at: iso(2 * D), kind: 'device-added', line: 'A computer was let in after the safety code was confirmed' },
          { at: iso(21 * D), kind: 'enrol-key-removed', line: 'The Crads-AI setup key was removed at handover' },
          { at: iso(21 * D), kind: 'claimed', line: 'Claimed by mel@driftwoodsurf.school' },
        ],
        promotion: null,
        waiting: { transfer_invitation: null, ownership_grant: null, asks: [] },
        lineage: [], generated: iso(0),
      })]);
    case 'rock-answer':
      return ok(['▸ answering…', '{"ok":true}', 'OK: tie ask ' + String(A.id || '').slice(0, 8) + '… ' + String(A.decision) + 'ed.']);
    case 'rock-tie-end':
      return ok(['▸ ending the tie…', '{"ok":true}', 'OK: tie ended, and they will see why.']);
    case 'device-activity':
      return ok(['▸ reading device activity…', JSON.stringify(deviceActivity(state), null, 1)]);
    // The empty world is a rock born through the door with no GitHub connected,
    // so its first New Pebble refuses. Shipped as a fixture because this exact
    // screen is what Sam saw twice on 2026-08-10 and the app has to explain it,
    // including the OLD raw guard a pre-2026-08-10 brain still prints.
    case 'invite-member':
      if (state === 'empty') {
        return { code: 1, lines: [
          '▸ invite-member @ driftwood-rock',
          'This rock has no GitHub account connected.',
          '',
          'To connect one, once: open this rock in the Terminal tab and run',
          '',
          '    connect-github',
          '',
          'then press Retry. Nothing has been created and no member has been changed.',
          '(technical: ORG_GH_OWNER + ORG_GH_TOKEN unresolved.)',
        ] };
      }
      return ok([
        '▸ preparing the invite…',
        'Creating Hetzner server jane01 (cx22, hel1)…',
        'booted; waiting for first start…',
        'cloudflare access wired',
        'registered jane01',
        `invite link: https://crads-ai.com/join${joinFragment().replace('mel', 'jane01')}`,
        `https://crads-ai.com/join#v1.${ORG}.jane01.${joinFragment().split('.').slice(3).join('.')}`,
      ]);
    case 'invite-reissue':
      return ok(['▸ minting a fresh link…', `https://crads-ai.com/join#v1.${ORG}.${String(A.slug || 'member')}.${joinFragment().split('.').slice(3).join('.')}`]);
    case 'approve-device':
      return ok(['▸ verifying the fingerprint…', 'fingerprint matches', `approved ${A.slug || 'device'}`]);
    case 'join-approve':
      return ok(['▸ approving…', 'assistant is being built', 'invite delivered to their app']);
    case 'join-decline':
      return ok(['▸ declining politely…', 'done']);
    case 'member-set-status':
      return ok([`status → ${A.status || '?'} for ${A.slug || '?'}`]);
    case 'deprovision-member':
      return ok(['▸ tearing down…', 'VM deleted', 'tunnel + DNS removed', 'registry row → left']);
    case 'people-add':
      return ok(['▸ adding…', 'key installed', 'committed + pushed']);
    case 'people-revoke':
      return ok(['▸ revoking…', 'keys removed', 'committed + pushed']);

    // ---- member -----------------------------------------------------------
    case 'dashboard-data':
      return ok(dashboardDataLines(state, signedOut, surface));
    case 'pages-list':
      return ok(pagesListLines(state));
    case 'page-read':
      if (String(A.page) === 'wins.html' && state !== 'empty') return ok(WINS_PAGE_HTML.split('\n'));
      return { code: 1, lines: ['no such page'] };
    case 'cadence-list':
      return ok(cadenceListLines(state));
    case 'cadence-write':
      return ok(['saved']);
    case 'skill-remove': {
      const meta = SKILL_META[args.id] || {};
      if (meta.source === 'org') return ok([`OK: /${args.id} removed. Your rock still offers it, so you can add it again any time.`]);
      if (meta.source === 'member') return ok([`OK: /${args.id} removed. That was the only copy.`]);
      return { code: 1, lines: [`ERROR: /${args.id} is a built-in skill and cannot be removed. Switch it off in Cadence instead.`] };
    }
    case 'skill-read': {
      const sk = SKILLS.find((x) => x.id === args.id);
      if (!sk) return { code: 1, lines: [`ERROR: /${args.id} is not installed on this mineral.`] };
      const meta = SKILL_META[args.id] || {};
      const b64 = (t) => Buffer.from(t, 'utf8').toString('base64');
      const fm = meta.source === 'org'
        ? `---\norigin-rock: "${meta.rock}"\norigin-version: ${sk.version}\ninstalled: 2026-08-01\nnote: "Yours to adapt. Updates arrive as offers from your rock and never overwrite without your OK."\n---\n`
        : '';
      const md = fm + `# ${meta.title || sk.id}\n\n${sk.description}\n\n## What it does\n\n1. Reads the last day of your brain.\n2. Writes one page, in your words.\n3. Tells you on Telegram when it is done.\n\n## Needs\n\n- a signed-in mineral\n- \`/${sk.id}\` switched on\n`;
      const out = ['__SKILL__ ' + b64(md)];
      if (meta.source === 'org') {
        out.push('__META__ ' + b64(`version: ${sk.version}\ntitle: "${meta.title}"\n`));
        out.push('__ORIGIN__ ' + b64(JSON.stringify({ rock: meta.rock, version: parseInt(sk.version, 10) || 0, installed: '2026-08-01' })));
      }
      return ok(out);
    }
    case 'secrets-discover':
      return ok([JSON.stringify({ found: secretsDiscover(state) }, null, 1)]);
    case 'sharing-list':
      return ok(sharingListLines(state));
    case 'sharing-write':
      return ok(['saved']);
    case 'support-status':
      return ok([JSON.stringify(supportStatus(state), null, 1)]);
    case 'support-grant':
      return ok(['support access granted for 24h (logged)']);
    case 'support-revoke':
      return ok(['support access revoked (logged)']);
    case 'secrets-list':
      return ok([JSON.stringify(secretsList(state), null, 1)]);
    case 'secrets-put':
      return ok(['OK: saved. Your box can use this while you are away, which means Crads AI could read it with server access.']);
    case 'secrets-remove':
      return ok(['OK: deleted.']);
    case 'devices-list':
      return ok([JSON.stringify(devicesList(state), null, 1)]);
    case 'devices-revoke':
      return ok(['OK: that computer can no longer open this box.']);
    case 'devices-add':
      return ok(['OK: added.']);
    case 'devices-rename':
      return ok(['OK: renamed.']);
    case 'devices-stamp':
      return ok(['OK: seen.']);
    case 'layout-write':
      return ok(['saved']);

    // Telegram linking, stateful so the whole three-step flow is drivable here:
    // not connected -> token saved -> waiting for a message -> linked. TG_STATE
    // lives on the module because the harness process IS the fake box.
    // the rock Overview's Health + Skills cards read these two (member.html
    // loadOrgOverviewExtras); the real box prints a build line and a SKILLS
    // JSON line, so the fixture does too
    case 'box-version':
      return ok(['build 806 (sha-c18917c)']);
    // The prefix is SKILLS_STATE, not SKILLS (fixed 2026-08-10). engine/appshell/
    // skills-list.mjs has always emitted "SKILLS_STATE {json}" and every reader
    // parses /SKILLS_STATE (.*)/, so this fixture matched nothing: the Community
    // catalogue card rendered permanently empty in the harness and in every shot,
    // which is why panel-publish showed "No publishable skills on this box yet"
    // directly under three skills. It also meant the 2026-08-09 community-catalogue
    // work was never once driven in the UI. Full state too, so category + source
    // (the fields the catalogue actually filters and files on) are real here.
    case 'skills-list':
      if (state === 'empty') return ok(['SKILLS_STATE {"skills":[],"cadence":{},"runs":{}}']);
      return ok(['SKILLS_STATE ' + JSON.stringify(allSkillsState())]);
    case 'telegram-status':
      return ok([JSON.stringify(TG_STATE)]);
    case 'telegram-verify':
      TG_STATE = { ok: true, token: true, chat: false, username: 'aster_bot' };
      return ok([JSON.stringify({ ok: true, username: 'aster_bot' })]);
    case 'telegram-link':
      // first poll finds nothing, the next one links: exactly what a member sees
      if (!TG_STATE.token) return ok([JSON.stringify({ ok: false, error: 'No bot token on this box yet.' })]);
      if (!TG_POLLS++) return ok([JSON.stringify({ ok: true, linked: false })]);
      TG_STATE = { ...TG_STATE, chat: true };
      return ok([JSON.stringify({ ok: true, linked: true, chat_id: '-100987', started: true })]);
    // MCP connections: stateful, so the real flows are drivable end to end.
    // contract mirrors engine/comms/mcp-connect.mjs's CONTRACT (currently 2):
    // omitting it made every fixture box read as "too old" against the page's
    // own MCP_CONTRACT_NEEDED guard, which is a real box field, not page fiction.
    case 'mcp-status':
      return ok([JSON.stringify({ ok: true, contract: MCP_CONTRACT, services: mcpRows() })]);
    case 'mcp-add':
      MCP_ON[args.key] = { authorised: false, auth: 'oauth', renews: null };
      return ok([JSON.stringify({ ok: true, contract: MCP_CONTRACT, key: args.key, action: 'add', services: mcpRows() })]);
    case 'mcp-add-custom': {
      const def = JSON.parse(Buffer.from(args.def_b64, 'base64').toString('utf8'));
      MCP_ON[def.name] = def.token_b64 ? { authorised: true, auth: 'token', renews: true } : { authorised: false, auth: 'oauth', renews: null };
      return ok([JSON.stringify({ ok: true, contract: MCP_CONTRACT, key: def.name, action: 'add', auth: def.token_b64 ? 'token' : 'oauth', services: mcpRows() })]);
    }
    case 'mcp-remove': {
      delete MCP_ON[args.key];
      // a Google row: the primary goes back to the off offer, a further account vanishes
      if (GW[args.key]) { if (args.key === 'google') GW.google = gwFresh(); else delete GW[args.key]; }
      // R8: the verb's own notice, printed verbatim by the page
      const lbl = (MCP_FEATURED[args.key] || {}).label || args.key;
      return ok([JSON.stringify({ ok: true, contract: MCP_CONTRACT, key: args.key, action: 'remove',
        notice: `${lbl} is disconnected and its credential is gone from this box. The permission you granted at ${lbl} is yours to revoke there.`,
        services: mcpRows() })]);
    }
    // Google's two box-side verbs (contract 2). The PAGE never calls either —
    // the app's /google-connect/* routes do — but the fixture box carries them
    // so route work can be driven here the day it lands, same as everything
    // else. (The mcp-login-* trio that used to sit here was deleted 2026-08-17:
    // that verb family was removed from the box on 2026-08-09, and the file it
    // claimed to drive, engine/comms/mcp-login.mjs, never existed in this tree.)
    case 'mcp-add-google': {
      const p = JSON.parse(Buffer.from(String(args.payload_b64 || ''), 'base64').toString('utf8'));
      const key = gwKeyOf(p.key);
      if (!key) return ok([JSON.stringify({ ok: false, error: GW_BAD_KEY })]);
      const a = gwAcct(key);
      a.added = true; if (p.email) a.email = String(p.email);
      return ok([JSON.stringify({ ok: true, contract: MCP_CONTRACT, key, action: 'add-google', services: mcpRows() })]);
    }
    case 'mcp-token-set-google': {
      const p = JSON.parse(Buffer.from(String(args.payload_b64 || ''), 'base64').toString('utf8'));
      const key = gwKeyOf(p.key);
      if (!key) return ok([JSON.stringify({ ok: false, error: GW_BAD_KEY })]);
      const a = gwAcct(key);
      a.added = true; a.on = true; a.expired = false; if (p.email) a.email = String(p.email);
      return ok([JSON.stringify({ ok: true, name: key, email: a.email || 'mel@gmail.com', keyed_at: Date.now() })]);
    }
    case 'mcp-adopt':
      delete MCP_CHAT[args.key];
      MCP_ON[args.key] = { authorised: true, auth: 'oauth', renews: true };
      return ok([JSON.stringify({ ok: true, contract: MCP_CONTRACT, key: args.key, action: 'adopt', services: mcpRows() })]);

    case 'telegram-forget':
      TG_STATE = { ok: true, token: false, chat: false, username: null };
      TG_POLLS = 0;
      return ok([JSON.stringify({ ok: true })]);

    // R18 (verify pass 2026-08-23): the box's /state/open-folder name; the page
    // falls back to the word "state" when the verb is missing (old image).
    case 'open-folder':
      return ok([surface === 'member' ? 'mels-pebble' : 'driftwood-rock']);
    default:
      return { code: 1, lines: [`harness: no fixture for verb "${verb}"`] };
  }
}

// ---- rock ties (rulings 2026-08-05 + 2026-08-09) -----------------------------
// The board a member browses, the ties they hold, and the org card's state.
// Rich state carries a join ask + an anchor ask + one tie of each kind + an
// org-owned row + a removal notice, so every rendered shape is visible.
export function rocksBoard(state) {
  if (state === 'empty') return { rocks: [] };
  return { rocks: [
    { org: 'driftwood-surf', org_display: 'Driftwood Surf School', blurb: 'Coaching for founders, weekly rooms, shared playbooks' },
    { org: 'harbour-guild', org_display: 'Harbour Guild', blurb: 'Sydney makers: tools, retreats and a shared library' },
    { org: 'quiet-current', org_display: 'Quiet Current', blurb: 'Mindfulness-first operators' },
  ] };
}
export function rockMine(state) {
  if (state === 'empty') return { signedIn: false };
  return {
    signedIn: true,
    // `slug` names the mineral the tie belongs to, and the page keeps only the
    // PICKED mineral's rows (finding 180). rockPickedSlug() reads targets[].org,
    // which this harness serves as ORG for the member host, so the rows carry
    // ORG: with 'mel' here every tie was hidden and the Organisations shots
    // never showed an anchored row (iteration 2, 2026-08-23).
    // Mel is ANCHORED to Driftwood (her rock built her box) and JOINED to
    // Harbour Guild. These two were inverted until audit round three
    // (2026-08-25): the Organisations shot said the opposite of the door, the
    // seat and the promote card, three different anchors across one world.
    mine: [
      { org: 'driftwood-surf', tie: 'anchored', slug: ORG, status: 'active' },
      { org: 'harbour-guild', tie: 'joined', slug: ORG, status: 'active' },
      // Tide Collective offers skills on the Skills page (the multi-inbox
      // case), so the tie that delivers its catalogue has to exist here too:
      // an offer from a rock the Organisations page has never heard of
      // photographed as a contradiction (audit round three).
      { org: 'tide-collective', tie: 'joined', slug: ORG, status: 'active' },
    ],
    notices: [{ org: 'old-guild', org_display: 'The Old Guild', tie: 'joined', reason: 'Programme wound down at the end of July', at: Date.now() - 5 * 86400e3 }],
  };
}
export function rockState(state) {
  if (state === 'empty') return { requests: [], ties: [] };
  return {
    requests: [
      { id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', tie: 'joined', e: 'e'.repeat(64), slug: 'bronte', note: 'Met you at the Bondi room, keen to plug in', at: Date.now() - 3600e3 },
      { id: 'b2c3d4e5f60718293a4b5c6d7e8f90a1', tie: 'anchored', e: 'c'.repeat(64), slug: 'wren', note: 'Want you to host me', at: Date.now() - 1800e3 },
    ],
    ties: [
      { e: 'f'.repeat(64), tie: 'joined', slug: 'rosief', box: 'rosief.crads-ai.com', status: 'active', updated: Date.now() - 86400e3 },
      { e: 'd'.repeat(64), tie: 'anchored', slug: 'kai03', box: 'kai03.crads-ai.com', status: 'active', updated: Date.now() - 2 * 86400e3 },
      { e: 'b'.repeat(64), tie: 'anchored', slug: 'lena02', box: 'lena02.crads-ai.com', status: 'active', owner: 'org', updated: Date.now() - 3 * 86400e3 },
    ],
  };
}

// Community catalogues (2026-08-09 audit, R9): what the joined rocks publish.
// driftwood-surf is the JOINED tie in rockMine above; harbour-guild is the
// anchor, whose own publishing renders through the entitled catalog instead.
export function communityCatalogs(state) {
  if (state === 'empty') return { signedIn: false, catalogs: [] };
  return {
    signedIn: true,
    catalogs: [{
      org: 'driftwood-surf', rock: 'Driftwood Surf School', updated: Date.now() - 86400e3,
      items: [
        { id: 'deep-research', kind: 'skill', version: 3, category: 'capture', title: 'Deep research',
          description: 'multi-source research sweeps with a cited summary', has_content: true },
        { id: 'pipeline-pulse', kind: 'skill', version: 1, category: 'briefing', title: 'Pipeline pulse',
          description: 'a morning read of your deals and who has gone quiet', has_content: true },
      ],
    }],
  };
}
