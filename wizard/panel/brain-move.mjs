// brain-move.mjs: move a member's brain between their own computer and a
// server, either way (Sam's rulings, 2026-10-14). Design, data flow and the
// failure table: docs/superpowers/specs/2026-10-14-local-server-switch-design.md.
//
//   moveUp   a brain FOLDER on this computer onto a server the wizard just built
//   moveDown a server's brain into a folder on this computer
//
// The brain travels as a git bundle over the app's own SSH connection; what git
// must never carry travels beside it as a move pack (engine/move-pack.mjs). The
// server-side merge is engine/restore.mjs, copied onto the server in the
// runbook's proven layout, so a move works whatever image the server runs.
//
// ORDER IS THE SAFETY, as in restore.mjs. Everything that can fail by reading
// fails first: the folder's commit, the bundle, the pack, the server's answer,
// the checksum of what arrived, restore's own dry run. The server's brain is
// changed only by restore (safe to repeat). The folder is changed on the way up
// by one commit of its own pending changes and a moved marker; on the way down
// only once the copy is whole in staging, and a folder this move created is
// removed again if the clone fails.
//
// NEVER the Claude sign-in (ruling 4). The pack refuses .claude-auth, and no
// function here writes outside the brain folder, the app's staging directory
// and the local-brains registry; the computer's own Claude Code files are not
// this module's business.
//
// The transport is injectable: { run(cmd, {stdin, timeoutMs}) -> {code,stdout,stderr},
// upload(localFile, remotePath, opts) -> {code,stderr}, download(remotePath, localFile, opts) }.
// sshTransport() is the real one; tests run the same commands through bash on
// a temp directory standing in for /state.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, lstatSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CARRY, MCP_FILE, SERVER_ONLY, PAUSED_DIR, PAUSED_MANIFEST, PAUSED_SERVER_MCP,
  packPaths, readPack, entryOf, writePack,
} from '../../engine/move-pack.mjs';
import { LOCAL_SKILL_IDS, dirState, scaffoldLocalBrain } from './local-scaffold.mjs';
import { listLocalTargets, registerLocalBrain, slugForName } from './local-targets.mjs';
import { localDashboardData } from './local-verbs.mjs';
import { rawSsh, runSsh } from './ssh-bridge.mjs';

export const STATE = '/state';
export const APP_ENGINE = '/app/engine';
// The files the app copies onto a server to run the move (runbook § "If the
// mineral's image predates the fix"). Repo-relative keys: they ride the SEA
// asset map (wizard-app.yml, pinned by selfhost-assets.test.mjs).
export const MOVE_TOOL_FILES = ['engine/restore.mjs', 'engine/lib/snapshot-cipher.mjs', 'engine/move-pack.mjs'];
// What the tool links to on the server: present on every image since the
// restore runbook was drilled (2026-10-14).
const TOOL_LINKS = [['box', 'box'], ['brain-push.sh', 'brain-push.sh'], ['lib/brain-ignore.mjs', 'lib/brain-ignore.mjs'], ['lib/brain-ignore.txt', 'lib/brain-ignore.txt'], ['lib/is-main.mjs', 'lib/is-main.mjs']];
// Paths a server keeps as its own when a brain moves onto it (restore.mjs
// KEEP_TRACKED), so a difference there is the design, not a lost file. The
// profile is rewritten once by name-set with the moving assistant's own name.
export const SERVER_KEEPS = ['devices', 'support', 'box-name', 'open-folder', 'ownership.json', 'profile.yaml'];
// The restart the app's Help > Update and restart sends (panel-server box-refresh).
export const RESTART_CMD = '(sleep 2; kill 1) </dev/null >/dev/null 2>&1 & echo restarting';

export class MoveRefusal extends Error {}
const refuse = (msg) => { throw new MoveRefusal(msg); };
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const SHA_JS = 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))';

const runGit = (cwd, args, opts = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: opts.timeout || 120000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) } });
const gitOut = (git, cwd, args) => { const r = git(cwd, args); return r.status === 0 ? String(r.stdout || '').trim() : null; };
const who = (slug) => ['-c', `user.name=${slug || 'brain'}`, '-c', `user.email=${slug || 'brain'}@brain.local`];
const rdJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
// Is `folder` the top of its own git repository? Compared on REAL paths: git
// answers with symlinks resolved, so a folder reached through a link (a home
// directory behind one, macOS /tmp -> /private/tmp) read as "not a repository"
// and a move up refused it (live drill, 2026-10-14).
const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
export const isRepoTop = (git, folder) => { const top = gitOut(git, folder, ['rev-parse', '--show-toplevel']); return top !== null && real(top) === real(folder); };

// ---------------------------------------------------------------- transports

function pipeTransport(spawnFor) {
  const collect = (child, stdin, timeoutMs) => new Promise((resolve) => {
    let out = ''; let err = ''; let done = false;
    const t = timeoutMs ? setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs) : null;
    const finish = (code) => { if (done) return; done = true; if (t) clearTimeout(t); resolve({ code: code ?? -1, stdout: out, stderr: err }); };
    child.stdout && child.stdout.on('data', (d) => { if (out.length < 4e6) out += d; });
    child.stderr && child.stderr.on('data', (d) => { if (err.length < 64e3) err += d; });
    child.on('error', (e) => { err += String(e && e.message || e); finish(-1); });
    child.on('close', finish);
    if (child.stdin) { if (stdin !== undefined) child.stdin.write(stdin); child.stdin.end(); }
  });
  return {
    async run(cmd, { stdin, timeoutMs = 120000 } = {}) {
      return collect(await spawnFor(cmd, true), stdin, timeoutMs);
    },
    async upload(localFile, remotePath, { timeoutMs = 30 * 60000 } = {}) {
      const child = await spawnFor(`umask 077; cat > ${shq(remotePath)}`, true);
      return new Promise((resolve) => {
        let err = ''; let done = false;
        const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
        const finish = (code) => { if (done) return; done = true; clearTimeout(t); resolve({ code: code ?? -1, stderr: err }); };
        child.stderr && child.stderr.on('data', (d) => { if (err.length < 64e3) err += d; });
        child.stdout && child.stdout.resume();
        child.on('error', (e) => { err += String(e && e.message || e); finish(-1); });
        child.on('close', finish);
        const rs = createReadStream(localFile);
        rs.on('error', (e) => { err += String(e.message || e); try { child.kill('SIGKILL'); } catch { /* gone */ } });
        child.stdin.on('error', () => { /* the far end went away; close reports it */ });
        rs.pipe(child.stdin);
      });
    },
    async download(remotePath, localFile, { timeoutMs = 30 * 60000 } = {}) {
      const child = await spawnFor(`cat ${shq(remotePath)}`, false);
      return new Promise((resolve) => {
        let err = ''; let done = false; let code = null; let flushed = false;
        const ws = createWriteStream(localFile, { mode: 0o600 });
        const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
        const finish = (c) => { if (done) return; done = true; clearTimeout(t); resolve({ code: c ?? -1, stderr: err }); };
        const both = () => { if (code !== null && flushed) finish(code); };
        child.stderr && child.stderr.on('data', (d) => { if (err.length < 64e3) err += d; });
        child.on('error', (e) => { err += String(e && e.message || e); finish(-1); });
        ws.on('error', (e) => { err += String(e && e.message || e); finish(-1); });
        ws.on('finish', () => { flushed = true; both(); });
        child.on('close', (c) => { code = c ?? -1; both(); });
        child.stdout.pipe(ws);
      });
    },
  };
}

/** The real transport: the system ssh, the alias the wizard installed. */
export function sshTransport(alias, { sshExe, configPath } = {}) {
  const t = pipeTransport((cmd, withStdin) => rawSsh(alias, cmd, { sshExe, configPath, stdinPipe: withStdin }));
  // Short text commands go through runSsh (queue, watchdog, recycled-address retry).
  t.run = async (cmd, { stdin, timeoutMs = 120000 } = {}) => runSsh(alias, cmd, { sshExe, configPath, hardTimeoutMs: timeoutMs, ...(stdin !== undefined ? { stdin } : {}) });
  return t;
}

/** bash on this machine: the tests' stand-in for a server (commands name the state dir explicitly). */
export function shellTransport({ shell = 'bash' } = {}) {
  return pipeTransport((cmd) => spawn(shell, ['-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'] }));
}

// ---------------------------------------------------------------- connections

/**
 * A server's connections, as a computer can use them (ruling 4). Remote (url)
 * connections come across. A sign-in the server renews for itself (named in
 * .kernel/mcp-oauth.json, or carrying the /app header helper) loses its
 * header: on a computer Claude Code signs in for itself (/mcp). A connection
 * made with the member's own API token keeps it. Box-only servers (a command
 * that runs on the server) stay behind, named.
 */
export function localMcpFromServer(serverMcp, { oauthNames = [] } = {}) {
  const oauth = new Set(oauthNames);
  const out = {}; const carried = []; const signIn = []; const needsServer = [];
  for (const [name, def] of Object.entries((serverMcp && serverMcp.mcpServers) || {})) {
    if (!def || typeof def !== 'object') continue;
    if (def.url && !def.command) {
      const entry = { type: def.type === 'sse' ? 'sse' : 'http', url: String(def.url) };
      const renewed = oauth.has(name) || !!def.headersHelper;
      if (def.headers && !renewed) entry.headers = def.headers;
      else if (renewed || !def.headers) signIn.push(name);
      out[name] = entry; carried.push(name);
    } else needsServer.push(name);
  }
  return { mcp: { mcpServers: out }, carried, signIn, needsServer };
}

/**
 * The connections a server gets back (the reverse). Start from the server's own
 * copy kept when the brain came down (it has the server's sign-in plumbing),
 * drop a remote connection the member removed on the computer, add any the
 * member added there. Box-only ones always come back.
 */
export function serverMcpFromLocal(pausedServer, local) {
  const base = pausedServer && typeof pausedServer === 'object' ? structuredClone(pausedServer) : {};
  base.mcpServers = base.mcpServers && typeof base.mcpServers === 'object' ? base.mcpServers : {};
  const mine = (local && local.mcpServers) || {};
  for (const [name, def] of Object.entries(base.mcpServers)) {
    if (def && def.url && !def.command && !(name in mine)) delete base.mcpServers[name];
  }
  for (const [name, def] of Object.entries(mine)) {
    if (name in base.mcpServers) continue;
    if (def && def.url && !def.command) base.mcpServers[name] = { type: def.type === 'sse' ? 'sse' : 'http', url: String(def.url), ...(def.headers ? { headers: def.headers } : {}) };
  }
  return base;
}

// ---------------------------------------------------------------- paused

/** What a computer cannot run, in words, from the files that came down. */
export function pausedSummary(get, { from = '', profile = '' } = {}) {
  const items = [];
  const cad = (() => { try { return JSON.parse(String(get('cockpit/cadence.json') || '')); } catch { return null; } })();
  const jobs = Object.entries((cad && (cad.version === 2 ? cad.jobs : cad)) || {}).filter(([, j]) => j && j.enabled === true);
  const when = (j) => {
    const s = j.schedule || {};
    if (s.kind === 'times') return `${Array.isArray(s.days) && s.days.length ? s.days.join(', ') : 'daily'} at ${(s.times || []).join(', ')}`;
    if (s.kind === 'every') return `every ${s.minutes} minutes`;
    if (s.kind === 'every-days') return `every ${s.n} days at ${s.time}`;
    if (j.time) return `${j.when || 'daily'} at ${j.time}`;
    return 'on a schedule';
  };
  const brief = jobs.find(([id]) => id === 'daily');
  if (brief) items.push({ id: 'morning-brief', words: 'Morning brief', detail: `${when(brief[1])}${brief[1].deliver ? ', sent to Telegram' : ''}` });
  const others = jobs.filter(([id]) => id !== 'daily');
  if (others.length) items.push({ id: 'schedule', words: 'Scheduled jobs', detail: others.map(([id, j]) => `/${id} ${when(j)}`).join('; ') });
  else if (!brief && get('.kernel/crontab')) items.push({ id: 'schedule', words: 'Scheduled jobs', detail: 'the schedule this mineral had' });
  if (get('secrets/telegram_bot_token')) items.push({ id: 'telegram', words: 'Telegram', detail: 'your bot and its chat, kept as they were' });
  void profile;
  return { version: 1, paused_at: new Date().toISOString(), from, items, files: SERVER_ONLY.filter((p) => get(p) !== null) };
}

/** The paused record in a folder, or null. Read by the local face. */
export function readPaused(folder) {
  const m = rdJson(path.join(folder, PAUSED_MANIFEST));
  return m && Array.isArray(m.items) ? m : null;
}

// ---------------------------------------------------------------- verification

/**
 * After a move UP: `git diff --name-status <folder commit> HEAD` on the server.
 * Added files are the server's own; a file of the folder's that is missing or
 * changed is a failed move, unless it is one the server keeps by design.
 */
export function judgeUpDiff(nameStatus, { keeps = SERVER_KEEPS } = {}) {
  const lost = []; const kept = [];
  for (const line of String(nameStatus || '').split('\n')) {
    const m = line.match(/^([ADMRTCU])\d*\t(.+?)(?:\t(.+))?$/);
    if (!m) continue;
    const [, st, a] = m;
    if (st === 'A') continue;
    const top = a.split('/')[0];
    if (keeps.includes(a) || keeps.includes(top)) { kept.push(a); continue; }
    lost.push(`${st === 'D' ? 'missing' : 'changed'}: ${a}`);
  }
  return { ok: lost.length === 0, lost, kept };
}

// ---------------------------------------------------------------- the tool

function toolCommands(state, app) {
  const mv = `${state}/.kernel/move`;
  const tool = `${mv}/tool`;
  const links = TOOL_LINKS.map(([to, from]) => `ln -sfn ${shq(`${app}/${from}`)} ${shq(`${tool}/${to}`)}`).join(' && ');
  return {
    mv, tool,
    prepare: `umask 077; rm -rf ${shq(mv)} && mkdir -p ${shq(`${tool}/lib`)} && ${links} && test -d ${shq(`${state}/.git`)} && test -f ${shq(`${state}/profile.yaml`)} && command -v node >/dev/null && command -v git >/dev/null && echo move-ready`,
  };
}

async function installTool(tx, toolFiles, { state, app }) {
  const c = toolCommands(state, app);
  const p = await tx.run(c.prepare, { timeoutMs: 60000 });
  if (p.code !== 0 || !/move-ready/.test(p.stdout)) {
    refuse(`the server is not ready for a move (${(String(p.stderr || '').trim().split('\n').pop() || 'it did not answer').slice(0, 200)}). If it was built a minute ago, give it a moment and try again.`);
  }
  for (const key of MOVE_TOOL_FILES) {
    const body = toolFiles[key];
    if (!body) refuse(`this build of the app is missing ${key}, so it cannot move a brain`);
    const rel = key.replace(/^engine\//, '');
    const r = await tx.run(`umask 077; cat > ${shq(`${c.tool}/${rel}`)}`, { stdin: body, timeoutMs: 60000 });
    if (r.code !== 0) refuse(`could not copy the move tool onto the server (${String(r.stderr || '').trim().slice(0, 200)})`);
  }
  return c;
}

/** The engine files, read from disk (dev checkout) or through the app's SEA asset reader. */
export function loadToolFiles({ read, root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..') } = {}) {
  const out = {};
  for (const key of MOVE_TOOL_FILES) {
    try { const v = read ? read(key, path.join(root, key)) : readFileSync(path.join(root, key)); out[key] = Buffer.isBuffer(v) ? v : Buffer.from(String(v)); } catch { /* missing: installTool says so */ }
  }
  return out;
}

const stagingDir = (base) => {
  const root = base || path.join(homedir(), '.crads-ai', 'move');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return mkdtempSync(path.join(root, 'm-'));
};

// ---------------------------------------------------------------- UP

/** What travels beside the brain from a folder (ruling 4 and 5, the way back). */
export function buildUpPack(folder) {
  const engine = new Set(LOCAL_SKILL_IDS);
  const skip = (rel) => { const m = rel.match(/^\.claude\/skills\/([^/]+)\//); return !!(m && engine.has(m[1])); };
  const extra = [];
  const local = rdJson(path.join(folder, MCP_FILE));
  const paused = rdJson(path.join(folder, PAUSED_SERVER_MCP));
  if (local || paused) {
    const merged = serverMcpFromLocal(paused, local);
    if (Object.keys(merged.mcpServers).length) extra.push({ path: MCP_FILE, data: JSON.stringify(merged, null, 2) + '\n', mode: 0o600 });
  }
  const restored = [];
  for (const rel of SERVER_ONLY) {
    const p = path.join(folder, PAUSED_DIR, rel);
    if (existsSync(p)) { extra.push({ path: rel, data: readFileSync(p), mode: 0o600 }); restored.push(rel); }
  }
  const pack = packPaths(folder, CARRY, { skip, extra });
  return { pack, restored };
}

/**
 * Move a brain folder onto a server. `to` is the server's alias; `transport`
 * reaches it. Returns the result; throws MoveRefusal in words a person can act on.
 */
export async function moveUp({ folder, to, name = '', transport, toolFiles, step = () => {}, git = runGit,
  state = STATE, app = APP_ENGINE, staging = '', restart = (tx) => tx.run(RESTART_CMD, { timeoutMs: 20000 }), computer = hostname() } = {}) {
  folder = path.resolve(String(folder || ''));
  step('Checking the folder');
  if (dirState(folder) !== 'brain') refuse(`${folder} is not a brain folder, so there is nothing to move`);
  if (!isRepoTop(git, folder)) refuse('this folder is not a git repository yet, so it cannot be moved. Install Git (git-scm.com), open the app again, and try again.');
  const slug = path.basename(folder).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'brain';
  if (gitOut(git, folder, ['status', '--porcelain'])) {
    git(folder, ['add', '-A']);
    const c = git(folder, [...who(slug), 'commit', '-q', '-m', 'move: this folder as it was before moving to a server']);
    if (c.status !== 0) refuse(`could not record the folder's latest changes before moving it: ${String(c.stderr || '').trim().slice(0, 200)}`);
  }
  const head = gitOut(git, folder, ['rev-parse', 'HEAD']);
  if (!head) refuse('this folder has no history yet, so there is nothing to move');
  const files = (gitOut(git, folder, ['ls-files']) || '').split('\n').filter(Boolean).length;
  const branch = gitOut(git, folder, ['symbolic-ref', '-q', 'HEAD']) || '';
  const displayName = String(name || (() => { try { return readFileSync(path.join(folder, 'box-name'), 'utf8'); } catch { return ''; } })()).trim().slice(0, 60);

  const dir = stagingDir(staging);
  try {
    step(`Packing your brain (${files} files)`);
    const bundle = path.join(dir, 'brain.bundle');
    const b = git(folder, ['bundle', 'create', bundle, 'HEAD', ...(branch ? [branch] : [])]);
    if (b.status !== 0 || !existsSync(bundle)) refuse(`could not pack the brain: ${String(b.stderr || '').trim().slice(0, 200)}`);
    const { pack, restored } = buildUpPack(folder);
    const packFile = path.join(dir, 'pack.json');
    writeFileSync(packFile, JSON.stringify(pack), { mode: 0o600 });
    const sum = sha256(bundle);

    step('Checking the server answers');
    const c = await installTool(transport, toolFiles, { state, app });
    const remoteBundle = `${c.mv}/brain.bundle`;
    const remotePack = `${c.mv}/pack.json`;
    let source = remoteBundle; let via = 'ssh';

    step('Copying your brain to the server');
    let arrived = false;
    for (let attempt = 0; attempt < 2 && !arrived; attempt++) {
      const up = await transport.upload(bundle, remoteBundle);
      if (up.code !== 0) continue;
      const s = await transport.run(`node -e ${shq(SHA_JS)} ${shq(remoteBundle)}`, { timeoutMs: 120000 });
      arrived = s.code === 0 && String(s.stdout).trim() === sum;
    }
    if (!arrived) {
      // Ruling 2's fallback: the member's own GitHub repository, if the folder is connected.
      const origin = gitOut(git, folder, ['remote', 'get-url', 'origin']);
      if (!origin) refuse('The copy to the server was interrupted twice (the computer may have gone to sleep, or the connection dropped). Nothing on the server or in your folder has changed. Keep the app open and the computer awake, then press Try again.');
      step('The direct copy kept failing, so your brain is going through your GitHub instead');
      const tokenFile = path.join(folder, '.kernel', 'brain-github-token');
      const push = git(folder, ['push', '-q', 'origin', `HEAD:${branch || 'refs/heads/master'}`], { timeout: 600000 });
      if (push.status !== 0) refuse(`the copy to the server kept failing, and sending your brain through GitHub failed too: ${String(push.stderr || '').trim().slice(0, 200)}. Nothing on the server or in your folder has changed.`);
      const src = `${c.mv}/src.git`;
      let helper = '';
      if (existsSync(tokenFile)) {
        const tk = await transport.run(`umask 077; cat > ${shq(`${c.mv}/gh-token`)}`, { stdin: readFileSync(tokenFile), timeoutMs: 30000 });
        if (tk.code !== 0) refuse('could not hand the server a GitHub sign-in for the copy');
        helper = `-c credential.helper=${shq(`!f() { echo username=x-access-token; echo "password=$(cat ${c.mv}/gh-token)"; }; f`)} `;
      }
      const ref = branch || 'refs/heads/master';
      const f = await transport.run(`umask 077; git init -q --bare ${shq(src)} && git -C ${shq(src)} ${helper}fetch -q --no-tags ${shq(origin)} ${shq(`${ref}:${ref}`)} && git -C ${shq(src)} symbolic-ref HEAD ${shq(ref)} && git -C ${shq(src)} rev-parse HEAD; rm -f ${shq(`${c.mv}/gh-token`)}`, { timeoutMs: 600000 });
      if (f.code !== 0 || String(f.stdout).trim().split('\n').pop() !== head) refuse(`the server could not read your brain from GitHub (${String(f.stderr || '').trim().split('\n').pop() || 'it did not match'}). Nothing on the server or in your folder has changed.`);
      source = src; via = 'github';
    }
    const pk = await transport.upload(packFile, remotePack);
    if (pk.code !== 0) refuse('The copy to the server was interrupted (the computer may have gone to sleep). Nothing on the server or in your folder has changed. Keep the app open, then press Try again.');

    const label = `the folder on ${String(computer || 'this computer').replace(/[^\w .-]/g, '').slice(0, 40) || 'this computer'}`;
    const base = `node ${shq(`${c.tool}/restore.mjs`)} ${shq(state)} --from ${shq(source)} --pack ${shq(remotePack)} --no-push --label ${shq(label)}${displayName ? ` --name ${shq(displayName)}` : ''}`;
    step('Checking the move before changing anything');
    const dry = await transport.run(`${base} --dry-run`, { timeoutMs: 300000 });
    if (dry.code !== 0) refuse(`the server refused the move before changing anything: ${String(dry.stderr || dry.stdout || '').trim().split('\n').pop().replace(/^restore: /, '').slice(0, 300)}`);

    step('Moving your brain in');
    const real = await transport.run(base, { timeoutMs: 600000 });
    if (real.code !== 0) refuse(`the move stopped on the server: ${String(real.stderr || real.stdout || '').trim().split('\n').pop().replace(/^restore: /, '').slice(0, 300)}. Your folder is unchanged, and the move is safe to run again: press Try again.`);

    step('Checking every file arrived');
    const v = await transport.run(`git -C ${shq(state)} merge-base --is-ancestor ${shq(head)} HEAD && echo IS-ANCESTOR; git -C ${shq(state)} diff --name-status ${shq(head)} HEAD; echo HEAD=$(git -C ${shq(state)} rev-parse HEAD)`, { timeoutMs: 120000 });
    const verdict = judgeUpDiff(v.stdout);
    const serverHead = (String(v.stdout).match(/HEAD=([0-9a-f]{40})/) || [])[1] || '';
    const verified = /IS-ANCESTOR/.test(v.stdout) && verdict.ok;
    if (!verified) refuse(`the move ran, but the check found ${verdict.lost.length ? verdict.lost.slice(0, 5).join(', ') : 'that the folder’s history is not on the server'}. Your folder is unchanged.`);

    // The folder stays as it was; it only learns where its brain went.
    try {
      mkdirSync(path.join(folder, '.kernel'), { recursive: true });
      writeFileSync(path.join(folder, '.kernel', 'moved.json'), JSON.stringify({ to, at: new Date().toISOString(), commit: head, files }, null, 2) + '\n');
    } catch { /* the move stands either way */ }

    step('Restarting the server so your schedule and Telegram start on what moved');
    try { await restart(transport); } catch { /* Help > Update and restart does the same */ }
    try { await transport.run(`rm -rf ${shq(c.mv)}`, { timeoutMs: 30000 }); } catch { /* left for the next move's prepare */ }
    return { ok: true, direction: 'up', to, commit: head, serverHead, files, via, restored, verified: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- DOWN

/** Where a downgrade may land. Returns { state: 'missing'|'empty'|'brain' } or refuses. */
export function checkDownFolder(folder, { targets = listLocalTargets } = {}) {
  if (!folder || !path.isAbsolute(folder)) refuse('the folder must be a full path (or start with ~/)');
  const f = path.resolve(folder);
  for (const t of (targets() || [])) {
    const tp = path.resolve(t.path);
    if (f !== tp && f.startsWith(tp + path.sep)) refuse(`${f} is inside another brain folder (${tp}). Pick a folder of its own.`);
  }
  const st = dirState(f);
  if (st === 'occupied') refuse(`${f} already has other files in it. Pick an empty folder, or leave the field blank for the default.`);
  return { state: st };
}

function adaptForComputer(folder, git, slug) {
  // The server's folder link (`<name> -> .`) is the Claude Code app's door into
  // /state; on a computer it is a second path to the same folder. Dropped.
  const link = (() => { try { return readFileSync(path.join(folder, 'open-folder'), 'utf8').trim(); } catch { return ''; } })();
  if (/^[a-z0-9][a-z0-9-]{0,39}$/.test(link)) {
    const p = path.join(folder, link);
    let st = null; try { st = lstatSync(p); } catch { st = null; }
    const isSelf = st && (st.isSymbolicLink() || (st.isFile() && st.size < 8 && readFileSync(p, 'utf8').trim() === '.'));
    if (isSelf) { git(folder, ['rm', '-q', '--cached', '--ignore-unmatch', '--', link]); try { unlinkSync(p); } catch { /* gone */ } return [link]; }
  }
  void slug;
  return [];
}

/**
 * Move a server's brain into a folder on this computer. `from` is the server's
 * alias. Returns the verified result; never touches the server's brain.
 */
export async function moveDown({ from, folder, transport, toolFiles, assets, step = () => {}, git = runGit,
  state = STATE, app = APP_ENGINE, staging = '', targets = listLocalTargets, register = registerLocalBrain } = {}) {
  if (!folder || !path.isAbsolute(String(folder))) refuse('the folder must be a full path (or start with ~/)');
  folder = path.resolve(String(folder));
  step('Checking the folder');
  const { state: before } = checkDownFolder(folder, { targets });
  if (before === 'brain') {
    if (!isRepoTop(git, folder)) refuse(`${folder} already holds a brain that is not a git repository, so it cannot be updated safely. Pick an empty folder.`);
    if (gitOut(git, folder, ['status', '--porcelain'])) refuse(`${folder} already holds a brain with changes of its own. Pick an empty folder, so neither copy is lost.`);
  }
  const dir = stagingDir(staging);
  let made = false;
  try {
    step('Checking the server answers');
    const c = await installTool(transport, toolFiles, { state, app });
    // A team's server stays a server: the company owns it, and the company
    // brain and its merges only run there (2026-10-14).
    const team = await transport.run(`[ -f ${shq(`${app}/team/team-status.mjs`)} ] && node ${shq(`${app}/team/team-status.mjs`)} ${shq(state)} 2>/dev/null || echo 'TEAM_STATUS {"team":false}'`, { timeoutMs: 60000 });
    if (/TEAM_STATUS \{[^\n]*"team":true/.test(String(team.stdout || ''))) refuse('This mineral belongs to a team, so it stays on its server: the company owns it, and the team runs there. Nothing has changed.');
    step('Packing your brain on the server');
    const ob = `${c.mv}/out.bundle`; const op = `${c.mv}/out.pack.json`;
    const prep = await transport.run([
      `cd ${shq(state)}`,
      `if [ -n "$(git status --porcelain 2>/dev/null)" ]; then git add -A && git -c user.name='AI OS kernel' -c user.email='kernel@ai-os.local' commit -q -m 'move: this mineral as it was before moving to a computer'; fi`,
      `BR=$(git symbolic-ref -q HEAD || true)`,
      `git bundle create ${shq(ob)} HEAD $BR 2>/dev/null`,
      `node ${shq(`${c.tool}/move-pack.mjs`)} pack ${shq(state)} --engine-skills ${shq(`${app}/skills`)} > ${shq(op)}`,
      `echo HEAD=$(git rev-parse HEAD)`,
      `echo FILES=$(git ls-files | wc -l)`,
      `echo BUNDLE=$(node -e ${shq(SHA_JS)} ${shq(ob)})`,
      `echo PACK=$(node -e ${shq(SHA_JS)} ${shq(op)})`,
      `echo NAME=$(head -c 60 box-name 2>/dev/null | tr -d '\\n')`,
    ].join(' && '), { timeoutMs: 600000 });
    const kv = (k) => (String(prep.stdout).match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || '';
    const serverHead = kv('HEAD'); const serverFiles = parseInt(kv('FILES'), 10);
    if (prep.code !== 0 || !/^[0-9a-f]{40}$/.test(serverHead)) refuse(`the server could not pack its brain (${String(prep.stderr || '').trim().split('\n').pop() || 'no answer'}). Nothing has changed.`);

    step('Copying your brain to this computer');
    const lb = path.join(dir, 'out.bundle'); const lp = path.join(dir, 'out.pack.json');
    for (const [rf, lf, k] of [[ob, lb, 'BUNDLE'], [op, lp, 'PACK']]) {
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        const d = await transport.download(rf, lf);
        ok = d.code === 0 && existsSync(lf) && sha256(lf) === kv(k);
      }
      if (!ok) refuse('The copy from the server was interrupted twice (the computer may have gone to sleep, or the connection dropped). Nothing on this computer or on the server has changed. Keep the app open and the computer awake, then press Try again.');
    }
    const pack = readPack(readFileSync(lp));

    step('Putting your brain in the folder');
    if (before === 'brain') {
      const f = git(folder, ['fetch', '-q', '--no-tags', lb]);
      const fh = gitOut(git, folder, ['rev-parse', 'FETCH_HEAD']);
      if (f.status !== 0 || !fh) refuse('could not read the copy from the server into the folder. Nothing in the folder has changed.');
      const anc = git(folder, ['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD']);
      if (anc.status !== 0) refuse(`${folder} already holds a different brain. Pick an empty folder, so neither is lost.`);
      const m = git(folder, ['merge', '--ff-only', '-q', 'FETCH_HEAD']);
      if (m.status !== 0) refuse(`could not bring the folder up to date: ${String(m.stderr || '').trim().slice(0, 200)}`);
    } else {
      made = before === 'missing';
      mkdirSync(path.dirname(folder), { recursive: true });
      const cl = git(path.dirname(folder), ['clone', '-q', lb, folder], { timeout: 600000 });
      if (cl.status !== 0) refuse(`could not make the folder from the copy: ${String(cl.stderr || '').trim().slice(0, 200)}`);
      git(folder, ['remote', 'remove', 'origin']);
    }

    // ---- VERIFY before anything else is written, and before any delete is offered
    step('Checking the copy against the server');
    const localHead = gitOut(git, folder, ['rev-parse', 'HEAD']);
    const localFiles = (gitOut(git, folder, ['ls-files']) || '').split('\n').filter(Boolean).length;
    if (localHead !== serverHead || localFiles !== serverFiles) {
      refuse(`the copy does not match the server (commit ${String(localHead || '').slice(0, 7)} with ${localFiles} files here, ${serverHead.slice(0, 7)} with ${serverFiles} there), so nothing more was done. The server is untouched.`);
    }

    // ---- what travels beside the brain (ruling 4), and what is paused (ruling 5)
    const get = (rel) => entryOf(pack, rel);
    const serverOnly = new Set(SERVER_ONLY);
    writePack(folder, pack, { map: (rel) => (serverOnly.has(rel) ? `${PAUSED_DIR}/${rel}` : rel === MCP_FILE ? PAUSED_SERVER_MCP : rel) });
    const serverMcp = (() => { try { return JSON.parse(String(get(MCP_FILE) || '')); } catch { return null; } })();
    const oauthNames = Object.keys((() => { try { return JSON.parse(String(get('.kernel/mcp-oauth.json') || '{}')); } catch { return {}; } })());
    const conn = localMcpFromServer(serverMcp, { oauthNames });
    if (conn.carried.length) {
      const cur = rdJson(path.join(folder, MCP_FILE)) || {};
      cur.mcpServers = { ...(cur.mcpServers || {}), ...conn.mcp.mcpServers };
      writeFileSync(path.join(folder, MCP_FILE), JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 });
      const sp = path.join(folder, '.claude', 'settings.local.json');
      const st = rdJson(sp) || {};
      const list = Array.isArray(st.enabledMcpjsonServers) ? st.enabledMcpjsonServers.map(String) : [];
      for (const n of conn.carried) if (!list.includes(n)) list.push(n);
      st.enabledMcpjsonServers = list;
      mkdirSync(path.dirname(sp), { recursive: true });
      writeFileSync(sp, JSON.stringify(st, null, 2) + '\n');
    }
    const paused = pausedSummary(get, { from });
    if (conn.needsServer.length) paused.items.push({ id: 'connections', words: 'Connections that run on a server', detail: conn.needsServer.join(', ') });
    if (paused.files.length || serverMcp) {
      mkdirSync(path.join(folder, PAUSED_DIR), { recursive: true, mode: 0o700 });
      writeFileSync(path.join(folder, PAUSED_MANIFEST), JSON.stringify({ ...paused, connections_need_server: conn.needsServer }, null, 2) + '\n', { mode: 0o600 });
    }
    try { unlinkSync(path.join(folder, '.kernel', 'moved.json')); } catch { /* there was none */ }

    // ---- adapt for a computer (the local scaffold), committed as one change
    step('Setting the folder up for this computer');
    const slug = String(from || '').replace(/-box$/, '') || 'brain';
    const dropped = adaptForComputer(folder, git, slug);
    if (assets) await scaffoldLocalBrain(folder, { assets });
    if (gitOut(git, folder, ['status', '--porcelain'])) {
      git(folder, ['add', '-A']);
      git(folder, [...who(slug), 'commit', '-q', '-m', 'move: set up for this computer']);
    }
    if (dirState(folder) !== 'brain') refuse('the folder does not read as a brain after the move, so nothing more was done. The server is untouched.');
    const name = (() => { try { return readFileSync(path.join(folder, 'box-name'), 'utf8').trim().slice(0, 60); } catch { return kv('NAME') || slug; } })();
    try { localDashboardData({ path: folder, name }); } catch (e) { refuse(`the folder does not open as a brain (${String(e && e.message || e).slice(0, 120)}), so nothing more was done. The server is untouched.`); }

    // ---- register (the slug follows the server's, made unique if another folder has it)
    const known = (targets() || []);
    const same = known.find((t) => path.resolve(t.path) === folder);
    const regSlug = same ? same.org : slugForName(slug, new Set(known.map((t) => t.org)));
    const reg = register(regSlug, { path: folder, name });
    if (!reg.ok) refuse(`the brain is in the folder, but the app could not list it: ${reg.reason}`);
    try { await transport.run(`rm -rf ${shq(c.mv)}`, { timeoutMs: 30000 }); } catch { /* the next move's prepare clears it */ }
    return {
      ok: true, direction: 'down', from, path: folder, alias: reg.alias, slug: regSlug, name,
      commit: serverHead, files: serverFiles, verified: true, dropped,
      paused: paused.items, connections: { carried: conn.carried, signIn: conn.signIn, needsServer: conn.needsServer },
    };
  } catch (e) {
    if (made) { try { rmSync(folder, { recursive: true, force: true }); } catch { /* left for the person */ } }
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Re-check, right now, that a downgraded folder still holds the server's commit
 * (or later) with every file. Called again just before a delete, so a folder
 * moved or emptied since the move can never be the reason a server goes.
 */
export function stillVerified(result, { git = runGit } = {}) {
  if (!result || !result.verified || !result.path) return { ok: false, why: 'no verified move to this computer in this session' };
  if (dirState(result.path) !== 'brain') return { ok: false, why: `${result.path} no longer holds the brain` };
  const anc = git(result.path, ['merge-base', '--is-ancestor', result.commit, 'HEAD']);
  if (anc.status !== 0) return { ok: false, why: 'the folder no longer holds the commit that was checked' };
  const missing = git(result.path, ['diff', '--name-only', '--diff-filter=D', result.commit, 'HEAD']);
  const gone = String(missing.stdout || '').split('\n').filter((l) => l && !(result.dropped || []).includes(l));
  if (missing.status !== 0 || gone.length) return { ok: false, why: 'files the server had are missing from the folder' };
  return { ok: true };
}

