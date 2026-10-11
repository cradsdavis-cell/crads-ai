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
    onStep: (step, detail) => { run.steps.push(detail ? `${step} (${detail})` : step); },
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
    if (Date.now() > deadline) throw new Error('the server was created but its workspace never answered; Retry checks again, or Start over rebuilds it');
    await sleep(bootPollMs);
  }
  pin(run.ip, { sshDir });
  // THE ENVIRONMENT ENTRY IN THE CLAUDE CODE APP. Without it a healthy, reachable,
  // pinned box never appears in the dropdown, the one surface that can open it
  // (found by Sam on the first working box, 2026-09-01). Best-effort: a settings
  // refusal must never fail a build that worked.
  try {
    register({ id: run.alias, name: run.slug, sshHost: run.alias, startDirectory: '/state' }, settingsPath);
    // /state/<name> is the folder the box wants opened, and it can only be asked
    // now the chain is proven.
    let of = null;
    try { of = await openFolder(run.alias); } catch { of = null; }
    if (of && of.code === 0) syncStartDir(run.alias, String(of.stdout || ''), settingsPath);
  } catch { /* the mineral is up; the dropdown entry is repairable by hand */ }
  run.state.booted = true;
  saveState(run.slug, run.state);
  run.phase = 'ready';
  return run;
}
