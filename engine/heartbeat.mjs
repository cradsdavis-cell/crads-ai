#!/usr/bin/env node
// heartbeat.mjs <state-dir> — write a METADATA-ONLY heartbeat (D31/D49).
// NEVER content: only liveness, auth, disk, onboarding phase, and skill
// ENGAGEMENT (which skills the member enabled + when each last ran). This is
// the single thing that ever describes a member box to the rock's stall
// board; the rock still never reads a member's notes. Emitted on a cron and
// (once transport lands) shipped up to the rock's heartbeats/<slug>.json.
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { normalizeCadence } from './cron/cadence-lib.mjs';
import { readRuns, tailForHeartbeat, lastOkRunBySkill } from './lib/run-ledger.mjs';
import { readClaudeCredential } from './lib/claude-credential.mjs';
import { readAssistantState } from './lib/assistant-state.mjs';
import { resolveBrainRoot } from './lib/brain-root.mjs';
import { readSkillOrigins, writeStateMd } from './box/state-md.mjs';

const stateDir = path.resolve(process.argv[2] || process.env.STATE_DIR || '/state');
const rdj = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// Where the BRAIN lives, which is not the state dir on a rock. The shared
// resolver (engine/lib/brain-root.mjs) carries the full chain, including the
// member-born leg this file's own copy was missing — on a promoted rock the
// old read returned a /state/brain that does not exist, IS_ORG read false,
// and the heartbeat described a rock as a pebble (reader six of finding 107).
//
// On a pebble the brain root and the state dir collapse to the same
// directory, which is why this was invisible for so long and why the fixtures
// below deliberately keep them apart. A rock's onboarding-state.json and wiki
// both live under the brain root, so reading them from stateDir reported a
// fully onboarded rock as onboarded: false with no activity, forever.
//
// heartbeat is a MEMBER heartbeat and the rock scheduler's allow-list
// (ROCK_JOBS = /^reconcile /) keeps it off a rock's cadence, so this is not on
// the path that broke the dashboard. But one panel verb runs it on any mineral,
// and a metadata file that lies when it does run is not worth keeping.
const brainRoot = resolveBrainRoot(stateDir);
const IS_ORG = existsSync(path.join(brainRoot, 'org-policy.yaml'));
const brainDir = IS_ORG ? brainRoot : stateDir;



// THE SIGN-IN QUESTION, ASKED HONESTLY (2026-08-20 audit).
//
// This was `const authOk = existsSync(<state>/.claude-auth/.credentials.json)`,
// pushed up as `auth_ok`, and read by the rock's stall board as the answer to
// "is this member's Claude sign-in working". It is not that answer and it never
// was. A revoked grant leaves that file exactly where it is, so a box that could
// not reach Claude at all reported auth_ok:true and rendered on the board as
// "active, N skills running". Nothing in this repo has ever parsed the
// credential, so nothing could have caught it.
//
// The field now says what the test does, and the test lives in ONE place
// (engine/lib/claude-credential.mjs) because three files were asking it three
// slightly different ways. What a box can add to "a file exists" is not another
// guess about the grant, it is EVIDENCE: skill_ok_runs below carries when each
// skill last COMPLETED, straight off the kernel's own run ledger. A sign-in that
// stopped working shows up there within a day as work that stops finishing, and
// that is something the box actually observed rather than a check it cannot
// perform. See the module header for why the credential's own stated expiry is
// NOT used: it is routinely days in the past on a perfectly healthy box.
const credential = readClaudeCredential(stateDir);
// On a mineral that thinks with something other than Claude (spec 2026-09-17) a Claude
// credential is rightly absent, and reporting that as "auth not ok" would paint every such
// mineral red. The boolean keeps its old NAMES for readers that predate this, and takes its
// VALUE from the one reader of what this mineral thinks with. ready:null (an endpoint nobody
// has probed) counts as not-ok here: a heartbeat must not vouch for what nobody checked.
const thinks = readAssistantState(stateDir);
const credentialPresent = thinks.harness === 'claude-code' ? credential.present : thinks.ready === true;

// Disk % used on /state.
let diskPct = null;
try { diskPct = parseInt(execFileSync('df', ['-P', stateDir], { encoding: 'utf8' }).trim().split('\n')[1].split(/\s+/)[4]); } catch { /* best-effort */ }

// Member-owned cadence: which skills they turned on. normalizeCadence reads
// both the v1 flat shape and v2 {version:2, jobs:{...}} (spec 2026-08-04),
// so the heartbeat never misreads a migrated file as zero engagement.
const cadence = normalizeCadence(rdj(path.join(stateDir, 'cockpit', 'cadence.json')) || {});
const skillsEnabled = Object.entries(cadence.jobs).filter(([, c]) => c && c.enabled).map(([id]) => id);

// Skill runs: id -> the ISO at which a run was ASKED FOR (metadata only). The
// scheduler writes this before it enqueues and the app's Run button writes it
// optimistically on the click, both so the Skills page reacts at once. It is a
// record of intent, and the pair below is the record of outcome.
const skillRuns = rdj(path.join(stateDir, 'cockpit', 'skill-runs.json')) || {};

// EVERY SKILL'S LAST SUCCESSFUL FINISH (2026-08-20 audit). skill_runs is stamped
// at ENQUEUE time, so a skill that fires daily and never drains looked identical
// to one that works. lastOkRunBySkill reads the run ledger for the only number
// the board needs. See that function for the rotation limit: an id missing here
// means "no evidence of a recent finish", never "never ran".
//
// Timestamps only: the one-line summaries the ledger keeps stay on the box,
// exactly as tailForHeartbeat does with the run ledger itself.
const skillOkRuns = Object.fromEntries(
  Object.entries(lastOkRunBySkill(stateDir)).map(([id, r]) => [id, r.ts]),
);

// Installed skills count (how much the org has given them).
let skillsInstalled = 0;
try { const d = path.join(resolveBrainRoot(stateDir), '.claude', 'skills'); if (existsSync(d)) skillsInstalled = execFileSync('bash', ['-c', `ls -1d ${d}/*/ 2>/dev/null | grep -v '/_' | wc -l`], { encoding: 'utf8' }).trim() | 0; } catch {}

// Last real activity: newest mtime across the member's own wiki pages (a proxy
// for "the box is being used"). Never reads the CONTENT, only the timestamp.
// Three-layer v2: brain STRUCTURE is user-land — the 8-layer template is a
// starting point, not a schema — so this scans whatever .md files exist under
// wiki/ rather than assuming _layers/ survived the member's restructures.
let lastActivity = null;
try {
  const wiki = path.join(brainDir, 'wiki');
  if (existsSync(wiki)) for (const f of execFileSync('bash', ['-c', `find ${wiki} -name '*.md' -not -path '*/.git/*' 2>/dev/null`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)) {
    const m = statSync(f).mtime.toISOString(); if (!lastActivity || m > lastActivity) lastActivity = m;
  }
} catch {}

// Onboarding phase — did they finish building their brain?
const onb = rdj(path.join(brainDir, 'onboarding-state.json'));

// Machinery version (three-layer L1): which engine this box is actually running,
// so the org/Crads can see fleet version spread and know an auto-update landed.
// Part of the box-health FLOOR: it describes the MACHINERY, never the member.
//
// THIS FIELD REPORTED null ON EVERY BOX EVER SHIPPED (found 2026-08-23, chasing
// why Harriet's rock could see an old transfer-accept.sh while the repo had the
// fix). The only source was `git -C /app rev-parse HEAD`, and `.git` is line 1
// of .dockerignore, so /app/.git exists in no image. The catch swallowed it and
// the field stayed null, so "did the update land" was unanswerable from here.
//
// The sha is now baked at build time into /etc/aios-build (Dockerfile.member /
// Dockerfile.rock, passed through docker-bake.hcl from CI). The git probe stays
// as a fallback for a dev box running the engine from a real checkout.
let appCommit = null;
let builtAt = null;
let imageTag = process.env.AIOS_IMAGE_TAG || null;
try {
  const stamp = JSON.parse(readFileSync('/etc/aios-build', 'utf8'));
  if (stamp && typeof stamp.sha === 'string' && stamp.sha && stamp.sha !== 'unknown') appCommit = stamp.sha.slice(0, 7);
  if (stamp && typeof stamp.built_at === 'string' && stamp.built_at) builtAt = stamp.built_at;
  if (!imageTag && stamp && typeof stamp.tag === 'string' && stamp.tag && stamp.tag !== 'unknown') imageTag = stamp.tag;
} catch { /* no stamp: pre-2026-08-23 image, or the engine run from a checkout */ }
if (!appCommit) {
  try { appCommit = execFileSync('git', ['-C', '/app', 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim() || null; } catch { /* image may ship without .git */ }
}

// Sharing (D49 refinement): the member controls granularity from their dashboard.
// BOX HEALTH (liveness + sign-in) is the always-on floor — a condition of
// membership, so the org can help (auth expiry is the #1 failure, D26) and tell
// a broken box from a quiet one. SKILL ENGAGEMENT + ACTIVITY default ON (opt-out;
// Sam ratified 2026-08-25, docs audit round four: the docs briefly said opt-in
// and were corrected to match THIS file, not the other way around)
// and the member can switch each off. The `shared` map tells the rock which
// categories are on, so the stall board reads "withheld" as withheld, not zero.
const sharing = rdj(path.join(stateDir, 'cockpit', 'sharing.json')) || {};
const shareEngagement = sharing.skill_engagement !== false;   // default true (opt-out)
const shareActivity = sharing.activity !== false;             // default true (opt-out)

const now = new Date().toISOString();
// The FULL snapshot — every field, LOCAL ONLY (never pushed). Powers the member's
// "what your org can see" preview, so they can honestly see what a category would
// reveal even while it is withheld.
// Run ledger tail (spec 2026-08-04 § 5): status + timestamps ONLY — the one-line
// summaries stay on the box. Machinery rows (backup, auto-update...) are part of
// the box-health floor; skill rows ride only with skill engagement shared.
const ledgerRuns = readRuns(stateDir);

// Catalog install requests (spec 2026-08-04 § 7.3): the member's own Install
// clicks, riding the heartbeat up so the rock can fulfil them. Not a sharing
// category — asking the org for its own published content IS the disclosure.
const catalogRequests = (() => {
  const a = rdj(path.join(stateDir, 'cockpit', 'catalog-requests.json'));
  return Array.isArray(a) ? a.filter((r) => r && /^[a-z0-9][a-z0-9-]{0,62}$/.test(String(r.id || ''))) : [];
})();

// INSTALL RECEIPTS, ON THE FLOOR (R2, panel iteration 2, 2026-08-23). One row
// per rock-published skill this box holds: {id, rock, version}, read from the
// .origin.json catalog-install writes. It rides regardless of the
// skill-engagement toggle, because it is the other half of the same disclosure
// as catalog_requests: asking a rock for its content and then holding it. The
// rock's per-member "installed" chip is this list and nothing else, so a
// withheld receipt would make the rock guess, and a guess on a consent surface
// is worse than a fact. Never what the skill did, never whether it ran: that
// stays behind skill engagement with skill_runs.
const skillsFromRocks = readSkillOrigins(stateDir);
const full = {
  generated_at: now, claude_credential_present: credentialPresent, auth_ok: credentialPresent,
  assistant_harness: thinks.harness,
  app_commit: appCommit, image_tag: imageTag, built_at: builtAt,
  onboarded: !!(onb && onb.phase === 'done'), disk_pct: diskPct, last_activity: lastActivity,
  skills_installed: skillsInstalled, skills_enabled: skillsEnabled, skill_runs: skillRuns,
  skill_ok_runs: skillOkRuns,
  run_ledger: tailForHeartbeat(ledgerRuns, { shareEngagement: true }),
  catalog_requests: catalogRequests, skills_from_rocks: skillsFromRocks,
};
// The FILTERED heartbeat — floor + only the member-permitted categories. THIS is
// what the transport ships up to the rock.
// `auth_ok` RIDES ON AS A MIRROR, AND NOTHING NEW MAY READ IT. It is the same
// boolean as claude_credential_present, kept under its old over-claiming name
// for one reason: a rock running an engine older than this change reads only
// auth_ok, and dropping it would make a mineral that has never been signed in
// read as fine on that rock instead of merely reading as unproven. Keep the two
// in lockstep; when every rock in the fleet is past this build, delete it.
const hb = { generated_at: now, claude_credential_present: credentialPresent, auth_ok: credentialPresent,
  app_commit: appCommit, image_tag: imageTag, built_at: builtAt, shared: { skill_engagement: shareEngagement, activity: shareActivity },
  run_ledger: tailForHeartbeat(ledgerRuns, { shareEngagement }), catalog_requests: catalogRequests,
  skills_from_rocks: skillsFromRocks };
if (shareActivity) { hb.onboarded = full.onboarded; hb.disk_pct = full.disk_pct; hb.last_activity = full.last_activity; }
// skill_ok_runs rides on the SAME toggle as skill_runs, because it is the same
// disclosure (which skills, and when) with a truthful verb. A member who
// withheld engagement withholds both.
if (shareEngagement) { hb.skills_installed = full.skills_installed; hb.skills_enabled = full.skills_enabled; hb.skill_runs = full.skill_runs; hb.skill_ok_runs = full.skill_ok_runs; }
const dir = path.join(stateDir, 'cockpit');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'heartbeat.json'), JSON.stringify(hb, null, 2) + '\n');            // pushed up
writeFileSync(path.join(dir, 'heartbeat-full.json'), JSON.stringify(full, null, 2) + '\n');     // local preview only, never pushed
// SELF-DESCRIPTION (R24): <brain-root>/STATE.md, the page the assistant reads
// before answering "what is this, whose is it, what can it do". Rewritten every
// run so it is never older than the last heartbeat. Never a reason to fail the
// heartbeat: the receipts above are the rock's view and must ship even if the
// brain root is momentarily unwritable.
let stateMd = null;
try { stateMd = writeStateMd(stateDir, { version: appCommit || '' }); } catch (e) { console.error(`heartbeat: STATE.md not written: ${e.message}`); }
// The log line says what the field says, so an operator reading a cadence log
// cannot come away with the belief the emitter just retired.
console.log(`heartbeat: credential=${credentialPresent ? 'present' : 'absent'}${credential.account ? ` (${credential.account})` : ''}`
  + ` completed-runs=${Object.keys(skillOkRuns).length} disk=${diskPct}% installed=${skillsInstalled}`
  + ` enabled=${skillsEnabled.length} from-rocks=${skillsFromRocks.length} onboarded=${hb.onboarded}`
  + (stateMd ? ` state-md=${stateMd}` : ''));
