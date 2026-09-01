#!/usr/bin/env node
// scheduler.mjs — in-container, NON-ROOT cadence scheduler. Replaces the broken system-cron
// path in box-up.sh (which gated on `command -v cron`, invisible to the non-root box user, and
// needed root to start the daemon anyway — so cadence never actually installed).
//
// This is a tiny cron the box user CAN run: a long-lived Node process that fires enqueue+drain
// jobs on schedule. No root, no crontab install, no system cron daemon. The container is already
// kept always-on by the host systemd unit (Restart=always), so a background scheduler here fires
// on schedule even when the client isn't in the box.
//
//   node scheduler.mjs <state-dir>              # run the scheduler (long-lived; box-up backgrounds it)
//   node scheduler.mjs <state-dir> --plan       # print the resolved schedule and exit
//   node scheduler.mjs <state-dir> --plan-json  # same, structured (the app's Cadence page reads this)
//   node scheduler.mjs <state-dir> --at "HH:MM Wed"   # print which jobs would fire at that time and exit
//
// Cadence v2 (spec 2026-08-04 § 4): ALL member-schedulable jobs live in
// /state/cockpit/cadence.json — the org-pushed skill cadence (D49) AND the four
// former profile-cadence jobs (daily / capture / weekly / inbox), folded in once
// at startup by migrateProfileCadence and member-owned from then on. The schedule
// semantics live in cadence-lib.mjs (pure, unit-tested); this file owns IO + time.
// Machinery jobs stay code-defined below (protected job floor, 2026-07-27).
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCadence, migrateProfileCadence, buildJobsFromCadence, describeSchedule } from './cadence-lib.mjs';
import { appendRun, summarize } from '../lib/run-ledger.mjs';   // run ledger (spec 2026-08-04 §5): machinery outcomes land here
import { releaseBootLockForCadence } from './cadence-lock.mjs';   // a boot lock must not outlive the reason it was taken
import { BRAIN_ROOT_SH, resolveBrainRoot, ensureBrainRootStamped, isOrgBox } from '../lib/brain-root.mjs';

const stateDir = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2]
                              : process.env.STATE_DIR || '/state');
// Engine dir normally resolves relative to this file (…/engine/cron/scheduler.mjs → …/engine).
// AIOS_ENGINE_DIR overrides it so the scheduler can run from OUTSIDE the image tree — e.g. staged
// in /state on a box whose image predates this fix, where /app is not writable by the box user.
const ENGINE_DIR = process.env.AIOS_ENGINE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KDIR = path.join(ENGINE_DIR, 'kernel');
const ENQUEUE = path.join(KDIR, 'enqueue.mjs');
const KERNEL = path.join(KDIR, 'kernel.mjs');
const BACKUP = path.join(ENGINE_DIR, 'backup.mjs');
const BRAIN_PUSH = path.join(ENGINE_DIR, 'brain-push.sh');
const HEARTBEAT = path.join(ENGINE_DIR, 'heartbeat.mjs');
const STATE_MD = path.join(ENGINE_DIR, 'box', 'state-md.mjs');
// Resolve the org brain root through the ONE shared resolver
// (engine/lib/brain-root.mjs) — shell form for the jobs that run through
// bash (the brain can be relocated after this process started), JS form for
// the few places that need the answer in THIS process (a match() deciding
// whether a job can fire at all). Same module, so the plan and the command
// cannot disagree. This file's old copies were readers six-and-seven of
// finding 107: both missed the member-born leg, so on a promoted rock the
// reconcile job and the control-script probes looked under a /state/brain
// that does not exist. (The old JS copy also read /state/deployment.yaml
// with the FIXTURE stateDir's default — a latent test lie the shared
// resolver retires.)
const BR_RESOLVE = BRAIN_ROOT_SH;
const brainRootOf = (sd) => resolveBrainRoot(sd);
const START_COMMS = path.join(ENGINE_DIR, 'start-comms.sh');   // comms supervisor target (keeps the Telegram bridge alive)
const CADENCE_FILE = path.join(stateDir, 'cockpit', 'cadence.json');
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
// Stable per-box jitter (0-29 min) so a fleet's nightly auto-update restarts
// don't hammer the image registry in the same minute. Derived from the state
// path + hostname, so it never changes across restarts.
const jitterMin = (() => {
  const s = stateDir + (process.env.HOSTNAME || '');
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 30;
})();

function loadCadence() {
  // A MISSING profile.yaml means cadence OFF, not a crash. This file says a few
  // lines down that "the scheduler ALWAYS runs", and it did not: readFileSync
  // threw ENOENT and took the process with it.
  //
  // That is not hypothetical, it is why a ROCK has no cadence at all. Checked on
  // the live rock 2026-08-04: no profile.yaml anywhere, no scheduler process, no
  // cadence.log, and `cron` is not even on the rock's PATH so boot-rock's
  // crontab block is dead code too. Which means the reconcile base job added
  // this morning could never have run where the appliers actually live.
  // The base jobs are exactly what such a box needs: they are the ones that do
  // not depend on a profile.
  let profile = '';
  try { profile = readFileSync(path.join(stateDir, 'profile.yaml'), 'utf8'); } catch { profile = ''; }
  // EMPTY is not the same as ABSENT, and only one of them was handled. The
  // `|| [, 'UTC']` fallback fires when the key is missing; a key present with an
  // empty value captured '' and sailed past it, and `new Intl.DateTimeFormat`
  // throws RangeError on an empty timeZone, which kills the scheduler at startup
  // before a single job is built.
  //
  // Not hypothetical: profile.yaml SHIPPED with `timezone: ""` until 2026-08-14.
  // A box in that state gets no cadence at all: no heartbeat (so the stall board
  // reads it as stalled), no backup, no auto-update, no reconcile. Found on a box
  // stamped 2026-08-04 (promo-lab), whose cadence.log was a RangeError stack and
  // nothing else.
  //
  // This comment used to claim "an org stamp fills it from org-policy, so
  // org-stamped boxes were fine". That was WRONG and it hid the real blast radius
  // for ten days. Nothing in the repo ever writes identity.timezone: every hit is
  // a reader. box-up.sh:17 copies config/profile.schema.yaml verbatim, so the
  // schema default IS the box default, and EVERY box was silently on UTC, not
  // just standalone ones. The schema now ships Australia/Sydney. Keep this
  // empty-string fallback anyway: it is the guard for a hand-edited profile.
  const tz = ((profile.match(/^\s*timezone:\s*"?([^"\n]*)"?/m) || [, ''])[1] || '').trim() || 'UTC';
  const cad = profile.split(/\ncadence:/)[1] || '';
  const enabled = /^\s*enabled:\s*true/m.test(cad);
  const cget = (k, d) => {
    const m = cad.match(new RegExp(`^\\s*${k}:\\s*"?([^"\\n]+)"?`, 'm'));
    return m ? m[1].trim() : d;
  };
  const [mh, mm] = cget('morning_brief', '07:00').split(':').map(Number);
  const [eh, em] = cget('evening_review', '18:00').split(':').map(Number);
  // Inbox watcher defaults OFF (0). Left unset it stays off — a */30 watcher shells `claude -p`
  // ~48×/day on the client's OWN subscription and will exhaust a Pro plan. Opt in explicitly.
  const watch = parseInt(cget('inbox_watcher_interval_min', '0'), 10) || 0;
  const wk = cget('weekly_review', 'Sun 17:00').split(/\s+/);
  const wdow = DOW[wk[0]] ?? 0;
  const [wh, wmin] = (wk[1] || '17:00').split(':').map(Number);
  const quiet = cget('quiet_hours', '');   // "22:00-07:00" — suppresses interval-kind cadence jobs
  return { tz, enabled, mh, mm, eh, em, watch, wdow, wh, wmin, quiet };
}

// Current wall-clock parts in the box timezone (no offset math; Intl does the DST-correct work).
function partsInTz(tz, date) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return { hour: parseInt(p.hour, 10) % 24, minute: parseInt(p.minute, 10), dow: DOW[p.weekday], ymd: `${p.year}-${p.month}-${p.day}` };
}

function readCadenceFile() {
  try { return JSON.parse(readFileSync(CADENCE_FILE, 'utf8')); } catch { return {}; }
}

// Cadence v2 fold-in: the four profile jobs become ordinary cadence.json entries,
// seeded once from profile.yaml (existing member entries always win) and marked
// with migrated_profile_cadence so this never runs twice. Best-effort write: if
// /state/cockpit is unwritable we still run from the migrated in-memory copy.
function ensureMigrated(c, ymd) {
  const { changed, cadence } = migrateProfileCadence(readCadenceFile(), c, { anchorYmd: ymd });
  if (changed) {
    try { writeFileSync(CADENCE_FILE, JSON.stringify(cadence, null, 2) + '\n'); }
    catch (e) { console.error(`[${new Date().toISOString()}] cadence fold-in could not persist: ${e.message}`); }
  }
  return cadence;
}

function buildJobs(c) {
  // Machinery only (protected job floor, 2026-07-27): these are Layer 1, never
  // member cadence, shown read-only in the app. Everything member-schedulable
  // comes from cadence.json via buildSkillJobs() below.
  //
  // GUARD WITH A TEST, NOT WITH `|| true` (2026-08-20 audit).
  //
  // Ten of the jobs below used to end their bash line with `|| true`. That was
  // written to mean "this box may legitimately have nothing to do here", and it
  // does not mean that. It means the shell exits 0 whatever happened, and the
  // ledger write in fire() is `status: e ? 'fail' : 'ok'`, so all ten recorded
  // ok unconditionally, on every run, forever.
  //
  // The two it hurt most had gone to the trouble of failing honestly.
  // engine/comms/mcp-refresh.mjs ends `process.exit(failed.length ? 1 : 0)`, and
  // engine/gh-token-refresh.mjs ends
  // `process.exit(r.refused || r.expired || r.storeFailed ? 1 : 0)` under a
  // comment saying in as many words that reporting a broken hour as a good one
  // is how a dead mineral kept reading green. Both exits were thrown away one
  // layer up, here. So a member whose Gmail connection had lapsed, or whose
  // GitHub sign-in could no longer be refreshed, had a clean run ledger, an
  // all-green Machinery card on their own Health page, and nothing at all on
  // their rock's stall board.
  //
  // The shape that tells the truth is the one reconcile and adopt-reconcile
  // below already use: a PRESENCE TEST that exits 0 when the job does not apply
  // to this box, and then the real command, unguarded, so the job's exit status
  // is the command's exit status.
  //
  //     [ -f <the thing the job needs> ] || exit 0; <the real command>
  //
  // Boxes the job does not concern are unchanged: the test fails, the shell
  // exits 0, node never spawns, and no ledger row claims anything either way.
  // All that is new is that a job which DID run and DID fail now says so.
  return [
    // Hourly :07: emit + push up (metadata only). Two commands, so the emitter
    // needs an `|| exit $?` of its own. Without it the job's status is whatever
    // the PUSH did, and a box that could not write its heartbeat at all still
    // reported a good run purely because it had no push script to fail at.
    { name: 'heartbeat', lid: 'heartbeat', cmd: ['bash', ['-c', `node ${HEARTBEAT} ${stateDir} || exit $?; [ -f ${stateDir}/heartbeat-push.sh ] || exit 0; bash ${stateDir}/heartbeat-push.sh ${stateDir}`]], match: (h, m) => m === 7 },
    // D51: pull the org inbox every ~2 min so a pushed member device key (admin-first invite
    // approval) or content installs UNATTENDED — an idle, never-logged-into member box completes
    // its own enrolment. Guarded on org-sync.sh so it is a no-op on a rock box (no inbox to pull).
    { name: 'org-sync', lid: 'org-sync', cmd: ['bash', ['-c', `[ -f ${stateDir}/org-sync.sh ] || exit 0; STATE_DIR=${stateDir} bash ${stateDir}/org-sync.sh`]], match: (h, m) => m % 2 === 0 },
    // Custody watch (Harriet audit point 4, 2026-08-19): the box tells its own
    // member when ownership / anchor / support / grants move. Odd beat — the
    // off-beat of org-sync — so a change pulled on the even minute is
    // reported within ~1 min. Guarded on ownership.json: no record, nothing to
    // watch. Silent when nothing moved; the first run only seeds.

    { name: 'custody-watch', lid: 'custody-watch', cmd: ['bash', ['-c', `[ -f ${stateDir}/ownership.json ] || exit 0; node ${path.join(ENGINE_DIR, 'box', 'custody-watch.mjs')} ${stateDir} >/dev/null`]], match: (h, m) => m % 2 === 1 },
    // seen-drain: the local remnant of enrol-sync (self-host strip, 2026-09-01).
    // The directory legs — registration, the ownership mirror, staged enrolments,
    // web revokes, web grants — died with the central directory; device add is
    // local now (the wizard writes the member authorized_keys over SSH). What
    // survives is the last-seen drain: the host's AuthorizedKeysCommand appends
    // sightings to /state/devices/seen.log and this stamps them onto the roster,
    // so the Devices page keeps a truthful recency column. Purely local, no
    // token guard needed; the drain no-ops when there is no log.
    { name: 'seen-drain (device recency)', lid: 'seen-drain', cmd: ['bash', ['-c', `[ -f ${stateDir}/devices/seen.log ] || exit 0; node ${path.join(ENGINE_DIR, 'devices', 'seen-drain.mjs')} ${stateDir}`]], match: (h, m) => m % 2 === 1 },
    // Keep the MCP CONNECTIONS alive (2026-08-12). Same bug as gh-token-refresh
    // below, one file over, and it survived because nothing ever pointed at it:
    // mcp-refresh.mjs opens by declaring itself "a cadence job" and was in no
    // cadence, in no allow-list, and referenced by no other file in the repo.
    // A sweep for engine scripts with zero inbound references found exactly two,
    // and this was one (QA finding 47).
    //
    // What it costs to leave out: the whole promise of doing OAuth ourselves is
    // that a member signs in ONCE. Access tokens expire in hours, so without a
    // renewer every Gmail, Calendar and Drive connection a member makes dies
    // within a day and only they can revive it. Guarded on the store existing,
    // so a box with no connections never spawns node. Every 30 min, half the
    // default 30-minute refresh window, so a due token is caught before it laps.
    { name: 'mcp-refresh (connections)', lid: 'mcp-refresh', cmd: ['bash', ['-c', `[ -f ${stateDir}/.kernel/mcp-oauth.json ] || exit 0; node ${path.join(ENGINE_DIR, 'comms', 'mcp-refresh.mjs')} ${stateDir} >/dev/null`]], match: (h, m) => m % 30 === 14 },
    // The BYO-Google key watch (2026-08-17; reshaped 2026-08-24 with the
    // Production wizard, docs/design-google-byo-connect.md). A published key
    // has no scheduled death, so this is a live probe now: every ~6h it asks
    // Google's token endpoint whether the refresh token still works, and only
    // a definitive invalid_grant is death — ONE Telegram message + the dead
    // marker mcp-connect's status row reads. The script is its own ledger and
    // its own silence (no key / not due / already told = no-op), so hourly
    // costs nothing; guarded on the store like mcp-refresh above.
    { name: 'google-rekey-ping', lid: 'google-rekey', cmd: ['bash', ['-c', `[ -f ${stateDir}/.kernel/mcp-oauth.json ] || exit 0; node ${path.join(ENGINE_DIR, 'comms', 'google-rekey-ping.mjs')} ${stateDir} >/dev/null`]], match: (h, m) => m === 52 },
    // Keep the GitHub sign-in alive (2026-08-10). OAuth user tokens expire in
    // ~8h, so before this every connected mineral's GitHub died within a day
    // and only a human at a terminal could revive it — the failure that stalled
    // the first live anchor. Hourly, guarded on the refresh store, silent while
    // the token is fresh.
    { name: 'gh-token-refresh', lid: 'gh-refresh', cmd: ['bash', ['-c', `[ -f ${stateDir}/.kernel/gh/device-refresh.json ] || exit 0; GH_CONFIG_DIR=${stateDir}/.kernel/gh node ${path.join(ENGINE_DIR, 'gh-token-refresh.mjs')}`]], match: (h, m) => m === 41 },
    // Registry reconcile every 15 min (live cert 2026-08-04). The appliers that act on the
    // directory's answers — a member leaving, an accepted transfer, an answered permission ask,
    // a framework offer — had NO cadence of any kind. The scheduler ran, but no base job ever
    // ran them, so every one waited for a human to open the console: a member could leave and
    // the registry would still read active. Guarded on the file so it is a silent no-op on a
    // brain stamped before this existed, and on every member box (no control/ dir at all).
    {
      name: 'reconcile (registry appliers)', lid: 'reconcile',
      // FINDING 121 AGAIN, ON THE JOB THAT NEEDED IT MOST (2026-08-14). That fix
      // hard-set GH_CONFIG_DIR for heartbeat-pull and gh-token-refresh and left
      // this one inheriting it. boot-rock exports `$ROCK_DIR/gh` (/state/.rock/gh)
      // into the container, that directory is EMPTY, and the real credential lives
      // in /state/.kernel/gh where Connect GitHub writes it. So every applier in
      // reconcile-all that needs the org's GitHub identity exited on
      // "no org GitHub identity resolves yet" on every scheduled run, and
      // succeeded by hand, because an interactive shell has no GH_CONFIG_DIR and
      // takes the default.
      //
      // Proven on qa-r2-gmail during the first live cert: a box posted its deploy
      // keys at 04:12:00, the 04:19 reconcile reported ok in 2.4 seconds and wired
      // nothing, and running anchor-reconcile with each value in turn reproduced
      // both outcomes exactly. That is the whole reason cert-one and cert-two each
      // needed a manual nudge to finish.
      cmd: ['bash', ['-c', `${BR_RESOLVE}[ -f "$BR/control/reconcile-all.mjs" ] || exit 0; cd "$BR"; set -a; . ${stateDir}/secrets/provisioning.env.local 2>/dev/null || true; set +a; export GH_CONFIG_DIR="${stateDir}/.kernel/gh"; node control/reconcile-all.mjs`]],
      match: (h, m) => m % 15 === 4,   // :04 :19 :34 :49 — off the :07 heartbeat and the even org-sync
    },
    // (The adopt-reconcile job went with the self-host strip, 2026-09-01: the
    // Mountain no longer builds pebbles for a rock, so no rock accrues an
    // adoption debt. The anchor-claim and tie-claim jobs followed in the same
    // strip: both claimed wire bundles staged AT THE CENTRAL DIRECTORY, which
    // is deleted, so a box wires to its rock by local means now and must not
    // poll a dead service every five minutes.)
    // MEMBER HEALTH, WITHOUT WHICH THE FLEET PAGE IS A LIE (finding 101,
    // 2026-08-13). control/heartbeat-pull.mjs pulls each active member's
    // heartbeat-<slug> repo into heartbeats/<slug>.json, and the stall board
    // reads exactly that directory. Its own header has always said "run on a
    // rock cron (every ~30 min is plenty)" and nothing ever ran it: it was in no
    // job list, and the ledger of a live rock showed ZERO runs of it, ever.
    //
    // The consequence was not a missing number, it was a false one. With the
    // directory never created, the stall board's glob matched nothing and every
    // active member rendered AT RISK · "never checked in (no heartbeat yet)",
    // permanently, however healthy. Driven live: a member whose heartbeat was
    // sitting on the rock's own disk read as never having checked in, and one
    // manual run of this script flipped it to the truthful reason within a
    // minute. On a cohort day that page is the owner's whole view of their fleet.
    //
    // Same guards as reconcile above: no control/ dir (older brain, or a member
    // box) is a silent no-op, and the org's GitHub credentials come from the
    // staged provisioning env, which is what resolveOrgGitHub reads.
    //
    // GH_CONFIG_DIR IS SET, NOT INHERITED (finding 121, 2026-08-13). This first
    // shipped as `${GH_CONFIG_DIR:-<state>/.kernel/gh}`, and a `:-` default only
    // fires when the variable is ABSENT. On a rock it is present and wrong:
    // boot-rock.sh exports `$ROCK_DIR/gh` (/state/.rock/gh) into /etc/ai-os/env,
    // the container inherits it, and that directory is EMPTY — while the app's
    // Connect GitHub flow writes the real credential to /state/.kernel/gh. So
    // this job inherited an empty gh config and died on every scheduled run with
    // "ORG_GH_OWNER + ORG_GH_TOKEN unresolved", 100% failure for 15 hours, while
    // succeeding by hand because an interactive shell has no GH_CONFIG_DIR at all
    // and so took the default. Hard-set, exactly as gh-token-refresh above does:
    // that job has always pointed at .kernel/gh unconditionally and has always
    // worked, and being the odd one out is what broke this.
    {
      name: 'heartbeat-pull (member health)', lid: 'heartbeat-pull',
      cmd: ['bash', ['-c', `${BR_RESOLVE}[ -f "$BR/control/heartbeat-pull.mjs" ] || exit 0; cd "$BR"; set -a; . ${stateDir}/secrets/provisioning.env.local 2>/dev/null || true; set +a; export GH_CONFIG_DIR="${stateDir}/.kernel/gh"; node control/heartbeat-pull.mjs`]],
      // Reads "never" on a box with no members to pull for, the same shape
      // org-publish uses below. A member's plan lists every job, so without this
      // a pebble would advertise a puller it can never run — which is finding 86
      // exactly, and adding to it while fixing 101 would be absurd.
      match: (h, m) => {
        try { readFileSync(path.join(brainRootOf(stateDir), 'control', 'heartbeat-pull.mjs')); }
        catch { return false; }
        return m % 30 === 26;   // :26 :56 — off every other machinery minute
      },
    },
    // (The edges-reflect job went with the self-host strip, 2026-09-01: it wrote
    // membership edges to the central directory, which is deleted. Membership
    // lives in the rock's own registry now; the commons model carries the
    // community-facing view.)
    // STATE.md ON A ROCK (R24, panel iteration 2, 2026-08-23). On a pebble the
    // heartbeat writes <brain-root>/STATE.md every run, and the heartbeat is a
    // MEMBER job (ROCK_JOBS keeps it off a rock: a rock reports to nobody). So a
    // rock needs its own writer or its assistant answers "what is this" from a
    // stamp-time template forever. Hourly at :09, after heartbeat-pull's :56 so
    // the member list carries fresh heartbeat ages. Reads "never" on a pebble,
    // same shape as heartbeat-pull, because the pebble's heartbeat already does
    // this and a second writer on the card would be finding 86 in reverse.
    {
      name: 'state-md (what this mineral is)', lid: 'state-md',
      cmd: ['bash', ['-c', `[ -f ${STATE_MD} ] || exit 0; node ${STATE_MD} ${stateDir}`]],
      match: (h, m) => isOrgBox(stateDir) && m === 9,
    },
    // Org brain (spec 2026-07-25): downflow pull hourly — whole-company context stays fresh
    // on the box with zero query-time network hops. No-op unless the box is org-enrolled.
    { name: 'org-pull (downflow)', lid: 'org-pull', cmd: ['bash', ['-c', `[ -d ${stateDir}/org/brain/.git ] || exit 0; git -C ${stateDir}/org/brain pull --rebase -q`]], match: (h, m) => m === 23 },
    // Org brain: nightly extract publish, jittered into the dead window before backup.
    // Runs through the kernel (enqueue+drain) so state-repo commits stay single-writer.
    {
      name: 'org-publish (nightly extracts)', skill: 'org-publish',
      match: (h, m) => {
        try { readFileSync(path.join(stateDir, 'org', 'config.json')); } catch { return false; }
        return h === 2 && m === 20 + jitterMin;
      },
    },
    // (The brain-public-push job went with the self-host strip, 2026-09-01: it
    // POSTed the marked public subset to the central directory, which is
    // deleted. The public: flags stay on the pages; serving them to tied
    // pebbles is the commons model's to rebuild.)
    { name: 'backup', lid: 'backup', cmd: ['node', [BACKUP, stateDir]], match: (h, m) => h === 3 && m === 40 },
    // Nightly brain push (Sam's ruling 2026-07-30): send the member's brain to THEIR
    // OWN private repo without waiting for anyone to open an app. Ten minutes after
    // the 03:40 snapshot, so the encrypted blob backup.mjs just wrote into
    // <state>/backups/ actually leaves the box, and comfortably before the 04:10+
    // auto-update restart. No-op when own-brain has not run (nowhere to push), and it
    // REFUSES if the protective .gitignore is not intact. See engine/brain-push.sh.
    { name: 'brain-push (nightly, to the owner’s own repo)', lid: 'brain-push', cmd: ['bash', [BRAIN_PUSH, stateDir]], match: (h, m) => h === 3 && m === 50 },
    // L1 auto-update (three-layer model): a nightly container restart IS the
    // update path — the host systemd unit `docker pull`s the org-pinned image
    // tag on every start, so once Crads/the org promote a new tag the whole
    // fleet converges within a day, no member clicks. Fires in the dead window
    // AFTER the 03:40 backup, at a per-box jittered minute (registry load).
    // The member's Update button stays as the fast path; the box owner can opt
    // out via /state/cockpit/auto-update.json {"enabled": false} (L2 lifecycle
    // power). The restart is the same consented mechanic as box-refresh: what
    // arrives is bounded by the tag the org pinned, never more.
    {
      name: 'auto-update (nightly restart onto the pinned image)', lid: 'auto-update',
      cmd: ['bash', ['-c', '(sleep 2; kill 1) </dev/null >/dev/null 2>&1 &']],
      match: (h, m) => {
        try { const cfg = JSON.parse(readFileSync(path.join(stateDir, 'cockpit', 'auto-update.json'), 'utf8')); if (cfg && cfg.enabled === false) return false; } catch { /* default on */ }
        return h === 4 && m === 10 + jitterMin;
      },
    },
  ];
  void c;
}

// Member cadence (v2): re-read each tick so Cadence-page edits take effect within
// a minute, without a restart. The lib drops junk ids and invalid schedules.
function buildSkillJobs(c) {
  return buildJobsFromCadence(readCadenceFile(), { quiet: c.quiet });
}


// Record that a skill was ASKED FOR (metadata only: id -> ISO). Note the verb.
//
// This stamp is written before enqueue, deliberately, and the panel's manual Run
// verb writes the same file the same way for the same reason: the Skills page has
// to reflect a run the moment it is asked for, not two minutes later when the
// drain finishes. That stays.
//
// What was never allowed was reading it as evidence a run WORKED, and the stall
// board did exactly that. Its one health fallback asked "enabled, but not
// running?" of this file, so a box whose every drain FAILED still looked busy:
// the stamp moved on schedule whatever happened next to the job. Evidence of a
// run finishing lives in the kernel's run ledger, which records ok or fail per
// run; engine/heartbeat.mjs carries that up as skill_ok_runs and the board reads
// that instead. Nothing may take this file for more than "asked for".
function recordSkillRun(id) {
  try {
    const f = path.join(stateDir, 'cockpit', 'skill-runs.json');
    let runs = {}; try { runs = JSON.parse(readFileSync(f, 'utf8')); } catch {}
    runs[id] = new Date().toISOString();
    writeFileSync(f, JSON.stringify(runs, null, 2) + '\n');
  } catch { /* metadata is best-effort */ }
}

// WHAT THE JOB ACTUALLY SAID, KEPT (finding 157, 2026-08-16).
//
// A live rock's cadence.log was 2782 lines and every one of them read
// "cadence: <job name>". reconcile-all prints a per-step ok/FAIL summary on
// stdout and the callback below took only the error, so all of it went nowhere.
// The line "anchor-reconcile: 1 wired, 1 re-staged, 1 still waiting" was
// printed every 15 minutes for days and read by nobody, which is exactly why
// the cross-wired deploy keys of finding 152 sat unseen: the applier was
// reporting the symptom on schedule into /dev/null.
//
// Bounded on purpose. A runaway job must not turn the log into the other thing
// nobody can read, and most jobs here are guarded no-ops that print nothing at
// all, so the common case still adds not one line.
const OUTPUT_LINES = 40;
function logOutput(stamp, job, out) {
  const lines = String(out || '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  if (!lines.length) return;
  for (const l of lines.slice(0, OUTPUT_LINES)) console.log(`[${stamp}]   ${job.name}: ${l.slice(0, 500)}`);
  if (lines.length > OUTPUT_LINES) console.log(`[${stamp}]   ${job.name}: (${lines.length - OUTPUT_LINES} more line(s) suppressed)`);
}

function fire(job) {
  const stamp = new Date().toISOString();
  if (job.cmd) {
    console.log(`[${stamp}] cadence: ${job.name}`);
    execFile(job.cmd[0], job.cmd[1], { cwd: KDIR, maxBuffer: 4 * 1024 * 1024 }, (e, stdout, stderr) => {
      const out = `${String(stdout || '')}${String(stderr || '')}`;
      // Two places, because they survive different things: the cadence log is
      // what an operator reads live but is truncated by every container
      // restart, and the run ledger outlives the restart but keeps one line.
      logOutput(stamp, job, out);
      // Machinery outcome -> run ledger (spec 2026-08-04 §5). This is what lets
      // the app answer "did the backup actually run" instead of "see elsewhere".
      if (job.lid) appendRun(stateDir, { ts: stamp, job: job.lid, skill: null, source: 'cron', status: e ? 'fail' : 'ok', summary: summarize(out), error: e && e.message });
      if (e) console.error(`[${stamp}] ${job.name} failed: ${e.message}`);
    });
    return;
  }
  console.log(`[${stamp}] cadence: ${job.name}`);
  if (job.isSkill) recordSkillRun(job.skill);
  const enqArgs = [ENQUEUE, stateDir, job.skill, '--source=cron'];
  if (job.deliver && chatId) enqArgs.push(`--reply-to=${chatId}`);   // route the brief to the client's Telegram
  // Skill outcomes are written by the KERNEL (with the real one-line summary);
  // the scheduler only records the cases the kernel never saw.
  execFile('node', enqArgs, { cwd: KDIR }, (e) => {
    if (e) {
      appendRun(stateDir, { ts: stamp, job: `skill /${job.skill}`, skill: job.skill, source: 'cron', status: 'fail', error: `enqueue failed: ${e.message}` });
      return console.error(`[${stamp}] enqueue ${job.skill} failed: ${e.message}`);
    }
    execFile('node', [KERNEL, stateDir, '--once'], { cwd: KDIR }, (e2) => {
      if (e2) {
        appendRun(stateDir, { ts: stamp, job: `skill /${job.skill}`, skill: job.skill, source: 'cron', status: 'fail', error: `drain failed: ${e2.message}` });
        console.error(`[${stamp}] drain failed: ${e2.message}`);
      }
    });
  });
}

// ---- entry ----
const c = loadCadence();
// The client's own Telegram chat, if they've connected it. Cadence jobs with deliver:true are
// enqueued with reply_to = this id so the kernel hands their output to the Telegram outbox.
// Empty => no delivery.
const chatId = (() => { try { return readFileSync(path.join(stateDir, 'secrets', 'telegram_chat_id'), 'utf8').trim(); } catch { return ''; } })();
// Fold the profile-cadence jobs into cadence.json exactly once (v2 fold-in).
// Runs in every mode so --plan / --plan-json describe the same reality that fires.
ensureMigrated(c, partsInTz(c.tz, new Date()).ymd);
// ROLE. A rock is not a member with a bigger brain: most base jobs are the
// member's own housekeeping and would be wrong or actively unwanted there.
// backup encrypts a member's state (a rock's brain is already a git repo
// pushed to GitHub), brain-push sends it to the member's own account,
// heartbeat emits a MEMBER heartbeat, org-sync and org-pull are the member end
// of the org channel, and auto-update restarts the box overnight. What a rock
// genuinely needs from a cadence is the reconcile pass, because control/ lives
// there and nothing else runs it unattended.
//
// So the rock takes an allow-list rather than the full set. Adding a job here
// is a deliberate act; inheriting one by accident is how a rock would start
// backing itself up over its own brain.
//
// seen-drain added with the self-host strip (2026-09-01): a rock has a device
// roster and a last-seen log exactly as a pebble does, and the drain that
// stamps recency onto its Devices rows is the local remnant of the old
// enrol-sync leg. (The enrolment, broker-registration, proof-drain and
// edge-reflect jobs left this list in the same strip: every one of them was a
// client of the central directory, which is deleted.)
// heartbeat-pull ADDED 2026-08-13 (finding 101): a rock is the only tier that
// has members to pull heartbeats FOR, and it was the one tier that never ran the
// puller. Without it the stall board reads an empty directory and calls every
// healthy member "never checked in".
const ROCK_JOBS = /^(reconcile|seen-drain|heartbeat-pull|state-md) /;
const ROLE = process.env.AIOS_SCHEDULER_ROLE === 'rock' ? 'rock' : 'member';
const jobs = buildJobs(c).filter((j) => ROLE !== 'rock' || ROCK_JOBS.test(j.name));
const argAt = process.argv.indexOf('--at');

// Machinery rows for --plan-json / --plan: the app's read-only "always-on
// machinery" block renders exactly this, resolved jitter included, so what the
// member sees is what this process will actually do.
// DERIVED FROM `jobs`, NEVER HAND-LISTED (finding 86, fixed 2026-08-13).
//
// This used to return a fixed array of the seven MEMBER jobs regardless of role,
// while the job list itself is filtered by ROCK_JOBS to four. On a rock the
// overlap was ZERO: the card showed a rock owner seven jobs that have never run
// on their box, badged ON, and hid the four that do. Measured on qa-base-gllm's
// run ledger, 587 entries: enrol-sync 339, grants 135, broker 68, reconcile 45.
// Not one of the seven appeared.
//
// The comment above claimed "what the member sees is what this process will
// actually do". It could not be true while one list was role-filtered and the
// other was not, so the display is now built FROM the filtered list. A row can no
// longer exist for a job that will not run, because there is nothing left to
// disagree with: add or remove a job and the card follows.
//
// DISPLAY carries only the human wording. A job with no entry still renders,
// using its own name, because a silent omission is the failure this had.
const DISPLAY = {
  heartbeat: { note: 'status metadata up to your rock (see Sharing)' },
  'org-sync': { note: 'pulls what your rock has shared with this box' },
  'org-pull': { note: 'refreshes the shared rock brain (if enrolled)' },
  'org-publish': { note: 'nightly extracts to the rock brain (if enrolled)' },
  backup: { note: 'encrypted snapshot of your settings and credentials; your brain rides its own repository' },
  'brain-push': { note: 'pushes your brain to your own private repo' },
  'auto-update': { note: 'restart onto the software your rock published' },
  'seen-drain': { note: 'keeps the "last seen" column on your Devices page true' },
  reconcile: { note: 'applies registry changes this box has not caught up with', pebble: false },
  'heartbeat-pull': { note: 'pulls each member check-in so the roster tells the truth', pebble: false },
  'mcp-refresh': { note: 'refreshes your connected services' },
  'google-rekey': { note: 'checks your Google sign-in still works, and tells you once if it ever stops' },
  'custody-watch': { note: 'tells you the moment ownership, anchor, support or access grants change' },
  'gh-refresh': { note: 'renews the GitHub credential your backups use' },
  // pebble: false marks the control-plane jobs whose match or guard can never
  // fire on a member box (no control/ dir, or org-box gated). The docs
  // generator's Pebble column reads this field; the app's Health card only ever
  // shows jobs the box actually schedules, so it needs nothing from it.
  'state-md': { note: 'rewrites STATE.md, the page your assistant reads about this mineral', pebble: false },
};

// "every 2 min", "hourly at :07", "03:40" — read off the SAME match function the
// scheduler runs, rather than re-stated by hand. Falls back to naming the job
// honestly rather than guessing a schedule it cannot describe.
function describeWhen(job) {
  const fires = [];
  for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m++) if (job.match(h, m)) fires.push([h, m]);
  if (!fires.length) return 'never';
  const two = (n) => String(n).padStart(2, '0');
  if (fires.length === 1) return `${two(fires[0][0])}:${two(fires[0][1])}`;
  const mins = [...new Set(fires.map(([, m]) => m))];
  if (fires.length === 24 && mins.length === 1) return `hourly at :${two(mins[0])}`;
  if (mins.length > 1 && fires.length === 24 * mins.length) {
    const step = mins.length > 1 ? mins[1] - mins[0] : 0;
    if (step > 0 && mins.every((m, i) => m === mins[0] + i * step)) return `every ${step} min`;
  }
  return `${fires.length}x a day`;
}

function machineryRows() {
  let autoUpdate = true;
  try { const cfg = JSON.parse(readFileSync(path.join(stateDir, 'cockpit', 'auto-update.json'), 'utf8')); if (cfg && cfg.enabled === false) autoUpdate = false; } catch {}
  return jobs.map((j) => {
    // Not every job declares a lid (org-publish does not), and a row with no id
    // is a row the card cannot key, badge or explain. Fall back rather than emit
    // a nameless row: silent omission is the exact failure this fix exists for.
    const id = j.lid || j.skill || String(j.name).split(' ')[0];
    const d = DISPLAY[id] || {};
    return {
      id,
      when: describeWhen(j),
      note: d.note || j.name,
      ...(j.lid === 'auto-update' ? { enabled: autoUpdate } : {}),
    };
  });
}

if (process.argv.includes('--plan-json')) {
  const cad = normalizeCadence(readCadenceFile());
  const skills = Object.entries(cad.jobs).map(([id, j]) => ({
    id, enabled: j.enabled === true, deliver: j.deliver === true, schedule: j.schedule, desc: describeSchedule(j.schedule),
  }));
  console.log(JSON.stringify({ tz: c.tz, jitter_min: jitterMin, quiet_hours: c.quiet, machinery: machineryRows(), skills }));
  process.exit(0);
}

if (process.argv.includes('--plan') || argAt !== -1) {
  console.log(`tz=${c.tz} (quiet ${c.quiet || 'unset'})`);
  for (const r of machineryRows()) console.log(`  ${r.id.padEnd(12)} ${r.when}${r.enabled === false ? ' (opted out)' : ''}`);
  const sj = buildSkillJobs(c);
  console.log(`  skills       ${sj.length ? sj.map(j => j.name).join(', ') : 'none enabled'}`);
  if (argAt !== -1) {
    const [hm, dowName] = (process.argv[argAt + 1] || '').split(/\s+/);
    const [h, m] = hm.split(':').map(Number);
    const d = DOW[dowName] ?? new Date().getDay();
    const { ymd } = partsInTz(c.tz, new Date());
    const firing = jobs.concat(buildSkillJobs(c)).filter(j => j.match(h, m, d, ymd)).map(j => j.name);
    console.log(`\nAt ${hm} (dow ${d}): ${firing.length ? firing.join(', ') : '(nothing)'}`);
  }
  process.exit(0);
}

// D49: the scheduler ALWAYS runs — heartbeat (metadata) must emit even from an
// idle box (an idle box is the churn signal the stall board needs), and live
// Cadence-panel edits are picked up each tick. box-up backgrounds it once.

console.log(`[${new Date().toISOString()}] scheduler up (tz ${c.tz}); ${jobs.length} machinery jobs + live member cadence (v2) + hourly heartbeat.`);

// BACKFILL (2026-08-17 hardening): stamp `brain_root:` into deployment.yaml
// on any org box that predates the promote-time stamp (ingrid,
// milk-and-honey — promoted before the stamp existed, unreachable by
// operator ssh since the operator holds no rock's key). The scheduler is the
// one process that ALWAYS runs on every box, and boxes restart nightly with
// the image update, so every standing rock self-describes within a day of
// this shipping. Org-gated + idempotent inside the module; a pebble is
// untouched. Never let a stamp failure take the scheduler down.
try {
  const st = ensureBrainRootStamped(stateDir);
  if (st.stamped) console.log(`[${new Date().toISOString()}] stamped brain_root: ${st.root} into deployment.yaml (self-describing backfill)`);
} catch (e) { console.log(`[${new Date().toISOString()}] brain_root stamp skipped: ${e.message}`); }
let last = '';
function tick() {
  const { hour, minute, dow, ymd } = partsInTz(c.tz, new Date());
  const key = `${dow}:${hour}:${minute}`;
  if (key === last) return;               // evaluate each wall-clock minute exactly once
  last = key;
  const all = jobs.concat(buildSkillJobs(c));   // member cadence re-read live each minute
  // box-up takes the kernel's human-lock at boot when the box has no member
  // cadence, and every box boots that way. Turning on a first schedule therefore
  // left the boot lock in place, so every drain deferred and nothing said so.
  // This is box-up's own ruling ("with cadence on... let them run"), applied at
  // the moment cadence actually goes live rather than only at boot.
  if (releaseBootLockForCadence(stateDir, all)) {
    console.log(`[${new Date().toISOString()}] cadence is live: released the boot-time human-lock so scheduled skills can drain.`);
  }
  for (const j of all) if (j.match(hour, minute, dow, ymd)) {
    if (j.lid === 'heartbeat') bootHeartbeatCovered = true;
    fire(j);
  }
}
// Whether any tick has already fired the heartbeat. The first-start block below
// consults this: a box whose FIRST start lands in minute :07 otherwise gets the
// heartbeat twice (the immediate tick() matches m === 7 AND the mark file does
// not exist yet, because the job writes it asynchronously). One minute in
// sixty; CI found it on 2026-09-01. A flag, not a clock re-read, so there is no
// boundary race between the two checks.
let bootHeartbeatCovered = false;
setInterval(tick, 20_000);                 // 20s poll so we never skip a minute boundary
tick();

// (The /wait long-poll accelerator went with the self-host strip, 2026-09-01:
// it held an outbound long-poll against the central directory to run enrolment
// work the second it was staged, and both the directory and the staged-work
// model are gone. Device add is local now, so there is nothing to accelerate.)

// ---- announce yourself once, at boot ----------------------------------------
// The heartbeat owns :07, hourly, so a box that boots at :11 is invisible to its
// rock and to the stall board for the next 56 minutes. From the outside that is
// indistinguishable from a box that never came up, and on 2026-08-10 it cost a
// long diagnosis on janet-jackson: machine running, tunnel healthy, org-sync and
// enrol-sync ticking over every two minutes since :49, and no heartbeat until
// :07 the following hour. "Fine but quiet" and "dead" must not look the same.
//
// Gated on the emitter never having run, so this fires on a box's FIRST start
// and not on every container restart of an established one (the hourly slot is
// still the steady-state signal; this only removes the opening blind spot).
const FIRST_HEARTBEAT_MARK = path.join(stateDir, 'cockpit', 'heartbeat.json');
if (!bootHeartbeatCovered && !existsSync(FIRST_HEARTBEAT_MARK)) {
  const hb = jobs.find((j) => j.lid === 'heartbeat');
  if (hb) {
    console.log(`[${new Date().toISOString()}] first start: emitting a heartbeat now rather than waiting for :07.`);
    fire(hb);
  }
}

// ---- comms supervisor ----
// box-up starts the Telegram bridge + kernel daemon once at container start, but nothing restarts
// them if they crash (systemd Restart=always restarts the CONTAINER, not an inner process). start-comms.sh
// is idempotent — its `alive` pidfile check relaunches ONLY what's dead — so re-running it on an interval
// resurrects a dead bridge/daemon without a container restart. Gated on the client having connected
// Telegram (start-comms self-gates too; skip the spawn otherwise). The first run is deferred one interval
// so box-up's own start-comms settles first, avoiding a double-launch race at boot.
function superviseComms() {
  if (!chatId) return;
  execFile('bash', [START_COMMS, stateDir], { cwd: ENGINE_DIR }, (e) => e && console.error(`[${new Date().toISOString()}] start-comms failed: ${e.message}`));
}
if (chatId) setInterval(superviseComms, 120_000);   // every 2 min; resurrects a crashed bridge/daemon
