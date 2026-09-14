#!/usr/bin/env node
// app.mjs: the Crads-AI desktop-app entry (D41 phase 2 + D43 + D44).
// This is what the downloadable .exe runs. TWO surfaces since the collapses
// (2026-09-01: the org/member edition split died, and the org setup wizard +
// invite surfaces were deleted with the hosted model):
//   DOOR    always: the front (wizard/panel/door.html) — the mineral list,
//           the self-host create flow, device-add.
//   PANEL   ~/.ssh/config carries any wizard-installed Host block
//           (`<slug>-box`, or a legacy `<org>-rock`): ONE panel server
//           (wizard/panel/member.html) opens on the mineral over SSH.
// Both: loopback only, no key, a free port, opened as a standalone app
// window. Zero runtime dependencies: node builtins only.
//
// Asset resolution order:
//   1. SEA-embedded assets (the packaged exe carries the pages + the managed
//      cloud-init template via node:sea; see .github/workflows/wizard-app.yml)
//   2. the filesystem relative to this module (dev checkout)
//
// The process stays up for the life of the session; Ctrl-C quits, closing the
// window does not.
//
//   Dev / CI smoke:  AIOS_NO_LAUNCH=1 node wizard/app.mjs   (prints the URL, no window)
//   Windows:         practice-partner-setup.exe
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPanelServer } from './panel/panel-server.mjs';
import { listPanelTargets, registerPromotedHost, unregisterPromotedHost, systemBridge } from './panel/ssh-bridge.mjs';
import { probePromotedHosts } from './panel/face-probe.mjs';
import { getBuildInfo, checkForUpdate, cleanupOld, applyUpdate } from './panel/updater.mjs';
import { createDoorServer } from './panel/door-server.mjs';
import { extractBox, registerProtocolHandler } from './panel/protocol.mjs';
import { wantsUninstall, uninstall, registerUninstall } from './panel/uninstall.mjs';
import { pushOwnedBrains } from './panel/brain-push.mjs';
import { runSsh } from './panel/ssh-bridge.mjs';
import { launchTarget, readLastUsed, lastUsedPath } from './panel/last-used.mjs';
import { listLocalTargets } from './panel/local-targets.mjs';
import { localBridge, composeBridge } from './panel/local-bridge.mjs';
import { loadEngineAssets } from './panel/local-scaffold.mjs';
import { pushLocalBrains } from './panel/own-brain-local.mjs';

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

// Where the Windows shortcuts live; shared by selfInstall and --uninstall so the
// two can never disagree about what to create and what to remove.
function winShortcutPaths() {
  return {
    startMenu: join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_NAME}.lnk`),
    desktop: join(homedir(), 'Desktop', `${APP_NAME}.lnk`),
  };
}

// `Crads-AI.exe --uninstall`: what the Add/Remove Programs entry runs. Handled
// before the single-instance / hidden-relaunch dance so it never opens a window.
async function runUninstall() {
  const dir = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', APP_NAME);
  const { startMenu, desktop } = winShortcutPaths();
  const r = await uninstall({ dir, shortcuts: [startMenu, desktop] });
  dbg(`uninstall: ${JSON.stringify(r)}`);
  console.log(r.done
    ? `${APP_NAME} uninstalled: shortcuts and the Windows entry removed; ${dir} is being deleted. Your data folder (${RUN_DIR}) was left alone.`
    : `${APP_NAME} uninstall finished with problems: ${r.failed.join(', ')}. Delete ${dir} by hand if it is still there.`);
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
    const { startMenu, desktop } = winShortcutPaths();
    // The Add/Remove Programs entry (per-user, idempotent): SignPath Foundation's
    // terms want a self-installing app to be uninstallable the normal Windows way.
    // Fail-silent like everything else here; `Crads-AI.exe --uninstall` is what it runs.
    const registerEntry = () => registerUninstall({
      target, dir, ico: existsSync(ico) ? ico : '', version: HOST_TAG,
      sizeBytes: (() => { try { return statSync(target).size; } catch { return 0; } })(),
      installDate: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    }).then((r) => dbg(`uninstall entry: ${r.done ? 'registered' : r.reason}`)).catch(() => {});
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
      registerEntry();                                         // migration: installs that predate the Add/Remove entry
      return;
    }
    mkdirSync(dir, { recursive: true });
    try { copyFileSync(process.execPath, target); } catch { /* installed copy is running; keep it */ }
    if (!existsSync(target)) return;
    writeIco();
    writeHost();
    sweepHosts();
    registerEntry();                                           // fast reg adds first; the shortcut PowerShell below can take seconds
    refresh([startMenu, desktop]);
    console.log(`installed: ${target} (Start menu + desktop shortcuts created; uninstall from Windows Settings > Apps, or run "${target}" --uninstall)`);
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
  if (wantsUninstall(process.argv)) { await runUninstall(); process.exit(0); }
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
        dbg(`already running at ${prev.url}; reopening window and exiting`);
        openAppWindow(prev.url); process.exit(0);
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
      // the same promise for brain folders on this computer (own-brain-local)
      pushLocalBrains({ targets: listLocalTargets(), log: dbg })
        .then((r) => dbg(`local brain-push: ${r.pushed.length} synced, ${r.failed.length} skipped`))
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

  // The engine files a LOCAL brain is scaffolded from and served with (the
  // no-server face, 2026-09-11). Same rule as the cloud-init sources below:
  // SEA assets in the packaged exe, the repo tree in a dev checkout, both
  // through asset() so neither half can ship without the other.
  const localAssets = loadEngineAssets({ read: (name, fsPath) => asset(name, fsPath) });
  // ONE bridge for the one panel: ssh for boxes, in-process for brain folders
  // on this computer. The panel's gates route by the target's kind.
  const bridge = composeBridge({ ssh: systemBridge(), local: localBridge({ targets: listLocalTargets, assets: localAssets }) });
  // Every mineral this computer can open: the ssh config's boxes plus the
  // brain folders in ~/.crads-ai/local-brains.json. Re-read on demand so a
  // brain made at the door mid-session is opened without a restart.
  const allTargetsNow = () => [...listPanelTargets(), ...listLocalTargets()];

  // D47: the DOOR is the app's front. What OPENS is the single identity's
  // dashboard when there is exactly one, else the door (0 identities: the
  // door's takeover offers self-host create + device-add). The org setup
  // wizard server (wizard/ui/) was DELETED 2026-09-01: the door's own
  // "Set up my own" flow (provision-routes) is the only create path.
  const allTargets = allTargetsNow();
  let panelFlipUrl = '';
  let memberUrl = '';
  let doorUrl = '';

  let panelStarted = false;
  const startPanel = () => {
    if (panelStarted) return;
    panelStarted = true;
    // ONE panel server (face collapse, 2026-09-01): member.html is the one
    // face, served to every alias kind. panelFlipUrl and memberUrl both point
    // here so the door's /go/panel and /go/member keep working unchanged.
    const panel = createPanelServer({
      port: 0,
      host: '127.0.0.1',
      bridge,
      htmlText: asset('member.html', join(HERE, 'panel', 'member.html')),
      doorUrl: () => doorUrl,
      vendor,
      updater,
      onDemoted: (host) => unregisterPromotedHost(host),
      // Ruling 6's record, and the ONE place in the tree that opts into the
      // real file. writeLastUsed has no default destination: a harness or a
      // scratch driver booting the same server writes nothing, rather than
      // silently retargeting the operator's next launch (four times over
      // 2026-08-13/14; see last-used.mjs).
      lastUsedPath: lastUsedPath(),
    });
    panel.on('listening', () => {
      panelFlipUrl = memberUrl = `http://127.0.0.1:${panel.address().port}/`;
    });
  };
  if (allTargets.length > 0) startPanel();

  // The member-connect (invite) server is GONE (2026-09-01): nobody can be
  // invited TO a box, so the app boots no surface for redeeming one. Its
  // surviving install/remove machinery is called directly by the door's
  // provision + device routes.

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
    bridge,
    htmlText: asset('door.html', join(HERE, 'panel', 'door.html')),
    provision: { files: selfHostFiles },
    local: { assets: localAssets },
    vendor,
    updater,
    urls: {
      panel: () => panelFlipUrl,
      member: () => memberUrl,
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
    // Lazy start (2026-08-03): a mineral connected mid-session never started
    // the dashboard, so the door listed the new box but /go/* answered "that
    // surface is not running" until the app was reopened. The door asks; the
    // starter says no (false) unless a matching identity actually exists on
    // this machine, so the surface never comes up with nothing behind it.
    // Both /go/panel and /go/member land on the SAME server since the face
    // collapse (2026-09-01); the two starters differ only in how the clicked
    // mineral is named (host= for legacy rock aliases, box= for slugs).
    start: {
      panel: (want) => {
        const targets = allTargetsNow();
        const host = want && want.host;
        const has = host ? targets.some((t) => t.host === host) : targets.length > 0;
        if (!has) return false;
        startPanel();
      },
      member: (want) => {
        const targets = allTargetsNow();
        const slug = want && want.box;
        const host = want && want.host;
        const has = slug || host
          ? targets.some((t) => t.org === slug || t.host === `${slug}-box` || (host && t.host === host))
          : targets.length > 0;
        if (!has) return false;
        startPanel();
      },
    },
  });
  door.on('listening', () => {
    doorUrl = `http://127.0.0.1:${door.address().port}/`;
    // let the sibling panel server bind, then open the right window
    setTimeout(() => {
      const single = allTargets.length === 1;
      let openUrl = doorUrl;
      let label = 'door';
      // crads-ai://box/<slug>: open straight into that mineral. A ROCK IS A BOX
      // TOO (Sam, 2026-08-11): a legacy -rock/-parent alias matches by slug and
      // opens the same one face on its #host convention. (The crads-ai://join/
      // invite deep link died with the invitation system, and AIOS_FORCE_WIZARD
      // with the org wizard, both 2026-09-01.)
      const wantBox = extractBox(process.argv);
      if (wantBox && panelFlipUrl && allTargets.some((t) => t.host === `${wantBox}-box`)) {
        openUrl = `${panelFlipUrl}#box=${wantBox}`; label = `panel(${wantBox})`;
      }
      else if (wantBox && panelFlipUrl && allTargets.some((t) => t.host === `${wantBox}-rock` || t.host === `${wantBox}-parent`)) {
        const alias = allTargets.find((t) => t.host === `${wantBox}-rock` || t.host === `${wantBox}-parent`).host;
        openUrl = `${panelFlipUrl}#host=${encodeURIComponent(alias)}`; label = `panel(${wantBox})`;
      }
      else if (single && panelFlipUrl) {
        openUrl = panelFlipUrl; label = 'panel';
      } else {
        // LAUNCH = LAST-USED BOX (ruling 6 of the 2026-08-09 upgraded-pebble
        // spec, built 2026-08-13). Deliberately LAST in the chain: a
        // crads-ai://box link says where to go explicitly, and a stored
        // preference must never override something the user just clicked.
        // launchTarget falls back to the door for every case it cannot
        // honour, so this can only ever change WHICH good screen opens,
        // never open a bad one.
        const pick = launchTarget(allTargets, readLastUsed());
        if (pick.open === 'panel' && panelFlipUrl) {
          openUrl = `${panelFlipUrl}#host=${encodeURIComponent(pick.host)}`; label = `panel(last:${pick.host})`;
        } else if (pick.open === 'member' && panelFlipUrl) {
          openUrl = `${panelFlipUrl}#box=${encodeURIComponent(pick.slug)}`; label = `panel(last:${pick.slug})`;
        } else if (pick.open === 'local' && panelFlipUrl) {
          // a brain folder rides the alias convention (#host=), like a rock
          openUrl = `${panelFlipUrl}#host=${encodeURIComponent(pick.host)}`; label = `panel(last:${pick.host})`;
        } else {
          dbg(`launch: door (${pick.why})`);
        }
      }
      console.log(`Crads-AI ${label}: ${openUrl}  (door: ${doorUrl}; local only; Ctrl-C to quit)`);
      dbg(`servers up (targets=${allTargets.length}); opening ${label} -> ${openUrl}`);
      try { mkdirSync(RUN_DIR, { recursive: true }); writeFileSync(RUN_FILE, JSON.stringify({ pid: process.pid, url: openUrl, door: doorUrl })); } catch { /* cosmetic */ }
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
  // Persist it to a log the user can send us: RUN_DIR/error.log (next to startup.log).
  const msg = `${(() => { try { return new Date().toISOString(); } catch { return 'now'; } })()} crads-ai: ${err && err.stack ? err.stack : (err && err.message ? err.message : err)}`;
  try { dbg(`FATAL ${err && err.stack ? err.stack : (err && err.message ? err.message : err)}`); } catch { /* startup.log best-effort */ }
  try { console.error(msg); } catch { /* no console (hidden relaunch) */ }
  try {
    // RUN_DIR, not the Windows path on every platform (2026-09-11): on a Mac
    // this used to land in ~/AppData/Local, where nobody looks
    mkdirSync(RUN_DIR, { recursive: true });
    appendFileSync(join(RUN_DIR, 'error.log'), msg + '\n');
  } catch { /* best-effort */ }
  process.exit(1);
});
