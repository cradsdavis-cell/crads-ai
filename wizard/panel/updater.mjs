// updater.mjs: single-file self-update for the Crads-AI app (D44/D45).
// No crads-ai server, no phone-home beyond one public release check:
//   - CI bakes build-info.json ({sha, built_at}) into the exe and publishes the
//     identical version.json next to crads-ai.exe on the rolling release.
//   - At launch the app compares its baked sha to the published one (fail-silent
//     offline) and the SPAs show a one-click banner when they differ.
//   - Apply: download the new exe, rename the running one aside (Windows allows
//     renaming a running exe; overwriting it is what's forbidden), move the new
//     one into place, relaunch. The .old file is cleaned on the next start.
// When the repo re-privatises (D37) this check starts failing silently; wiring
// the per-org access token through here folds into the licensing build.
import { existsSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

// Public releases host (crads-ai-app) so the in-app updater works for EVERYONE, not just the
// owner logged into the private ai-os repo. CI still builds in ai-os; a mirror publishes each
// build to this public repo, which is where the app checks for + downloads updates.
const RELEASE_BASE = 'https://github.com/cradsdavis-cell/crads-ai-app/releases/download/wizard-app';
export const VERSION_URL = `${RELEASE_BASE}/version.json`;
export const CHANGELOG_URL = `${RELEASE_BASE}/changelog.json`;

// What's-new (2026-08-09, Sam: "understand where we're up to"): CI publishes
// changelog.json (last 25 commit subjects) beside the exe; the faces show it
// behind the version chip. Cached in-process, fail-silent offline — the app
// must render identically with no network, just with an empty list.
let _changelog = { at: 0, entries: [] };
export async function fetchChangelog(opts = {}) {
  const now = Date.now();
  if (_changelog.at && now - _changelog.at < (opts.ttlMs ?? 30 * 60 * 1000)) return _changelog.entries;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 6000);
    const r = await (opts.fetch || fetch)(opts.url || CHANGELOG_URL, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(t);
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j)) _changelog = { at: now, entries: j.slice(0, 25) };
    }
  } catch { /* offline: serve what we have */ }
  return _changelog.entries;
}

// Plain words (2026-08-13, Sam: "more digestible for a non-crads-ai developer
// audience"). The git log is written for whoever is BUILDING this thing: scopes,
// finding numbers, leg letters, trap numbers, and on a typical week half of any
// release is QA runs and design notes a member of somebody's community has no
// reason to read. So the app publishes a filtered, tidied view, and when a
// release was all plumbing it says that in one line instead of showing six
// riddles.
//
// What this deliberately does NOT do is pretend to rewrite a developer's
// sentence into a member's sentence. "A rock adopted another box's repo" is
// tidy and still a riddle, and a filter cannot know it means "your backup went
// to the wrong place". The seam for that is `notes` on an entry: a curated
// one-liner, which WINS over the commit subject whenever it is there. This
// filter is the fallback for every release nobody wrote one for.
//
// Nothing here classifies a change as a fix or a feature. These subjects do not
// carry that: "a rock showed its assistant's name where its organisation should
// be" is a bug report with no word in it saying so, and a wrong "New" tag on a
// bug fix is worse than no tag.

// Scopes whose changes never reach a member's screen. Matched on the FIRST word
// of the `scope:` prefix, so "baseline loop 3:" and "clean-gate was right:" land
// here too.
const INTERNAL_SCOPES = new Set([
  'baseline', 'chore', 'ci', 'clean-gate', 'design', 'doc', 'docs', 'harness',
  'lint', 'prompt', 'qa', 'refactor', 'scheduler', 'shots', 'style', 'test',
  'tests', 'vocab', 'wait-loop', 'wip',
  // server-side machinery: real work, no screen it can be seen on
  'cron', 'directory', 'engine', 'factory', 'mirror', 'provisioning', 'worker',
  // Added 2026-08-25, by MEASURING the list instead of guessing at it: running
  // plainRelease() over the window the docs-v2 merge produced showed five
  // entries reaching the chip and four of them written for whoever builds this
  // repo ("Spec: the Crads issuer in the device handshake, and why 177's fix is
  // wrong"). Trap 39 again: this filter catches internal WORK, and a scope it
  // has never heard of is not internal to it however internal it reads. These
  // six are all documents, tests, ledgers or operator machinery, and every one
  // of them appeared in that one window.
  'docs-pipeline', 'evidence', 'spec', 'stamp', 'suite', 'traps',
]);
// Vocabulary that only exists inside the build: a subject carrying any of it is
// addressed to the person holding the checklist, whatever its scope says.
const INTERNAL_MARKERS = /\b(findings?|leg [a-e]\b|trap \d|fixture|qa|sabotage|regression|scoreboard|checklist)\b/i;

// The first word before an opening colon. Deliberately not a tight `scope:`
// pattern: this log writes "clean-gate was right again: ..." and "baseline loop
// 3: ..." as often as it writes "docs: ...", and a pattern that only matched the
// short form let the chattiest internal subjects through (caught in test).
function scopeOf(subject) {
  const i = subject.indexOf(':');
  if (i < 1 || i > 40) return '';
  const head = subject.slice(0, i);
  if (/[.!?]/.test(head)) return '';   // a colon after a finished sentence is not a scope
  return head.trim().split(/\s+/)[0].toLowerCase();
}

export function isInternalChange(subject) {
  const s = String(subject || '').trim();
  if (!s) return true;
  if (/^merge\b/i.test(s)) return true;          // merges are bookkeeping
  if (/^retract\b/i.test(s)) return true;        // an internal finding withdrawn
  if (INTERNAL_SCOPES.has(scopeOf(s))) return true;
  return INTERNAL_MARKERS.test(s);
}

// Tidy, not rewrite: drop the internal cross-references, normalise whitespace,
// open with a capital. The scope prefix STAYS, because "Door: one mineral
// inventory" tells a member which screen moved and "One mineral inventory" does not.
export function tidySubject(subject) {
  let s = String(subject || '')
    .replace(/\s*\((?:finding|findings|trap|leg)[^)]*\)/gi, '')
    // "door P2:" is this repo's phase notation, not something a member can act on
    .replace(/^([^:]{1,24}?)\s+P\d\s*:/i, '$1:')
    .replace(/\s+/g, ' ')
    .trim();
  // Capitalise a word, not an identifier: "door:" reads better as "Door:", but
  // "ssh-bridge:" turning into "Ssh-bridge:" just looks like a typo.
  const first = s.split(/[\s:]/)[0] || '';
  if (s && !/[-_./]/.test(first)) s = s[0].toUpperCase() + s.slice(1);
  return s;
}

// "2026-08-13" -> "13 Aug". Anything unparseable passes through untouched: a
// date the app cannot read is not worth an exception.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''));
  if (!m) return String(date || '');
  const mon = MONTHS[Number(m[2]) - 1];
  return mon ? `${Number(m[3])} ${mon}` : String(date);
}

// The member-facing view of a release: { entries:[{plain,when,...}], hidden }.
// `hidden` is the count of internal changes filtered out, reported rather than
// swallowed so the surface never implies a quiet week was an empty one.
export function plainRelease(entries) {
  const out = [];
  let hidden = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    const subject = String((e && e.subject) || '').trim();
    const note = String((e && e.notes) || '').trim();
    if (!note && isInternalChange(subject)) { hidden++; continue; }
    const plain = note ? tidySubject(note) : tidySubject(subject);
    if (!plain) { hidden++; continue; }
    out.push({ ...e, plain, when: shortDate(e && e.date), curated: !!note });
  }
  return { entries: out, hidden };
}
// Per-platform asset: Windows ships the SEA exe; macOS ships the .app bundle zipped.
export const EXE_URL = process.platform === 'darwin' ? `${RELEASE_BASE}/crads-ai-mac.zip` : `${RELEASE_BASE}/crads-ai.exe`;

// Build identity: SEA asset in the packaged exe; AIOS_BUILD_INFO env for tests
// and dev runs. null = dev build, never offers updates.
export function getBuildInfo(sea) {
  if (process.env.AIOS_BUILD_INFO) {
    try { return JSON.parse(process.env.AIOS_BUILD_INFO); } catch { return null; }
  }
  if (!sea) return null;
  try { return JSON.parse(Buffer.from(sea.getAsset('build-info.json')).toString('utf8')); } catch { return null; }
}

export function installedTarget() {
  if (process.platform === 'darwin') return join(homedir(), 'Applications', 'Crads-AI.app');
  return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
    'Programs', 'Crads-AI', 'Crads-AI.exe');
}

// The single-instance run file app.mjs writes ({pid, url, door}). The updater
// must know it: see the 2026-07-23 relaunch-race note in applyUpdate.
export function runFilePath() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Crads-AI', 'app.json');
  return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
    'Crads-AI', 'app.json');
}

// Best-effort startup cleanup of the swap leftover (a file on Windows, a directory on macOS).
export function cleanupOld(target = installedTarget()) {
  try { rmSync(target + '.old', { recursive: true, force: true }); } catch { /* still locked: next time */ }
}

export async function checkForUpdate(current, opts = {}) {
  if (!current || !current.sha) return { available: false, current: null, reason: 'dev build' };
  const fetchFn = opts.fetch || fetch;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 6000);
    const r = await fetchFn(opts.versionUrl || VERSION_URL, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(t);
    if (!r.ok) return { available: false, current, reason: `check failed (${r.status})` };
    const latest = await r.json();
    return { available: !!latest.sha && latest.sha !== current.sha, current, latest };
  } catch {
    return { available: false, current, reason: 'offline or unreachable' };
  }
}

// Download + swap + relaunch. opts for tests: target, exeUrl, fetch, spawn,
// relaunch:false, force (skips the platform + size rails and uses the file-swap path).
export async function applyUpdate(opts = {}) {
  const state = opts.onState || (() => {});
  try {
    return await applyUpdateImpl(opts, state);
  } catch (e) {
    // EVERY failure names itself (2026-08-24). Until today the throws below
    // reached only console.error, inside the process the Windows launcher runs
    // with NO console attached, so the reason was destroyed at the moment it was
    // produced. The page then sat through its whole deadline and reported "That
    // update could not be started", which is not a diagnosis, it is a shrug. A
    // real incident took five rounds of guesswork because the app knew exactly
    // what was wrong every time and had no way to say it.
    state({ phase: 'failed', reason: String((e && e.message) || e) });
    throw e;
  }
}

async function applyUpdateImpl(opts, state) {
  if (process.platform === 'darwin' && !opts.force) return applyUpdateDarwin(opts, state);
  const target = opts.target || installedTarget();
  if (process.platform !== 'win32' && !opts.force) throw new Error('self-update applies to the installed app only');
  if (!existsSync(dirname(target))) throw new Error('no installed copy to update (run the downloaded exe once to install)');
  const fetchFn = opts.fetch || fetch;
  // Announce the download BEFORE it starts. It is the long leg (~85 MiB) and it
  // used to run entirely unannounced: the first state any watcher saw was
  // 'starting', emitted after the download AND the swap were already done. A
  // page watching for progress therefore saw nothing at all through the part
  // that takes the longest, and could only tell "downloading fine" from "died
  // instantly" by waiting out a timeout.
  state({ phase: 'downloading' });
  const r = await fetchFn(opts.exeUrl || EXE_URL, { redirect: 'follow' });
  if (!r.ok) throw new Error(`download failed (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 10 * 1024 * 1024 && !opts.force) throw new Error('downloaded file implausibly small; keeping the current version');
  state({ phase: 'installing' });
  const fresh = target + '.new';
  writeFileSync(fresh, buf);
  // The outgoing exe IS the rollback. Windows cannot overwrite a running binary, but
  // a running PROCESS does not need its file on disk, so renaming it aside is both
  // legal and exactly the copy worth keeping until the new one has proven it starts.
  // cleanupOld() removes it at the next successful boot, which is the right moment.
  const backup = target + '.old';
  if (existsSync(target)) {
    try { unlinkSync(backup); } catch { /* stale leftover may block the rename target */ }
    renameSync(target, backup);
  }
  renameSync(fresh, target);
  if (opts.relaunch !== false) {
    // Keep the run file's contents: a failed handoff leaves THIS process alive, and
    // it has to stay findable by the next launch.
    let prevRun = null;
    try { prevRun = readFileSync(opts.runFile || runFilePath(), 'utf8'); } catch { /* none */ }
    // 2026-07-23 relaunch race: the dying process keeps answering on its port
    // for the ~400ms exit linger. The freshly-spawned exe reads the run file,
    // probes that still-alive URL, decides "already running", opens a window at
    // the about-to-die port, and exits — leaving a dead window and NO app.
    // Deleting the run file first means the newcomer skips the probe and boots
    // fresh on its own ports.
    try { unlinkSync(opts.runFile || runFilePath()); } catch { /* none */ }
    // Retire any OTHER copy of the app before relaunching (2026-07-30). This
    // process exits below, but a second instance would keep serving the OLD
    // build on its own ports: an update that looks applied while the user
    // carries on seeing the previous version, which is exactly what happened.
    // The app is single-instance by design, so another live copy is an anomaly.
    if (opts.retireOthers !== false && process.platform === 'win32') {
      try {
        (opts.spawnSync || spawnSync)('taskkill', ['/F', '/IM', 'Crads-AI.exe', '/FI', `PID ne ${process.pid}`],
          { stdio: 'ignore', windowsHide: true, timeout: 10000 });
      } catch { /* best-effort: never block the update */ }
    }
    // ---- HANDOFF, not "spawn and hope" (2026-07-30, Sam: same window) ----------
    // The old behaviour spawned the new exe and exited 400ms later. The newcomer
    // booted, bound fresh ports and opened its OWN window, so an update produced a
    // second window while the first sat pointing at a port that was about to die.
    // You cannot fix that by closing the old window either: every app window shares
    // one --user-data-dir, so a single browser process owns them all and killing it
    // takes the new window with it.
    //
    // So the new instance starts with AIOS_NO_LAUNCH=1: it comes up fully, writes
    // its url to the run file, and opens nothing. We wait for it to actually ANSWER,
    // hand the already-open page over to it (the client polls /update-handoff and
    // does location.replace), and only then exit. One window throughout.
    const pebble = (opts.spawn || spawn)(target, [], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, AIOS_NO_LAUNCH: '1' },
    });
    if (pebble.unref) pebble.unref();
    state({ phase: 'starting' });
    const url = await waitForHandoff(opts);
    const exit = opts.exit || ((code) => process.exit(code));
    if (url) {
      state({ phase: 'ready', url });
      // Long enough for the page's poll to see 'ready' and navigate away before the
      // server under it disappears. Exiting immediately races the very handoff we
      // just waited for.
      setTimeout(() => exit(0), opts.exitDelayMs ?? 2000);
      return { target, url };
    }
    // ---- the new version did not come up: put everything back -----------------
    // An app that closes itself and fails to reopen is strictly worse than one that
    // never updated, so this path must leave the member exactly where they were:
    // old exe restored, old run file restored, THIS process still serving, and the
    // banner told the truth.
    try { if (pebble.pid) process.kill(pebble.pid); } catch { /* already gone */ }
    try {
      if (existsSync(backup)) {
        try { renameSync(target, target + '.failed'); } catch { /* fall through */ }
        renameSync(backup, target);
        try { rmSync(target + '.failed', { force: true }); } catch { /* leftover, harmless */ }
      }
    } catch { /* if the restore itself fails, the .old copy is still on disk to hand-run */ }
    if (prevRun !== null) { try { writeFileSync(opts.runFile || runFilePath(), prevRun); } catch { /* cosmetic */ } }
    state({ phase: 'failed', reason: 'the new version did not start, so the previous one was put back' });
    return { target, rolledBack: true };
  }
  return { target };
}

// Wait for the freshly-spawned instance to publish a url AND answer on it. Both
// halves matter: the run file appearing only proves a process got far enough to
// write a file, and sending a human to a url that does not answer is the failure
// this whole dance exists to avoid.
async function waitForHandoff(opts = {}) {
  const runFile = opts.runFile || runFilePath();
  const fetchFn = opts.fetch || fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = (opts.now || Date.now)() + (opts.handoffTimeoutMs ?? 45000);
  while ((opts.now || Date.now)() < deadline) {
    await sleep(opts.pollMs ?? 500);
    let info = null;
    try { info = JSON.parse(readFileSync(runFile, 'utf8')); } catch { continue; }
    // Ours was deleted before the spawn, so anything here is the newcomer's. The pid
    // check is belt and braces against a stale file we failed to remove.
    if (!info || !info.url || info.pid === process.pid) continue;
    try { await fetchFn(info.url, { redirect: 'manual' }); return info.url; } catch { /* not listening yet */ }
  }
  return null;
}

// macOS: the unit of install is the whole .app bundle, so the swap dance moves
// directories. The zip is fetched in-process (no quarantine attribute, so
// Gatekeeper does not re-prompt) and unpacked with ditto, which preserves the
// bundle exactly. Same fail-safe order as Windows: unpack + verify BEFORE the
// running copy is touched.
async function applyUpdateDarwin(opts = {}, state = () => {}) {
  const target = opts.target || installedTarget();
  if (!existsSync(join(target, 'Contents', 'MacOS'))) throw new Error('no installed copy to update (open the downloaded app once to install it)');
  const fetchFn = opts.fetch || fetch;
  state({ phase: 'downloading' });
  const r = await fetchFn(opts.exeUrl || EXE_URL, { redirect: 'follow' });
  if (!r.ok) throw new Error(`download failed (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 10 * 1024 * 1024) throw new Error('downloaded file implausibly small; keeping the current version');
  state({ phase: 'installing' });
  const zip = target + '.new.zip';
  const unpack = target + '.new';
  writeFileSync(zip, buf);
  rmSync(unpack, { recursive: true, force: true });
  const un = spawnSync('ditto', ['-xk', zip, unpack], { stdio: 'ignore', timeout: 120000 });
  if (un.status !== 0) { rmSync(zip, { force: true }); throw new Error('could not unpack the update; keeping the current version'); }
  const fresh = join(unpack, 'Crads-AI.app');
  if (!existsSync(join(fresh, 'Contents', 'MacOS'))) { rmSync(unpack, { recursive: true, force: true }); rmSync(zip, { force: true }); throw new Error('update package looks wrong; keeping the current version'); }
  rmSync(target + '.old', { recursive: true, force: true });
  renameSync(target, target + '.old');
  renameSync(fresh, target);
  rmSync(unpack, { recursive: true, force: true });
  rmSync(zip, { force: true });
  if (opts.relaunch !== false) {
    try { unlinkSync(opts.runFile || runFilePath()); } catch { /* none */ }
    const pebble = (opts.spawn || spawn)('open', [target], { detached: true, stdio: 'ignore' });
    if (pebble.unref) pebble.unref();
    const exit = opts.exit || ((code) => process.exit(code));
    setTimeout(() => exit(0), 400);
  }
  return { target };
}
