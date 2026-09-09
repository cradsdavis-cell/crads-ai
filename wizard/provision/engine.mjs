// engine.mjs — the wizard's provisioning engine (self-host pivot, 2026-09-01).
//
// Orchestrates: validate token → ensure SSH key → render cloud-init → create
// server → wait running. Resumable: every step writes its result into `state`
// (a plain object the caller persists wherever it likes — the app keeps it in
// its config dir) so a crashed run resumes instead of double-creating, and a
// half-created server is visible with its id for destroy-and-retry. The
// provider token itself is NEVER written into state.
//
// Providers (2026-09-09): the engine drives whichever client providers.mjs
// hands it for `provider` (Hetzner by default, DigitalOcean the second). The
// provider is written into state on the first step and checked on resume,
// because a state file started on one provider names a server id that means
// nothing on the other: resuming it there would create a second server.

import { providerOf, DEFAULT_PROVIDER } from './providers.mjs';
import { renderSelfHostCloudInit } from './selfhost-cloudinit.mjs';

export const DEFAULT_IMAGE = 'ghcr.io/cradsdavis-cell/crads-pebble:v2'; // public on GHCR (verified 2026-08-20)
// Hetzner's defaults, kept under their old names for the callers that read
// them; per-provider defaults live in providers.mjs.
export const DEFAULT_SERVER_TYPE = providerOf(DEFAULT_PROVIDER).defaults.serverType;
export const DEFAULT_LOCATION = providerOf(DEFAULT_PROVIDER).defaults.location;

/**
 * @param {object} o
 * @param {string} o.token         the user's provider API token (in-memory only)
 * @param {string} [o.provider]    'hetzner' (default) or 'digitalocean'; see providers.mjs
 * @param {string} o.boxName
 * @param {string} o.ownerPubKey   ssh-ed25519 line (the app's own identity key)
 * @param {object} o.state         mutable run state; caller persists between steps
 * @param {(step: string, detail?: string) => void} [o.onStep]
 * @param {object} [o.overrides]   {serverType, location, image, client}
 */
export async function provisionSelfHost({ token, boxName, ownerPubKey, state, onStep = () => {}, overrides = {}, provider = DEFAULT_PROVIDER }) {
  const P = providerOf(provider);
  if (state.provider && state.provider !== P.id) {
    throw new Error(`this build was started on ${providerOf(state.provider).label}, not ${P.label}; remove the half-made server there, or give the new one a different name`);
  }
  state.provider = P.id;
  const hc = overrides.client ?? P.makeClient(token);
  const serverType = overrides.serverType ?? P.defaults.serverType;
  const location = overrides.location ?? P.defaults.location;
  const image = overrides.image ?? DEFAULT_IMAGE;

  if (!state.tokenValidated) {
    onStep('validate-token');
    const v = await hc.validateToken();
    if (!v.ok) throw new Error(v.reason === 'unauthorized'
      ? `${P.label} rejected the token. Check it is a read-write API token for the right account.`
      : `could not reach ${P.label}: ${v.reason}`);
    state.tokenValidated = true;
  }

  if (!state.sshKeyId) {
    onStep('ensure-ssh-key');
    state.sshKeyId = await hc.ensureSshKey(`${boxName}-owner`, ownerPubKey);
  }

  if (!state.serverId) {
    onStep('create-server', `${serverType} @ ${location}`);
    const userData = renderSelfHostCloudInit({ boxName, ownerPubKey, image, files: overrides.files });
    const created = await hc.createServer({
      name: `aios-${boxName}`,
      serverType,
      location,
      sshKeyIds: [state.sshKeyId],
      userData,
    });
    state.serverId = created.id;
    state.serverIp = created.ip;
    state.createActionId = created.actionId;
  }

  if (!state.serverRunning) {
    onStep('wait-running');
    if (state.createActionId) await hc.waitAction(state.createActionId);
    // The create action reports success while the server is still 'starting';
    // poll the server itself (live-cert finding, 2026-09-01).
    const deadline = Date.now() + (overrides.runningTimeoutMs ?? 180_000);
    for (;;) {
      const s = await hc.getServer(state.serverId);
      state.serverIp = s.ip ?? state.serverIp;
      if (s.status === 'running') { state.serverRunning = true; break; }
      if (['off', 'deleting', 'unknown'].includes(s.status) || Date.now() > deadline) {
        throw new Error(`server is '${s.status}', not running; retry or destroy-and-retry`);
      }
      await (overrides.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(3000);
    }
  }

  onStep('done', `${state.serverIp}`);
  return { serverId: state.serverId, ip: state.serverIp };
  // Next wizard steps (separate modules, separate consent): write the SSH
  // config Host block + known_hosts entry, GitHub brain-repo creation via
  // device flow, and the on-box `claude setup-token` walk. None of them touch
  // the provider again.
}

/** destroy-and-retry for a half-created run. Only ever the user's own metal. */
export async function destroySelfHost({ token, state, client, provider }) {
  if (!state.serverId) return { destroyed: false };
  const P = providerOf(provider || state.provider || DEFAULT_PROVIDER);
  const hc = client ?? P.makeClient(token);
  await hc.deleteServer(state.serverId);
  for (const k of ['serverId', 'serverIp', 'createActionId', 'serverRunning']) delete state[k];
  return { destroyed: true };
}
