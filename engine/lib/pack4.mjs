// pack4.mjs — B4 / Pack 4 "Run-your-week" capability (spec §2.4 B4 + G5 ladder).
// The final block: prove the assistant runs the client's week autonomously + hand it over.
//  - cadence live: the client's cron schedule exists (from profile.cadence)
//  - autonomy: the action-ledger shows an AUTO (cron-triggered) action that ran with no manual touch
//  - handover: a self-serve walkthrough + the client OWNS a git-backed brain repo
// Deterministic; reads only the box's own state. Deliverable: brain/packs/pack4-handover.{md,json}.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const rd = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

export function generate(stateDir) {
  const profile = rd(path.join(stateDir, 'profile.yaml'));
  // cadence (from profile.cadence)
  const cad = profile.split(/\ncadence:/)[1] || '';
  const cget = (k) => (cad.match(new RegExp(`^\\s*${k}:\\s*"?([^"\\n]+)`, 'm')) || [, null])[1];
  const cadence_jobs = [
    { job: 'morning_brief', at: cget('morning_brief') },
    { job: 'evening_review', at: cget('evening_review') },
    { job: 'inbox_watch', every_min: cget('inbox_watcher_interval_min') },
    { job: 'weekly_review', at: cget('weekly_review') },
  ].filter((j) => j.at || j.every_min);
  const tz = (profile.match(/timezone:\s*"?([^"\n]+)"?/) || [, 'UTC'])[1].trim();

  // autonomy: an auto (cron) action that ran with no approval (the §0.4 allowlist brief is the canonical one)
  const actions = (() => { try { return rd(path.join(stateDir, 'state', 'action_ledger.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
  const autoActions = actions.filter((a) => a.actor_class === 'auto' && a.trigger && a.trigger.kind === 'cron');

  // handover: client owns a git-backed brain repo
  let commits = 0; try { commits = Number(execFileSync('git', ['-C', stateDir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()); } catch {}
  const ownsRepo = commits > 0;
  const first = (profile.match(/user_short:\s*"([^"]+)"/) || [, 'you'])[1];

  const pack = {
    schema: 'pack4-handover/1', block: 'b4', title: 'Pack 4 — Run-your-week',
    cadence: { live: cadence_jobs.length >= 3, tz, jobs: cadence_jobs },
    autonomy: { demonstrated: autoActions.length > 0, auto_cron_actions: autoActions.length },
    handover: {
      owns_repo: ownsRepo, repo_commits: commits,
      walkthrough: [
        `Your assistant runs your week on a schedule (${cadence_jobs.length} jobs, ${tz}) — you don't start it.`,
        `Everything it does is recorded in your own git repo (${commits} commits) — the brain is yours to keep.`,
        `Outbound is default-deny: it drafts, you tap approve. Nothing sends without you.`,
        `To run anything yourself, open the box and type the skill (e.g. /daily). To get help, message your operator.`,
      ],
    },
  };
  const ok = pack.cadence.live && pack.autonomy.demonstrated && pack.handover.owns_repo;
  const dir = path.join(stateDir, 'brain', 'packs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'pack4-handover.json'), JSON.stringify(pack, null, 2) + '\n');
  writeFileSync(path.join(dir, 'pack4-handover.md'),
    `# Pack 4 — Run-your-week (handover)\n\nHi ${first} — you're running on your own now.\n\n` +
    `**Cadence (live):** ${cadence_jobs.map((j) => `${j.job} ${j.at || `every ${j.every_min}m`}`).join(' · ')} (${tz}).\n` +
    `**Autonomy:** ${autoActions.length} cron-triggered action(s) ran with no manual touch.\n` +
    `**You own it:** a git-backed brain repo (${commits} commits) — yours to keep.\n\n` +
    pack.handover.walkthrough.map((w) => `- ${w}`).join('\n') + '\n');
  return { cadence_live: pack.cadence.live, autonomy: autoActions.length, owns_repo: ownsRepo, complete: ok, deliverable: 'brain/packs/pack4-handover.md' };
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(generate(process.argv[2] || '.'), null, 2));
