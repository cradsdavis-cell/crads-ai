// org-publish.mjs — the member-side org-brain publish job (spec 2026-07-25-org-brain-hive-mind-design.md).
// Dispatched by runner.mjs like the pack builders: deterministic in dry-run, claude -p in live.
// Layered enclave protection: (1) this snapshot NEVER copies wiki/personal/** or enclave:true
// pages; (2) the generated .claude/settings.json wires enclave-guard.mjs as a PreToolUse deny;
// (3) every publish is a reviewable org-repo commit (the audit trail).
import { cp, mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, 'enclave-guard.mjs');
const execFile = promisify(execFileCb);
const GIT_ID = ['-c', 'user.name=box', '-c', 'user.email=box@local'];

async function git(cwd, ...args) {
  return execFile('git', [...GIT_ID, ...args], { cwd });
}

// frontmatter enclave flag: `enclave: true` between the FIRST pair of '---' fences only.
export function isEnclavePage(text) {
  if (!text.startsWith('---')) return false;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return false;
  return /^enclave:\s*true\s*$/m.test(text.slice(3, end));
}

export async function buildSnapshot(stateDir, workDir) {
  const srcWiki = path.join(stateDir, 'wiki');
  const dstWiki = path.join(workDir, 'wiki');
  let copied = 0, excluded = 0;
  async function walk(src, dst) {
    const entries = await readdir(src, { withFileTypes: true });
    for (const e of entries) {
      const s = path.join(src, e.name);
      // Skip all symlinks — no legitimate role in a wiki snapshot, and they can read-through to enclave.
      if (e.isSymbolicLink()) {
        excluded++;
        continue;
      }
      // Exclude wiki/personal/** at the top level only (intentionally root-only per org-brain-setup.sh convention).
      if (e.isDirectory()) {
        if (path.relative(srcWiki, s) === 'personal') { excluded++; continue; }
        await walk(s, path.join(dst, e.name));
      } else {
        let text = null;
        if (e.name.endsWith('.md')) {
          text = await readFile(s, 'utf8');
          if (isEnclavePage(text)) { excluded++; continue; }
        }
        await mkdir(dst, { recursive: true });
        if (text !== null) await writeFile(path.join(dst, e.name), text);
        else await cp(s, path.join(dst, e.name));
        copied++;
      }
    }
  }
  await rm(workDir, { recursive: true, force: true });
  await mkdir(dstWiki, { recursive: true });
  try { await stat(srcWiki); await walk(srcWiki, dstWiki); } catch { /* no wiki yet: empty snapshot */ }
  // Second-layer guard: deny Read/Grep/Glob/Bash calls that reference the REAL enclave.
  const protectedPaths = [path.join(stateDir, 'wiki', 'personal'), 'wiki/personal'];
  const settings = {
    hooks: {
      PreToolUse: [{
        matcher: 'Read|Grep|Glob|Bash',
        hooks: [{ type: 'command', command: `node ${GUARD} ${protectedPaths.map((p) => `'${p}'`).join(' ')}` }],
      }],
    },
  };
  await mkdir(path.join(workDir, '.claude'), { recursive: true });
  await writeFile(path.join(workDir, '.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  return { copied, excluded };
}

export const PROVENANCE_RE = /^source: [a-z0-9][a-z0-9-]*\/\S+ · \d{4}-\d{2}-\d{2}$/m;

export async function validateExtracts(memberDir) {
  const violations = [];
  async function walk(dir, rel) {
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, path.join(rel, e.name));
      else if (e.name.endsWith('.md') && !PROVENANCE_RE.test(await readFile(p, 'utf8')))
        violations.push(path.join(rel, e.name));
    }
  }
  await walk(memberDir, '');
  return { ok: violations.length === 0, violations };
}

// Deterministic extract for DRY_RUN (kernel spine + trap test run with no auth, repo convention).
// Real distillation is the live path (Task 4); this mirrors its shape: dated updates section
// from log.md bullets + one entity page per wiki/projects/*.md, every section stamped.
export async function writeDryExtracts(workDir, orgDir, slug, date) {
  const files = [];
  const memberDir = path.join(orgDir, 'members', slug);
  const stamp = (wikiPath) => `\nsource: ${slug}/${wikiPath} · ${date}\n`;
  let log = '';
  try { log = await readFile(path.join(workDir, 'wiki', 'log.md'), 'utf8'); } catch {}
  const bullets = log.split('\n').filter((l) => l.trim().startsWith('-')).slice(-5);
  const updatesPath = path.join(memberDir, 'updates.md');
  let prev = '';
  try { prev = (await readFile(updatesPath, 'utf8')).replace(/^# Updates[^\n]*\n+/, ''); } catch {}
  const section = `## ${date}\n${bullets.length ? bullets.join('\n') : '- (no logged work this window)'}\n${stamp('wiki/log.md')}`;
  await mkdir(memberDir, { recursive: true });
  await writeFile(updatesPath, `# Updates from ${slug}\n\n${section}\n${prev}`);
  files.push(updatesPath);
  const projDir = path.join(workDir, 'wiki', 'projects');
  let projects = [];
  try { projects = (await readdir(projDir)).filter((f) => f.endsWith('.md')); } catch {}
  for (const f of projects) {
    const body = await readFile(path.join(projDir, f), 'utf8');
    const out = path.join(memberDir, 'entities', f);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, `${body.trimEnd()}\n${stamp('wiki/projects/' + f)}`);
    files.push(out);
  }
  return { files };
}

// Same headless contract as runner.mjs runClaude: stdin closed, hard timeout. Duplicated
// (not imported) because runner's helper is module-private; keep both tiny and in sync.
function defaultRunClaude(args, { cwd, env, timeoutMs = 240000 }) {
  return new Promise((resolve, reject) => {
    const pebble = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { pebble.kill('SIGKILL'); reject(new Error(`claude timed out after ${timeoutMs}ms`)); }, timeoutMs);
    pebble.stdout.on('data', (d) => { out += d; });
    pebble.stderr.on('data', (d) => { err += d; });
    pebble.on('error', (e) => { clearTimeout(t); reject(e); });
    pebble.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error((err || `claude exited ${code}`).slice(0, 300))); });
  });
}

function livePrompt(slug, orgDir, date) {
  return (
    `You are the org-publish job for member box "${slug}". Today is ${date}.\n` +
    `Read the wiki snapshot at ./wiki — this is the ONLY content you may read.\n` +
    `Update the org-facing extracts in ${orgDir}/members/${slug}/ :\n` +
    `- updates.md: prepend a "## ${date}" section summarising NEW work-relevant state since the newest existing section (clients, projects, decisions, blockers). Facts only, no opinions, no personal content.\n` +
    `- entities/<name>.md: one page per client/project with current state, updated in place.\n` +
    `- decisions.md: append any decisions not already recorded, one per line as a "- " bullet (the hub only harvests "- " lines), then end the file with a provenance line — it is not a bullet, so the hub ignores it.\n` +
    `EVERY .md file you write or modify must carry at least one provenance line, and every claim-bearing section must end with one, in EXACTLY this format:\n` +
    `source: ${slug}/<wiki-path> · YYYY-MM-DD\n` +
    `Write ONLY inside ${orgDir}/members/${slug}/. Do not run git. If nothing is new, change nothing and reply "no changes".`
  );
}

export async function publish(stateDir, { dryRun = false, runClaude = defaultRunClaude } = {}) {
  let cfg;
  try { cfg = JSON.parse(await readFile(path.join(stateDir, 'org', 'config.json'), 'utf8')); }
  catch { return { ok: true, output: 'org brain not configured — no-op' }; }
  const { slug } = cfg;
  const orgDir = path.join(stateDir, 'org', 'brain');
  const { localDate, nowISO } = await import('./clock.mjs');
  let tz = 'UTC';
  try { tz = (await readFile(path.join(stateDir, 'profile.yaml'), 'utf8')).match(/timezone:\s*"?([^"\n]+)"?/)?.[1]?.trim() || 'UTC'; } catch {}
  const date = localDate(stateDir, tz);
  await git(orgDir, 'pull', '--rebase', '-q').catch(() => {});   // best-effort freshness
  const workDir = path.join(stateDir, '.kernel', 'org-publish-work');
  const snap = await buildSnapshot(stateDir, workDir);
  if (dryRun) {
    await writeDryExtracts(workDir, orgDir, slug, date);
  } else {
    await runClaude(
      ['-p', livePrompt(slug, orgDir, date), '--permission-mode', 'acceptEdits',
       '--allowedTools', 'Read,Edit,Write,Glob,Grep', '--add-dir', orgDir],
      { cwd: workDir, env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(stateDir, '.claude-auth') } }
    );
  }
  const memberDir = path.join(orgDir, 'members', slug);
  const check = await validateExtracts(memberDir);
  if (!check.ok) {
    await git(orgDir, 'checkout', '--', `members/${slug}`).catch(() => {});
    await git(orgDir, 'clean', '-fd', `members/${slug}`).catch(() => {});
    throw new Error(`org-publish: provenance validation failed (${check.violations.join(', ')}) — publish reverted`);
  }
  // Substantive-change detection MUST run before .stamp is touched: .stamp is the
  // publish-job liveness heartbeat (spec §3.3/§8 — the hub's 36h staleness check needs
  // it to move on every successful run), not content. If it's inspected as part of the
  // diff it always looks "changed" and the no-op/heartbeat distinction below is dead.
  const stampPath = path.join(memberDir, '.stamp');
  const relStamp = path.relative(orgDir, stampPath).split(path.sep).join('/');
  const preSt = await git(orgDir, 'status', '--porcelain', '--', `members/${slug}`);
  const substantive = preSt.stdout.split('\n').some((line) => {
    const l = line.trim();
    return l.length > 0 && !l.endsWith(relStamp);
  });
  await writeFile(stampPath, nowISO(stateDir) + '\n');
  await git(orgDir, 'add', `members/${slug}`);
  const st = await git(orgDir, 'status', '--porcelain');
  if (!st.stdout.trim()) return { ok: true, output: `publish(${slug}): no changes (snapshot ${snap.copied} pages, ${snap.excluded} enclave-excluded)` };
  const commitMsg = substantive
    ? `publish(${slug}): extracts for ${date}`
    : `publish(${slug}): heartbeat ${date} (no content changes)`;
  await git(orgDir, 'commit', '-q', '-m', commitMsg);
  let pushed = true;
  try { await git(orgDir, 'push', '-q'); } catch { pushed = false; }
  const label = pushed ? 'pushed' : 'queued (push failed)';
  const output = substantive
    ? `publish(${slug}): ${date} committed, ${label} (${snap.excluded} enclave-excluded)`
    : `publish(${slug}): heartbeat ${date} committed, ${label} (${snap.excluded} enclave-excluded)`;
  return { ok: true, output };
}
