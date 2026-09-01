#!/usr/bin/env node
// gen-crontab.mjs — turn profile.cadence into crontab lines (the autonomy layer).
// Mirrors Sam's "VPS cron -> jobs" model: each scheduled line enqueues a job and
// drains it. Times honour profile.identity.timezone via CRON_TZ.
//
//   node gen-crontab.mjs <state-dir>           # print the crontab to stdout (reference only)
//
// ⚠️  NEVER `| crontab -` on a SHARED operator user: that REPLACES the entire crontab (wiping the
//     operator's own fleet) AND the CRON_TZ line bleeds into every other job. Client cadence must
//     run under an ISOLATED mechanism (systemd user timer, a dedicated cron user, or the client's
//     own VPS). Until that lands, do NOT install — box-up.sh's commit-on-exit persists the brain.
//
// Cadence -> skill mapping:
//   morning_brief            -> /daily
//   evening_review           -> /capture   (end-of-day sweep; proposes, client approves)
//   inbox_watcher_interval   -> /inbox
//   weekly_review            -> /weekly
// Skills themselves respect profile.cadence.quiet_hours when invoked by cron.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const stateDir = path.resolve(process.argv[2] || process.env.STATE_DIR || '.');
const KDIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kernel');
const ENQUEUE = path.join(KDIR, 'enqueue.mjs');
const KERNEL = path.join(KDIR, 'kernel.mjs');

const profile = await readFile(path.join(stateDir, 'profile.yaml'), 'utf8');

// Targeted extraction — avoids a YAML dependency for these flat cadence fields.
const tz = (profile.match(/^\s*timezone:\s*"?([^"\n]+)"?/m) || [, 'UTC'])[1].trim();
const cad = profile.split(/\ncadence:/)[1] || '';
const cget = (key, d) => {
  const m = cad.match(new RegExp(`^\\s*${key}:\\s*"?([^"\\n]+)"?`, 'm'));
  return m ? m[1].trim() : d;
};
const [mh, mm] = cget('morning_brief', '07:00').split(':');
const [eh, em] = cget('evening_review', '18:00').split(':');
const watch = parseInt(cget('inbox_watcher_interval_min', '30'), 10) || 30;
const weekly = cget('weekly_review', 'Sun 17:00').split(/\s+/);
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const wdow = DOW[weekly[0]] ?? 0;
const [wh, wmin] = (weekly[1] || '17:00').split(':');

const job = (skill) =>
  `cd ${KDIR} && node ${ENQUEUE} ${stateDir} ${skill} --source=cron >/dev/null 2>&1; ` +
  `node ${KERNEL} ${stateDir} --once >/dev/null 2>&1`;

const BACKUP = path.join(KDIR, '..', 'backup.mjs');
const out = [
  `# AI OS cron — generated from ${stateDir}/profile.yaml. Times in ${tz}.`,
  `# ⚠️ DO NOT pipe to 'crontab -' on a shared user: it REPLACES the whole crontab + CRON_TZ bleeds.`,
  `# Install client cadence via an ISOLATED mechanism only (systemd user timer / dedicated user / own VPS).`,
  `CRON_TZ=${tz}`,
  `${+mm} ${+mh} * * *   ${job('daily')}    # morning brief`,
  `${+em} ${+eh} * * *   ${job('capture')}  # evening review`,
  `*/${watch} * * * *   ${job('inbox')}    # inbox watcher (skill respects quiet_hours)`,
  `${+wmin} ${+wh} * * ${wdow}   ${job('weekly')}   # weekly review`,
  `40 3 * * *   node ${BACKUP} ${stateDir} >/dev/null 2>&1   # encrypted state backup (engine/backup.mjs, 2026-07-14)`,
  '',
].join('\n');

console.log(out);
console.error('\n⚠️  Reference only. Do NOT `| crontab -` on a shared operator user (it wipes the operator crontab + CRON_TZ bleeds). Use an isolated mechanism; cadence is post-S1.');
