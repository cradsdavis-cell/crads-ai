// adopt-host.mjs: adopt a server and brain the person already has (spec
// docs/superpowers/specs/2026-10-17-adopt-existing-server.md § Flow 1 and 2).
//
// The "A server you already have" card asks "Is your assistant already on
// it?". "Yes" lands here. Three jobs, one module:
//
//   collectInventory(client)                 the read-only probe, as the host
//                                            inventory /move-in reads
//   setupSharedHost(client, opts)            the shared-server host setup
//                                            (adopt-cloudinit.mjs renders it)
//   teardownSharedHost(client, {brainRoot})  undo every host change setup made,
//                                            from <brain>/.kernel/move-in/host-setup.json
//
// `client` is an OwnServerClient (own-server.mjs): client.ssh(command, input,
// timeoutMs) runs one command over SSH as the person's login. Root work rides
// stdin through AS_ROOT, exactly as the dedicated path does.
//
// THE PROBE CHANGES NOTHING. It runs as the login, uses sudo only to READ
// (another login's crontab, a folder the login cannot list, the docker
// socket), passes git `--no-optional-locks` so not even git's index is
// refreshed, and never prints a secret: MCP server NAMES only, env file PATHS
// only, the remote's NAME and never its URL (a URL can carry a token).
//
// THE CONTRACT WITH /move-in (Builder B, engine/skills/move-in.md). After a
// passing probe, setup writes <brain>/.kernel/move-in/host-inventory.json,
// owned by the brain's owner, 0600:
//   { version: 1, collected_at, login, brain_root, owner: {uid, gid},
//     crontab: [{user, line_no, text}], units: [{name, scope, working_directory, exec_start, active}],
//     containers: [{name, image, status}], listeners: ["0.0.0.0:8080", ...],
//     skills, lazy_skills, hooks, mcp_servers, env_files (relative to brain_root),
//     git: {branch, remote, dirty} }
import { AS_ROOT_SCRIPT, publicListeners } from './own-server-shared.mjs';
import { renderAdoptSetup, mergeOwnership, SAFE_PATH_RE, ADOPT_HOST_FILES, ADOPT_HOST_DIRS, ADOPT_HOST_UNITS, ADOPT_HOST_USER, ADOPT_SWAPFILE } from './adopt-cloudinit.mjs';

export const ADOPT_MIN_FREE_DISK_GB = 5;   // the image is about 3 GB unpacked, plus 2 GB headroom
const UBUNTU_OK = ['22.04', '24.04'];
export const INVENTORY_REL = '.kernel/move-in/host-inventory.json';
export const HOST_SETUP_REL = '.kernel/move-in/host-setup.json';

// What the person may type for the folder: an absolute path, or one under
// their login's home (`~` is expanded ON THE SERVER, to the login's home).
const FOLDER_RE = /^(~|~\/[A-Za-z0-9._@+/-]*|\/[A-Za-z0-9._@+/-]+)$/;
export function parseBrainRoot(raw) {
  let s = String(raw || '').trim();
  if (s.length > 1) s = s.replace(/\/+$/, '');
  if (!s) return { error: 'type the folder your assistant lives in on the server' };
  if (!FOLDER_RE.test(s)) return { error: 'the folder should be a full path like /home/you/my-assistant (or ~/my-assistant), using letters, digits, dots, dashes, underscores and slashes only' };
  if (s === '/') return { error: 'the whole disk is not a folder your assistant lives in; give its own folder' };
  return { brainRoot: s };
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The root half of the probe. Every line is `key=value` or a tab-separated
// record whose first field names it. Reads only.
const PROBE_ROOT = String.raw`
L="$CRADS_LOGIN"; RAW="$CRADS_FOLDER"
LH=$(getent passwd "$L" | cut -d: -f6)
. /etc/os-release 2>/dev/null; echo "os=$ID"; echo "version=$VERSION_ID"
echo "arch=$(uname -m)"
echo "mem_mb=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)"
echo "cpus=$(nproc 2>/dev/null || echo 1)"
command -v systemctl >/dev/null 2>&1 && echo systemd=yes || echo systemd=no
echo "tz=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)"
[ -e /etc/ai-os/env ] && echo existing=yes || echo existing=no
getent passwd member >/dev/null 2>&1 && echo member_user=yes || echo member_user=no
[ -e /etc/ssh/sshd_config.d/60-aios-member.conf ] && echo member_ours=yes || echo member_ours=no
if command -v docker >/dev/null 2>&1; then
  echo docker=yes
  if dpkg -s docker.io 2>/dev/null | grep -q '^Status: install ok installed'; then echo docker_pkg=io
  elif dpkg -s docker-ce 2>/dev/null | grep -q '^Status: install ok installed'; then echo docker_pkg=ce
  else echo docker_pkg=other; fi
  docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx ai-os && echo aios_container=yes || echo aios_container=no
  docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null | awk -F'\t' 'NF{printf "container\t%s\t%s\t%s\n",$1,$2,$3}'
else
  echo docker=no; echo docker_pkg=none; echo aios_container=no
fi
DD=/var/lib/docker; [ -d "$DD" ] || DD=/var/lib
echo "disk_gb=$(df -BG --output=avail "$DD" 2>/dev/null | tail -1 | tr -dc 0-9)"
ss -ltnH 2>/dev/null | awk '{printf "listen\t%s\n",$4}'
echo "login_home=$LH"
case "$RAW" in
  "~") F="$LH" ;;
  "~/"*) F="$LH/$(printf '%s' "$RAW" | cut -c3-)" ;;
  *) F="$RAW" ;;
esac
echo "folder_input=$RAW"
if [ -d "$F" ]; then
  FR=$(readlink -f "$F"); echo "folder=$FR"; echo folder_dir=yes
else
  echo "folder=$F"; echo folder_dir=no; [ -e "$F" ] && echo folder_exists=yes || echo folder_exists=no
  exit 0
fi
echo "login_home_real=$(readlink -f "$LH" 2>/dev/null || echo "$LH")"
OU=$(stat -c %u "$FR"); OG=$(stat -c %g "$FR")
echo "owner_uid=$OU"; echo "owner_gid=$OG"
ON=$(getent passwd "$OU" | cut -d: -f1); echo "owner_name=$ON"
G() { git -c safe.directory='*' --no-optional-locks -C "$FR" "$@" 2>/dev/null; }
if [ "$(G rev-parse --is-inside-work-tree)" = true ]; then
  echo git=yes
  echo "git_top=$(G rev-parse --show-toplevel)"
  echo "branch=$(G symbolic-ref --short -q HEAD)"
  echo "remote=$(G remote | head -1)"
  GD=$(G rev-parse --absolute-git-dir); OP=""
  [ -d "$GD/rebase-merge" ] || [ -d "$GD/rebase-apply" ] && OP=rebase
  [ -z "$OP" ] && [ -e "$GD/MERGE_HEAD" ] && OP=merge
  [ -z "$OP" ] && [ -e "$GD/CHERRY_PICK_HEAD" ] && OP=cherry-pick
  echo "git_op=$OP"
  echo "dirty=$(G status --porcelain | wc -l)"
else
  echo git=no
fi
for d in "$FR"/.claude/skills/*/; do [ -d "$d" ] || continue; n=$(basename "$d"); [ "$n" = _lazy ] && continue; printf 'skill\t%s\n' "$n"; done
for d in "$FR"/.claude/skills/_lazy/*/; do [ -d "$d" ] && printf 'lazy\t%s\n' "$(basename "$d")"; done
for f in "$FR"/.claude/hooks/*; do [ -f "$f" ] && printf 'hook\t%s\n' "$(basename "$f")"; done
[ -f "$FR/CLAUDE.md" ] && echo claude_md=yes || echo claude_md=no
if [ -f "$FR/.mcp.json" ]; then
  python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
for k in (d.get("mcpServers") or {}): print("mcp\t"+k)' "$FR/.mcp.json" 2>/dev/null || echo mcp_unreadable=yes
fi
find "$FR" -maxdepth 4 \( -name .git -o -name node_modules -o -name .kernel -o -name .claude-auth \) -prune -o -type f \( -name .env -o -name '.env.*' -o -name '*.env' \) -printf 'env\t%P\n' 2>/dev/null
find "$FR" -mindepth 1 -maxdepth 1 -type d -printf 'top\t%f\n' 2>/dev/null
[ -f "$FR/ownership.json" ] && echo "ownership_b64=$(base64 -w0 "$FR/ownership.json")"
[ -f "$FR/.kernel/move-in/host-setup.json" ] && echo "setup_b64=$(base64 -w0 "$FR/.kernel/move-in/host-setup.json")"
for u in $(printf '%s\n%s\n' "$L" "$ON" | awk 'NF && !s[$0]++'); do
  crontab -l -u "$u" 2>/dev/null | awk -v u="$u" '{ if ($0 ~ /^[[:space:]]*(#|$)/) next; printf "cron\t%s\t%d\t%s\n", u, NR, $0 }'
done
# Services: every loaded or installed unit, filtered to the folder by the app.
units() { { "$@" list-units --type=service --all --no-legend --plain 2>/dev/null | awk '{print $1}'; "$@" list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}'; } | grep -v '@\.service$' | awk 'NF && !s[$0]++'; }
show() { xargs -r "$@" show -p Id -p ActiveState -p WorkingDirectory -p ExecStart 2>/dev/null | awk -v sc="$SC" 'BEGIN{RS="";FS="\n"} { id="";as="";wd="";ex=""; for(i=1;i<=NF;i++){ k=substr($i,1,index($i,"=")-1); v=substr($i,index($i,"=")+1); gsub(/\t/," ",v); if(k=="Id")id=v; else if(k=="ActiveState")as=v; else if(k=="WorkingDirectory")wd=v; else if(k=="ExecStart")ex=v } if(id!="") printf "unit\t%s\t%s\t%s\t%s\t%s\n",sc,id,as,wd,ex }'; }
SC=system; units systemctl | show systemctl
if [ -n "$ON" ] && [ "$OU" != 0 ] && [ -S "/run/user/$OU/bus" ]; then
  SC=user; units runuser -u "$ON" -- env XDG_RUNTIME_DIR="/run/user/$OU" systemctl --user | show runuser -u "$ON" -- env XDG_RUNTIME_DIR="/run/user/$OU" systemctl --user
fi
echo probe=done
`;

/** The whole probe: login-level checks, then the root half above through sudo. */
export function probeScript({ login, folder }) {
  return `echo "uid=$(id -u)"
if [ "$(id -u)" = 0 ]; then R=""; elif sudo -n true 2>/dev/null; then R="sudo -n"; else echo sudo=no; exit 0; fi
echo sudo=ok
command -v cloud-init >/dev/null 2>&1 && echo cloudinit=yes || echo cloudinit=no
$R env CRADS_LOGIN=${shq(login)} CRADS_FOLDER=${shq(folder)} bash -s <<'CRADS_PROBE'
${PROBE_ROOT}
CRADS_PROBE
`;
}

// ExecStart as `systemctl show` prints it: `{ path=/x ; argv[]=/x a b ; ... }`.
function execArgv(s) {
  const all = [...String(s || '').matchAll(/argv\[\]=([^;]*)/g)].map((m) => m[1].trim()).filter(Boolean);
  return all.length ? all.join(' ; ') : String(s || '').trim();
}
const under = (p, root) => !!p && (p === root || p.startsWith(root + '/'));
const mentions = (cmd, root) => String(cmd).split(/\s+/).some((t) => under(t.replace(/^[^/]*=/, ''), root));

/** The probe's output, as facts. Pure: the fixtures in adopt-host.test.mjs drive it. */
export function parseAdoptProbe(stdout) {
  const kv = {}; const rec = { container: [], listen: [], skill: [], lazy: [], hook: [], mcp: [], env: [], top: [], cron: [], unit: [] };
  for (const line of String(stdout || '').split('\n')) {
    if (!line) continue;
    if (line.includes('\t')) {
      const [kind, ...rest] = line.split('\t');
      if (rec[kind]) rec[kind].push(rest);
      continue;
    }
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  const folder = kv.folder || '';
  const dec = (b) => { if (!b) return null; try { return Buffer.from(b, 'base64').toString('utf8'); } catch { return null; } };
  const units = rec.unit.map(([scope, name, active, wd, exec]) => ({ name, scope, working_directory: wd || '', exec_start: execArgv(exec), active: active === 'active' }))
    .filter((u) => folder && (under(u.working_directory, folder) || mentions(u.exec_start, folder)));
  return {
    sudo: kv.sudo === 'ok', cloudInit: kv.cloudinit === 'yes', complete: kv.probe === 'done',
    os: kv.os || '', version: kv.version || '', arch: kv.arch || '',
    memoryMb: Number(kv.mem_mb) || 0, cpus: Number(kv.cpus) || 1, diskGb: Number(kv.disk_gb) || 0,
    systemd: kv.systemd === 'yes', tz: kv.tz || 'UTC', existing: kv.existing === 'yes',
    memberUser: kv.member_user === 'yes', memberOurs: kv.member_ours === 'yes',
    docker: kv.docker === 'yes', dockerPkg: kv.docker_pkg || 'none', aiosContainer: kv.aios_container === 'yes',
    containers: rec.container.map(([name, image, status]) => ({ name, image, status })),
    listen: rec.listen.map(([a]) => a).filter(Boolean),
    loginHome: kv.login_home || '', loginHomeReal: kv.login_home_real || kv.login_home || '',
    folderInput: kv.folder_input || '', folder, folderDir: kv.folder_dir === 'yes', folderExists: kv.folder_exists === 'yes' || kv.folder_dir === 'yes',
    ownerUid: kv.owner_uid === undefined ? null : Number(kv.owner_uid), ownerGid: kv.owner_gid === undefined ? null : Number(kv.owner_gid), ownerName: kv.owner_name || '',
    git: kv.git === 'yes', gitTop: kv.git_top || '', branch: kv.branch || '', remote: kv.remote || '', gitOp: kv.git_op || '', dirty: Number(kv.dirty) || 0,
    skills: rec.skill.map(([n]) => n), lazySkills: rec.lazy.map(([n]) => n), hooks: rec.hook.map(([n]) => n),
    claudeMd: kv.claude_md === 'yes', mcpServers: rec.mcp.map(([n]) => n), envFiles: rec.env.map(([p]) => p), topDirs: rec.top.map(([n]) => n),
    ownershipText: dec(kv.ownership_b64), hostSetupText: dec(kv.setup_b64),
    crontab: rec.cron.map(([user, n, ...text]) => ({ user, line_no: Number(n), text: text.join('\t') })),
    units,
  };
}

/** Why this server cannot be adopted, in words; null when it can. Spec § Flow 1. */
export function adoptRefusal(f, { login }) {
  if (!f.sudo) return `the login "${login}" needs passwordless sudo (cloud servers have it for their default login; on your own machine, add it with visudo)`;
  if (f.os !== 'ubuntu' || !UBUNTU_OK.includes(f.version)) return `this needs Ubuntu 24.04 (or 22.04); the server runs ${f.os || 'an unknown system'} ${f.version}`.trim();
  if (!['x86_64', 'aarch64'].includes(f.arch)) return `this needs an Intel/AMD (x86_64) or Arm (aarch64) machine; this one is ${f.arch || 'unknown'}`;
  if (!f.systemd) return 'this needs a normal Ubuntu install with systemd';
  if (!f.folderDir) return f.folderExists
    ? `${f.folder} is a file, not a folder. Give the folder your assistant lives in`
    : `there is no folder at ${f.folder || f.folderInput} on the server. Check the path (the app looked for it as "${login}")`;
  if (!SAFE_PATH_RE.test(f.folder) || f.folder === '/') return `the folder's real path (${f.folder}) has characters the app cannot pass on safely; use a folder whose path is letters, digits, dots, dashes, underscores and slashes`;
  if (f.folder === f.loginHomeReal || f.folder === f.loginHome) return `${f.folder} is the home folder of "${login}" itself. Give the folder your assistant lives in, for example ${f.loginHome || '~'}/my-assistant`;
  if (f.ownerUid === 0) return `${f.folder} belongs to root, and your assistant must not run as root. Give the folder to your own login (sudo chown -R ${login}: ${f.folder}) and check again`;
  if (!f.complete) return 'the server stopped answering part way through the check; try again';
  const ours = f.existing && !!f.hostSetupText;
  if (f.existing && !ours) return 'this server already has a Crads-AI assistant set up on it. Setting up a second one would replace it, so the app stops here and has changed nothing';
  if (f.dockerPkg === 'io') return 'Docker on this server came from Ubuntu\u2019s own package (docker.io). Your assistant\u2019s container needs Docker\u2019s own package (docker-ce), and the two cannot both be installed, so the app stops here and has changed nothing. Switching is your call: Docker\u2019s guide is at docs.docker.com/engine/install/ubuntu';
  if (f.dockerPkg === 'other') return 'Docker on this server was not installed from Docker\u2019s own package (docker-ce), for example it came as a snap. The app works only with docker-ce, so it stops here and has changed nothing';
  if (f.aiosContainer && !ours) return 'a container named ai-os already exists on this server, and that is the name your assistant\u2019s container needs. Rename or remove it, then check again';
  const taken = !ours && f.listen.filter((a) => /:(7780|7781)$/.test(a));
  if (taken && taken.length) return `something on this server already listens on ${[...new Set(taken.map((a) => a.replace(/^.*:/, 'port ')))].join(' and ')}, which your assistant\u2019s container needs on this machine. Stop it or move it, then check again`;
  if (f.memberUser && !f.memberOurs) return 'a login named "member" already exists on this server, and the app needs that name for its own way in. The app has changed nothing';
  if (f.diskGb < ADOPT_MIN_FREE_DISK_GB) return `this needs at least ${ADOPT_MIN_FREE_DISK_GB} GB of free disk for your assistant\u2019s container; the server has ${f.diskGb} GB`;
  return null;
}

/** The host inventory /move-in reads (the contract above). */
export function inventoryFrom(f, { login, now = new Date() } = {}) {
  return {
    version: 1,
    collected_at: now.toISOString(),
    login,
    brain_root: f.folder,
    owner: { uid: f.ownerUid, gid: f.ownerGid },
    crontab: f.crontab.map(({ user, line_no, text }) => ({ user, line_no, text })),
    units: f.units.map(({ name, scope, working_directory, exec_start, active }) => ({ name, scope, working_directory, exec_start, active })),
    containers: f.containers.map(({ name, image, status }) => ({ name, image, status })),
    listeners: publicListeners(f.listen),
    skills: [...f.skills], lazy_skills: [...f.lazySkills], hooks: [...f.hooks], mcp_servers: [...f.mcpServers],
    env_files: [...f.envFiles],
    git: { branch: f.branch, remote: f.remote, dirty: f.dirty },
  };
}

/** One line a person can read on the door, after a passing check. */
export function adoptSummary(f) {
  return {
    folder: f.folder, branch: f.branch, git: f.git, gitOp: f.gitOp, dirty: f.dirty,
    skills: f.skills.length + f.lazySkills.length, cron: f.crontab.filter((c) => !/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(c.text)).length,
    units: f.units.length, containers: f.containers.length, listeners: publicListeners(f.listen).length,
  };
}

/** Run the probe over the client; facts plus the refusal, if any. */
export async function probeAdopt(client) {
  const t = client.t;
  const r = await client.ssh('bash -s', probeScript({ login: t.user, folder: t.brainRoot }), 90_000);
  return { r, facts: r.code === 0 ? parseAdoptProbe(r.stdout) : null };
}

/** CONTRACT (Builder B): the host inventory, freshly read. Throws in words when the server will not answer. */
export async function collectInventory(client) {
  const { r, facts } = await probeAdopt(client);
  if (!facts) throw new Error(`the server did not answer the check (exit ${r.code})`);
  if (!facts.folderDir) throw new Error(`there is no folder at ${facts.folder || client.t.brainRoot} on the server`);
  return inventoryFrom(facts, { login: client.t.user });
}

function parseEntries(text) {
  if (!text) return [];
  let v; try { v = JSON.parse(text); } catch { return []; }
  return Array.isArray(v) ? v.filter((e) => e && typeof e === 'object') : [];
}

/** The rendered setup for a passing probe (what createServer runs). */
export function renderForFacts(f, { boxName, ownerPubKey, image, login, files, swap = false, now }) {
  return renderAdoptSetup({
    boxName, ownerPubKey, image, files, swap,
    brainRoot: f.folder, uid: f.ownerUid, gid: f.ownerGid, tz: f.tz,
    inventory: inventoryFrom(f, { login, now }),
    ownershipText: f.ownershipText,
    priorEntries: parseEntries(f.hostSetupText).map((e) => JSON.stringify(e)),
  });
}

/**
 * CONTRACT (Builder B): run the shared-server setup as root.
 * opts.script: a script renderAdoptSetup() made (createServer passes this);
 * otherwise opts are renderAdoptSetup's own.
 */
export async function setupSharedHost(client, opts = {}) {
  const script = opts.script || renderAdoptSetup(opts).script;
  const r = await client.ssh(AS_ROOT_SCRIPT, script, 30 * 60_000);
  const out = String(r.stdout || '');
  if (r.code !== 0 || !out.includes('crads-setup-ok')) {
    const why = (out.match(/crads-failed: (.+)/) || [])[1];
    const step = [...out.matchAll(/crads-step: (\S+)/g)].map((m) => m[1]).pop();
    const e = new Error(why
      ? `setting up the server stopped: ${why}. Every change made so far is listed in ${HOST_SETUP_REL} in your folder, so it can be undone`
      : `setting up the server stopped${step ? ` at "${step}"` : ''} (exit ${r.code}). Every change made so far is listed in ${HOST_SETUP_REL} in your folder, so it can be undone`);
    e.code = 'setup_failed';
    throw e;
  }
  return { ok: true, steps: [...out.matchAll(/crads-step: (\S+)/g)].map((m) => m[1]) };
}

// The only reverses teardown will run. Anything else in the file (a hand
// edit, or a container that wrote to the brain folder) is skipped and named.
function reverseCommand(rv, R) {
  const op = rv && rv.op;
  if (op === 'keep') return { keep: true };
  if (op === 'remove-file' && ADOPT_HOST_FILES.includes(rv.path)) return { cmd: `rm -f "${R}${rv.path}"` };
  if (op === 'remove-dir' && ADOPT_HOST_DIRS.includes(rv.path)) return { cmd: `rmdir "${R}${rv.path}" 2>/dev/null || [ ! -d "${R}${rv.path}" ]` };
  if (op === 'stop-unit' && ADOPT_HOST_UNITS.includes(rv.unit)) {
    // Idempotent, like every reverse here: a unit already gone counts as undone,
    // so a Move out that stopped half way can simply be run again.
    const off = `{ systemctl disable --now ${rv.unit} || ! systemctl cat ${rv.unit}; }`;
    return { cmd: rv.unit === 'ai-os.service'
      ? `${off} && { docker rm -f ai-os >/dev/null 2>&1 || true; }`
      : `${off} && { systemctl stop ai-os-host-update.service 2>/dev/null || true; }` };
  }
  if (op === 'remove-user' && rv.user === ADOPT_HOST_USER) return { cmd: `! getent passwd ${ADOPT_HOST_USER} || { pkill -KILL -u ${ADOPT_HOST_USER}; userdel -r ${ADOPT_HOST_USER} || userdel ${ADOPT_HOST_USER}; }` };
  if (op === 'remove-swap' && rv.path === ADOPT_SWAPFILE) return { cmd: `{ swapoff "${R}/swapfile" || true; }; rm -f "${R}/swapfile" && sed -i '\\#^/swapfile #d' "${R}/etc/fstab"` };
  return { unknown: true };
}

/**
 * CONTRACT (Builder B): undo every host change setupSharedHost made, newest
 * first, from <brainRoot>/.kernel/move-in/host-setup.json. Never touches the
 * brain folder apart from deleting host-setup.json LAST, and only when every
 * reverse succeeded and none was skipped. Never uninstalls Docker.
 * hostRoot is for tests only (a scratch tree standing in for /), like
 * renderAdoptSetup's.
 * @returns {{ ok, undone: string[], kept: string[], skipped: string[], failed: string[] }}
 */
export async function teardownSharedHost(client, { brainRoot, hostRoot = '' } = {}) {
  if (!SAFE_PATH_RE.test(String(brainRoot || '')) || brainRoot === '/') throw new Error('the brain folder must be an absolute path of plain characters');
  const hs = `${brainRoot}/${HOST_SETUP_REL}`;
  const read = await client.ssh(AS_ROOT_SCRIPT, `cat "${hs}" 2>/dev/null || echo CRADS_NO_RECORD\n`, 60_000);
  const text = String(read.stdout || '');
  if (read.code !== 0) throw new Error(`could not read ${HOST_SETUP_REL} on the server (exit ${read.code})`);
  if (text.trim() === 'CRADS_NO_RECORD') return { ok: true, undone: [], kept: [], skipped: [], failed: [], nothing: true };
  const entries = parseEntries(text);
  const R = hostRoot && SAFE_PATH_RE.test(hostRoot) ? hostRoot : '';
  const plan = []; const kept = []; const skipped = [];
  for (const e of [...entries].reverse()) {
    const what = String(e.what || '(unnamed change)');
    const c = reverseCommand(e.reverse, R);
    if (c.keep) kept.push(what);
    else if (c.unknown) skipped.push(what);
    else plan.push({ what, cmd: c.cmd });
  }
  const lines = ['set -u', 'F=0'];
  plan.forEach((p, i) => {
    lines.push(`if ( ${p.cmd} ) >/dev/null 2>&1; then echo "crads-undone: ${i}"; else echo "crads-undo-failed: ${i}"; F=1; fi`);
  });
  lines.push('systemctl daemon-reload 2>/dev/null || true',
    '{ sshd -t && { systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null; }; } >/dev/null 2>&1 || true',
    // The record goes last, and only when every entry was undone: a failed or
    // a skipped one (not ours to run) keeps it, so it can be read and run again.
    skipped.length ? 'echo crads-record-kept' : `if [ "$F" = 0 ]; then rm -f "${hs}"; echo crads-record-removed; fi`,
    'echo crads-teardown-done');
  const r = await client.ssh(AS_ROOT_SCRIPT, lines.join('\n') + '\n', 10 * 60_000);
  const out = String(r.stdout || '');
  if (!out.includes('crads-teardown-done')) throw new Error(`undoing the setup stopped part way (exit ${r.code}); ${HOST_SETUP_REL} is still in your folder, so it can be run again`);
  const idx = (re) => [...out.matchAll(re)].map((m) => Number(m[1]));
  const undone = idx(/crads-undone: (\d+)/g).map((i) => plan[i].what);
  const failed = idx(/crads-undo-failed: (\d+)/g).map((i) => plan[i].what);
  return { ok: failed.length === 0 && skipped.length === 0, undone, kept, skipped, failed, recordRemoved: out.includes('crads-record-removed') };
}

export { mergeOwnership };
