#!/usr/bin/env node
// ask-answers-reconcile.mjs · slice 2 (pebble agency, 2026-08-03): read the
// member lane's ANSWERS off each member-owned box's heartbeat repo
// (asks/<kind>-answer.json, published by the box when the person answers in
// their console) and apply them:
//   ask-read / ask-install -> the row's grant fields via applyPermissionGrant
//     (a decline lands 'false' explicitly: a recorded no, not an absence);
//   reframe accepted -> deliver factory/imprint namespaced (the same
//     reframe-record + push-down leg reframe-reconcile uses for the
//     directory lane); declined -> control/reframe-log.json history.
// Applied-ledger keyed by slug|kind|at, so re-runs never re-apply or re-ping.
// Row rewrites preserve EVERY extractRow field (transferRowYaml). Registry
// commit/push rides the caller's cadence (git-sync). Fail-soft everywhere:
// a box with no heartbeat repo or no answers is simply skipped.
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRow, normalizeRow } from '../registry/normalize-row.mjs';
import { setScalar } from '../registry/set-field.mjs';
import { resolveOrgGitHub, plainRemote, runGit } from '../factory/org-github.mjs';

// A row write is not visible until the INDEX is rebuilt: the panel's Fleet
// health reads registry/index.json, not the yaml files. Every panel verb that
// touches a row runs build-index; these appliers did not, so a member who had
// LEFT still showed as ACTIVE on Fleet health, with Pause/Transfer/Leave
// offered against a box whose door key was already detached (seen live
// 2026-08-03). Fail-soft: a missing builder must never strand an applied row.
const rebuildIndex = async (root) => {
  const b = path.join(root, 'registry', 'build-index.mjs');
  if (!existsSync(b)) return;
  await new Promise((res) => execFile('node', [b], { cwd: root }, () => res())).catch(() => {});
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = await readFile(path.join(repoRoot, 'org-policy.yaml'), 'utf8').catch(() => '');
const ORG = (policy.match(/^org:\s*$[\s\S]*?^\s+name:\s*"?([^"\n#]*)"?/m) || [])[1]?.trim();
if (!ORG) { console.log('ask-answers-reconcile: dormant (no org handle).'); process.exit(0); }

// An unattended reconciler goes DORMANT rather than refusing: nobody is reading
// its output at 3am, and a rock whose GitHub is not connected yet is a normal
// state, not an error. The stamp path is where a person gets told.
const { owner: OWNER, token: TOKEN } = resolveOrgGitHub({ brainRoot: repoRoot });
if (!OWNER || !TOKEN) { console.log('ask-answers-reconcile: dormant (no org GH auth).'); process.exit(0); }

const ledgerPath = path.join(repoRoot, 'control', 'ask-answers-applied.json');
const applied = JSON.parse(await readFile(ledgerPath, 'utf8').catch(() => '[]'));
const logPath = path.join(repoRoot, 'control', 'reframe-log.json');
const rlog = JSON.parse(await readFile(logPath, 'utf8').catch(() => '[]'));
const notify = async (msg) => {
  const script = path.join(repoRoot, 'control', 'notify.mjs');
  if (!existsSync(script)) return;
  await new Promise((res) => execFile('node', [script, msg], { cwd: repoRoot }, () => res())).catch(() => {});
};

const files = await readdir(path.join(repoRoot, 'registry', 'members')).catch(() => []);
let grants = 0, delivered = 0, recorded = 0;
for (const f of files) {
  if (!f.endsWith('.yaml') || f.startsWith('_')) continue;
  const slug = f.replace(/\.yaml$/, '');
  const rowText = await readFile(path.join(repoRoot, 'registry', 'members', f), 'utf8').catch(() => '');
  if (!rowText) continue;
  const owner = (rowText.match(/^owner:\s*"?([a-z0-9-]+)"?/m) || [, 'member'])[1];
  if (owner !== 'member') continue;   // the member lane only ever answers for member-owned boxes
  // Working copy: every write in the kind-loop below builds on the previous one.
  let text = rowText;

  // read-only clone/pull of the heartbeat repo (the transfer-org-complete mechanism)
  const work = path.join(repoRoot, 'state', 'heartbeats-work', slug);
  const remote = process.env.HEARTBEAT_REMOTE_URL || plainRemote(OWNER, `heartbeat-${slug}`);
  try {
    const git = (a, cwd = work) => runGit(a, { cwd, token: TOKEN });
    let cloned = false; try { await stat(path.join(work, '.git')); cloned = true; } catch { /* fresh */ }
    if (!cloned) { await mkdir(path.dirname(work), { recursive: true }); runGit(['clone', remote, work], { token: TOKEN }); }
    else { git(['remote', 'set-url', 'origin', remote]); git(['pull', '--ff-only', 'origin', 'main']); }
  } catch { continue; }   // no heartbeat repo: nothing to read for this box

  for (const kind of ['ask-read', 'ask-install', 'reframe']) {
    const raw = (await readFile(path.join(work, 'asks', `${kind}-answer.json`), 'utf8').catch(() => '')).trim();
    if (!raw) continue;
    let ans; try { ans = JSON.parse(raw); } catch { continue; }
    if (ans.answer !== 'accepted' && ans.answer !== 'declined') continue;
    // Key on the answer's exact timestamp, not its date. With a date-only key a
    // member who declined at 09:00 and accepted at 14:00 had the accept
    // SILENTLY DISCARDED until the next day: same key, already in the ledger.
    // Consent is the one surface where changing your mind is both most likely
    // and most consequential, so a same-day reversal has to land. Older answers
    // carry no `ts` and keep the date key, which is what stops this change from
    // re-applying every answer already on the ledger.
    const key = `${slug}|${kind}|${ans.ts || ans.at || ''}`;
    if (applied.includes(key)) continue;

    if (kind === 'ask-read' || kind === 'ask-install') {
      // touch ONLY the grant field: regenerating the row from a normalized
      // object destroyed everything normalizeRow does not model (live cert
      // 2026-08-03: a 61-line record became a 10-line stub).
      // Accumulate onto `text`, NOT the pre-loop `rowText`. Both grant writes
      // used to build from the same original read, so a member who answered
      // ask-read and ask-install in one pass had the FIRST answer silently
      // reverted by the second write: declining read while accepting install
      // left read_consent still "true". The two answers are independent files
      // in the box's heartbeat repo, so both being fresh in one pass is the
      // ordinary case, not a rare race.
      const field = kind === 'ask-read' ? 'read_consent' : 'infra_push_consent';
      text = setScalar(text, field, ans.answer === 'accepted' ? 'true' : 'false');
      await writeFile(path.join(repoRoot, 'registry', 'members', f), text);
      await notify(`${kind}: ${slug} answered ${ans.answer}. The grant is on the row.`);
      grants++;
    } else {
      const entry = { id: key, box: slug, to: 'member', framework: ans.framework || '', intensity: ans.intensity || 'overlay', outcome: ans.answer, date: ans.at || '' };
      if (ans.answer === 'accepted') {
        const n = normalizeRow(extractRow(rowText), { anchorSlug: ORG });
        if (n.anchor !== ORG) {
          console.log(`ask-answers-reconcile: ${slug} accepted a reframe but we are not its anchor; logged only.`);
        } else if (!existsSync(path.join(repoRoot, 'factory', 'imprint'))) {
          console.log(`ask-answers-reconcile: ${slug} accepted but factory/imprint/ is empty; nothing to deliver.`);
        } else {
          const rec = { from: ORG, framework: ans.framework || '', intensity: ans.intensity || 'overlay', date: ans.at || '', outcome: 'accepted' };
          await writeFile(path.join(repoRoot, 'factory', 'imprint', 'reframe-record.json'), JSON.stringify(rec) + '\n');
          const ok = await new Promise((res) => execFile('node',
            [path.join(repoRoot, 'orchestrator', 'push-down.mjs'), slug, path.join(repoRoot, 'factory', 'imprint'), `frameworks/${ORG}`],
            { cwd: repoRoot }, (e) => res(!e)));
          if (!ok) { console.log(`ask-answers-reconcile: delivery to ${slug} failed; will retry next pass.`); continue; }
          delivered++;
        }
      }
      rlog.push(entry); recorded++;
      await notify(`reframe: ${slug} ${ans.answer} the framework offer.`);
    }
    // the ask is answered: take it off their inbox so the card clears everywhere
    await new Promise((res) => execFile('node',
      [path.join(repoRoot, 'orchestrator', 'push-ask.mjs'), slug, kind, '--withdraw'],
      { cwd: repoRoot }, () => res())).catch(() => {});
    applied.push(key);
  }
}
await writeFile(logPath, JSON.stringify(rlog.slice(-500), null, 2) + '\n');
await rebuildIndex(repoRoot);
await writeFile(ledgerPath, JSON.stringify(applied.slice(-500)) + '\n');
console.log(`ask-answers-reconcile: ${grants} grants, ${delivered} delivered, ${recorded} reframe outcomes recorded.`);
