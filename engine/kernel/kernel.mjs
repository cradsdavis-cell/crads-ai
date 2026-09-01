#!/usr/bin/env node
// kernel.mjs — the per-instance single-writer kernel (decisions D9).
//
// The ONLY process that commits to a client's git-backed state. Telegram, cron
// and the dashboard never write the tree directly — they enqueue jobs; the
// kernel drains them serially: (defer if human editing) -> run -> commit -> push.
// Concurrency at the edges, serialisation at the write.
//
//   node kernel.mjs <state-dir> [--once] [--dry-run]
//     --once      drain the current queue and exit (cron-friendly + tests)
//     --dry-run   don't invoke Claude Code; runner produces deterministic output
//   env: STATE_DIR, DRY_RUN=1, KERNEL_POLL_MS (daemon poll interval, default 2000)
import { rename, writeFile, rm, readFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { kpaths, ensureDirs, listQueued } from './lib/queue.mjs';
import { ensureRepo, clearRebase, commitAll, syncPush } from './lib/git.mjs';
import { runSkill } from './lib/runner.mjs';
import { syncSkills } from './lib/skills.mjs';
import { nowISO } from '../lib/clock.mjs';   // injectable clock (spec §0.5)
import { appendAction, classifyJob } from '../lib/ledger.mjs';   // action ledger (spec §7, §3.P3)
import { appendRun, summarize } from '../lib/run-ledger.mjs';    // run ledger (spec 2026-08-04 §5): cockpit-side, uncommitted, app-readable
import { generate as genStateView } from '../lib/stateview.mjs';  // operator state-view (spec §3.P5)
import { localDate } from '../lib/clock.mjs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { brainIgnores } from '../lib/brain-ignore.mjs';

const ENGINE_SKILLS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');

const argv = process.argv.slice(2);
const stateDir = path.resolve(argv.find((a) => !a.startsWith('--')) || process.env.STATE_DIR || '.');
const once = argv.includes('--once');
const dryRun = argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const pollMs = Number(process.env.KERNEL_POLL_MS || 2000);

// THE NEVER-COMMIT SET, from the one file that holds it (2026-08-20 audit).
// This was a 7-entry literal that omitted .env and *.key, and this kernel is the
// thing that COMMITS: ensureIgnored runs here, then git.mjs does a blind
// `git add -A` on every drain. <brainRoot>/.env is where ORG_PULL_TOKEN lives,
// so the box that pushes its brain to GitHub could and did track it. Four
// writers of this list disagreed; now there is one.
// (org/ in the list = the org-brain clone, its own repo, never tracked here.)
const IGNORE = brainIgnores();
// Reply outbox dir, keyed by source. Voice turns get their OWN dir: the Telegram
// adapter drains .kernel/outbox and sends every file to its chat, so a voice reply
// left there would be mis-delivered (and retried forever). serve-voice.mjs polls voice-outbox.
const outboxDir = (base, job) => path.join(base, job.source === 'voice' ? 'voice-outbox' : 'outbox');
let firstDrain = true;
const log = (...m) => console.log(`[kernel ${nowISO(stateDir)}]`, ...m);

async function ensureIgnored(dir) {
  const gi = path.join(dir, '.gitignore');
  let cur = '';
  try { cur = await readFile(gi, 'utf8'); } catch {}
  const lines = new Set(cur.split('\n'));
  const missing = IGNORE.filter((l) => !lines.has(l));
  if (missing.length) await writeFile(gi, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + missing.join('\n') + '\n');
}

async function acquireLock(p) {
  try { await stat(p.humanLock); log('human-lock present — deferring writes'); return false; } catch {}
  try { await writeFile(p.lock, String(process.pid), { flag: 'wx' }); return true; }
  catch {
    try {
      const pid = Number(await readFile(p.lock, 'utf8'));
      try { process.kill(pid, 0); log(`lock held by live pid ${pid} — skipping`); return false; }
      catch { await rm(p.lock).catch(() => {}); await writeFile(p.lock, String(process.pid), { flag: 'wx' }); return true; }
    } catch { return false; }
  }
}

async function drain() {
  const p = await ensureDirs(stateDir);
  await ensureRepo(stateDir);
  // Clear crash-remnant rebase state BEFORE any job touches files: an abort
  // resets uncommitted TRACKED edits, so firing it now (nothing edited yet)
  // instead of at commit time closes the one-drain tracked-edit-loss window
  // (2026-07-25 O2 gate, declared residual eliminated).
  await clearRebase(stateDir);
  await ensureIgnored(stateDir);
  if (!(await acquireLock(p))) return;
  try {
    const jobs = await listQueued(stateDir);
    // Sync skills on the first drain (fresh-instance init) or whenever there are
    // jobs to run — not on every idle poll (this was logging "synced" every 2s).
    if (firstDrain || jobs.length) {
      const ns = await syncSkills(stateDir, ENGINE_SKILLS);
      if (ns) log(`synced ${ns} skills -> .claude/skills`);
    }
    firstDrain = false;
    if (!jobs.length) return;
    log(`draining ${jobs.length} job(s)`);
    const runId = randomUUID();                          // one run_id per drain (ledger key)
    const clientId = path.basename(path.dirname(stateDir)); // per-client id (box dir name / client slug)
    const ts = nowISO(stateDir);
    let tz = 'UTC';
    try { tz = (await readFile(path.join(stateDir, 'profile.yaml'), 'utf8')).match(/timezone:\s*"?([^"\n]+)"?/)?.[1]?.trim() || 'UTC'; } catch {}
    let committed = false, ledgerDirty = false;
    // Build one action-ledger row (spec §7, §3.P3). git_commit is the sha the skill produced.
    const logAction = (job, { sha = null, ok = true } = {}) => {
      const c = classifyJob(job);
      appendAction(stateDir, {
        client_id: clientId, ts, ts_utc: ts,
        actor_class: c.actor_class, actor_id: c.actor_id, action_type: job.skill,
        trigger: c.trigger_kind ? { trigger_id: c.actor_id, kind: c.trigger_kind, fired_at: ts, condition_snapshot: { source: job.source || 'cli' } } : null,
        approval: c.actor_class === 'approval_gated' ? { decision: 'approve', decided_by: 'telegram', latency: null } : null,
        side_effect: { kind: ok ? 'state.write' : 'error', external_id: null, observed: ok },
        skill: job.skill,
        dedup_key: `${c.actor_id}:${localDate(stateDir, tz)}`,   // actor_id already includes the skill
        run_id: runId, seed: null, persona_index: null,
        git_commit: sha,
      });
      ledgerDirty = true;
    };
    for (const job of jobs) {
      log(`-> /${job.skill} (${job.id.slice(0, 8)}) from ${job.source || '?'}`);
      const startedAt = new Date().toISOString();
      try {
        const res = await runSkill(stateDir, job, { dryRun });
        if (res.output) log(`   output: ${res.output.slice(0, 200).replace(/\s+/g, ' ').trim()}`);
        appendRun(stateDir, { ts: startedAt, job: `skill /${job.skill}`, skill: job.skill, source: job.source || 'cli', status: 'ok', summary: summarize(res.output) });
        const sha = await commitAll(stateDir, `job(${job.skill}): ${(res.output || 'done').slice(0, 60)} [${job.id.slice(0, 8)}]`);
        await rename(job.file, path.join(p.done, job.name));
        if (job.reply_to) {
          // Hand the reply to the comms adapter (Telegram) or the voice bridge via its outbox.
          const outDir = outboxDir(p.base, job);
          await mkdir(outDir, { recursive: true });
          await writeFile(path.join(outDir, job.name), JSON.stringify({ chat_id: job.reply_to, text: res.output || '(no reply)', job: job.id }));
        }
        logAction(job, { sha, ok: true });               // every drain produces a ledger row (P4.ZUL)
        if (sha) committed = true;
        log(`   done${sha ? ` @ ${sha.slice(0, 8)}` : ' (no changes)'}`);
      } catch (e) {
        log(`   FAILED: ${String(e.stderr || e).slice(0, 200)}`);
        appendRun(stateDir, { ts: startedAt, job: `skill /${job.skill}`, skill: job.skill, source: job.source || 'cli', status: 'fail', error: String(e.stderr || e) });
        await rename(job.file, path.join(p.failed, job.name)).catch(() => {});
        logAction(job, { sha: null, ok: false });         // failures are logged too (no silent drop)
        if (job.reply_to) {
          const outDir = outboxDir(p.base, job);
          await mkdir(outDir, { recursive: true });
          await writeFile(path.join(outDir, job.name), JSON.stringify({ chat_id: job.reply_to, text: '⚠️ That one errored on my end. Give it another go in a moment.', job: job.id }));
        }
      }
    }
    // Regenerate the operator state-view from the box's own data (spec §3.P5), then
    // persist ledger rows + state-view in one git-reachable commit (P3 I6 / P5 freshness).
    try { genStateView(stateDir); ledgerDirty = true; } catch (e) { log(`   state-view gen failed: ${String(e).slice(0, 120)}`); }
    if (ledgerDirty) { const lsha = await commitAll(stateDir, `ledger+state-view [run ${runId.slice(0, 8)}]`); if (lsha) committed = true; }
    if (committed) {
      const push = await syncPush(stateDir);
      log(`push: ${push.pushed ? 'ok' : 'skipped (' + push.reason + ')'}`);
    }
  } finally {
    await rm(p.lock).catch(() => {});
  }
}

async function main() {
  log(`state=${stateDir} once=${once} dryRun=${dryRun}`);
  if (once) return drain();
  for (;;) { await drain(); await new Promise((r) => setTimeout(r, pollMs)); }
}
main().catch((e) => { console.error(e); process.exit(1); });
