// own-server.mjs: "a server you already have" (2026-10-15, Sam: "I want to
// cover all the bases"). The provisioning client for a Linux machine the
// person made themselves: rented at AWS, Google Cloud, Azure or anywhere else,
// or a machine they physically own (an old PC, a mini PC, a Raspberry Pi 5, an
// office server). Same contract as hetzner.mjs (see providers.mjs), but it
// talks SSH instead of a cloud API, so no cloud credential ever reaches the app.
//
// THE FLOW. The person names the mineral and the app shows that mineral's
// public key (minted before anything exists, /provision/own-key). They put the
// key on their server for a login that has passwordless sudo (every cloud
// console has an "SSH key" box for exactly this), then give the app the
// address and that login. validateToken() checks the machine over SSH;
// createServer() hands the machine's OWN cloud-init the same setup file a
// Hetzner or DigitalOcean build boots with, module by module, so the result
// is the same mineral; the build then carries on exactly as for any provider.
//
// THE TOKEN is the door's JSON from credentialFields, { host, user }, plus the
// mineral's `slug`, which provision-routes adds (the key on this computer is
// named after it). Nothing in it is secret. SSH is port 22 only, on purpose:
// the setup's firewall lets SSH in on 22 and nothing else, so a server reached
// on another port would lock itself out the moment setup finished. A machine
// at home reached from outside goes through Tailscale, which is port 22 too.
//
// WHY CLOUD-INIT, ON DEMAND. `cloud-init single --name <module> --file <ours>`
// runs one module against our file on a machine that has already booted.
// Proven on a stand-in Ubuntu 24.04 server where cloud-init never ran at boot
// (2026-10-15): users, files, timezone and packages applied; runcmd only WROTE
// its script, because scripts_user looks for a current instance that such a
// machine does not have, so the script is run directly here. That is also
// right on a cloud machine, where scripts_user would re-run the provider's own
// first-boot scripts as well.
//
// WHAT IT NEVER DOES. It never deletes or resets the person's machine: there
// is no API to do it with, and it is their machine. "Remove" forgets it on
// this computer only (the build's state), and says so.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\d{1,3}(?:\.\d{1,3}){3}|\[?[0-9A-Fa-f:]+\]?)$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

// The modules the setup file needs, in the order a first boot effectively
// gives them: the users first (files and services are owned by them), then
// the files, the timezone, the packages (ufw and fail2ban, which the commands
// use), and the commands last.
export const SETUP_MODULES = ['users_groups', 'write_files', 'timezone', 'package_update_upgrade_install', 'runcmd'];

// A 4 GB machine reports about 3.7 GB to the kernel; below this it is a 2 GB
// machine, which the measurements on 2026-10-15 say is too small.
export const MIN_MEMORY_MB = 3300;
export const MIN_FREE_DISK_GB = 15;
const UBUNTU_OK = ['22.04', '24.04'];

export class OwnServerError extends Error {
  constructor(message, { code } = {}) { super(message); this.code = code; }
}

export function parseOwnServer(token) {
  let t;
  try { t = typeof token === 'string' ? JSON.parse(token) : token; } catch { t = null; }
  if (!t || typeof t !== 'object') return { error: 'the server details did not arrive' };
  const host = String(t.host || '').trim();
  const user = String(t.user || 'ubuntu').trim();
  const port = 22;
  const slug = String(t.slug || '').trim();
  if (!host || !HOST_RE.test(host)) return { error: 'the server address does not look like an address or a hostname' };
  if (!USER_RE.test(user)) return { error: 'the login name does not look like a Linux user name' };
  if (slug && !SLUG_RE.test(slug)) return { error: 'the mineral name is not valid' };
  return { host: host.replace(/^\[|\]$/g, ''), user, port, slug };
}

// The default runner: the system ssh client, with this mineral's own key and
// the app's own known_hosts (the same file every later connection uses).
// Tests inject a fake with the same shape.
function systemRunner({ sshExe = 'ssh', knownHosts } = {}) {
  return ({ host, user, port, keyPath, command, input, timeoutMs }) => new Promise((resolve) => {
    const args = [
      '-i', keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'ServerAliveInterval=20',
      '-p', String(port), `${user}@${host}`, command,
    ];
    const p = spawn(sshExe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { p.kill('SIGTERM'); }, timeoutMs);
    p.stdout.on('data', (c) => { stdout += c; });
    p.stderr.on('data', (c) => { stderr += c; });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: String(e.message) }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    p.stdin.end(input || '');
  });
}

// Runs what it is given as root: directly when the login is root, through
// passwordless sudo otherwise. The script arrives on stdin, never in argv.
const AS_ROOT = 'if [ "$(id -u)" = 0 ]; then bash -s; else sudo -n bash -s; fi';

const CHECK_SCRIPT = `
echo "uid=$(id -u)"
if [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; then echo sudo=ok; else echo sudo=no; fi
. /etc/os-release 2>/dev/null; echo "os=$ID"; echo "version=$VERSION_ID"
echo "arch=$(uname -m)"
echo "mem_mb=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)"
echo "cpus=$(nproc 2>/dev/null || echo 1)"
echo "disk_gb=$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc 0-9)"
command -v cloud-init >/dev/null 2>&1 && echo cloudinit=yes || echo cloudinit=no
command -v systemctl >/dev/null 2>&1 && echo systemd=yes || echo systemd=no
[ -e /etc/ai-os/env ] && echo existing=yes || echo existing=no
`;

export function setupScript(userData) {
  const b64 = Buffer.from(String(userData), 'utf8').toString('base64').replace(/(.{76})/g, '$1\n');
  return `set -eu
d=$(mktemp -d /root/crads-setup.XXXXXX)
base64 -d > "$d/user-data.yaml" <<'CRADS_B64'
${b64}
CRADS_B64
for m in ${SETUP_MODULES.join(' ')}; do
  echo "crads-step: $m"
  cloud-init single --name "$m" --frequency always --file "$d/user-data.yaml" > "$d/$m.log" 2>&1 || { echo "crads-failed: $m"; tail -20 "$d/$m.log"; exit 41; }
done
s=$(ls -t /var/lib/cloud/instance/scripts/runcmd /var/lib/cloud/instances/*/scripts/runcmd 2>/dev/null | head -1)
[ -n "$s" ] || { echo "crads-failed: runcmd script not written"; exit 42; }
echo "crads-step: commands"
sh "$s" > "$d/commands.log" 2>&1 || { echo "crads-failed: commands"; tail -30 "$d/commands.log"; exit 43; }
echo crads-setup-ok
`;
}

export class OwnServerClient {
  constructor(token, { sshDir = join(homedir(), '.ssh'), knownHosts, runner, sshExe } = {}) {
    if (!token) throw new OwnServerError('the server details are required');
    this.t = parseOwnServer(token);
    this.sshDir = sshDir;
    this.run = runner || systemRunner({ sshExe, knownHosts: knownHosts || join(homedir(), '.crads-ai', 'known_hosts') });
    this.facts = null;
  }

  keyPath() { return join(this.sshDir, `${this.t.slug}-box.key`); }

  async ssh(command, input, timeoutMs = 60_000) {
    if (this.t.error) throw new OwnServerError(this.t.error, { code: 'bad_details' });
    if (!this.t.slug) throw new OwnServerError('name the mineral first, so the app knows which key to use', { code: 'bad_details' });
    return this.run({ host: this.t.host, user: this.t.user, port: this.t.port, keyPath: this.keyPath(), command, input, timeoutMs });
  }

  /** Reads the machine and says, in words, why it will not do. Changes nothing. */
  async validateToken() {
    if (this.t.error) return { ok: false, reason: this.t.error };
    let r;
    try { r = await this.ssh('bash -s', CHECK_SCRIPT, 30_000); } catch (e) { return { ok: false, reason: e.message }; }
    if (r.code !== 0) return { ok: false, reason: sshReason(r, this.t) };
    const f = Object.fromEntries(String(r.stdout).split('\n').map((l) => l.trim().split('=')).filter((p) => p.length === 2));
    const facts = {
      sudo: f.sudo === 'ok', os: f.os || '', version: f.version || '', arch: f.arch || '',
      memoryMb: Number(f.mem_mb) || 0, cpus: Number(f.cpus) || 1, diskGb: Number(f.disk_gb) || 0,
      cloudInit: f.cloudinit === 'yes', systemd: f.systemd === 'yes', existing: f.existing === 'yes',
    };
    this.facts = facts;
    if (!facts.sudo) return { ok: false, reason: `the login "${this.t.user}" needs passwordless sudo (cloud servers have it for their default login; on your own machine, add it with visudo)` };
    if (facts.os !== 'ubuntu' || !UBUNTU_OK.includes(facts.version)) return { ok: false, reason: `this needs Ubuntu 24.04 (or 22.04); the server runs ${facts.os || 'an unknown system'} ${facts.version}`.trim() };
    if (!['x86_64', 'aarch64'].includes(facts.arch)) return { ok: false, reason: `this needs an Intel/AMD (x86_64) or Arm (aarch64) machine; this one is ${facts.arch || 'unknown'}` };
    if (!facts.systemd) return { ok: false, reason: 'this needs a normal Ubuntu install with systemd' };
    if (!facts.cloudInit) return { ok: false, reason: 'cloud-init is missing; install it on the server with: sudo apt install cloud-init' };
    if (facts.memoryMb < MIN_MEMORY_MB) return { ok: false, reason: `this needs at least 4 GB of memory; the server has about ${Math.round(facts.memoryMb / 1024 * 10) / 10} GB` };
    if (facts.diskGb < MIN_FREE_DISK_GB) return { ok: false, reason: `this needs at least ${MIN_FREE_DISK_GB} GB of free disk; the server has ${facts.diskGb} GB` };
    return { ok: true, facts };
  }

  async listLocations() {
    return [{ name: 'own', city: this.t.host || 'Your server', country: '' }];
  }

  /** One "machine": the server itself, described by what it reported. */
  async listServerTypes() {
    if (!this.facts) await this.validateToken();
    const f = this.facts || {};
    return [{
      id: 'own', name: 'own', cores: f.cpus || 0, memoryGb: Math.round((f.memoryMb || 0) / 1024),
      diskGb: f.diskGb || 0, arch: f.arch === 'aarch64' ? 'arm' : 'x86', prices: {},
    }];
  }

  async listAvailability() { return { own: ['own'] }; }

  // The key is already on the machine: the person put it there.
  async ensureSshKey() { return 'own'; }
  async deleteSshKey() {}

  async createServer({ userData }) {
    if (!this.facts) {
      const v = await this.validateToken();
      if (!v.ok) throw new OwnServerError(v.reason, { code: 'not_ready' });
    }
    // Docker's install and the first image pull take a few minutes on a small
    // machine; the ceiling is generous, a stall still ends.
    const r = await this.ssh(AS_ROOT, setupScript(userData), 30 * 60_000);
    if (r.code !== 0 || !String(r.stdout).includes('crads-setup-ok')) {
      const step = (String(r.stdout).match(/crads-failed: (.+)/) || [])[1];
      throw new OwnServerError(step
        ? `setting up the server stopped at "${step}". The details are in /root/crads-setup.* on the server.`
        : sshReason(r, this.t), { code: 'setup_failed' });
    }
    return { id: this.t.host, ip: this.t.host, actionId: null };
  }

  async waitAction() { return null; }

  // The engine polls until 'running'; the machine was running all along.
  async getServer(id) { return { id, name: id, status: 'running', ip: this.t.host }; }

  // Never touches the person's machine. Forgetting it is the caller's job.
  async deleteServer() { return { forgotten: true }; }
}

function sshReason(r, t) {
  const e = String(r.stderr || '');
  if (/Permission denied/i.test(e)) return `the server would not let this computer in as "${t.user}". Check the key shown above is on the server for that login`;
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(e)) return `the server's identity changed since this computer last saw ${t.host}. If you rebuilt it, remove its old entry and try again`;
  if (/Connection refused/i.test(e)) return `${t.host} refused a connection on port 22. Is SSH running, and is port 22 open in the firewall?`;
  if (/timed out|No route to host|Network is unreachable|Could not resolve/i.test(e) || r.code === 255) return `could not reach ${t.host} on port 22. Check the address, and that the server allows SSH from the internet (or that you are on the same network, or both on Tailscale)`;
  if (r.code === 127) return 'this computer has no ssh client to connect with';
  return `the server answered with an error (exit ${r.code})`;
}
