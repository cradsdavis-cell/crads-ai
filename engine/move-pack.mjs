#!/usr/bin/env node
// move-pack.mjs: what travels BESIDE the brain when a member moves between a
// server and their own computer (Sam's rulings, 2026-10-14; design in
// docs/superpowers/specs/2026-10-14-local-server-switch-design.md).
//
// The brain itself moves as a git bundle. Everything here is what git must
// never carry: the connections, their sign-ins, the stored secrets, the
// member's own skills, and (paused on a computer, restored on a server) the
// schedule and Telegram. One module, two runners: the app imports it to pack a
// folder and to unpack a server's pack into a folder; a server runs it as a
// command to pack itself:
//
//   node move-pack.mjs pack <state-dir> [--engine-skills <dir>]   -> the pack, as JSON, on stdout
//
// THE PACK. { kind: 'crads-move-pack', version: 1, files: [{ path, mode, b64 }] }.
// Plain JSON, not encrypted: it only ever travels inside the app's own SSH
// connection and sits in a 0600 file inside a 0700 directory until the move
// deletes it. Regular files only (a link is never packed), every path relative
// and inside the root, and engine/restore.mjs runs its own entry checks over it
// again before a single file lands on a server.
//
// WHAT IS NEVER PACKED, in either direction. The Claude sign-in: on a computer
// it is that computer's own Claude Code login, so a move must never carry one
// over the other. Also the second harness's sign-in, the server's GitHub CLI
// login, the backups, the door (devices, support, ssh) and git itself.
import { existsSync, lstatSync, readFileSync, readdirSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { isMain } from './lib/is-main.mjs';

export const PACK_KIND = 'crads-move-pack';
export const PACK_VERSION = 1;
export const PACK_MAX_BYTES = 20 * 1024 * 1024;

// Carried both ways, at the same paths (ruling 4).
export const CARRY = ['.kernel/mcp-oauth.json', '.kernel/mcp-added.json', '.kernel/google-creds', 'secrets', '.claude/skills'];
// The connections list. Carried both ways, but rewritten on a computer (see
// localMcpFromServer in wizard/panel/brain-move.mjs), so it is named apart.
export const MCP_FILE = '.mcp.json';
// Needs a server (ruling 5): paused under PAUSED_DIR on a computer, put back
// exactly where it was by the next move to a server.
export const SERVER_ONLY = ['cockpit/cadence.json', '.kernel/crontab', '.kernel/telegram-offset', 'secrets/telegram_bot_token', 'secrets/telegram_chat_id'];
export const PAUSED_DIR = '.kernel/paused';
export const PAUSED_MANIFEST = `${PAUSED_DIR}/paused.json`;
export const PAUSED_SERVER_MCP = `${PAUSED_DIR}/server-mcp.json`;
// Refused whatever asks for them. A prefix match on whole path segments.
export const NEVER = ['.claude-auth', '.opencode-auth', '.kernel/gh', '.kernel/move', '.kernel/brain-github-token', '.git', 'backups', 'devices', 'support', 'ssh', '.ssh'];

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
export const isNever = (rel) => {
  const r = norm(rel);
  return NEVER.some((n) => r === n || r.startsWith(n + '/'));
};

/** A path the pack may hold: relative, inside, no `..`, never on the NEVER list. */
export function safeRel(rel) {
  const r = norm(rel);
  if (!r || r.startsWith('/') || /^[A-Za-z]:/.test(r)) return false;
  const parts = r.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return false;
  return !isNever(r);
}

function walkFiles(root, rel, out) {
  const abs = path.join(root, rel);
  let st; try { st = lstatSync(abs); } catch { return; }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    for (const name of readdirSync(abs).sort()) walkFiles(root, `${rel}/${name}`, out);
    return;
  }
  if (st.isFile() && safeRel(rel)) out.push({ rel: norm(rel), mode: st.mode & 0o777 });
}

/**
 * Pack `paths` (files or directories, relative to root) that exist. `skip` is a
 * predicate on the relative path. Returns the pack object.
 */
export function packPaths(root, paths, { skip = () => false, extra = [] } = {}) {
  const found = [];
  for (const p of paths) if (safeRel(p)) walkFiles(root, norm(p), found);
  const files = [];
  let bytes = 0;
  const seen = new Set();
  for (const f of found) {
    if (seen.has(f.rel) || skip(f.rel)) continue;
    seen.add(f.rel);
    const buf = readFileSync(path.join(root, f.rel));
    bytes += buf.length;
    if (bytes > PACK_MAX_BYTES) throw new Error(`what travels beside the brain is over ${PACK_MAX_BYTES / 1024 / 1024} MB, so it was not packed (the biggest piece is under ${f.rel.split('/').slice(0, 2).join('/')})`);
    files.push({ path: f.rel, mode: f.mode, b64: buf.toString('base64') });
  }
  for (const e of extra) {
    if (!safeRel(e.path)) throw new Error(`refusing to pack ${e.path}`);
    const buf = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data));
    files.push({ path: norm(e.path), mode: e.mode ?? 0o600, b64: buf.toString('base64') });
  }
  return { kind: PACK_KIND, version: PACK_VERSION, files };
}

/** Parse and check a pack. Throws in words a person can act on. */
export function readPack(text) {
  let p;
  try { p = typeof text === 'string' || Buffer.isBuffer(text) ? JSON.parse(String(text)) : text; } catch { throw new Error('the move pack is not readable (it may have been cut short in transit)'); }
  if (!p || p.kind !== PACK_KIND) throw new Error('that file is not a Crads-AI move pack');
  if (p.version !== PACK_VERSION) throw new Error(`this move pack is version ${p.version}; this software reads version ${PACK_VERSION}`);
  if (!Array.isArray(p.files)) throw new Error('the move pack lists no files');
  for (const f of p.files) {
    if (!f || typeof f.path !== 'string' || !safeRel(f.path)) throw new Error(`the move pack holds a path it must not (${f && f.path}); not unpacking it`);
    if (typeof f.b64 !== 'string') throw new Error(`the move pack entry ${f.path} has no content`);
  }
  return p;
}

/** The bytes of one entry, or null. */
export function entryOf(pack, rel) {
  const f = pack.files.find((x) => x.path === norm(rel));
  return f ? Buffer.from(f.b64, 'base64') : null;
}

/**
 * Write a pack's files under `dir`. `map(rel) -> rel|null` relocates or drops an
 * entry. Directories are made 0700; each file keeps its owner bits only.
 */
export function writePack(dir, pack, { map = (r) => r } = {}) {
  const written = [];
  for (const f of pack.files) {
    const to = map(f.path);
    if (!to) continue;
    if (!safeRel(to) && !norm(to).startsWith(PAUSED_DIR + '/')) throw new Error(`refusing to write ${to}`);
    const abs = path.join(dir, norm(to));
    const rel = path.relative(dir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`refusing to write outside the folder: ${to}`);
    mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
    writeFileSync(abs, Buffer.from(f.b64, 'base64'), { mode: (f.mode & 0o700) || 0o600 });
    try { chmodSync(abs, (f.mode & 0o700) || 0o600); } catch { /* a filesystem without modes */ }
    written.push(norm(to));
  }
  return written;
}

/**
 * The pack a SERVER sends down: the carried set, the connections list and the
 * server-only set, at their own paths (the computer decides where they land).
 * Engine skills (the ones the image ships, in `engineSkills`) stay behind: the
 * computer has its own copies.
 */
export function packForDown(stateDir, { engineSkills = '' } = {}) {
  const engine = new Set();
  if (engineSkills) {
    try { for (const f of readdirSync(engineSkills)) if (f.endsWith('.md')) engine.add(f.replace(/\.md$/, '')); } catch { /* none to skip */ }
  }
  const skip = (rel) => {
    const m = rel.match(/^\.claude\/skills\/([^/]+)\//);
    return !!(m && engine.has(m[1]));
  };
  return packPaths(stateDir, [...CARRY, MCP_FILE, ...SERVER_ONLY], { skip });
}

async function cli(argv) {
  const [cmd, dir, ...rest] = argv;
  if (cmd !== 'pack' || !dir) {
    process.stderr.write('usage: node move-pack.mjs pack <state-dir> [--engine-skills <dir>]\n');
    return 2;
  }
  const i = rest.indexOf('--engine-skills');
  const root = path.resolve(dir);
  if (!existsSync(path.join(root, 'profile.yaml'))) { process.stderr.write(`move-pack: ${root} does not look like a mineral (no profile.yaml)\n`); return 2; }
  const pack = packForDown(root, { engineSkills: i > -1 ? rest[i + 1] : '' });
  process.stdout.write(JSON.stringify(pack));
  return 0;
}

// isMain, never a hand-rolled argv check: inside the bundled app every module
// "is" argv[1] (engine/lib/is-main.mjs, the mac app that exited before main()).
if (isMain(import.meta.url)) {
  cli(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(`move-pack: ${e.message || e}\n`); process.exitCode = 1; });
}
