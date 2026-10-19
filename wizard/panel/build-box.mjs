// build-box.mjs: make ONE box end to end on the person's own provider account.
//
// Lifted out of provision-routes.mjs (2026-10-10) so "Set up my own" and "Set up a
// team" build each box the same way: key before birth, the engine, HostName
// repaired after, the boot wait through the whole ssh chain, the known-hosts pin,
// and the Claude Code app's Environment entry. The comments that explain each step
// moved with it.
//
// `run` is the caller's mutable record: { slug, alias, provider, location?,
// serverType?, token, state, steps[] }. buildBox fills run.ip and run.phase
// ('provisioning' -> 'booting' -> 'ready') and throws on failure; the caller
// persists run.state through deps.saveState.
import { provisionSelfHost } from '../provision/engine.mjs';
import { PROVIDERS } from '../provision/providers.mjs';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hostNameFor } from './ssh-bridge.mjs';

// The engine names its steps with ids ('validate-token', 'create-server' with
// "cx33 @ nbg1" as detail); the door printed those raw, under a tick each, to a
// person who has never seen either. Plain words here, the ids stay the engine's
// (its tests and resume state speak them). An unknown id still shows, as itself.
export function stepWords(step, detail, own = false) {
  // A server the person's assistant already lives on (own server, adopt mode):
  // checked and set up beside what it runs.
  if (own === 'adopt') {
    switch (step) {
      case 'validate-token': return 'Checking your server and your assistant\u2019s folder';
      case 'ensure-ssh-key': return 'Using this computer\u2019s key, already on your server';
      case 'create-server': return 'Setting up your assistant\u2019s container beside what the server already runs (a few minutes)';
      case 'wait-running': return 'Finishing setup';
      case 'done': return detail ? `Your assistant is set up, at ${detail}, in move-in mode` : 'Your assistant is set up, in move-in mode';
      default: break;
    }
  }
  // A server the person made themselves (providers.mjs ownServer) is checked
  // and set up, not created; its steps say so.
  if (own) {
    switch (step) {
      case 'validate-token': return 'Checking your server';
      case 'ensure-ssh-key': return 'Using this computer\u2019s key, already on your server';
      case 'create-server': return 'Setting up your server: Docker and your assistant (a few minutes)';
      case 'wait-running': return 'Finishing setup';
      case 'done': return detail ? `Your server is ready, at ${detail}` : 'Your server is ready';
      default: break;
    }
  }
  switch (step) {
    case 'validate-token': return 'Checking your hosting token';
    case 'ensure-ssh-key': return 'Adding this computer\u2019s key to your hosting account';
    case 'create-server': return 'Creating your server';
    case 'wait-running': return 'Waiting for the server to switch on';
    case 'done': return detail ? `Server switched on, at ${detail}` : 'Server switched on';
    default: return detail ? `${step} (${detail})` : step;
  }
}

// false for a cloud build, true for an own server, 'adopt' for an own server
// whose details carry mode 'adopt'.
function ownKind(run) {
  if (!(PROVIDERS[run.provider] && PROVIDERS[run.provider].ownServer)) return false;
  try { return JSON.parse(run.token).mode === 'adopt' ? 'adopt' : true; } catch { return true; }
}

export async function buildBox(run, deps) {
  const { install, pin, probe, register, syncStartDir, openFolder, settingsPath, makeClient,
    saveState = () => {}, sleep, bootTimeoutMs, bootPollMs, files, image, sshDir } = deps;
  run.phase = 'provisioning';
  // Key before birth: installMemberAccess with a placeholder address mints (or
  // reuses) the keypair and writes the Host block; the second call below repairs
  // HostName to the real IP (repair-on-rerun is installAccess's own documented
  // behaviour, 2026-08-14), so a crash in between leaves nothing worse than a
  // dead-address block the door already knows how to Forget.
  const pre = install({ slug: run.slug, host: '0.0.0.0', user: 'member' }, sshDir);
  const ownerPubKey = String(pre.publicKey).trim().split('\n')[0];
  const r = await provisionSelfHost({
    token: run.token, boxName: run.slug, ownerPubKey, state: run.state, provider: run.provider,
    onStep: (step, detail) => { run.steps.push(stepWords(step, detail, ownKind(run))); },
    overrides: {
      client: makeClient(run.token, run.provider),
      ...(files ? { files } : {}),
      ...(image ? { image } : {}),
      ...(run.location ? { location: run.location } : {}),
      ...(run.serverType ? { serverType: run.serverType } : {}),
    },
  });
  saveState(run.slug, run.state);
  run.ip = r.ip;
  install({ slug: run.slug, host: r.ip, user: 'member' }, sshDir);
  run.phase = 'booting';
  // First boot pulls the image; minutes, not seconds. Silence here is normal, so
  // the deadline is generous. The probe goes through the whole chain on purpose:
  // owner key -> sshd ForceCommand -> enter-aios -> the container. Its echo
  // answering IS the box working, not a proxy for it (live-cert 2026-09-01).
  const deadline = Date.now() + bootTimeoutMs;
  for (;;) {
    let p; try { p = await probe(run.alias); } catch { p = null; }
    if (p && p.code === 0 && String(p.stdout || '').includes('chain-ok')) break;
    // No button names here: the door and the team flow offer different ones,
    // and each adds its own (2026-10-13: this once named a button no screen has).
    if (Date.now() > deadline) throw new Error('The server was created, but its workspace never answered.');
    await sleep(bootPollMs);
  }
  await finishBox({ alias: run.alias, slug: run.slug, ip: run.ip }, deps);
  run.state.booted = true;
  saveState(run.slug, run.state);
  run.phase = 'ready';
  return run;
}

// What a build does once the chain answers: pin the host key where the Claude
// Code app can see it, and write that app's Environment entry (plus the start
// folder the box asks for). Shared by buildBox and repairUnfinished, so a build
// finished late is finished the same way as one finished on time.
export async function finishBox({ alias, slug, ip }, deps) {
  const { pin, register, syncStartDir, openFolder, settingsPath, sshDir } = deps;
  pin(ip, { sshDir });
  // THE ENVIRONMENT ENTRY IN THE CLAUDE CODE APP. Without it a healthy, reachable,
  // pinned box never appears in the dropdown, the one surface that can open it
  // (found by Sam on the first working box, 2026-09-01). Best-effort: a settings
  // refusal must never fail a build that worked.
  try {
    register({ id: alias, name: slug, sshHost: alias, startDirectory: '/state' }, settingsPath);
    // /state/<name> is the folder the box wants opened, and it can only be asked
    // now the chain is proven.
    let of = null;
    try { of = await openFolder(alias); } catch { of = null; }
    if (of && of.code === 0) syncStartDir(alias, String(of.stdout || ''), settingsPath);
  } catch { /* the mineral is up; the dropdown entry is repairable by hand */ }
}

// A BUILD THE APP STOPPED WATCHING (adopt rehearsal T4, finding 9). The pin and
// the Claude Code entry above happen only after the first-boot probe passes in
// the SAME app run, and that wait is minutes. Close the app during it and the
// mineral comes up fine, but ~/.ssh/known_hosts never gets its key (the Claude
// Code app's bundled ssh2 reads only that file and never accepts a new key) and
// the dropdown never gets its entry; reopening the app did nothing about it.
//
// So on start the app walks its own build records (<slug>-box.provision.json,
// written only by provision-routes, the one writer) and, for each one not marked
// booted whose ssh alias has a real address and whose chain now answers
// chain-ok, does what the build would have done and marks it booted. Idempotent
// (a booted record is never touched), best-effort (never throws), and `busy`
// lets the caller skip a slug a live build in this session still owns.
// Returns { repaired: [alias], waiting: [alias] }: waiting = not answering yet,
// worth asking again later.
export async function repairUnfinished(deps) {
  const { sshDir, probe, loadState, saveState, busy = () => false, log = () => {} } = deps;
  const out = { repaired: [], waiting: [] };
  let files = [];
  try { files = readdirSync(sshDir).filter((f) => /^[a-z0-9][a-z0-9-]*-box\.provision\.json$/.test(f)); } catch { return out; }
  const cfg = join(sshDir, 'config');
  for (const f of files) {
    const slug = f.slice(0, -'-box.provision.json'.length);
    const alias = `${slug}-box`;
    try {
      if (busy(slug)) continue;
      const state = loadState(slug);
      if (!state || typeof state !== 'object' || state.booted) continue;
      // No Host block (forgotten), or the pre-birth placeholder: nothing to dial.
      if (!existsSync(cfg)) continue;
      const ip = hostNameFor(alias, cfg);
      if (!ip || ip === '0.0.0.0') continue;
      let p; try { p = await probe(alias); } catch { p = null; }
      if (!(p && p.code === 0 && String(p.stdout || '').includes('chain-ok'))) { out.waiting.push(alias); continue; }
      await finishBox({ alias, slug, ip }, deps);
      // Re-read before writing: the record is the build's, and a build started
      // while the probe was out owns it now.
      if (busy(slug)) continue;
      const fresh = loadState(slug);
      if (fresh && typeof fresh === 'object' && !fresh.booted) {
        fresh.booted = true;
        saveState(slug, fresh);
      }
      out.repaired.push(alias);
      log(`build repair: ${alias} pinned and registered after a build the app stopped watching`);
    } catch (e) {
      log(`build repair: ${alias} skipped (${String((e && e.message) || e)})`);
    }
  }
  return out;
}

// When to ask again. The app runs `repair` a little after start (never in the
// way of startup's own ssh traffic), then again while any record is still
// waiting for its mineral to answer, until `forMs` has passed. A run that
// throws counts as nothing waiting. Timers are unref'd: this never holds the
// app open. Returns a stop function.
export function scheduleRepair(repair, { firstMs = 8000, everyMs = 5 * 60_000, forMs = 60 * 60_000,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  const until = now() + forMs;
  let timer = null; let stopped = false;
  const arm = (ms) => {
    timer = setTimer(tick, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };
  async function tick() {
    if (stopped) return;
    let r = null;
    try { r = await repair(); } catch { r = null; }
    if (stopped) return;
    if (r && Array.isArray(r.waiting) && r.waiting.length && now() + everyMs <= until) arm(everyMs);
  }
  arm(firstMs);
  return () => { stopped = true; if (timer) clearTimer(timer); };
}
