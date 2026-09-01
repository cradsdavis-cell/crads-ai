#!/usr/bin/env node
// app.mjs: the Practice Partner desktop-app entry (D41 phase 2 + D43 + D44).
// This is what the downloadable Windows .exe runs. Three modes, decided at
// launch (D44: the app IS the dashboard; setup is a flow inside it):
//   PANEL   ~/.ssh/config carries at least one wizard-installed
//           `Host <org>-rock` block: the app opens as the org's control
//           panel (wizard/panel/) driving the rock over SSH with that key.
//           The wizard co-runs unopened ("Set up another rock").
//   MEMBER  no org, but a `Host <slug>-box` block (the member's own box):
//           the app opens as the member's companion (dashboard + brain viewer,
//           wizard/panel/member.html). No chat, no org verbs: the member's EA
//           lives in the Claude Code app; this window is the read surface.
//   WIZARD  neither kind of Host block (true first run): the same wizard
//           server as the VPS (server-lib.mjs) on the pure-JS engine
//           (engine.mjs), loopback only.
//           AIOS_FORCE_WIZARD=1 forces the wizard from any state.
// Both modes: loopback only, no key, a free port, opened as a standalone app
// window. Zero runtime dependencies: node builtins only.
//
// Asset resolution order:
//   1. SEA-embedded assets (the packaged exe carries index.html + the cloud-init
//      template via node:sea; see .github/workflows/wizard-app.yml)
//   2. the filesystem relative to this module (dev checkout)
// The template is written to a temp file at startup because the engine reads
// CLOUD_INIT_TEMPLATE from disk.
//
// The process stays up after a provision completes (the operator may re-run, or go
// Back and fix an answer); Ctrl-C quits, closing the window does not.
//
//   Dev / CI smoke:  AIOS_NO_LAUNCH=1 node wizard/app.mjs   (prints the URL, no window)
//   Windows:         practice-partner-setup.exe
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWizardServer } from './ui/server-lib.mjs';
import { deprovision } from './engine.mjs';
import { createPanelServer } from './panel/panel-server.mjs';
import { createMemberConnectServer, removeIdentityAccess } from './panel/member-connect.mjs';
import { listPanelTargets, matchesKind, registerPromotedHost, unregisterPromotedHost } from './panel/ssh-bridge.mjs';
import { probePromotedHosts } from './panel/face-probe.mjs';
import { getBuildInfo, checkForUpdate, cleanupOld, applyUpdate } from './panel/updater.mjs';
import { createDoorServer } from './panel/door-server.mjs';
import { extractInvite, extractBox, registerProtocolHandler } from './panel/protocol.mjs';
import { signInWithGoogle } from './panel/google-signin.mjs';
import { pushOwnedBrains } from './panel/brain-push.mjs';
import { runSsh } from './panel/ssh-bridge.mjs';
import { launchTarget, readLastUsed, lastUsedPath } from './panel/last-used.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_NAME = 'Crads-AI';

// The window host ships under a BUILD-VERSIONED filename: the window the user
// clicks "update" in IS the old host, so its file is locked at exactly the
// moment selfInstall runs, and a fixed name lost that race on every update
// (found live 2026-08-04: two updates in, the taskbar still wore the pre-brand
// icon). A fresh name never collides; stale copies sweep once their windows close.
let HOST_TAG = '';
const hostName = (tag) => (tag ? `crads-ai-window-${tag}.exe` : 'crads-ai-window.exe');
function setHostTag(sea) {
  try { HOST_TAG = String(JSON.parse(Buffer.from(sea.getAsset('build-info.json')).toString('utf8')).sha || '').slice(0, 8); }
  catch { HOST_TAG = ''; }
}

// macOS: the packaged app ships as a Crads-AI.app bundle; execPath sits at
// <bundle>/Contents/MacOS/crads-ai. Everything bundle-shaped keys off this.
function macBundleRoot() {
  const m = String(process.execPath).match(/^(.*?\/[^/]+\.app)\/Contents\/MacOS\//);
  return m ? m[1] : '';
}

// First-run self-install (packaged app only). Windows: copy the exe to
// %LOCALAPPDATA%\Programs\Crads-AI\ + Start-menu/desktop shortcuts. macOS: copy
// the whole .app bundle into ~/Applications (no admin prompt, Launchpad picks it
// up) unless it's already running from /Applications or ~/Applications. Best-effort
// (an app that fails to install still runs fine from anywhere); skipped via
// AIOS_NO_INSTALL=1 (CI).
function selfInstall(sea) {
  if (!sea || process.env.AIOS_NO_INSTALL === '1') return;
  if (process.platform === 'darwin') {
    try {
      const bundle = macBundleRoot();
      if (!bundle) return;                                     // raw binary (dev): run in place
      const apps = join(homedir(), 'Applications');
      if (bundle.startsWith('/Applications/') || bundle.startsWith(apps + '/')) return;
      mkdirSync(apps, { recursive: true });
      const target = join(apps, `${APP_NAME}.app`);
      // ditto preserves the bundle exactly (permissions, structure); replace any old copy
      spawnSync('rm', ['-rf', target], { stdio: 'ignore', timeout: 20000 });
      const r = spawnSync('ditto', [bundle, target], { stdio: 'ignore', timeout: 60000 });
      if (r.status === 0) console.log(`installed: ${target} (find it in Launchpad; you can delete the downloaded copy)`);
    } catch { /* best-effort by design */ }
    return;
  }
  if (process.platform !== 'win32') return;
  try {
    const dir = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', APP_NAME);
    const target = join(dir, `${APP_NAME}.exe`);
    // Shortcuts carry an explicit IconLocation pointing at a dedicated .ico
    // (a SEA asset, Windows job only): icons resolved from the exe itself go
    // stale in Windows' icon cache, which is how installs kept showing
    // node.exe's icon in the Start menu after the exe was branded.
    const ico = join(dir, 'crads-ai.ico');
    const syncAsset = (name, dest) => {
      try {
        const want = Buffer.from(sea.getAsset(name));
        let have = null;
        try { have = readFileSync(dest); } catch { /* first write */ }
        if (have && have.equals(want)) return 'current';
        writeFileSync(dest, want);
        return have ? 'updated' : 'created';
      } catch { return null; }                                 // asset missing, or dest locked by a running copy
    };
    const writeIco = () => syncAsset('crads-ai.ico', ico);
    // The window host (WebView2 shell, see wizard/assets/win-host/) lands under
    // its build-versioned name (see hostName above), so an open old window never
    // blocks the new build's copy. Old copies are swept as their windows close.
    const writeHost = () => syncAsset('crads-ai-window.exe', join(dir, hostName(HOST_TAG)));
    const sweepHosts = () => {
      try {
        for (const f of readdirSync(dir)) {
          if (!/^crads-ai-window(-[0-9a-f]{4,40})?\.exe$/.test(f) || f === hostName(HOST_TAG)) continue;
          try { unlinkSync(join(dir, f)); } catch { /* its window is still open; a later launch sweeps it */ }
        }
      } catch { /* dir unreadable: nothing to sweep */ }
    };
    const esc = (s) => s.replace(/'/g, "''");
    const mk = (lnk) => `$s=$W.CreateShortcut('${esc(lnk)}');$s.TargetPath='${esc(target)}';$s.WorkingDirectory='${esc(dir)}';$s.Description='${APP_NAME}';`
      + (existsSync(ico) ? `$s.IconLocation='${esc(ico)},0';` : '') + `$s.Save();`;
    const refresh = (lnks) => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      '$W=New-Object -ComObject WScript.Shell;' + lnks.map(mk).join('')],
    { stdio: 'ignore', windowsHide: true, timeout: 20000 });
    const nudgeIconCache = () => { try { spawnSync('ie4uinit.exe', ['-show'], { stdio: 'ignore', windowsHide: true, timeout: 10000 }); } catch { /* cache nudge only */ } };
    const startMenu = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_NAME}.lnk`);
    const desktop = join(homedir(), 'Desktop', `${APP_NAME}.lnk`);
    if (resolve(process.execPath).toLowerCase() === resolve(target).toLowerCase()) {
      // Already installed. Migration for installs that predate the .ico: write
      // it and re-point only the shortcuts that still exist (a deliberately
      // deleted desktop shortcut stays deleted).
      const state = writeIco();
      writeHost();
      sweepHosts();
      if (state === 'created') {
        const stale = [startMenu, desktop].filter((l) => existsSync(l));
        if (stale.length) refresh(stale);
        nudgeIconCache();
      } else if (state === 'updated') nudgeIconCache();        // same path, new pixels: cache is the only stale layer
      return;
    }
    mkdirSync(dir, { recursive: true });
    try { copyFileSync(process.execPath, target); } catch { /* installed copy is running; keep it */ }
    if (!existsSync(target)) return;
    writeIco();
    writeHost();
    sweepHosts();
    refresh([startMenu, desktop]);
    console.log(`installed: ${target} (Start menu + desktop shortcuts created)`);
  } catch { /* best-effort by design */ }
}

const RUN_DIR = process.platform === 'darwin'
  ? join(homedir(), 'Library', 'Application Support', APP_NAME)
  : join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), APP_NAME);
const RUN_FILE = join(RUN_DIR, 'app.json');

// Full startup trace to %LOCALAPPDATA%\Crads-AI\startup.log, so a launch that opens no window is
// diagnosable from ONE run (the hidden relaunch has no console, so nothing is visible otherwise).
// Best-effort; never throws.
const LOG_FILE = join(RUN_DIR, 'startup.log');
function dbg(msg) {
  let stamp = '?';
  try { stamp = new Date().toISOString(); } catch { /* clock unavailable */ }
  const line = `${stamp} [pid ${process.pid}${process.env.AIOS_RELAUNCHED ? ' pebble' : ''}] ${msg}\n`;
  try { console.error(line.trimEnd()); } catch { /* no console in the hidden pebble */ }
  try { mkdirSync(RUN_DIR, { recursive: true }); appendFileSync(LOG_FILE, line); } catch { /* best-effort */ }
}

async function main() {
  let sea = null;
  try { const m = await import('node:sea'); if (m.isSea()) sea = m; } catch { /* dev: no SEA module */ }
  if (sea) setHostTag(sea);
  dbg(`main() start: platform=${process.platform} sea=${!!sea} execPath=${process.execPath} NO_LAUNCH=${process.env.AIOS_NO_LAUNCH || ''} RELAUNCHED=${process.env.AIOS_RELAUNCHED || ''}`);
  // No visible console (the SEA exe is a console binary, so a double-click
  // opens a terminal): the first launch respawns itself HIDDEN and exits; a
  // click while already running just reopens the window (single instance via
  // the run file). CI (AIOS_NO_LAUNCH=1) skips both. macOS shares the
  // single-instance check (a bundle launch has no console, so no hide dance).
  if ((process.platform === 'win32' || process.platform === 'darwin') && sea && process.env.AIOS_NO_LAUNCH !== '1') {
    // Never trust a PID (Windows re-uses them, and a killed instance leaves the
    // file behind): ask the recorded URL whether it actually answers. Anything
    // short of a live 200 means stale: remove the file and start fresh.
    try {
      const prev = JSON.parse(readFileSync(RUN_FILE, 'utf8'));
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch(prev.url, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        // D58 P2.2: a crads-ai://join/ click while the app runs re-invokes this exe with the
        // link in argv; hand the invite to the live instance's connect surface.
        const invited = extractInvite(process.argv);
        const reopen = invited && prev.connect ? `${prev.connect}#invite=${encodeURIComponent(invited)}` : prev.url;
        dbg(`already running at ${prev.url}; reopening window (${invited ? 'with invite' : 'plain'}) and exiting`);
        openAppWindow(reopen); process.exit(0);
      }
      throw new Error('stale');
    } catch { try { unlinkSync(RUN_FILE); } catch { /* nothing to clear */ } }
    if (process.platform === 'win32' && !process.env.AIOS_RELAUNCHED) {
      dbg('no live instance; relaunching self HIDDEN (console-hide) and exiting rock');
      const pebble = spawn(process.execPath, process.argv.slice(1),
        { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, AIOS_RELAUNCHED: '1' } });
      pebble.unref();
      process.exit(0);
    }
    dbg('running as the relaunched hidden pebble; continuing to servers');
  }
  selfInstall(sea);
  cleanupOld();
  // D58 P2.2: idempotent per-user registration of the crads-ai:// scheme, so invite
  // links can open this app directly. Fail-silent: a refusal only means the member
  // pastes the link instead.
  registerProtocolHandler().then((r) => dbg(`protocol handler: ${r.done ? 'registered' : r.reason}`)).catch(() => {});
  // D58 P3.5: once per launch, opportunistically push any member-OWNED brains
  // (boxes whose brain has an origin remote). Best-effort + fail-silent; delayed
  // so it never competes with startup's own SSH traffic for bridge slots.
  setTimeout(() => {
    try {
      pushOwnedBrains({ targets: listPanelTargets(), bridge: runSsh, log: dbg })
        .then((r) => dbg(`brain-push: ${r.pushed.length} synced, ${r.failed.length} skipped`))
        .catch(() => {});
    } catch { /* never blocks startup */ }
  }, 15000);
  dbg('selfInstall + cleanupOld done; starting servers');
  // Self-update (fail-silent): the status fills in asynchronously; the SPAs
  // poll /update-status and show the one-click banner when it flips.
  // 2026-07-23 fix: this process is LONG-LIVED (closing the window doesn't quit;
  // relaunches reuse it), so a single at-startup check went permanently stale.
  // refresh() re-checks, throttled to one real fetch per 5 minutes; every
  // /update-status poll nudges it, and a timer covers idle days.
  const buildInfo = getBuildInfo(sea);
  // `handoff` is what the already-open page follows during an update: the new
  // instance boots windowless, we confirm it answers, and the page navigates itself
  // to it rather than a second window appearing. Phases: starting, ready, failed.
  const updater = {
    status: { available: false, current: buildInfo },
    handoff: { phase: 'idle' },
    apply: () => applyUpdate({ onState: (s) => { updater.handoff = s; } }),
  };
  let lastUpdateCheck = 0;
  // refresh RETURNS the check, so a caller can wait for the truth. Until
  // 2026-07-30 /update-status kicked this and answered with the PREVIOUS value,
  // so the app said "no update available" while a newer build was published and
  // only told the truth on a second look.
  updater.refresh = (force) => {
    const now = Date.now();
    if (!force && now - lastUpdateCheck < 5 * 60 * 1000) return Promise.resolve(updater.status);
    lastUpdateCheck = now;
    return checkForUpdate(buildInfo).then((s) => { updater.status = s; return s; });
  };
  updater.refresh(true);
  const updateTimer = setInterval(() => updater.refresh(true), 4 * 60 * 60 * 1000);
  if (updateTimer.unref) updateTimer.unref();
  const asset = (name, fsPath) => {
    if (sea) { try { return Buffer.from(sea.getAsset(name)); } catch { /* fall through to disk */ } }
    return readFileSync(fsPath);
  };
  const htmlText = asset('index.html', join(HERE, 'ui', 'index.html'));
  const template = asset('cloud-init.rock.template.yaml',
    join(HERE, '..', 'provisioning', 'rock', 'cloud-init.rock.template.yaml'));
  // D53: vendored terminal frontend, served by the panel servers at /vendor/*
  const vendor = {};
  // 'marks/index.mjs' (2026-08-23): the connector marks module. It was added to
  // the tree with 60 sibling .svg/.png files and to NEITHER this list nor the SEA
  // asset map, so in the packaged exe /vendor/marks/index.mjs 404ed, member.html's
  // `import { markFor }` failed, and EVERY connector fell back to its initial
  // disc. It worked in a dev checkout the whole time, because the /vendor/ route
  // falls back to reading disk. Only the module ships: it inlines every mark as a
  // data URI, and the sibling image files are the readable source, not runtime.
  for (const name of ['xterm.js', 'xterm.css', 'xterm-addon-fit.js',
    'tokens.css', 'inter/inter.css', 'inter/InterVariable.woff2', 'marks/index.mjs']) {
    try { vendor[name] = asset(name, join(HERE, 'panel', 'vendor', name)); } catch { /* dev checkout missing vendor: route falls back to disk */ }
  }

  // the engine reads the template from disk: stage the embedded copy in a temp dir
  const work = mkdtempSync(join(tmpdir(), 'practice-partner-'));
  const templatePath = join(work, 'cloud-init.rock.template.yaml');
  writeFileSync(templatePath, template);

  // D47: the DOOR is the app's front. Every applicable surface runs; what
  // OPENS is the single identity's dashboard when there is exactly one, else
  // the door (0 identities: the door offers create/join). AIOS_FORCE_WIZARD
  // still jumps straight to org setup.
  const allTargets = listPanelTargets();
  const targets = allTargets.filter((t) => matchesKind(t, 'rock'));
  const memberTargets = allTargets.filter((t) => matchesKind(t, 'member'));
  let wizardUrlStr = '';
  let memberConnectUrl = '';
  let panelFlipUrl = '';
  let memberUrl = '';
  let doorUrl = '';
  let onStampSuccess = null;

  const wizardServer = createWizardServer({
    vendor,   // SEA exe: tokens.css + inter serve from the embedded map (no disk files)
    memberUrl: () => memberConnectUrl,
    panelUrl: () => panelFlipUrl,
    doorUrl: () => doorUrl,
    onExit: (code) => { if (code === 0 && onStampSuccess) onStampSuccess(); },
    engine: 'js',
    port: 0,
    host: '127.0.0.1',
    key: '',
    htmlText,
    log: null,
    autoInstallKey: true,
    extraAnswers: {
      TEMPLATE_REPO: process.env.TEMPLATE_REPO || 'cradsdavis-cell/brain-template',
      CLOUD_INIT_TEMPLATE: templatePath,
      STATE_DIR: join(homedir(), '.practice-partner', 'state'),
    },
  });

  // D54 org self-destruction: runs the engine's rock teardown LOCALLY from
  // the wizard's state file (~/.practice-partner/state/rock-<org>.env), with
  // cloud tokens the admin re-pastes in the Danger flow. The panel server owns
  // every guardrail; this is only the executor.
  // Legacy fallback (pre-2026-07-23 builds hardcoded slug 'rock'): if there is
  // no per-org state file, accept rock-rock.env ONLY when its DEPLOYMENT
  // line names this exact org. confirm must echo the file's own SLUG, which is
  // what the engine checks.
  // Resolve the local provisioning record for an org, if THIS computer made
  // the rock. Hosted rocks (platform-provisioned, Sam's ruling 2026-08-09)
  // have no record here and their owner never held the Hetzner/Cloudflare
  // codes, so the self-serve teardown cannot apply to them; the panel uses
  // this to show the hosted path instead of demanding codes that don't exist.
  const orgStateRecord = (org) => {
    const stateDir = join(homedir(), '.practice-partner', 'state');
    const ref = join(stateDir, `rock-${org}.env`);
    if (existsSync(ref)) return { ref, confirm: org, note: '' };
    const legacy = join(stateDir, 'rock-rock.env');
    let text = '';
    try { text = readFileSync(legacy, 'utf8'); } catch { /* no legacy file either */ }
    if (new RegExp(`^DEPLOYMENT=["']?${org}["']?\\s*$`, 'm').test(text)) {
      return { ref: legacy, confirm: (text.match(/^SLUG=["']?([a-z0-9-]+)["']?\s*$/m) || [])[1] || 'rock',
        note: `using the pre-rename state record (${legacy}) for rock '${org}'` };
    }
    return null;
  };
  const orgTeardown = (args, emit) => {
    const stateDir = join(homedir(), '.practice-partner', 'state');
    const rec = orgStateRecord(args.org);
    if (rec && rec.note) emit(rec.note);
    const ref = rec ? rec.ref : join(stateDir, `rock-${args.org}.env`);
    const confirm = rec ? rec.confirm : args.org;
    return deprovision(ref, emit, {
      stateDir,
      confirm,
      HCLOUD_TOKEN: args.hcloudToken,
      CF_API_TOKEN: args.cfToken,
      GITHUB_TOKEN: args.githubToken,
      // optional: retires the org's handle at the directory so the name is
      // reusable. Absent is fine and says so rather than failing the teardown.
      ORG_PULL_TOKEN: args.orgPullToken,
    }).then((r) => {
      // Infrastructure is gone; also remove THIS computer's identity for the org
      // (Host block + keypair + known-hosts pin + Claude Code entry) so the door
      // stops listing a dead rock. Best-effort: the teardown already
      // succeeded, a local cleanup hiccup must not report it as failed.
      try {
        const gone = removeIdentityAccess(`${args.org}-rock`);
        emit(gone.configUpdated || gone.keysRemoved
          ? `removed this computer's '${args.org}' identity (SSH access + key${gone.claudeRemoved ? ' + Claude Code connection' : ''})`
          : `no local '${args.org}' identity found to remove`);
        if (gone.keysStuck) emit(`WARN: ${gone.keysStuck} key file(s) for '${args.org}' could not be deleted; remove ${args.org}-rock.key* from your .ssh folder by hand`);
      } catch (e) { emit(`WARN: could not remove the local '${args.org}' identity (${e.message || e}); remove the ${args.org}-rock entry from your SSH config by hand`); }
      return r;
    });
  };

  let panelStarted = false;
  const startPanel = () => {
    if (panelStarted) return;
    panelStarted = true;
    const panel = createPanelServer({
      port: 0,
      host: '127.0.0.1',
      // upgraded-pebble ruling (2026-08-09): the org face serves the ONE member
      // shell; panel-server stamps edition=org into it at serve time. The old
      // panel.html is gone; /console keeps the legacy console until P3 re-homes it.
      htmlText: asset('member.html', join(HERE, 'panel', 'member.html')),
      topologyHtml: asset('topology.html', join(HERE, 'panel', 'topology.html')),
      wizardUrl: () => wizardUrlStr,
      doorUrl: () => doorUrl,
      vendor,
      updater,
      orgTeardown,
      orgProvisioned: (org) => !!orgStateRecord(org),
      onDemoted: (host) => unregisterPromotedHost(host),
      role: process.env.AIOS_PANEL_ROLE || '',
      // Ruling 6's record, and the ONE place in the tree that opts into the
      // real file. writeLastUsed has no default destination: a harness or a
      // scratch driver booting the same server writes nothing, rather than
      // silently retargeting the operator's next launch (four times over
      // 2026-08-13/14; see last-used.mjs).
      lastUsedPath: lastUsedPath(),
    });
    panel.on('listening', () => { panelFlipUrl = `http://127.0.0.1:${panel.address().port}/`; });
  };
  if (targets.length > 0) startPanel();
  // first stamp of this session: the panel comes up in place (finish-screen button)
  onStampSuccess = () => {
    if (panelFlipUrl) return;
    const rocks = listPanelTargets().filter((t) => matchesKind(t, 'rock'));
    if (rocks.length) startPanel();
  };

  let memberStarted = false;
  const startMember = () => {
    if (memberStarted) return;
    memberStarted = true;
    const member = createPanelServer({
      port: 0,
      host: '127.0.0.1',
      htmlText: asset('member.html', join(HERE, 'panel', 'member.html')),
      consoleHtml: asset('member-console.html', join(HERE, 'panel', 'member-console.html')),
      topologyHtml: asset('topology.html', join(HERE, 'panel', 'topology.html')),
      edition: 'member',
      doorUrl: () => doorUrl,
      // promotion, member side (2026-08-04): the ID token names the caller to the
      // directory (same sign-in the claim flow uses); a completed flip registers
      // the second face and brings the org panel up beside the member one.
      directoryUrl: process.env.AIOS_DIRECTORY_URL || 'https://directory.crads-ai.com',
      promoteIdToken: async () => {
        // T5: the account bridge replaced this gate. Silent first (disk
        // session), interactive crads second, Google fallback while the site
        // issuer is unarmed — a member with a session promotes with no pop-up.
        const { signInWithCrads } = await import('./panel/crads-account.mjs');
        const r = await signInWithCrads({}).catch(() => ({ ok: false }));
        return r.ok ? r.idToken : '';
      },
      onPromoted: (host, org) => { registerPromotedHost(host, org); startPanel(); },
      // so the console's "Connect my GitHub" can hand off to the own-brain flow,
      // which lives on the member-connect server (2026-07-30)
      connectUrl: () => memberConnectUrl,
      vendor,
      updater,
      // the other half of the opt-in above: the member face is the one a pebble
      // owner actually opens, so it is the one that most needs to be recorded,
      // and the one whose stray copies did the damage.
      lastUsedPath: lastUsedPath(),
    });
    member.on('listening', () => { memberUrl = `http://127.0.0.1:${member.address().port}/`; });
  };
  if (memberTargets.length > 0) startMember();
  // PROMOTE RULING § 3 (2026-08-04): the alias suffix is only the guess; the
  // BOX says what it is. A promoted rock keeps its -box alias and address, so
  // ask each member box for its ownership record: tier 'rock' registers the
  // second face and brings the org panel up beside the member one. Fail-open:
  // offline or pre-anchor boxes leave the alias faces exactly as today's.
  if (memberTargets.length > 0) {
    (async () => {
      try {
        const promoted = await probePromotedHosts(runSsh, memberTargets);
        if (promoted.length) {
          for (const p of promoted) registerPromotedHost(p.host, p.org);
          startPanel();
        }
      } catch { /* alias faces stand */ }
    })();
  }

  const memberConnect = createMemberConnectServer({
    port: 0,
    host: '127.0.0.1',
    htmlText: asset('member-connect.html', join(HERE, 'panel', 'member-connect.html')),
    vendor,
    urls: { door: () => doorUrl, member: () => memberUrl, panel: () => panelFlipUrl },
    // D58 verified handshake: during redeem, sign the member in with Google in their
    // system browser. CONTRACT: nonce = the device fingerprint, so the signed token
    // commits to the key being enrolled (the rock refuses anything else). Any
    // failure or refusal returns '' and the manual code-readback path stands.
    // Never reached for a standalone pebble: member-connect skips the handshake
    // when the invite carries the solo org (there is no rock to prove to).
    idTokenProvider: async (inv, { fingerprint }) => {
      // DELIBERATELY still Google. The reason recorded here until 2026-08-24
      // was "boxes in the field only trust Google until T9 ships
      // crads-token-verify.mjs in the image", which invited the conclusion that
      // T9 shipping makes this stale. It does not, and QA finding 177 drew
      // exactly that conclusion.
      //
      // THERE ARE TWO ENROLMENT LANES AND THEY DO NOT SHARE A VERIFIER. This
      // token goes to the rock's control/idtoken-verify.mjs, which accepts
      // GOOGLE_ISS and pinned Microsoft tenants and knows no Crads issuer.
      // crads-token-verify.mjs serves the OTHER lane (T9a account enrolment via
      // enrol-sync). So sending a Crads token here fails on every rock, however
      // new its image, and every member holding a Crads session would drop to
      // the manual code readback: strictly worse than today, where only a member
      // with no Google account does.
      //
      // The fix is to teach the handshake verifier the Crads issuer FIRST and
      // ship it to every rock, then let the app prefer the member's own session:
      // docs/superpowers/specs/2026-08-24-crads-issuer-in-the-handshake.md.
      const r = await signInWithGoogle({ nonce: fingerprint }).catch(() => ({ ok: false }));
      return r.ok ? r.idToken : '';
    },
    // D52: a passing connection test brings the matching dashboard up in place,
    // so the page can offer "Open my dashboard" instead of "reopen the app".
    // Ask the box what it is on every successful connection, so a box that was
    // promoted since last launch stops being shown the wrong face (live-cert
    // 2026-08-04), through the same face probe + registry the startup path
    // uses (promote ruling § 3). Fail-soft: no answer means the alias guess
    // stands, and the probe can only ADD a face, never take one away.
    onConnected: ({ kind, alias }) => {
      // NB: this callback is invoked with { kind, alias } (member-connect.mjs:592),
      // not { host }. Checked, because assuming the field name here would have
      // meant the probe silently never ran.
      if (alias && kind === 'member') {
        (async () => {
          try {
            const promoted = await probePromotedHosts(runSsh,
              listPanelTargets().filter((t) => t.host === alias && t.kind === 'member'));
            if (promoted.length) {
              for (const p of promoted) registerPromotedHost(p.host, p.org);
              startPanel();
            }
          } catch { /* the alias guess stands */ }
        })();
      }
      if (kind === 'member') startMember(); else startPanel();
    },
  });
  memberConnect.on('listening', () => {
    memberConnectUrl = `http://127.0.0.1:${memberConnect.address().port}/`;
  });

  // The self-host wizard's cloud-init sources. In the packaged exe none of
  // these repo paths exist on disk (import.meta.url is the exe; the first real
  // Windows run failed on exactly this, 2026-09-01), so they ride the SEA
  // assets like door.html itself, with the disk paths as the dev fallback.
  const selfHostFiles = {
    template: asset('cloud-init.template.yaml',
      join(HERE, '..', 'provisioning', 'managed', 'cloud-init.template.yaml')).toString('utf8'),
    hostUpdate: asset('aios-host-update',
      join(HERE, '..', 'provisioning', 'host', 'aios-host-update')).toString('utf8'),
    enterAios: asset('enter-aios',
      join(HERE, '..', 'provisioning', 'host', 'enter-aios')).toString('utf8'),
  };

  const door = createDoorServer({
    port: 0,
    host: '127.0.0.1',
    htmlText: asset('door.html', join(HERE, 'panel', 'door.html')),
    provision: { files: selfHostFiles },
    vendor,
    updater,
    directoryUrl: process.env.AIOS_DIRECTORY_URL || 'https://directory.crads-ai.com',
    urls: {
      panel: () => panelFlipUrl,
      member: () => memberUrl,
      wizard: () => wizardUrlStr,
      connect: () => memberConnectUrl,
    },
    // Tier honesty (2026-08-19, the display half of 05936d2's click fix). The
    // door serves an inventory row it can only GUESS the tier of — a `-box`
    // alias, cold probe cache, account unheard — and until now nothing probed
    // for the display's sake, so a fresh rock sat painted "Pebble" and its
    // click routed to the member face by the same guess (Harriet, 2026-08-18).
    // inventory-routes calls this with those aliases when it serves them: same
    // probe, same bound, same registry, same fail-open as the launch and click
    // paths above.
    probeFaces: async (aliases = []) => {
      const ask = listPanelTargets()
        .filter((t) => t.kind === 'member' && aliases.includes(t.host));
      if (!ask.length) return;
      const promoted = await probePromotedHosts((h, c) => runSsh(h, c, { hardTimeoutMs: 6000 }), ask);
      if (!promoted.length) return;
      for (const p of promoted) registerPromotedHost(p.host, p.org);
      startPanel();
    },
    // Lazy start (2026-08-03): a pebble stamped or claimed mid-session never
    // started the member dashboard (onStampSuccess only handles rocks), so the
    // door listed the new box but /go/member answered "that surface is not
    // running" until the app was reopened. The door now asks; each starter says
    // no (false) unless a matching identity actually exists on this machine, so
    // a surface never comes up with nothing behind it.
    start: {
      panel: async (want) => {
        const targets = listPanelTargets();
        if (targets.some((t) => matchesKind(t, 'rock'))) { startPanel(); return; }
        // No rock face on THIS machine -- and yet the door just drew a rock, or
        // we would not be here. The two sides read different sources: the row's
        // tier comes from the ACCOUNT (inventory.mjs: "the account's tier wins
        // when we have it"), while listPanelTargets() knows only the ssh alias
        // suffix plus the promoted-host cache. A rock provisioned or promoted in
        // this session keeps its <slug>-box alias until the face probe has run
        // and cached its answer, and until 2026-08-18 the only thing that ran
        // that probe was app launch -- so the member's first click dead-ended on
        // "that surface is not running" and stayed dead until they relaunched
        // (Harriet, 2026-08-18; same root as the ingrid fix one day earlier).
        // So: ask the box now, for the one host that was actually clicked.
        // Bounded well under the door's own wait, and fail-open in the same
        // direction the launch probe is -- no answer leaves the alias standing
        // and the honest 404 with it.
        const ask = targets.filter((t) => t.host === (want && want.host) && t.kind === 'member');
        if (!ask.length) return false;
        let promoted = [];
        try {
          promoted = await probePromotedHosts((h, c) => runSsh(h, c, { hardTimeoutMs: 6000 }), ask);
        } catch { promoted = []; }
        if (!promoted.length) return false;
        for (const p of promoted) registerPromotedHost(p.host, p.org);
        startPanel();
      },
      member: (want) => {
        const targets = listPanelTargets();
        // Same host-awareness as the rock path above, for the same reason: the
        // clicked pebble must be one this machine actually holds, not merely
        // "some pebble exists". A slug the account knows and this machine does
        // not is the elsewhere-row's job (Connect this computer), not this one's.
        const slug = want && want.box;
        const has = slug
          ? targets.some((t) => matchesKind(t, 'member') && (t.org === slug || t.host === `${slug}-box`))
          : targets.some((t) => matchesKind(t, 'member'));
        if (!has) return false;
        startMember();
      },
    },
  });
  door.on('listening', () => { doorUrl = `http://127.0.0.1:${door.address().port}/`; });

  wizardServer.on('listening', () => {
    wizardUrlStr = `http://127.0.0.1:${wizardServer.address().port}/`;
    // let the sibling servers bind, then open the right window
    setTimeout(() => {
      const single = targets.length + memberTargets.length === 1;
      let openUrl = doorUrl;
      let label = 'door';
      // D58 P2.2: launched from a crads-ai://join/ link (or the /join page handoff):
      // go straight to the connect flow with the invite pre-filled.
      const invitedLink = extractInvite(process.argv);
      // crads-ai://box/<slug>: open straight into that box (the ready email's link)
      const wantBox = extractBox(process.argv);
      if (invitedLink && memberConnectUrl) { openUrl = `${memberConnectUrl}#invite=${encodeURIComponent(invitedLink)}`; label = 'connect(invite)'; }
      // A ROCK IS A BOX TOO. This matched member targets only (`<slug>-box`), so a
      // rock's ready-email link fell straight through: `crads-ai://box/<slug>` for
      // a rock opened the door, or whatever the single-identity fallback below
      // happened to pick, and never that mineral. Sam, 2026-08-11: "when I click
      // on that link, it doesn't actually open up a window into that mineral".
      // A rock's alias is `<slug>-rock` and it lives in `targets`, not
      // `memberTargets`, so the pebble check could never have matched one.
      // Checked pebble-first only because that is the older, more common shape;
      // the two lists are disjoint, so the order carries no other meaning.
      else if (wantBox && memberUrl && memberTargets.some((t) => t.host === `${wantBox}-box`)) {
        openUrl = `${memberUrl}#box=${wantBox}`; label = `member(${wantBox})`;
      }
      else if (wantBox && panelFlipUrl && targets.some((t) => t.host === `${wantBox}-rock` || t.host === `${wantBox}-parent`)) {
        // the org panel IS the rock's window; it opens on the connected identity
        openUrl = panelFlipUrl; label = `panel(${wantBox})`;
      }
      else if (process.env.AIOS_FORCE_WIZARD) { openUrl = wizardUrlStr; label = 'setup'; }
      else if (single && targets.length === 1 && panelFlipUrl) {
        openUrl = panelFlipUrl; label = 'panel';
      } else if (single && memberTargets.length === 1 && memberUrl) {
        openUrl = memberUrl; label = 'member';
      } else {
        // LAUNCH = LAST-USED BOX (ruling 6 of the 2026-08-09 upgraded-pebble
        // spec, built 2026-08-13). Ratified that day and left unbuilt because
        // the door was the only way to switch minerals: demoting it before a
        // switcher existed would have stranded a multi-mineral owner inside one
        // box. The dashboard's mineral picker is that switcher, so this is now
        // safe to turn on.
        //
        // Deliberately LAST in the chain: an invite link, a crads-ai://box link
        // and AIOS_FORCE_WIZARD all say where to go explicitly, and a stored
        // preference must never override something the user just clicked.
        //
        // launchTarget falls back to the door for every case it cannot honour
        // (no record; the mineral forgotten, torn down or renamed since), so
        // this can only ever change WHICH good screen opens, never open a bad
        // one. The door stays reachable from every dashboard's "Start screen".
        const pick = launchTarget(allTargets, readLastUsed());
        if (pick.open === 'panel' && panelFlipUrl) {
          openUrl = `${panelFlipUrl}#host=${encodeURIComponent(pick.host)}`; label = `panel(last:${pick.host})`;
        } else if (pick.open === 'member' && memberUrl) {
          openUrl = `${memberUrl}#box=${encodeURIComponent(pick.slug)}`; label = `member(last:${pick.slug})`;
        } else {
          dbg(`launch: door (${pick.why})`);
        }
      }
      console.log(`Crads-AI ${label}: ${openUrl}  (door: ${doorUrl}; local only; Ctrl-C to quit)`);
      dbg(`servers up (targets=${targets.length} members=${memberTargets.length}); opening ${label} -> ${openUrl}`);
      try { mkdirSync(RUN_DIR, { recursive: true }); writeFileSync(RUN_FILE, JSON.stringify({ pid: process.pid, url: openUrl, door: doorUrl, connect: memberConnectUrl })); } catch { /* cosmetic */ }
      if (process.env.AIOS_NO_LAUNCH === '1') { dbg('AIOS_NO_LAUNCH=1: leaving window unopened (CI/foreground)'); return; }
      if (process.platform === 'win32' || process.platform === 'darwin') openAppWindow(openUrl);
      // linux: dev mode, the printed URL is the interface
    }, 400);
  });
}

// Locate a Chromium browser (Edge, then Chrome) at its real install path. We spawn it DIRECTLY,
// not via `cmd /c start msedge`, because `start` returns 0 even when nothing launched (the old
// silent-failure bug). existsSync + a direct spawn means a missing browser is a real error we can
// fall through on.
function chromiumBrowsers() {
  if (process.platform === 'darwin') {
    const bins = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
      'Chromium.app/Contents/MacOS/Chromium',
    ];
    return ['/Applications', join(homedir(), 'Applications')]
      .flatMap((root) => bins.map((b) => join(root, b)))
      .filter((p) => { try { return existsSync(p); } catch { return false; } });
  }
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local');
  return [
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter((p) => { try { return existsSync(p); } catch { return false; } });
}

// Last-resort: open a normal browser TAB in the default browser. Only used if no Chromium browser
// is found (rare on Windows: Edge ships with the OS). explorer.exe can exit 1 even on success, so
// we never key off exit codes, only spawn errors.
function openBrowserTab(url) {
  const methods = process.platform === 'darwin' ? [
    () => spawn('open', [url], { stdio: 'ignore' }),
  ] : [
    () => spawn('explorer.exe', [url], { stdio: 'ignore', windowsHide: true }),
    () => spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true }),
    () => spawn('powershell', ['-NoProfile', '-Command', `Start-Process '${String(url).replace(/'/g, "''")}'`], { stdio: 'ignore', windowsHide: true }),
  ];
  let i = 0;
  const attempt = () => {
    if (i >= methods.length) { dbg('openBrowserTab: all fallbacks exhausted'); return; }
    const n = i;
    try { const p = methods[i++](); p.on('error', (e) => { dbg(`openBrowserTab method ${n} error: ${e.message}`); attempt(); }); }
    catch (e) { dbg(`openBrowserTab method ${n} threw: ${e.message}`); attempt(); }
  };
  attempt();
}

// Open the app UI as a chromeless APP WINDOW (not a browser tab). Launch Edge/Chrome with
// --app=<url> in a dedicated profile dir so it's a standalone window, not merged into the user's
// browser session. Fall back to a browser tab only if no Chromium browser exists.
function openChromiumWindow(url) {
  const browsers = chromiumBrowsers();
  dbg(`openChromiumWindow(${url}); chromium browsers found: ${browsers.length ? browsers.join(' | ') : 'NONE'}`);
  const dataDir = join(RUN_DIR, 'app-window-profile');
  const tryApp = (i) => {
    if (i >= browsers.length) { dbg('no chromium app-window worked; falling back to a browser tab'); openBrowserTab(url); return; }
    const exe = browsers[i];
    try {
      const p = spawn(exe, [`--app=${url}`, `--user-data-dir=${dataDir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1200,840'],
        { stdio: 'ignore', windowsHide: false, detached: true });
      p.on('error', (e) => { dbg(`app-window via ${exe} error: ${e.message}`); tryApp(i + 1); });
      p.on('spawn', () => dbg(`app-window launched via ${exe}`));
      p.unref();
    } catch (e) { dbg(`app-window via ${exe} threw: ${e.message}`); tryApp(i + 1); }
  };
  tryApp(0);
}

// Windows: the branded window host (wizard/assets/win-host/, a static-linked
// WebView2 shell shipped as a SEA asset and installed by selfInstall). The
// --app= Edge window belonged to msedge.exe, so the taskbar showed Edge's icon
// no matter what favicon the pages served; the host owns the window, so the
// taskbar shows the mark. Look in the install dir first (a first run from
// Downloads has already self-installed by the time a window opens).
function windowHostPath() {
  if (process.platform !== 'win32') return '';
  const dirs = [
    join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', APP_NAME),
    dirname(process.execPath),
  ];
  // prefer THIS build's host; the legacy fixed name covers half-migrated installs
  for (const nm of [HOST_TAG ? hostName(HOST_TAG) : '', 'crads-ai-window.exe'].filter(Boolean)) {
    for (const d of dirs) { const p = join(d, nm); if (existsSync(p)) return p; }
  }
  return '';
}

function openAppWindow(url) {
  const host = windowHostPath();
  if (host) {
    try {
      // windowsHide MUST be false: it sets STARTF_USESHOWWINDOW/SW_HIDE on the
      // pebble, and a GUI app's nCmdShow honours it, so the host came up as a
      // live-but-invisible window (the 2026-08-03 "app won't open" break; the
      // reopen path exits immediately, so the fallback never fired either).
      const p = spawn(host, [url], { stdio: 'ignore', detached: true, windowsHide: false });
      let settled = false;
      // A fast non-zero exit means the host could not get a WebView2 environment
      // (runtime missing/broken): fall back to the old Edge/Chrome app window so
      // the failure mode is yesterday's behaviour, not a dead click. After 5s a
      // non-zero exit is a real session ending, not a launch failure.
      const fallback = (why) => { if (settled) return; settled = true; dbg(`window host failed (${why}); falling back to a chromium app-window`); openChromiumWindow(url); };
      p.on('error', (e) => fallback(e.message));
      p.on('exit', (code) => { if (code) fallback(`exit ${code}`); });
      setTimeout(() => { settled = true; }, 5000);
      p.unref();
      dbg(`window host launched: ${host}`);
      return;
    } catch (e) { dbg(`window host threw: ${e.message}`); }
  }
  openChromiumWindow(url);
}

main().catch((err) => {
  // The hidden relaunch has no console, so a crash there was silent (the "flash then nothing" bug).
  // Persist it to a log the user can send us: %LOCALAPPDATA%\Crads-AI\error.log.
  const msg = `${(() => { try { return new Date().toISOString(); } catch { return 'now'; } })()} crads-ai: ${err && err.stack ? err.stack : (err && err.message ? err.message : err)}`;
  try { dbg(`FATAL ${err && err.stack ? err.stack : (err && err.message ? err.message : err)}`); } catch { /* startup.log best-effort */ }
  try { console.error(msg); } catch { /* no console (hidden relaunch) */ }
  try {
    const dir = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), APP_NAME);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'error.log'), msg + '\n');
  } catch { /* best-effort */ }
  process.exit(1);
});
