#!/usr/bin/env node
// health-check.mjs <state-dir>: the mineral tells its own member when it is unwell.
//
// WHY (2026-10-26). A member's offsite copy stopped on 12 Oct and nobody knew for two
// weeks: a self-hosted mineral reports to nobody (on purpose: we cannot see it), and
// every failure lived in a run ledger only the Health card reads, so finding it meant
// already suspecting it. Same blind spot for a disk filling up and a scheduled job that
// fails every morning. This is the "tell me" half, the same shape as custody-watch.mjs:
// it runs ON the box, needs no network, and writes
//   cockpit/health-report.json + .md   always (the app, the assistant, a member's own
//                                      scheduled skill can read these, e.g. to post the
//                                      .md to their own Slack)
//   one Telegram message (.kernel/outbox) when a NEW problem appears, and a weekly
//                                      summary on Mondays, if Telegram is linked
//                                      (or Slack, when it is the owner's primary
//                                      channel: lib/delivery-target.mjs).
//
// Checks, each from what the box already records (nothing new to keep in step):
//   backup      the 03:40 snapshot's last run (run ledger, job "backup")
//   offsite     the 03:50 brain push's last run (job "brain-push"), once a repo exists
//   passphrase  the backup passphrase is marked saved off the box (backup.mjs's marker)
//   disk        the state disk at or above DISK_WARN percent used
//   jobs        scheduled skills that failed in the last 7 days
import { readFileSync, writeFileSync, mkdirSync, existsSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRuns } from '../lib/run-ledger.mjs';
import { resolveBrainRoot } from '../lib/brain-root.mjs';
import { deliveryTarget } from '../lib/delivery-target.mjs';   // Telegram, or the owner's Slack DM when they chose it

const DAY = 86400000;
export const DISK_WARN = 80;

const lastOf = (runs, job) => runs.filter((r) => r.job === job).sort((a, b) => String(a.ts).localeCompare(String(b.ts))).pop();
const hasOrigin = (dir) => { try { return /\[remote "origin"\]/.test(readFileSync(path.join(dir, '.git', 'config'), 'utf8')); } catch { return false; } };

export function diskPct(dir) {
  try { const s = statfsSync(dir); return Math.round(100 * (1 - s.bavail / s.blocks)); } catch { return null; }
}

export function check(stateDir, { now = Date.now(), runs = readRuns(stateDir), disk = diskPct(stateDir) } = {}) {
  const problems = [];
  const since = (r, days) => r && Date.parse(r.ts) >= now - days * DAY;

  const backup = lastOf(runs, 'backup');
  if (!since(backup, 2)) problems.push({ id: 'backup-missing', text: 'No nightly backup has run in the last two days.' });
  else if (backup.status !== 'ok') problems.push({ id: 'backup-failed', text: `Last night's backup failed: ${backup.summary || backup.error || 'no reason recorded'}` });

  if (hasOrigin(resolveBrainRoot(stateDir))) {
    const push = lastOf(runs, 'brain-push');
    if (!since(push, 2)) problems.push({ id: 'offsite-missing', text: 'Your brain has not been sent to your GitHub repository in the last two days.' });
    else if (push.status !== 'ok') problems.push({ id: 'offsite-failed', text: `Sending your brain to GitHub failed: ${push.summary || push.error || 'no reason recorded'}` });
  } else {
    problems.push({ id: 'offsite-none', text: 'There is no off-box copy yet: your brain is not connected to a GitHub repository.' });
  }

  if (existsSync(path.join(stateDir, 'secrets', 'backup_passphrase')) && !existsSync(path.join(stateDir, 'secrets', 'backup_passphrase.escrowed'))) {
    problems.push({ id: 'passphrase', text: 'Your backup passphrase is not marked as saved off this mineral, so a lost server could not be restored from its backup.' });
  }

  if (disk != null && disk >= DISK_WARN) problems.push({ id: 'disk', text: `The disk is ${disk}% full.` });

  const failed = {};
  for (const r of runs) if (r.skill && r.status === 'fail' && since(r, 7)) failed[r.skill] = (failed[r.skill] || 0) + 1;
  for (const [skill, n] of Object.entries(failed)) problems.push({ id: `job:${skill}`, text: `The scheduled job "${skill}" failed ${n} time${n === 1 ? '' : 's'} in the last week.` });

  return { at: new Date(now).toISOString(), ok: !problems.length, disk_pct: disk, problems };
}

export function render(report) {
  if (report.ok) return `Your mineral is healthy (checked ${report.at.slice(0, 10)}): backups ran, the off-box copy is current, disk ${report.disk_pct ?? '?'}% used, no failed jobs this week.`;
  return `Your mineral needs attention (checked ${report.at.slice(0, 10)}):\n\n${report.problems.map((p) => `• ${p.text}`).join('\n')}\n\nAsk your assistant "what's wrong with my mineral's health?" for the detail.`;
}

export function run(stateDir, { now = new Date(), notify = true, ...opts } = {}) {
  const report = check(stateDir, { now: now.getTime(), ...opts });
  const text = render(report);
  mkdirSync(path.join(stateDir, 'cockpit'), { recursive: true });
  writeFileSync(path.join(stateDir, 'cockpit', 'health-report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(path.join(stateDir, 'cockpit', 'health-report.md'), text + '\n');

  // Tell the member about a problem once, when it first appears, plus a weekly summary
  // (Mondays, box time) so silence means "checked and fine", never "nobody looked".
  const seenF = path.join(stateDir, '.kernel', 'health-seen.json');
  let seen = []; try { seen = JSON.parse(readFileSync(seenF, 'utf8')).ids || []; } catch { /* first run */ }
  const ids = report.problems.map((p) => p.id);
  const fresh = ids.filter((id) => !seen.includes(id));
  mkdirSync(path.dirname(seenF), { recursive: true });
  writeFileSync(seenF, JSON.stringify({ at: report.at, ids }) + '\n');
  const weekly = now.getDay() === 1;
  let sent = false;
  if (notify && (fresh.length || weekly)) {
    const chatId = deliveryTarget(stateDir);   // '' = no channel connected
    if (chatId) {
      const outbox = path.join(stateDir, '.kernel', 'outbox');
      mkdirSync(outbox, { recursive: true });
      writeFileSync(path.join(outbox, `health-${now.getTime()}.json`), JSON.stringify({ chat_id: chatId, text, job: 'health-check' }) + '\n');
      sent = true;
    }
  }
  return { report, fresh, sent };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { report, fresh, sent } = run(path.resolve(process.argv[2] || process.env.STATE_DIR || '/state'));
  console.log(report.ok ? 'health: ok' : `health: ${report.problems.length} problem(s)${fresh.length ? `, ${fresh.length} new` : ''}${sent ? ', member told' : ''}: ${report.problems.map((p) => p.id).join(', ')}`);
  // a sick mineral is not a failed health check: exit 0 so the ledger row stays about this job
}
