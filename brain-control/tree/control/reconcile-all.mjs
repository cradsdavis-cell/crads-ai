#!/usr/bin/env node
// reconcile-all.mjs · run every applier once, in order. The rock's own
// heartbeat.
//
// Why this exists (live cert, 2026-08-04): the appliers had no cadence. A box
// DOES run a scheduler (engine/cron/scheduler.mjs, always-on, started by
// box-up.sh — it replaced a crontab path that never installed), but its base
// jobs were heartbeat, org-sync, org-pull and backup. Not one of them ran an
// applier. So every applier only ever ran when a human opened the console: a
// member could leave and the registry would still say active; an accepted
// transfer, permission answer or framework offer would sit unapplied; the
// fleet view would stay stale. Nothing was broken, nothing was running either.
// The fix is a `reconcile` base job in that same scheduler, which is why this
// file only has to be safe to run unattended and often.
//
// Order matters: pull the directory inbox FIRST so the appliers see this round's
// answers, then apply, cheapest and most local first. Every step is fail-soft
// and independent: one applier erroring must never stop the rest, because the
// next run is only minutes away and a stuck queue is worse than a noisy log.
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The pull comes first; the rest are appliers. Names only: anything missing on
// an older brain is skipped silently, which is how this ships safely to boxes
// stamped before it existed.
const STEPS = [
  'requests-reconcile',      // fetch answers + new requests from the directory
  'transfer-reconcile',      // org-to-org ownership flips
  'late-attach-reconcile',   // community ties
  // one-inbox (spec 2026-08-17 § 3): a joined tie gets the same channel a seat
  // gets. Runs BEFORE anchor-reconcile so a tie recorded this round has its
  // posted keys registered in the same pass rather than waiting for the next.
  'tie-reconcile',           // joined ties: record + stage the wire
  'anchor-reconcile',        // adopted minerals: register deploy keys, flip wired:
  'rejoin-reconcile',        // a left row revived
  'permission-reconcile',    // ask-read / ask-install answered org-side
  'ask-answers-reconcile',   // the member lane's answers (grants + reframes)
  'reframe-reconcile',       // framework offers answered org-to-org
  're-anchor-reconcile',     // a box changing its home rock
  // The SECOND half of a re-anchor, and it had no caller anywhere: its own
  // header says it "runs on both rocks' reconcile cadence after
  // re-anchor-reconcile has moved the registry row", and a grep across both
  // repos found only the file itself. So the registry moved and the box kept
  // pointing its heartbeat at the old rock forever: the new rock's appliers
  // cloned a heartbeat repo that does not exist, hit their catch, and silently
  // skipped every consent answer and leave marker, while the member kept
  // publishing those same answers into the old rock's repo. Must run AFTER
  // re-anchor-reconcile in the same pass, which is why it sits here.
  're-anchor-channel',       // ...and the heartbeat channel that has to follow it
  'leave-reconcile',         // a member's unilateral leave
  'ask-push-pending',        // drain pended reframe offers into the member lane
  // Same class of defect as re-anchor-channel above: an applier whose only
  // callers were the two REMOVAL paths (evict-member.mjs, leave-reconcile.mjs),
  // so edges were reflected when a member left and never when one arrived. The
  // app's own tie flow writes its edge at the worker (/rock-tie-result accept),
  // which is why this hid: members who joined through the app were fine, and
  // members seated ROCK-side had no edge at all. The community catalogue reads
  // exactly that edge (worker.js: edge:<sha(email)>:<org>:member, rel must be
  // joined|anchored), so those members saw the public manifest and got a 403 on
  // every content fetch, with the page telling them to join a rock they were
  // already seated on. Runs after every membership applier so it reflects
  // settled rows; the two removal-path callers stay, and an overlap costs one
  // idempotent POST, not state.
  'edges-reflect',           // registry rows -> directory edges (the tie gate reads these)
  // Catalog channel (spec 2026-08-04 § 7): pull fresh heartbeats so install
  // requests are current, re-materialise entitled catalog views, then fulfil.
  // heartbeat-pull may also run from an operator cron; both are pull-only and
  // fail-soft, so an occasional overlap costs a noisy line, not state.
  'heartbeat-pull',
  'catalog-reconcile',       // entitled per-member catalogue + packages -> inbox
  // catalog-requests-reconcile is RETIRED (one-inbox, 2026-08-17). It fulfilled
  // member Install clicks that arrived by heartbeat, which was the upward half
  // of a round trip that no longer exists: catalog-reconcile materialises the
  // whole package, and the member installs from their own disk. Left out of
  // STEPS rather than left in as a no-op, so a brain that still carries the file
  // does not keep walking every heartbeat looking for requests nobody sends.
];

const run = (script) => new Promise((resolve) => {
  const p = path.join(repoRoot, 'control', `${script}.mjs`);
  if (!existsSync(p)) return resolve({ script, skipped: true });
  execFile('node', [p], { cwd: repoRoot, timeout: 120_000 }, (err, stdout, stderr) => {
    const out = String(stdout || stderr || '').trim().split('\n').filter(Boolean).pop() || '';
    resolve({ script, ok: !err, line: out.slice(0, 160) });
  });
});

const started = Date.now();
const results = [];
for (const s of STEPS) results.push(await run(s));

const ran = results.filter((r) => !r.skipped);
const failed = ran.filter((r) => !r.ok);
for (const r of ran) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.script}: ${r.line}`);
console.log(`reconcile-all: ${ran.length} step(s) in ${Math.round((Date.now() - started) / 1000)}s`
  + `, ${failed.length} failed, ${results.length - ran.length} not present on this brain.`);
// Always exit 0: this runs unattended on a timer, and a non-zero exit would only
// teach an operator's monitoring to page about a single flaky applier.
process.exit(0);
