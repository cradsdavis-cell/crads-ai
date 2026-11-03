// update.mjs: the member decides when their mineral updates (Sam's ruling 2026-11-03).
//
// Two rulings, the same day, after a member lost a day of work (trap 82):
//   "It's just the infrastructure that should get wiped and reset. Not anything else."
//   "The box should only restart when the user actually wants to update."
//
// Before this, a scheduler job restarted every member box at 04:10 plus a per-box
// offset EVERY night, new software or not, and the host pulled whatever was
// published on every start. So a night with no release still killed live work, and
// a crash or a host reboot was a silent update. Now:
//
//   check     asks the registry (anonymously, the image is public) whether the tag
//             this box follows points somewhere other than the build it runs, and
//             writes the answer to <state>/cockpit/update-status.json. Read-only.
//   request   writes the flag the HOST reads on the next start: it pulls the
//             published image only when this file exists (cloud-init unit), then
//             deletes it. No flag, no pull: a restart that nobody asked to be an
//             update comes back on the same software.
//   auto      the optional overnight update, OFF unless the member switched it on
//             (cockpit/auto-update.json {"enabled": true}). Even then it restarts
//             only when there IS a new version and nothing is running.
//
// The flag lives in /state/.kernel/, which the brain never commits (brain-ignore).
// The host treats it as a bare existence check: all it can trigger is a pull of
// the tag the host was stamped with, which is the update the member asked for.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { loadavg } from 'node:os';
import path from 'node:path';

export const DEFAULT_IMAGE = 'ghcr.io/cradsdavis-cell/crads-pebble:v2';
export const STATUS_FILE = (stateDir) => path.join(stateDir, 'cockpit', 'update-status.json');
export const FLAG_FILE = (stateDir) => path.join(stateDir, '.kernel', 'update-requested');
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

// The optional overnight update is opt-IN: only an explicit true turns it on. A
// missing or unreadable file is off, never on (the old default was on).
export function autoUpdateEnabled(stateDir) {
  try { return JSON.parse(readFileSync(path.join(stateDir, 'cockpit', 'auto-update.json'), 'utf8')).enabled === true; } catch { return false; }
}

// "ghcr.io/owner/name:tag" -> { registry, repo, tag }. Digest refs and other
// registries are answered as unknown rather than guessed at.
export function parseImage(ref) {
  const m = /^([a-z0-9.-]+)\/([a-z0-9._/-]+):([A-Za-z0-9._-]+)$/.exec(String(ref || ''));
  return m ? { registry: m[1], repo: m[2], tag: m[3] } : null;
}

// What this box runs. /etc/aios-build is baked at build time (Dockerfile.member);
// AIOS_IMAGE_TAG is the same tag as an env var.
export function currentBuild({ buildFile = '/etc/aios-build', env = process.env } = {}) {
  let b = {};
  try { b = JSON.parse(readFileSync(buildFile, 'utf8')); } catch { /* not baked */ }
  const tag = (b.tag && b.tag !== 'unknown') ? b.tag : (env.AIOS_IMAGE_TAG && env.AIOS_IMAGE_TAG !== 'unknown' ? env.AIOS_IMAGE_TAG : null);
  const sha = (b.sha && b.sha !== 'unknown') ? b.sha : null;
  return { tag, sha, security: Number(env.AIOS_SECURITY_LEVEL) || 0 };
}

async function registryToken(img, fetchImpl) {
  if (img.registry !== 'ghcr.io') return null;
  const r = await fetchImpl(`https://ghcr.io/token?scope=repository:${img.repo}:pull`);
  if (!r.ok) throw new Error(`token ${r.status}`);
  return (await r.json()).token;
}

async function manifest(img, tag, token, fetchImpl, accept = MANIFEST_ACCEPT) {
  const r = await fetchImpl(`https://${img.registry}/v2/${img.repo}/manifests/${tag}`, {
    headers: { Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!r.ok) throw new Error(`manifest ${tag} ${r.status}`);
  return { digest: r.headers.get('docker-content-digest'), body: await r.json() };
}

// The published image's own env, read from its config blob: AIOS_SECURITY_LEVEL
// says whether the new version carries a security fix this box lacks. Best
// effort: an older image has no such variable, which reads as 0.
async function publishedEnv(img, index, token, fetchImpl) {
  let m = index.body;
  if (Array.isArray(m.manifests)) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const pick = m.manifests.find((x) => x.platform && x.platform.os === 'linux' && x.platform.architecture === arch) || m.manifests[0];
    m = (await manifest(img, pick.digest, token, fetchImpl, pick.mediaType || MANIFEST_ACCEPT)).body;
  }
  if (!m.config || !m.config.digest) return {};
  const r = await fetchImpl(`https://${img.registry}/v2/${img.repo}/blobs/${m.config.digest}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!r.ok) return {};
  const cfg = await r.json();
  const env = {};
  for (const kv of (cfg.config && cfg.config.Env) || []) { const i = kv.indexOf('='); if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1); }
  return env;
}

// Is there a newer published version than the one running? Compares the digest of
// the tag this box follows with the digest of the tag it was built as. Never throws:
// a check that cannot answer says so ({ available: null, error }).
export async function checkForUpdate({ image = process.env.AIOS_IMAGE || DEFAULT_IMAGE, build = currentBuild(), fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  const out = { checked_at: now.toISOString(), image, current: build.tag, available: null, security: false };
  const img = parseImage(image);
  if (!img) return { ...out, error: 'unrecognised image reference' };
  if (!build.tag) return { ...out, error: 'this build does not know its own version' };
  try {
    const token = await registryToken(img, fetchImpl);
    const latest = await manifest(img, img.tag, token, fetchImpl);
    const mine = await manifest(img, build.tag, token, fetchImpl);
    out.available = !!latest.digest && latest.digest !== mine.digest;
    if (out.available) {
      const env = await publishedEnv(img, latest, token, fetchImpl).catch(() => ({}));
      if (env.AIOS_IMAGE_TAG) out.latest = env.AIOS_IMAGE_TAG;
      out.security = (Number(env.AIOS_SECURITY_LEVEL) || 0) > build.security;
    }
    return out;
  } catch (e) {
    return { ...out, error: String(e && e.message || e) };
  }
}

function writeJsonAtomic(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj) + '\n');
  renameSync(tmp, file);
}

export function readStatus(stateDir) {
  try { return JSON.parse(readFileSync(STATUS_FILE(stateDir), 'utf8')); } catch { return null; }
}

export function requestUpdate(stateDir, now = new Date()) {
  mkdirSync(path.dirname(FLAG_FILE(stateDir)), { recursive: true });
  writeFileSync(FLAG_FILE(stateDir), now.toISOString() + '\n');
}

// Nothing running = no Claude session or job, and the machine is not busy with
// anything else a member started (a video render, a download). The load test is
// what catches work that is not Claude: anything heavy keeps the 1-minute load up.
export function isIdle({ procDir = '/proc', load = loadavg()[0], maxLoad = 0.5 } = {}) {
  if (load >= maxLoad) return { idle: false, why: `busy (load ${load.toFixed(2)})` };
  let pids = [];
  try { pids = readdirSync(procDir).filter((d) => /^\d+$/.test(d)); } catch { return { idle: true }; }
  for (const pid of pids) {
    let cmd = '';
    try { cmd = readFileSync(path.join(procDir, pid, 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' '); } catch { continue; }
    // The claude CLI is a node script, so match it as an argument too.
    if (/(^|[\s/])claude(\s|$)/.test(cmd)) return { idle: false, why: 'a Claude session is running' };
  }
  return { idle: true };
}

// The optional overnight update. Returns what it decided; the CLI restarts the
// box (kill 1) only on { restart: true }.
export async function autoStep(stateDir, { now = new Date(), check = checkForUpdate, idle = isIdle, maxAgeMs = 6 * 3600e3 } = {}) {
  if (!autoUpdateEnabled(stateDir)) return { restart: false, why: 'automatic updates are off' };
  let st = readStatus(stateDir);
  if (!st || !st.checked_at || now - new Date(st.checked_at) > maxAgeMs) {
    st = await check({ now });
    writeJsonAtomic(STATUS_FILE(stateDir), st);
  }
  if (st.available !== true) return { restart: false, why: st.error ? `could not check: ${st.error}` : 'already on the latest version' };
  const i = idle();
  if (!i.idle) return { restart: false, why: i.why };
  requestUpdate(stateDir, now);
  return { restart: true, why: `updating to ${st.latest || 'the latest version'}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [verb, stateDir = '/state'] = process.argv.slice(2);
  if (verb === 'check') {
    const st = await checkForUpdate();
    writeJsonAtomic(STATUS_FILE(stateDir), st);
    console.log(JSON.stringify(st));
  } else if (verb === 'request') {
    requestUpdate(stateDir);
    console.log('OK: update requested');
  } else if (verb === 'auto') {
    const r = await autoStep(stateDir);
    console.log(r.why);
    if (r.restart) { const { spawn } = await import('node:child_process'); spawn('bash', ['-c', '(sleep 2; kill 1) </dev/null >/dev/null 2>&1 &'], { detached: true, stdio: 'ignore' }).unref(); }
  } else {
    console.error('usage: update.mjs check|request|auto <stateDir>');
    process.exit(2);
  }
}
